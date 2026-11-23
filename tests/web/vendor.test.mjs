// Third-party code is served from web/vendor, byte for byte as published on npm, and the CSP allows no other
// script source. To update a vendored file, download it with `npm pack`, check it, then update SHA256SUMS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TRANSFORMERS_URL, ORT_FILES } from "../../web/lib/detective.js";

const vendor = new URL("../../web/vendor/", import.meta.url);
const sums = readFileSync(new URL("SHA256SUMS", vendor), "utf8").trim().split("\n").map((line) => {
  const [, sha256, path] = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
  return { sha256, path };
});

test("every vendored file matches its recorded SHA-256", () => {
  for (const { sha256, path } of sums) {
    const actual = createHash("sha256").update(readFileSync(new URL(path, vendor))).digest("hex");
    assert.equal(actual, sha256, path);
  }
});

test("the detective loads its runtime from the checked files", () => {
  const listed = new Set(sums.map(({ path }) => fileURLToPath(new URL(path, vendor))));
  for (const url of [TRANSFORMERS_URL, ORT_FILES.mjs, ORT_FILES.wasm]) {
    const path = fileURLToPath(url);
    assert.ok(existsSync(path), path);
    assert.ok(listed.has(path), `${path} is not in SHA256SUMS`);
  }
});

test("the CSP runs scripts from this site only and connects only to Hugging Face", () => {
  const config = JSON.parse(readFileSync(new URL("../../web/vercel.json", import.meta.url), "utf8"));
  const csp = config.headers.flatMap((rule) => rule.headers).find((h) => h.key === "Content-Security-Policy").value;
  const directives = Object.fromEntries(csp.split(";").map((d) => d.trim().split(/\s+/)).map(([name, ...v]) => [name, v]));
  assert.deepEqual(directives["script-src"], ["'self'", "'wasm-unsafe-eval'"]);
  assert.deepEqual(directives["worker-src"], ["'self'"]);
  assert.deepEqual(directives["connect-src"], ["'self'", "https://huggingface.co", "https://*.hf.co"]);
});
