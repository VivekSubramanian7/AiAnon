// The detective's word splitting, grouping and download checks (no model needed).
// The model itself is tested in the browser (web/dev/check.html?detective=1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  bertWords, groupWords, modelFetch, checkedCache, IntegrityError, MODEL_FILES, MODEL_FILE, MODEL_ID, MODEL_REVISION,
  UNPINNED_REVISION,
} from "../../web/lib/detective.js";

test("words split like BERT: punctuation stands alone", () => {
  assert.deepEqual(bertWords("Hi O'Brien, it's 9am.").map((w) => w.text),
    ["Hi", "O", "'", "Brien", ",", "it", "'", "s", "9am", "."]);
  const [w] = bertWords("  Zoë");
  assert.deepEqual([w.start, w.end], [2, 5]);
});

test("B/I tags group into entities, neighbours of one type merge, MISC is ignored", () => {
  const text = "Priya Natarajan met Tom at Contoso Health in Leeds , English";
  const labels = ["B-PER", "I-PER", "O", "B-PER", "O", "B-ORG", "I-ORG", "O", "B-LOC", "O", "B-MISC"];
  const scores = [0.99, 0.98, 0.9, 0.97, 0.9, 0.8, 0.9, 0.9, 0.95, 0.9, 0.9];
  const words = bertWords(text).map((w, i) => ({ ...w, label: labels[i], score: scores[i] }));
  const ents = groupWords(text, words);
  assert.deepEqual(ents.map((e) => [e.type, e.text]),
    [["PERSON", "Priya Natarajan"], ["PERSON", "Tom"], ["ORG", "Contoso Health"], ["LOCATION", "Leeds"]]);
  assert.ok(Math.abs(ents[0].score - 0.985) < 1e-9);
});

test("a B tag starts a new entity, then adjacent same-type entities are joined (as the Python benchmark did)", () => {
  const text = "Anna Bell";
  const words = bertWords(text).map((w, i) => ({ ...w, label: "B-PER", score: i ? 0.5 : 0.9 }));
  assert.deepEqual(groupWords(text, words).map((e) => [e.text, e.score]), [["Anna Bell", 0.5]]);
});

// ---------- downloads: only the pinned files, only when their SHA-256 matches ----------

const BASE = `https://huggingface.co/${MODEL_ID}/resolve/`;
const GOOD = new TextEncoder().encode('{"model_type":"bert"}');
const FILES = { "config.json": { bytes: GOOD.length, sha256: createHash("sha256").update(GOOD).digest("hex") } };

function fakeFetch(body) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return new Response(body, { status: 200, headers: { "content-length": String(body.length) } });
  };
  return Object.assign(impl, { calls });
}

async function readAll(response) { // as Transformers.js reads a download
  const reader = response.body.getReader();
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(parts);
    parts.push(value);
  }
}

test("a file matching its SHA-256 comes through unchanged, always from the pinned revision", async () => {
  const fetchImpl = fakeFetch(GOOD);
  const get = modelFetch(fetchImpl, FILES);
  for (const revision of [MODEL_REVISION, UNPINNED_REVISION]) {
    const response = await get(`${BASE}${revision}/config.json`);
    assert.deepEqual(new Uint8Array(await readAll(response)), GOOD);
  }
  assert.deepEqual(fetchImpl.calls.map((c) => c.url), Array(2).fill(`${BASE}${MODEL_REVISION}/config.json`));
});

test("a tampered, longer or shorter file errors the download, so it is never used or cached", async () => {
  const tampered = GOOD.slice();
  tampered[3] ^= 1;
  const longer = new Uint8Array([...GOOD, 32]);
  for (const body of [tampered, longer, GOOD.slice(0, -1)]) {
    const response = await modelFetch(fakeFetch(body), FILES)(`${BASE}${MODEL_REVISION}/config.json`);
    await assert.rejects(readAll(response), (err) => err instanceof IntegrityError);
  }
});

test("existence checks are answered without a request; other files are missing", async () => {
  const fetchImpl = fakeFetch(GOOD);
  const get = modelFetch(fetchImpl, FILES);
  const head = await get(`${BASE}${UNPINNED_REVISION}/config.json`, {
    method: "GET", headers: new Headers({ Range: "bytes=0-0" }),
  });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(GOOD.length));
  assert.equal((await get(`${BASE}${MODEL_REVISION}/generation_config.json`)).status, 404);
  assert.equal(fetchImpl.calls.length, 0);
});

test("anything but the pinned model is refused", async () => {
  const fetchImpl = fakeFetch(GOOD);
  const get = modelFetch(fetchImpl, FILES);
  for (const url of [
    `${BASE}0000000000000000000000000000000000000000/config.json`, // another revision
    "https://huggingface.co/someone/bert-base-NER/resolve/main/config.json", // another model
    "https://example.com/Xenova/bert-base-NER/resolve/main/config.json", // another host
  ]) await assert.rejects(get(url));
  assert.equal(fetchImpl.calls.length, 0);
});

// ---------- the browser cache: a stored file comes out only if it still matches ----------

function fakeCache(entries = {}) { // the parts of the Cache API Transformers.js and checkedCache use
  const store = new Map(Object.entries(entries));
  const url = (key) => (typeof key === "string" ? key : key.url); // like the real one, keys may be Requests
  return {
    store,
    match: async (key) => (store.has(url(key)) ? new Response(store.get(url(key))) : undefined),
    put: async (key, response) => { store.set(url(key), new Uint8Array(await response.arrayBuffer())); },
    delete: async (key) => store.delete(url(key)),
  };
}

const CONFIG_URL = `${BASE}${MODEL_REVISION}/config.json`;

test("a stored file that still matches comes out of the cache unchanged", async () => {
  const cache = checkedCache(fakeCache({ [CONFIG_URL]: GOOD }), FILES);
  for (let i = 0; i < 2; i++) { // the second read skips the hash, not the file
    const response = await cache.match(CONFIG_URL);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), GOOD);
  }
  assert.deepEqual(new Uint8Array(await (await cache.match(new Request(CONFIG_URL))).arrayBuffer()), GOOD);
});

test("a stored file that no longer matches is deleted and reported missing, so it is downloaded again", async () => {
  const tampered = GOOD.slice();
  tampered[3] ^= 1;
  for (const body of [tampered, new Uint8Array([...GOOD, 32]), GOOD.slice(0, -1)]) {
    const inner = fakeCache({ [CONFIG_URL]: body });
    assert.equal(await checkedCache(inner, FILES).match(CONFIG_URL), undefined);
    assert.equal(inner.store.has(CONFIG_URL), false);
  }
});

test("only the pinned files come out of the cache; a miss stays a miss; put stores", async () => {
  const others = [
    `${BASE}${UNPINNED_REVISION}/config.json`, // not the pinned revision
    `${BASE}${MODEL_REVISION}/generation_config.json`, // not one of the files
    "https://huggingface.co/someone/bert-base-NER/resolve/main/config.json", // another model
  ];
  const inner = fakeCache(Object.fromEntries(others.map((url) => [url, GOOD])));
  const cache = checkedCache(inner, FILES);
  for (const url of others) assert.equal(await cache.match(url), undefined);
  assert.equal(await cache.match(CONFIG_URL), undefined);
  await cache.put(CONFIG_URL, new Response(GOOD));
  assert.deepEqual(new Uint8Array(await (await cache.match(CONFIG_URL)).arrayBuffer()), GOOD);
});

test("the real list covers every file the detective loads", () => {
  assert.deepEqual(Object.keys(MODEL_FILES).sort(),
    ["config.json", MODEL_FILE, "tokenizer.json", "tokenizer_config.json"].sort());
  for (const { bytes, sha256 } of Object.values(MODEL_FILES)) {
    assert.ok(bytes > 0);
    assert.match(sha256, /^[0-9a-f]{64}$/);
  }
});
