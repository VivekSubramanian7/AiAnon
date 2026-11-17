// Full quick-frisk reports (extract -> patterns -> rules -> report) must equal the Python pipeline's.
// Regenerate fixtures with: .venv/bin/python scripts/web_fixtures_scan.py
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRules } from "../../web/lib/rules.js";
import { extractFile, bytesSource } from "../../web/lib/extract.js";
import { scan, buildChunks, splitLinesKeepEnds } from "../../web/lib/scan.js";
import { mask, exposureScore, levelFor } from "../../web/lib/report.js";

const root = new URL("../../", import.meta.url);
const lists = JSON.parse(readFileSync(new URL("web/data/lists.json", root), "utf8"));
const fixture = JSON.parse(readFileSync(new URL("tests/web/fixtures/stage1.json", root), "utf8"));
const findEntities = createRules(lists);

for (const name of fixture.files) {
  test(`quick frisk report for ${name} equals Python`, async () => {
    const bytes = new Uint8Array(readFileSync(new URL(`samples/mock-memories/${name}`, root)));
    const extracted = await extractFile(bytesSource(name, bytes));
    const { report } = await scan(extracted, findEntities);
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

test("masks, score and levels", () => {
  assert.equal(mask("names", "Sam Miller"), "S•• M•••••");
  assert.equal(mask("emails", "dana.whitfield@example.com"), "d•••.•••••••••@e••••••.com");
  assert.equal(mask("phones", "+44 7700 900123"), "+•• •••• ••••23");
  assert.equal(mask("links", "https://example.com/a/b"), "example.com/•••");
  assert.equal(mask("ages", "36 years old"), "30s");
  assert.equal(exposureScore(0, 0), 0);
  assert.equal(levelFor(exposureScore(6, 4)), "oversharer");
});
