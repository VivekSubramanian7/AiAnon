import { test } from "node:test";
import assert from "node:assert/strict";
import { RECIPES, KIND_NOUNS } from "../../web/lib/stories-data.js";
import { IMPACT_ORDER } from "../../web/lib/stories.js";
import { KIND_LABELS } from "../../web/lib/sensitivity.js";

const IDS = [
  "pasted-password",
  "card-online",
  "direct-debit",
  "open-accounts",
  "bank-call",
  "sim-swap",
  "immigration-call",
  "work-message",
  "doorstep",
  "fake-insurer",
  "hi-mum",
  "friends-message",
];

const BANNED = /\bwill\b|\bhackers?\b|\bcriminals?\b|\beverything\b|!/i;
const CAPS_ALLOWED = new Set(["SIM", "PIN", "IBAN", "SMS"]);

const words = (s) => s.trim().split(/\s+/).filter(Boolean);
const sentences = (s) => s.split(/(?<=[.?])\s+/).filter((x) => x.trim());
const texts = (r) => [r.title, r.howItGoes, ...r.fix];

test("twelve recipes with unique ids, in the spec's order", () => {
  assert.deepEqual(RECIPES.map((r) => r.id), IDS);
  assert.equal(new Set(RECIPES.map((r) => r.id)).size, 12);
});

test("every kind a recipe names exists", () => {
  for (const r of RECIPES) {
    for (const p of r.pieces) {
      assert.ok(p.kinds.length > 0, `${r.id}: ${p.label} has no kinds`);
      for (const k of p.kinds) assert.ok(k in KIND_LABELS, `${r.id}: unknown kind ${k}`);
    }
  }
});

test("every recipe has exactly one key piece, a fix, an impact and an official source", () => {
  for (const r of RECIPES) {
    assert.equal(r.pieces.filter((p) => p.key).length, 1, `${r.id}: key pieces`);
    assert.ok(!r.pieces.some((p) => p.key && p.optional), `${r.id}: key piece is optional`);
    assert.ok(IMPACT_ORDER.includes(r.impact), `${r.id}: impact ${r.impact}`);
    assert.ok(Array.isArray(r.fix) && r.fix.length >= 1 && r.fix.length <= 2, `${r.id}: fix`);
    for (const f of r.fix) assert.ok(typeof f === "string" && f.trim(), `${r.id}: empty fix`);
    assert.ok(["you", "others"].includes(r.about), `${r.id}: about ${r.about}`);
    for (const field of ["title", "scam", "howItGoes"]) {
      assert.ok(typeof r[field] === "string" && r[field].trim(), `${r.id}: ${field}`);
    }
    assert.ok(r.source && typeof r.source.name === "string" && r.source.name.trim(), `${r.id}: source.name`);
    assert.ok(typeof r.source.url === "string" && r.source.url.startsWith("https://"), `${r.id}: source.url`);
  }
});

test("your name is always optional", () => {
  for (const r of RECIPES) {
    for (const p of r.pieces) {
      if (p.kinds.length === 1 && p.kinds[0] === "self_name") {
        assert.equal(p.optional, true, `${r.id}: ${p.label}`);
      }
      if (p.kinds.includes("self_name")) assert.deepEqual(p.kinds, ["self_name"], `${r.id}: self_name mixed`);
    }
  }
});

test("who is you, others or any; any only for children", () => {
  for (const r of RECIPES) {
    for (const p of r.pieces) {
      assert.ok(["you", "others", "any"].includes(p.who), `${r.id}: ${p.label} who ${p.who}`);
      if (p.who === "any") assert.deepEqual(p.kinds, ["children"], `${r.id}: ${p.label}`);
    }
  }
});

test("writing rules", () => {
  for (const r of RECIPES) {
    assert.ok(words(r.title).length <= 8, `${r.id}: title too long`);
    const n = sentences(r.howItGoes).length;
    assert.ok(n >= 2 && n <= 3, `${r.id}: howItGoes has ${n} sentences`);
    assert.ok(words(r.howItGoes).length <= 50, `${r.id}: howItGoes has ${words(r.howItGoes).length} words`);
    for (const t of texts(r)) {
      assert.doesNotMatch(t, BANNED, `${r.id}: banned word in "${t}"`);
      for (const w of t.match(/\b[A-Z]{3,}\b/g) ?? []) {
        assert.ok(CAPS_ALLOWED.has(w), `${r.id}: all-caps "${w}"`);
      }
    }
  }
});

test("KIND_NOUNS covers every kind in KIND_LABELS", () => {
  for (const kind of Object.keys(KIND_LABELS)) {
    const nouns = KIND_NOUNS[kind];
    assert.ok(Array.isArray(nouns) && nouns.length === 2, `${kind}: missing`);
    for (const n of nouns) {
      assert.ok(typeof n === "string" && n.trim(), `${kind}: empty noun`);
      assert.equal(n, n.toLowerCase(), `${kind}: "${n}" not lower-case`);
    }
  }
});
