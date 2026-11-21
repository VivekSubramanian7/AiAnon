// Masked detector findings must match Python (scripts/web_fixtures_detectors.py).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { detect } from "../../web/lib/detectors.js";
import { assemble } from "../../web/lib/sensitivity.js";
import { readEnvelope, nullEnvelope } from "../../web/lib/envelope.js";
import { bytesSource } from "../../web/lib/extract.js";

const root = new URL("../../", import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("tests/web/fixtures/detectors.json", root), "utf8"));
const envelopeExpected = JSON.parse(readFileSync(new URL("tests/web/fixtures/envelope.json", root), "utf8"));

function rowsFor(text, inCodeBlock) {
  const hits = detect(text, { inCodeBlock });
  return assemble([], hits).map(({ id, label, ...rest }) => rest);
}

for (const { name, text, inCodeBlock, findings } of fixture.cases) {
  test(`detectors ${name}`, () => {
    assert.deepEqual(rowsFor(text, inCodeBlock), findings);
  });
}

test("readEnvelope matches Python fixture", async () => {
  const bytes = new Uint8Array(readFileSync(new URL("tests/web/fixtures/zips/envelope.zip", root)));
  const env = await readEnvelope(bytesSource("export.zip", bytes));
  const rows = env.findings.map(({ label, ...rest }) => rest);
  const expected = { ...envelopeExpected, findings: envelopeExpected.findings };
  assert.deepEqual({ ...env, findings: rows }, expected);
});

test("null envelope for pasted text", () => {
  assert.deepEqual(nullEnvelope(), {
    userJsonPresent: null,
    userJsonSkipped: null,
    binaryAttachments: null,
    unreadMembers: [],
    findings: [],
  });
});