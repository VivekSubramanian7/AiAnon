// Dev-only browser check: quick frisk vs Python fixtures, detective vs the Python bert-base-NER benchmark.
// Served by scripts/serve_web.py (which also maps /samples/ and /fixtures/); excluded from Vercel.
import { extractFile, bytesSource } from "../lib/extract.js";
import { createRules } from "../lib/rules.js";
import { scan } from "../lib/scan.js";
import { loadDetective, TRANSFORMERS_URL } from "../lib/detective.js";

// Things found by the Python pipeline with bert-base-NER (browser-model-benchmark/results).
const PYTHON_BERT = {
  "chatgpt-saved-memories.txt": 17, "gemini-saved-info.txt": 10, "bot-answer-what-do-you-remember.txt": 11,
  "clean-memory.txt": 0, "chatgpt-export.zip": 19, "claude-export.zip": 18,
};
const params = new URLSearchParams(location.search);
const out = { crossOriginIsolated, frisk: {}, detective: {} };
const logEl = document.getElementById("log");
const log = (line) => { logEl.textContent += `\n${line}`; };

async function bytes(name) {
  const response = await fetch(`/samples/mock-memories/${name}`);
  return bytesSource(name, new Uint8Array(await response.arrayBuffer()));
}

function strip(report) {
  const copy = structuredClone(report);
  delete copy.elapsedMs;
  return copy;
}

try {
  const lists = await (await fetch("../data/lists.json")).json();
  const fixture = await (await fetch("/fixtures/stage1.json")).json();
  const rules = createRules(lists);
  for (const name of fixture.files) {
    const extracted = await extractFile(await bytes(name));
    const t0 = performance.now();
    const { report } = await scan(extracted, rules);
    const same = JSON.stringify(strip(report)) === JSON.stringify(fixture.reports[name]);
    out.frisk[name] = { things: report.totals.unique, python: fixture.reports[name].totals.unique, identical: same, ms: Math.round(performance.now() - t0) };
    log(`frisk ${name}: ${report.totals.unique} things (Python ${fixture.reports[name].totals.unique}) ${same ? "identical" : "DIFFERENT"} in ${out.frisk[name].ms} ms`);
  }

  if (params.get("detective")) {
    let t0 = performance.now();
    const find = await loadDetective({ onDownload: (a, b) => { out.download = `${Math.round(a / 2 ** 20)}/${Math.round(b / 2 ** 20)} MB`; } });
    out.loadMs = Math.round(performance.now() - t0);
    const { env } = await import(TRANSFORMERS_URL);
    out.threads = env.backends.onnx.wasm.numThreads;
    log(`detective loaded in ${out.loadMs} ms, wasm threads: ${out.threads}, cores: ${navigator.hardwareConcurrency}`);
    if (params.get("speed")) {
      // throughput on real text: the first ~150,000 characters of the large ChatGPT export
      const big = await extractFile(await bytes("chatgpt-export-large.zip"));
      let budget = 150_000;
      big.segments = big.segments.filter((s) => (budget -= s.text.length) > 0);
      let chars = 0;
      const t1 = performance.now();
      await scan(big, (text) => find(text, (n) => { chars += n; }));
      const seconds = (performance.now() - t1) / 1000;
      out.speed = { chars, seconds: Number(seconds.toFixed(1)), charsPerSecond: Math.round(chars / seconds) };
      log(`speed: ${chars} chars in ${out.speed.seconds} s = ${out.speed.charsPerSecond} chars/s`);
    }
    for (const name of Object.keys(PYTHON_BERT)) {
      const extracted = await extractFile(await bytes(name));
      t0 = performance.now();
      let chars = 0;
      const { report } = await scan(extracted, (text) => find(text, (n) => { chars += n; }));
      const ms = Math.round(performance.now() - t0);
      const names = report.categories.find((c) => c.key === "names").unique;
      out.detective[name] = { things: report.totals.unique, python: PYTHON_BERT[name], names, ms, charsPerSecond: Math.round(chars / (ms / 1000)),
        categories: Object.fromEntries(report.categories.filter((c) => c.unique).map((c) => [c.key, c.unique])),
        examples: Object.fromEntries(report.categories.filter((c) => c.unique).map((c) => [c.key, c.examples.map((e) => e.masked)])) };
      log(`detective ${name}: ${report.totals.unique} things (Python bert ${PYTHON_BERT[name]}), ${names} names, ${ms} ms`);
    }
  }
  out.done = true;
} catch (err) {
  out.error = String(err?.stack || err);
  log(`ERROR ${out.error}`);
}
window.__check = out;
log("done");
