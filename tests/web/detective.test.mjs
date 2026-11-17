// The detective's word splitting and grouping (no model needed). The model itself is tested in the browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bertWords, groupWords } from "../../web/lib/detective.js";

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
