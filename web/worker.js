// TMI's scan worker: reads the file, runs the quick frisk and, on request, the detective.
// Everything stays in this browser tab. The page only ever receives counts and masked examples.
//
// Messages in:  { type: "warm" }                       load the word lists early (so offline works)
//               { type: "frisk", input }                input = { id, file } or { id, text }
//               { type: "detective", input }            rescan with the model (input re-read if needed)
// Messages out: { type: "progress", phase, done, total }   phase: reading | frisk | download | starting | detective
//               { type: "result", stage, report, missed?, dropped? }  stage: frisk | detective
//               { type: "error", stage, message, retry? }

import { extractFile, extractText, fileSource, ExtractError } from "./lib/extract.js";
import { createRules } from "./lib/rules.js";
import { scan, prepareTexts, buildChunks } from "./lib/scan.js";
import { loadDetective } from "./lib/detective.js";

let rulesPromise = null;
let detectivePromise = null;
let current = null; // { input, extracted, friskKeys }

const post = (message) => self.postMessage(message);

function rules() {
  rulesPromise ??= fetch(new URL("./data/lists.json", import.meta.url))
    .then((response) => {
      if (!response.ok) throw new Error(`lists ${response.status}`);
      return response.json();
    })
    .then(createRules)
    .catch((err) => {
      rulesPromise = null;
      throw err;
    });
  return rulesPromise;
}

async function read(input) {
  if (current && current.input.id === input.id) return current.extracted;
  post({ type: "progress", phase: "reading", done: 0, total: 0 });
  const extracted = input.file ? await extractFile(fileSource(input.file)) : extractText(input.text ?? "");
  current = { input, extracted, friskKeys: null };
  return extracted;
}

function throttled(fn, ms = 120) {
  let last = 0;
  return (...args) => {
    const now = performance.now();
    if (now - last >= ms) {
      last = now;
      fn(...args);
    }
  };
}

async function frisk(input, { silent = false } = {}) {
  const extracted = await read(input);
  const findEntities = await rules();
  const progress = throttled((done, total) => post({ type: "progress", phase: "frisk", done, total }));
  const { report, keys } = await scan(extracted, findEntities, { onProgress: silent ? undefined : progress });
  current.friskKeys = keys;
  return report;
}

async function detective(input) {
  if (!current || current.input.id !== input.id || !current.friskKeys) await frisk(input, { silent: true });
  const extracted = current.extracted;

  detectivePromise ??= loadDetective({
    onDownload: throttled((loaded, total) => post({ type: "progress", phase: "download", done: loaded, total })),
  }).catch((err) => {
    detectivePromise = null;
    throw err;
  });
  post({ type: "progress", phase: "starting", done: 0, total: 0 });
  const find = await detectivePromise;

  const { texts } = prepareTexts(extracted);
  const total = buildChunks(texts).reduce((n, chunk) => n + chunk.text.length, 0);
  let done = 0;
  const progress = throttled(() => post({ type: "progress", phase: "detective", done: Math.min(done, total), total }));
  progress();
  const { report, keys } = await scan(extracted, (text) => find(text, (chars) => {
    done += chars;
    progress();
  }));
  let missed = 0; // found by the detective, not by the frisk
  let dropped = 0; // found by the frisk, not by the detective (the frisk's false alarms, mostly)
  for (const key of keys) if (!current.friskKeys.has(key)) missed += 1;
  for (const key of current.friskKeys) if (!keys.has(key)) dropped += 1;
  return { report, missed, dropped };
}

function friendly(err, stage) {
  if (err instanceof ExtractError) return { message: err.message };
  if (stage === "detective") {
    return {
      message: "The detective couldn't get here. Check your connection (the 104 MB download needs one) and try again.",
      retry: true,
    };
  }
  return { message: "Something went wrong. It's not you, it's us. Try again?" };
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "warm") {
      await rules();
    } else if (data.type === "frisk") {
      const report = await frisk(data.input);
      post({ type: "result", stage: "frisk", report });
    } else if (data.type === "detective") {
      const { report, missed, dropped } = await detective(data.input);
      post({ type: "result", stage: "detective", report, missed, dropped });
    }
  } catch (err) {
    if (data.type === "warm") return; // tried again when a scan starts
    console.error(err);
    post({ type: "error", stage: data.type, ...friendly(err, data.type) });
  }
};
