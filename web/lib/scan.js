// Runs the pipeline over extracted text and builds the report. Port of lib/scanner/scan.py.
// Text is packed into chunks under 7,500 characters; fenced code blocks are skipped (numbers in code
// look like phone numbers). The name finder is passed in: quick-frisk rules or the detective model.

import { stripPatterns } from "./patterns.js";
import { nameTokens } from "./entities.js";
import { Aggregator, contextBefore, dropNestedDates, exposureScore, levelFor } from "./report.js";

export const MAX_CHUNK_CHARS = 7500;
export const MAX_SCAN_CHARS = 5_000_000; // beyond this the rest is skipped and the report says so
const CODE_BLOCK_RE = /```[\s\S]*?(?:```|(?=\n?$))/g;

const FORMAT_LABELS = {
  chatgpt_export: "ChatGPT export",
  claude_export: "Claude export",
  json: "JSON file",
  text: "pasted memories",
};

// Python's str.splitlines(keepends=True)
const LINE_RE = /[^\n\r\v\f\x1c-\x1e\x85\u2028\u2029]*(?:\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029])?/g;
export function splitLinesKeepEnds(text) {
  const out = [];
  for (const m of text.matchAll(LINE_RE)) if (m[0]) out.push(m[0]);
  return out;
}

const pyStrip = (s) => s.trim();

/** Split text longer than limit at line breaks, then spaces, then hard. */
function splitLong(text, limit) {
  const pieces = [];
  let current = "";
  for (let line of splitLinesKeepEnds(text)) {
    while (line.length > limit) { // one line longer than a whole chunk
      if (current) {
        pieces.push(current);
        current = "";
      }
      let cut = line.lastIndexOf(" ", limit - 1);
      if (cut <= Math.floor(limit / 2)) cut = limit;
      pieces.push(line.slice(0, cut));
      line = line.slice(cut);
    }
    if (current.length + line.length > limit) {
      pieces.push(current);
      current = "";
    }
    current += line;
  }
  if (current) pieces.push(current);
  return pieces.filter((p) => pyStrip(p));
}

export function buildChunks(texts, limit = MAX_CHUNK_CHARS) {
  const chunks = [];
  let buf = "";
  let spans = [];
  const sep = "\n\n";
  texts.forEach((text, index) => {
    if (!pyStrip(text)) return;
    for (const piece of text.length > limit ? splitLong(text, limit) : [text]) {
      const needed = piece.length + (buf ? sep.length : 0);
      if (buf && buf.length + needed > limit) {
        chunks.push({ text: buf, spans });
        buf = "";
        spans = [];
      }
      if (buf) buf += sep;
      spans.push([buf.length, buf.length + piece.length, index]);
      buf += piece;
    }
  });
  if (buf) chunks.push({ text: buf, spans });
  return chunks;
}

function segmentsContaining(chunk, value, found) {
  let start = chunk.text.indexOf(value);
  while (start >= 0) {
    for (const [s, e, index] of chunk.spans) if (s <= start && start < e) found.add(index);
    start = chunk.text.indexOf(value, start + 1);
  }
}

/** Code blocks out, whitespace trimmed, 5 million character cap: one entry per segment. */
export function prepareTexts(extracted) {
  let codeBlocks = 0;
  let budget = MAX_SCAN_CHARS;
  let truncated = false;
  const texts = [];
  for (const segment of extracted.segments) {
    if (budget <= 0) {
      truncated = true; // segments left over that we won't scan
      break;
    }
    let text = segment.text.replace(CODE_BLOCK_RE, () => {
      codeBlocks += 1;
      return " ";
    });
    text = pyStrip(text);
    if (text.length > budget) {
      truncated = true;
      text = text.slice(0, budget);
    }
    budget -= text.length;
    texts.push(text);
  }
  return { texts, codeBlocks, truncated };
}

/**
 * findEntities(text) -> [{type, text, start, end, score}] (sync or async).
 * onProgress(done, total) after each chunk. shouldStop() lets the caller cancel between chunks.
 * Returns { report, keys }: keys are the distinct finds, for comparing stages inside the worker only.
 */
export async function scan(extracted, findEntities, { onProgress, shouldStop } = {}) {
  const started = performance.now();
  const { texts, codeBlocks, truncated } = prepareTexts(extracted);
  const chunks = buildChunks(texts);
  const agg = new Aggregator();
  const withFinds = new Set();
  let failedChunks = 0;

  for (let i = 0; i < chunks.length; i++) {
    if (shouldStop?.()) throw new Error("cancelled");
    const chunk = chunks[i];
    try {
      const stripped = stripPatterns(chunk.text);
      const names = await nameTokens(stripped.text, stripped.senderName, findEntities);
      for (const token of dropNestedDates([...stripped.tokens, ...names])) {
        const original = token.original || "";
        const context = token.type === "DOB" || token.type === "PHONE" ? contextBefore(chunk.text, original) : "";
        if (agg.add(token.type, original, context)) segmentsContaining(chunk, original, withFinds);
      }
    } catch (err) {
      if (err?.message === "cancelled") throw err;
      failedChunks += 1;
    }
    onProgress?.(i + 1, chunks.length);
  }

  const totals = agg.totals();
  const score = exposureScore(totals.directUnique, totals.contextUnique);
  const kinds = {};
  for (const s of extracted.segments) kinds[s.source] = (kinds[s.source] ?? 0) + 1;
  const report = {
    source: {
      format: extracted.format,
      label: FORMAT_LABELS[extracted.format] ?? extracted.format,
      conversations: extracted.conversations,
      piecesScanned: texts.filter((t) => t).length,
      piecesWithFinds: withFinds.size,
      kinds,
      assistantMessagesSkipped: extracted.assistantMessagesSkipped,
      codeBlocksSkipped: codeBlocks,
      charactersScanned: texts.reduce((n, t) => n + t.length, 0),
      truncated,
      failedChunks,
    },
    totals,
    score,
    level: levelFor(score),
    categories: agg.categories(),
    elapsedMs: Math.round(performance.now() - started),
  };
  return { report, keys: agg.keys() };
}
