import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchRecipe, pickStories, piecesFromReport, storyView, IMPACT_ORDER } from "../../web/lib/stories.js";
import { RECIPES as LIBRARY, KIND_NOUNS } from "../../web/lib/stories-data.js";

const p = (kind, subject = "account_holder", confidence = "high", example = `${kind}-ex`) => ({
  kind, subject, count: 1, confidence, example,
});

const piece = (label, kinds, extra = {}) => ({ label, kinds, who: "you", key: false, optional: false, ...extra });

function recipe(id, impact, pieces, about = "you") {
  return {
    id, title: `T ${id}`, scam: `S ${id}`, about, impact,
    howItGoes: `H ${id}`, fix: `F ${id}`, source: `Src ${id}`, pieces,
  };
}

const idsOf = (cards) => cards.map((c) => c.id);

test("low confidence never fills a piece", () => {
  const r = recipe("a", "Costly", [piece("Health", ["health"], { key: true })]);
  const m = matchRecipe(r, [p("health", "account_holder", "low")], 0);
  assert.equal(m.cards[0].state, "missing");
  assert.equal(m.cards[0].example, null);
  assert.equal(m.qualifies, false);
});

test("unknown subject fills a you-piece as looks-yours", () => {
  const r = recipe("a", "Costly", [piece("Email", ["email"], { key: true })]);
  const m = matchRecipe(r, [p("email", "unknown", "medium", "a***@x.com")], 0);
  assert.equal(m.cards[0].state, "looks-yours");
  assert.equal(m.cards[0].example, "a***@x.com");
  assert.equal(m.qualifies, true);
});

test("account_holder wins over unknown for the same kind", () => {
  const r = recipe("a", "Costly", [piece("Email", ["email"], { key: true })]);
  const m = matchRecipe(r, [p("email", "unknown", "confirmed", "U"), p("email", "account_holder", "medium", "A")], 0);
  assert.equal(m.cards[0].state, "yours");
  assert.equal(m.cards[0].example, "A");
});

test("ties break on confidence, then the order of the piece's kinds", () => {
  const r = recipe("a", "Costly", [piece("Secret", ["jwt", "api_token"], { key: true })]);
  const byConf = matchRecipe(r, [p("jwt", "account_holder", "medium", "J"), p("api_token", "account_holder", "high", "T")], 0);
  assert.equal(byConf.cards[0].example, "T");
  const byKind = matchRecipe(r, [p("jwt", "account_holder", "high", "J"), p("api_token", "account_holder", "high", "T")], 0);
  assert.equal(byKind.cards[0].example, "J");
});

test("third-party rows never fill a you-piece and you-rows never fill an others-piece", () => {
  const rows = [p("phone", "account_holder", "high", "MINE"), p("phone", "third_party", "high", "THEIRS")];
  const you = recipe("you", "Costly", [piece("Phone", ["phone"], { key: true })]);
  const others = recipe("others", "Costly", [piece("Phone", ["phone"], { key: true, who: "others" })], "others");
  const my = matchRecipe(you, rows, 0).cards[0];
  const their = matchRecipe(others, rows, 0).cards[0];
  assert.deepEqual([my.state, my.example], ["yours", "MINE"]);
  assert.deepEqual([their.state, their.example], ["others", "THEIRS"]);
  assert.equal(matchRecipe(you, [rows[1]], 0).cards[0].state, "missing");
  assert.equal(matchRecipe(others, [rows[0]], 0).cards[0].state, "missing");
});

test("who: any accepts every subject and always shows as others; who: others needs third_party", () => {
  const any = recipe("c", "Costly", [piece("Child", ["children"], { key: true, who: "any" })], "others");
  for (const subject of ["third_party", "account_holder"]) {
    assert.equal(matchRecipe(any, [p("children", subject)], 0).cards[0].state, "others");
  }
  const others = recipe("o", "Costly", [piece("Child", ["children"], { key: true, who: "others" })], "others");
  assert.equal(matchRecipe(others, [p("children", "account_holder")], 0).cards[0].state, "missing");
});

test("a story needs its key piece and half its counted pieces", () => {
  const mk = (n) => recipe("a", "Costly", [
    piece("K", ["health"], { key: true }), piece("B", ["email"]), piece("C", ["phone"]),
  ].slice(0, n));
  const rows = (...kinds) => kinds.map((k) => p(k));
  assert.equal(matchRecipe(mk(3), rows("health", "email"), 0).qualifies, true);
  assert.equal(matchRecipe(mk(3), rows("email", "phone"), 0).qualifies, false);
  assert.equal(matchRecipe(mk(3), rows("health"), 0).qualifies, false);
  assert.equal(matchRecipe(mk(1), rows("health"), 0).qualifies, true);
});

test("optional pieces show but do not count", () => {
  const r = recipe("a", "Costly", [
    piece("K", ["health"], { key: true }), piece("B", ["email"]), piece("Name", ["self_name"], { optional: true }),
  ]);
  const m = matchRecipe(r, [p("health"), p("self_name")], 0);
  assert.equal(m.cards[2].state, "yours");
  assert.equal(m.cards[2].optional, true);
  assert.equal(m.cards[0].key, true);
  assert.deepEqual([m.found, m.total], [1, 2]);
});

test("stories sort by impact, then completeness, then recipe order", () => {
  const k = (kinds) => kinds.map((kind, i) => piece(kind, [kind], { key: i === 0 }));
  const recipes = [
    recipe("hassle", "A hassle", k(["email"])),
    recipe("costly-half", "Costly", k(["email", "phone"])),
    recipe("costly-full-late", "Costly", k(["email"])),
    recipe("costly-full-early", "Costly", k(["email"])),
    recipe("hard", "Hard to undo", k(["email", "phone"])),
  ];
  const matches = recipes.map((r, i) => matchRecipe(r, [p("email")], i));
  const { shown, more } = pickStories(matches);
  assert.deepEqual(shown.map((m) => m.recipe.id), ["hard", "costly-full-late", "costly-full-early"]);
  assert.deepEqual(more.map((m) => m.recipe.id), ["costly-half", "hassle"]);
});

test("top three, with one place kept for a story about others", () => {
  const you = (id) => recipe(id, "Costly", [piece("E", ["email"], { key: true })]);
  const oth = recipe("oth", "A hassle", [piece("C", ["children"], { key: true, who: "others" })], "others");
  const recipes = [you("y1"), you("y2"), you("y3"), you("y4"), oth];
  const matches = recipes.map((r, i) => matchRecipe(r, [p("email"), p("children", "third_party")], i));
  const { shown, more, closest } = pickStories(matches);
  assert.deepEqual(shown.map((m) => m.recipe.id), ["y1", "y2", "oth"]);
  assert.deepEqual(more.map((m) => m.recipe.id), ["y3", "y4"]);
  assert.equal(closest, null);
});

test("an others story already in the top three is not moved", () => {
  const oth = recipe("oth", "Hard to undo", [piece("C", ["children"], { key: true, who: "others" })], "others");
  const you = (id) => recipe(id, "Costly", [piece("E", ["email"], { key: true })]);
  const rows = [p("email"), p("children", "third_party")];
  const matches = [you("y1"), oth, you("y2"), you("y3")].map((r, i) => matchRecipe(r, rows, i));
  const { shown, more } = pickStories(matches);
  assert.deepEqual(shown.map((m) => m.recipe.id), ["oth", "y1", "y2"]);
  assert.deepEqual(more.map((m) => m.recipe.id), ["y3"]);
});

test("closest is offered only when nothing qualifies, and is null when no piece is found at all", () => {
  const two = (id, impact) => recipe(id, impact, [
    piece("K", ["health"], { key: true }), piece("B", ["email"]), piece("C", ["phone"]), piece("D", ["place"]),
  ]);
  const recipes = [two("late", "A hassle"), two("early", "Costly"), two("far", "Costly")];
  const run = (rows) => pickStories(recipes.map((r, i) => matchRecipe(r, rows, i)));
  // email + phone found, no key: no story qualifies.
  const none = run([p("email"), p("phone")]);
  assert.equal(none.shown.length, 0);
  assert.equal(none.closest.recipe.id, "early");
  assert.equal(run([]).closest, null);
  assert.equal(run([p("health"), p("email")]).closest, null);
});

const RECIPES = [
  recipe("r1", "Hard to undo", [piece("Health", ["health"], { key: true })]),
  recipe("r2", "Costly", [piece("Email", ["email"], { key: true })]),
  recipe("r3", "Costly", [piece("Phone", ["phone"], { key: true })]),
];

test("headline, summary and also lines", () => {
  const none = storyView({ pieces: [] }, RECIPES);
  assert.equal(none.headline, "Not much to build with here.");
  assert.equal(none.summary, "Nothing in my file is enough for a common scam.");
  assert.equal(none.also, null);

  const one = storyView({ pieces: [p("health")] }, RECIPES);
  assert.equal(one.headline, "If this leaked, someone could try 1 thing.");
  assert.equal(one.summary, "Someone could try 1 thing with my file: 1 hard to undo.");

  const three = storyView({ pieces: [p("health"), p("email"), p("phone")] }, RECIPES);
  assert.equal(three.headline, "If this leaked, someone could try 3 things.");
  assert.equal(three.summary, "Someone could try 3 things with my file: 1 hard to undo, 2 costly.");
  assert.deepEqual(IMPACT_ORDER, ["Hard to undo", "Costly", "A hassle"]);
});

test("story cards carry recipe text and piece states", () => {
  const v = storyView({ pieces: [p("health", "account_holder", "high", "H*")] }, RECIPES);
  assert.deepEqual(Object.keys(v.shown[0]).sort(),
    ["about", "fix", "found", "howItGoes", "id", "impact", "pieces", "scam", "source", "title", "total"]);
  assert.equal(v.shown[0].id, "r1");
  assert.equal(v.shown[0].pieces[0].example, "H*");
  assert.equal(v.closest, null);
});

test("also line: unused kinds, summed across subjects, top 4, nouns or labels", () => {
  const rows = [
    p("health"),
    p("place", "account_holder", "low"), { ...p("place", "unknown", "low"), count: 3 },
    { ...p("org", "unknown", "low"), count: 2 },
    p("url"), p("age"), p("date"), p("date", "third_party"),
  ];
  const v = storyView({ pieces: rows }, RECIPES, { place: ["place", "places"], org: ["organisation", "organisations"], date: ["date", "dates"], age: ["age", "ages"] });
  // counts: place 4, org 2, date 2, age 1, url 1 -> top 4 by count then kind: place, date, org, age
  assert.equal(v.also, "Also in here: 4 places, 2 dates, 2 organisations and 1 age.");
});

test("also line: label fallback, singular, and kinds named by a shown recipe that filled nothing stay listed", () => {
  const rs = [recipe("r", "Costly", [piece("Health", ["health"], { key: true }), piece("Email", ["email"])])];
  const v = storyView({ pieces: [p("health"), p("email", "account_holder", "low"), p("age")] }, rs);
  // health used; email (low) filled nothing so it is still listed; age too.
  assert.equal(v.also, "Also in here: 1 age and 1 email.");
});

test("works from findings when report.pieces is missing", () => {
  const findings = [
    { id: "1", harm: "H3", kind: "health", confidence: "high", subject: "account_holder", masked: "h*" },
    { id: "2", harm: "H4", kind: "email", confidence: "medium", subject: "unknown", masked: "e*" },
  ];
  const withPieces = { findings, pieces: piecesFromReport({ findings }) };
  const without = { findings };
  assert.deepEqual(idsOf(storyView(without, RECIPES).shown), idsOf(storyView(withPieces, RECIPES).shown));
  assert.deepEqual(idsOf(storyView(without, RECIPES).shown), ["r1", "r2"]);
  assert.deepEqual(piecesFromReport({}), []);
});

test("a low-confidence-only file gets the calm result", () => {
  const v = storyView({ pieces: [p("health", "account_holder", "low"), p("place", "account_holder", "low")] }, RECIPES);
  assert.equal(v.headline, "Not much to build with here.");
  assert.equal(v.shown.length, 0);
  assert.equal(v.closest, null);
});

test("also line: only the kind that actually filled a multi-kind piece counts as used", () => {
  const rs = [recipe("r", "Costly", [piece("Secret", ["jwt", "api_token"], { key: true })])];
  const v = storyView({ pieces: [p("jwt"), p("api_token", "account_holder", "high")] }, rs);
  assert.equal(v.also, "Also in here: 1 api token.");
});

// The mock memories' stories, read against each file in samples/mock-memories (reviewed by Vivek).
// - chatgpt-saved-memories: birth date and personal email are Dana's. The IBAN is one she paid a charge to, not
//   her own; it shows as "looks like yours" (unknown subject), so direct-debit is a known over-read.
// - gemini-saved-info: Kofi's phone, birthday and email; "allergic to peanuts" is the health condition.
// - bot-answer: the bot lists Sam's birthday, emails and "your number".
// - clean-memory: preferences only; nothing to build with and nothing close.
// - chatgpt-export: Priya's phone, birthday and "flat 4B at 18 Elm Grove".
// - claude-export: Marcus's phone, birth date and salary IBAN. The file holds others' contacts (a referee's
//   email, the movers' phone), but the row that fills friends-message is his own email, tagged third_party.
// - chatgpt-export-large: "My number is …" only; no birth date or address, so sim-swap is just the closest.
const MOCK_STORIES = {
  "chatgpt-saved-memories.txt": { shown: ["bank-call", "direct-debit"], more: [], closest: null },
  "gemini-saved-info.txt": { shown: ["sim-swap", "fake-insurer", "bank-call"], more: [], closest: null },
  "bot-answer-what-do-you-remember.txt": { shown: ["sim-swap", "bank-call"], more: [], closest: null },
  "clean-memory.txt": { shown: [], more: [], closest: null },
  "chatgpt-export.zip": { shown: ["sim-swap", "bank-call", "doorstep"], more: [], closest: null },
  "claude-export.zip": { shown: ["sim-swap", "friends-message", "bank-call"], more: ["direct-debit"], closest: null },
  "chatgpt-export-large.zip": { shown: [], more: [], closest: "sim-swap" },
};

test("stories for the mock memories", () => {
  const fixture = JSON.parse(readFileSync(new URL("fixtures/stage1.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(fixture.reports).sort(), Object.keys(MOCK_STORIES).sort());
  for (const [name, report] of Object.entries(fixture.reports)) {
    const v = storyView(report, LIBRARY, KIND_NOUNS);
    const got = { shown: idsOf(v.shown), more: idsOf(v.more), closest: v.closest ? v.closest.id : null };
    assert.deepEqual(got, MOCK_STORIES[name], name);
  }
});
