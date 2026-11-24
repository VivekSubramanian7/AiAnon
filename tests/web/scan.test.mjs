// Full quick-frisk reports (extract -> patterns -> rules -> report) must equal the Python pipeline's.
// Regenerate fixtures with: .venv/bin/python scripts/web_fixtures_scan.py
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRules } from "../../web/lib/rules.js";
import { extractFile, bytesSource, extractText } from "../../web/lib/extract.js";
import { scan, buildChunks, splitLinesKeepEnds } from "../../web/lib/scan.js";
import { mask, exposureScore, levelFor } from "../../web/lib/report.js";
import { buildPieces } from "../../web/lib/sensitivity.js";
import { readEnvelope, nullEnvelope } from "../../web/lib/envelope.js";

const root = new URL("../../", import.meta.url);
const lists = JSON.parse(readFileSync(new URL("web/data/lists.json", root), "utf8"));
const fixture = JSON.parse(readFileSync(new URL("tests/web/fixtures/stage1.json", root), "utf8"));
const findEntities = createRules(lists);

for (const name of fixture.files) {
  test(`quick frisk report for ${name} equals Python`, async () => {
    const bytes = new Uint8Array(readFileSync(new URL(`samples/mock-memories/${name}`, root)));
    const extracted = await extractFile(bytesSource(name, bytes));
    const envelope = name.toLowerCase().endsWith(".zip")
      ? await readEnvelope(bytesSource(name, bytes))
      : nullEnvelope();
    const { report } = await scan(extracted, findEntities, { envelope });
    delete report.elapsedMs;
    assert.deepEqual(report, fixture.reports[name]);
  });
}

test("chunks stay under the limit and keep segment spans", () => {
  const chunks = buildChunks(["a".repeat(9000), "short", "", "x\ny"], 7500);
  assert.ok(chunks.every((c) => c.text.length <= 7500));
  assert.deepEqual(chunks.at(-1).spans.map((s) => s[2]), [0, 1, 3]);
});

test("splitlines keeps Python's line endings", () => {
  assert.deepEqual(splitLinesKeepEnds("a\r\nb\rc\u2028d"), ["a\r\n", "b\r", "c\u2028", "d"]);
});

test("H1–H3 detector kinds match between frisk and detective", async () => {
  const text = readFileSync(new URL("samples/mock-memories/chatgpt-saved-memories.txt", root), "utf8");
  const extracted = extractText(text);
  const noNer = () => [];
  const kinds = (report) =>
    report.findings
      .filter((f) => f.source === "detector" && ["H1", "H2", "H3"].includes(f.harm))
      .map((f) => f.kind)
      .sort();
  const { report: a } = await scan(extracted, findEntities, { envelope: nullEnvelope() });
  const { report: b } = await scan(extracted, noNer, { envelope: nullEnvelope() });
  assert.deepEqual(kinds(a), kinds(b));
});

test("masks, score and levels", () => {
  assert.equal(mask("names", "Sam Miller"), "S•• M•••••");
  assert.equal(mask("emails", "dana.whitfield@example.com"), "d•••.•••••••••@e••••••.com");
  assert.equal(mask("phones", "+44 7700 900123"), "+•• •••• ••••23");
  assert.equal(mask("links", "https://example.com/a/b"), "example.com/•••");
  assert.equal(mask("ages", "36 years old"), "30s");
  assert.equal(exposureScore(0, 0), 0);
  assert.equal(levelFor(exposureScore(6, 4)), "oversharer");
});

test("buildPieces groups by kind and subject", () => {
  const rows = [
    { harm: "H4", kind: "phone", confidence: "high", subject: "third_party", masked: "+44 •••• ••• 789", id: "f-02" },
    { harm: "H6", kind: "phone", confidence: "low", subject: "third_party", masked: "0•••• •••111", id: "f-05" },
    { harm: "H2", kind: "date_of_birth", confidence: "medium", subject: "account_holder", masked: "14/0•/19••", id: "f-01" },
    { harm: "H4", kind: "phone", confidence: "medium", subject: "account_holder", masked: "+49 •••• ••• 123", id: "f-03" },
  ];
  assert.deepEqual(buildPieces(rows), [
    { kind: "date_of_birth", subject: "account_holder", count: 1, confidence: "medium", example: "14/0•/19••" },
    { kind: "phone", subject: "account_holder", count: 1, confidence: "medium", example: "+49 •••• ••• 123" },
    { kind: "phone", subject: "third_party", count: 2, confidence: "high", example: "+44 •••• ••• 789" },
  ]);
});

test("pieces add up to the band totals for every mock", () => {
  for (const name of fixture.files) {
    const r = fixture.reports[name];
    const fromPieces = r.pieces.reduce((n, p) => n + p.count, 0);
    const fromBands = ["H1", "H2", "H3", "H4", "H5", "H6"].reduce((n, h) => n + r.bands[h].unique, 0);
    assert.equal(fromPieces, fromBands, name);
  }
});
