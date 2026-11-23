// The detective: bert-base-NER (Hugging Face's official browser build, 8-bit, 104 MB) via Transformers.js.
// Loaded only when the visitor asks for it. Transformers.js and ONNX Runtime are served from this site
// (web/vendor, checked against npm's published hashes; see vendor/SHA256SUMS). The model comes from Hugging
// Face, pinned to one revision; every file is checked against its SHA-256 before use, and stays in the browser
// cache afterwards.
//
// Transformers.js's token-classification pipeline has no character offsets and no "first" aggregation,
// so this splits text into words the way BERT does, tokenizes word by word, and labels each word with its
// first piece. That reproduces the Python benchmark (HF pipeline, aggregation_strategy="first").

export const TRANSFORMERS_URL = new URL("../vendor/transformers-4.3.2.min.js", import.meta.url).href;
// The ONNX Runtime build Transformers.js 4.3.2 is compiled against (its JavaScript is bundled inside it).
// The plain CPU build: the detective runs on WebAssembly only, so the WebGPU build (twice the size) isn't needed.
const ORT_DIR = new URL("../vendor/onnxruntime-web-1.31.0-dev.20260914-8d85527a0/", import.meta.url);
export const ORT_FILES = {
  mjs: new URL("ort-wasm-simd-threaded.mjs", ORT_DIR).href,
  wasm: new URL("ort-wasm-simd-threaded.wasm", ORT_DIR).href,
};
export const MODEL_ID = "Xenova/bert-base-NER";
export const MODEL_REVISION = "8e892123e8b7c2c0c2bd1dcb598b7d244c4e53aa";
export const MODEL_FILE = "onnx/model_quantized.onnx";
export const CACHE_NAME = "transformers-cache";
// Everything the detective downloads, with size and SHA-256. The model's hash is Hugging Face's own LFS record;
// the JSON files were hashed after checking they match Hugging Face's git ids for this revision.
export const MODEL_FILES = {
  "config.json": { bytes: 999, sha256: "a73a2eccc921bbdea95a94b49a157d3694b5c2abbae7a6f3000e14404a9c31a8" },
  "tokenizer.json": { bytes: 668_923, sha256: "343989712a36cd8b253efeaf8baf6a08b9d2583f78e395e83832e8ee9f8d8ee1" },
  "tokenizer_config.json": { bytes: 385, sha256: "5be1a180e9badb4811a6c31502d70fb35a085af5457982937419c42d7530bae6" },
  [MODEL_FILE]: { bytes: 108_952_255, sha256: "caaee70a5518ec7f9e46e5308fcc9263a8c227703a9ce46cf61c69a552349648" },
};
export const MODEL_BYTES = MODEL_FILES[MODEL_FILE].bytes;
const MODEL_BASE = `https://huggingface.co/${MODEL_ID}/resolve/`;

/** A download that doesn't match its published SHA-256 (or size). Nothing from it is used or cached. */
export class IntegrityError extends Error {
  constructor(file) {
    super(`${file} doesn't match its published SHA-256, so it was thrown away`);
    this.name = "IntegrityError";
  }
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Passes the body through, and errors it at the end unless it has exactly the expected size and hash. */
function verified(file, { bytes, sha256 }) {
  const data = new Uint8Array(bytes);
  let length = 0;
  return new TransformStream({
    transform(chunk, controller) {
      if (length + chunk.length > bytes) throw new IntegrityError(file);
      data.set(chunk, length);
      length += chunk.length;
      controller.enqueue(chunk);
    },
    async flush() {
      if (length !== bytes || (await sha256Hex(data)) !== sha256) throw new IntegrityError(file);
    },
  });
}

/**
 * The fetch Transformers.js uses (env.fetch). It only reaches the pinned files in MODEL_FILES, and only hands
 * them over once their SHA-256 matches; Transformers.js caches a file only after reading all of it, so a bad
 * download is never cached. Transformers.js 4.3.2 checks that tokenizer_config.json exists on the "main" branch,
 * without the revision: that check is answered here, so nothing outside the pinned revision is ever requested.
 */
export function modelFetch(fetchImpl, files = MODEL_FILES) {
  return async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url ?? String(input);
    if (!url.startsWith(MODEL_BASE)) throw new Error(`The detective only downloads ${MODEL_ID}, not ${url}`);
    const [revision, ...path] = url.slice(MODEL_BASE.length).split("/");
    if (revision !== MODEL_REVISION && revision !== "main") throw new Error(`Unexpected model revision: ${url}`);
    const file = path.join("/");
    const expected = files[file];
    if (!expected) return new Response(null, { status: 404, statusText: "Not Found" });
    if (new Headers(init.headers).has("Range")) { // an existence check
      return new Response(null, { status: 200, headers: { "content-length": String(expected.bytes) } });
    }
    const response = await fetchImpl(`${MODEL_BASE}${MODEL_REVISION}/${file}`, init);
    if (!response.ok || !response.body) return response;
    const { status, statusText, headers } = response;
    return new Response(response.body.pipeThrough(verified(file, expected)), { status, statusText, headers });
  };
}

const LABELS = { PER: "PERSON", ORG: "ORG", LOC: "LOCATION" }; // MISC is ignored, as in the Python benchmark
const MAX_PIECES = 510; // 512 minus [CLS] and [SEP]
const SOFT_PIECES = 400; // past this, end the window at a sentence or line break if there is one

// BERT's basic tokenizer: whitespace splits words, every punctuation character is its own word.
const PUNCT = "\\p{P}\\x21-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\x7e";
const WORD_RE = new RegExp(`[${PUNCT}]|[^\\s${PUNCT}]+`, "gu");
const SENTENCE_END = new Set([".", "!", "?", ";"]);

export function bertWords(text) {
  return Array.from(text.matchAll(WORD_RE), (m) => ({ text: m[0], start: m.index, end: m.index + m[0].length }));
}

function softmaxRow(data, offset, width) {
  let max = -Infinity;
  for (let k = 0; k < width; k++) max = Math.max(max, data[offset + k]);
  let sum = 0;
  const out = new Float64Array(width);
  for (let k = 0; k < width; k++) sum += out[k] = Math.exp(data[offset + k] - max);
  for (let k = 0; k < width; k++) out[k] /= sum;
  return out;
}

/** Group labelled words into entities, as Hugging Face's group_entities does, then join neighbours. */
export function groupWords(text, words) {
  const groups = [];
  let open = null;
  for (const w of words) {
    const [bi, tag] = w.label === "O" ? ["O", "O"] : [w.label[0], w.label.slice(2)];
    if (open && open.tag === tag && bi !== "B") {
      open.end = w.end;
      open.scores.push(w.score);
    } else {
      open = { tag, start: w.start, end: w.end, scores: [w.score] };
      groups.push(open);
    }
  }
  const entities = [];
  for (const g of groups) {
    const type = LABELS[g.tag];
    if (!type) continue;
    const score = g.scores.reduce((a, b) => a + b, 0) / g.scores.length;
    const prev = entities[entities.length - 1];
    // two pieces of the same type with only spaces between: one entity (as the Python benchmark did)
    if (prev && prev.type === type && text.slice(prev.end, g.start).trim() === "") {
      prev.end = g.end;
      prev.text = text.slice(prev.start, g.end);
      prev.score = Math.min(prev.score, score);
      continue;
    }
    entities.push({ type, text: text.slice(g.start, g.end), start: g.start, end: g.end, score });
  }
  return entities;
}

/**
 * Downloads (or reads from cache) and starts the model. onDownload(loadedBytes, totalBytes) while downloading.
 * Returns findEntities(text, onChars?) -> Promise<[{type, text, start, end, score}]>.
 */
export async function loadDetective({ onDownload } = {}) {
  const { env, AutoTokenizer, AutoModelForTokenClassification, Tensor } = await import(TRANSFORMERS_URL);
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = true;
  env.fetch = modelFetch(globalThis.fetch.bind(globalThis));
  // ONNX Runtime from this site, imported directly (the WebAssembly cache would turn it into a blob: URL).
  env.useWasmCache = false;
  env.backends.onnx.wasm.wasmPaths = { ...ORT_FILES };

  const progress_callback = (p) => {
    if (p.status === "progress" && typeof p.file === "string" && p.file.endsWith(".onnx")) {
      onDownload?.(p.loaded ?? 0, p.total || MODEL_BYTES);
    }
  };
  const options = { revision: MODEL_REVISION, progress_callback };
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID, options);
  const model = await AutoModelForTokenClassification.from_pretrained(MODEL_ID, { ...options, dtype: "q8", device: "wasm" });
  const id2label = model.config.id2label;
  const width = Object.keys(id2label).length;
  const cls = tokenizer.cls_token_id ?? 101;
  const sep = tokenizer.sep_token_id ?? 102;
  const pieceCache = new Map();

  const piecesOf = (word) => {
    let ids = pieceCache.get(word);
    if (!ids) {
      ids = tokenizer.encode(word, { add_special_tokens: false }).slice(0, MAX_PIECES);
      if (pieceCache.size > 50_000) pieceCache.clear();
      pieceCache.set(word, ids);
    }
    return ids;
  };

  async function label(window) {
    // window: [{ word, ids }]; returns words with a label and score from their first piece
    const ids = [cls];
    const firstPiece = [];
    for (const w of window) {
      firstPiece.push(ids.length);
      ids.push(...w.ids);
    }
    ids.push(sep);
    const n = ids.length;
    const tensor = (values) => new Tensor("int64", BigInt64Array.from(values, (v) => BigInt(v)), [1, n]);
    const { logits } = await model({
      input_ids: tensor(ids),
      attention_mask: tensor(new Array(n).fill(1)),
      token_type_ids: tensor(new Array(n).fill(0)),
    });
    const data = logits.data;
    return window.map((w, i) => {
      const probs = softmaxRow(data, firstPiece[i] * width, width);
      let best = 0;
      for (let k = 1; k < width; k++) if (probs[k] > probs[best]) best = k;
      return { ...w.word, label: id2label[best], score: probs[best] };
    });
  }

  return async function findEntities(text, onChars) {
    const words = bertWords(text).map((word) => ({ word, ids: piecesOf(word.text) })).filter((w) => w.ids.length);
    const labelled = [];
    let i = 0;
    let doneChars = 0;
    while (i < words.length) {
      // take words up to the piece budget, ending at a sentence or line break when one is near
      let pieces = 0;
      let j = i;
      let cut = -1;
      while (j < words.length && pieces + words[j].ids.length <= MAX_PIECES) {
        pieces += words[j].ids.length;
        j += 1;
        if (pieces >= SOFT_PIECES && j < words.length) {
          const w = words[j - 1].word;
          const gap = text.slice(w.end, words[j].word.start);
          if (SENTENCE_END.has(w.text) || gap.includes("\n")) cut = j;
        }
      }
      if (j === i) j = i + 1; // a single word longer than the budget (already truncated to MAX_PIECES)
      const end = cut > i && j < words.length ? cut : j;
      labelled.push(...(await label(words.slice(i, end))));
      const reached = words[end - 1].word.end;
      onChars?.(reached - doneChars);
      doneChars = reached;
      i = end;
    }
    if (doneChars < text.length) onChars?.(text.length - doneChars);
    return groupWords(text, labelled);
  };
}

/** Forget the downloaded model (frees ~104 MB). Returns true if something was deleted. */
export async function forgetDetective() {
  try {
    return await caches.delete(CACHE_NAME);
  } catch {
    return false;
  }
}

/** Whether the model is already in this browser's cache (so no download is needed). */
export async function detectiveIsCached() {
  try {
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();
    return keys.some((request) => request.url.includes(MODEL_ID) && request.url.endsWith(MODEL_FILE));
  } catch {
    return false;
  }
}
