// The quick-frisk rules (web/lib/rules.js) must match the Python reference (scripts/web_reference_rules.py).
// Regenerate fixtures with: .venv/bin/python scripts/web_fixtures_scan.py
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRules } from "../../web/lib/rules.js";

const root = new URL("../../", import.meta.url);
const lists = JSON.parse(readFileSync(new URL("web/data/lists.json", root), "utf8"));
const { cases } = JSON.parse(readFileSync(new URL("tests/web/fixtures/rules.json", root), "utf8"));
const findEntities = createRules(lists);

test("rules match the Python reference on every text", () => {
  const mismatches = [];
  for (const { text, entities } of cases) {
    const got = findEntities(text);
    try {
      assert.deepEqual(got, entities);
    } catch {
      mismatches.push({ text: text.slice(0, 120), expected: entities.map((e) => `${e.type}:${e.text}`), got: got.map((e) => `${e.type}:${e.text}`) });
    }
  }
  assert.equal(mismatches.length, 0, JSON.stringify(mismatches.slice(0, 5), null, 1));
});

test("ordinary sentence starts and common words are not people", () => {
  assert.deepEqual(findEntities("Will you check this? Reading is fun. Grace period ends in March."), []);
});
