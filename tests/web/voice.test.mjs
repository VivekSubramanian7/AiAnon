// Memories written to the user are read as the account holder's own words. Port of tests/test_voice.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoriesInSecondPerson, readInFirstPerson, toFirstPerson } from "../../web/lib/voice.js";
import { extractText } from "../../web/lib/extract.js";
import { detect } from "../../web/lib/detectors.js";
import { assemble } from "../../web/lib/sensitivity.js";

test("you and your become I and my", () => {
  assert.equal(toFirstPerson("Your name is Jo Bloggs."), "My name is Jo Bloggs.");
  assert.equal(toFirstPerson("You're married to Sam. Your daughter is Mia."), "I'm married to Sam. My daughter is Mia.");
  assert.equal(toFirstPerson("You’ve asked about your own anxiety"), "I've asked about my own anxiety");
  assert.equal(
    toFirstPerson("you are 29, you were born in Leeds and the flat is yours"),
    "I am 29, I was born in Leeds and the flat is mine",
  );
  assert.equal(toFirstPerson("You'd asked yourself; you'll see"), "I'd asked myself; I'll see");
  assert.equal(toFirstPerson("YouTube, young people and yourselves"), "YouTube, young people and yourselves");
});

test("only memories mostly written to the user are second person", () => {
  const seg = (text, source = "memory") => ({ text, source });
  assert.ok(memoriesInSecondPerson([seg("Your name is Jo."), seg("You live in Leeds.")]));
  assert.ok(!memoriesInSecondPerson([seg("My name is Kofi."), seg("I live in Accra."), seg("Your name is Ava.")]));
  assert.ok(!memoriesInSecondPerson([seg("Prefers short answers.")]));
  assert.ok(!memoriesInSecondPerson([seg("Your answer was wrong. Your name is Ava.", "message")]));
});

test("messages to the bot and first-person memories are never rewritten", () => {
  const segments = [
    { text: "Your name is Jo.", source: "memory" },
    { text: "Your answer was wrong, your name is Ava now", source: "message" },
  ];
  assert.deepEqual(readInFirstPerson(segments.map((s) => s.text), segments), [
    "My name is Jo.",
    "Your answer was wrong, your name is Ava now",
  ]);
  const first = extractText("I'm vegetarian.\nMy name is Kofi.\nI live in Accra.\nYour name is Ava.");
  const texts = first.segments.map((s) => s.text);
  assert.deepEqual(readInFirstPerson(texts, first.segments), texts);
});

test("a second-person summary reads like the first person", () => {
  const summary = toFirstPerson(
    "You're married to Sam, and your daughter is Mia. You've asked about your own anxiety. "
      + "Your Niederlassungserlaubnis came through in March.",
  );
  const rows = Object.fromEntries(assemble([], detect(summary)).map((r) => [`${r.kind}/${r.subject}`, r.confidence]));
  assert.equal(rows["children/account_holder"], "medium");
  assert.equal(rows["health/account_holder"], "medium");
  assert.equal(rows["immigration/account_holder"], "medium");
});
