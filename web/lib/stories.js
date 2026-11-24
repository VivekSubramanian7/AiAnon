// Scam stories: match recipes against a scan's pieces and build the view model. Pure; no DOM.

import { buildPieces, KIND_LABELS } from "./sensitivity.js";

export const IMPACT_ORDER = ["Hard to undo", "Costly", "A hassle"];

const IMPACT_RANK = Object.fromEntries(IMPACT_ORDER.map((impact, i) => [impact, i]));
const CONFIDENCE_RANK = { confirmed: 0, high: 1, medium: 2 };
const SUBJECT_RANK = { account_holder: 0, unknown: 1 };
const SHOWN_LIMIT = 3;
const ALSO_LIMIT = 4;
// "Someone could try 4 things with my file: 1 hard to undo, 2 costly and 1 that's a hassle."
const SUMMARY_PHRASE = {
  "Hard to undo": () => "hard to undo",
  Costly: () => "costly",
  "A hassle": (n) => (n === 1 ? "that's a hassle" : "that are a hassle"),
};

export function piecesFromReport(report) {
  return Array.isArray(report?.pieces) ? report.pieces : buildPieces(report?.findings ?? []);
}

/** Does this row fill the piece, and as what? Returns a state or null. */
function stateFor(row, piece) {
  if (!piece.kinds.includes(row.kind)) return null;
  if (CONFIDENCE_RANK[row.confidence] === undefined) return null;
  // Card, IBAN and ID numbers: only the account holder's own row (a payee's IBAN is not yours).
  if (piece.yoursOnly) return row.subject === "account_holder" ? "yours" : null;
  // A child the visitor mentions ("my son"): their own or unknown rows, never someone else's child.
  if (piece.who === "family") {
    return row.subject === "account_holder" || row.subject === "unknown" ? "others" : null;
  }
  if (piece.who === "others") return row.subject === "third_party" ? "others" : null;
  if (row.subject === "account_holder") return "yours";
  return row.subject === "unknown" ? "looks-yours" : null;
}

function isBefore(a, b) {
  const i = a.findIndex((v, j) => v !== b[j]);
  return i !== -1 && a[i] < b[i];
}

function fillPiece(piece, pieces) {
  let best = null;
  let bestRank = null;
  for (const row of pieces) {
    const state = stateFor(row, piece);
    if (!state) continue;
    const rank = [
      SUBJECT_RANK[row.subject] ?? 2,
      CONFIDENCE_RANK[row.confidence],
      piece.kinds.indexOf(row.kind),
    ];
    if (!best || isBefore(rank, bestRank)) {
      best = { row, state };
      bestRank = rank;
    }
  }
  return {
    kind: best ? best.row.kind : null,
    card: {
      label: piece.label,
      state: best ? best.state : "missing",
      example: best ? best.row.example ?? null : null,
      key: Boolean(piece.key),
      optional: Boolean(piece.optional),
    },
  };
}

export function matchRecipe(recipe, pieces, index = 0) {
  const fills = recipe.pieces.map((piece) => fillPiece(piece, pieces));
  const cards = fills.map((f) => f.card);
  const usedKinds = fills.map((f) => f.kind).filter(Boolean);
  const counted = cards.filter((c) => !c.optional);
  const found = counted.filter((c) => c.state !== "missing").length;
  const total = counted.length;
  const keyFound = cards.some((c) => c.key && c.state !== "missing");
  return { recipe, index, cards, usedKinds, found, total, qualifies: keyFound && found * 2 >= total };
}

const share = (m) => (m.total ? m.found / m.total : 0);

function byRank(a, b) {
  return (
    (IMPACT_RANK[a.recipe.impact] ?? 99) - (IMPACT_RANK[b.recipe.impact] ?? 99) ||
    share(b) - share(a) ||
    a.index - b.index
  );
}

export function pickStories(matches) {
  const qualifying = matches.filter((m) => m.qualifies).sort(byRank);
  const shown = qualifying.slice(0, SHOWN_LIMIT);
  let more = qualifying.slice(SHOWN_LIMIT);

  if (!shown.some((m) => m.recipe.about === "others")) {
    const others = more.find((m) => m.recipe.about === "others");
    if (others) {
      const displaced = shown[SHOWN_LIMIT - 1];
      shown[SHOWN_LIMIT - 1] = others;
      more = [displaced, ...more.filter((m) => m !== others)];
    }
  }

  let closest = null;
  if (!shown.length) {
    const best = [...matches].sort(
      (a, b) =>
        b.found - a.found ||
        (IMPACT_RANK[a.recipe.impact] ?? 99) - (IMPACT_RANK[b.recipe.impact] ?? 99) ||
        a.index - b.index,
    )[0];
    closest = best && best.found > 0 ? best : null;
  }
  return { shown, more, closest };
}

function toCard(match) {
  const { recipe } = match;
  return {
    id: recipe.id,
    title: recipe.title,
    scam: recipe.scam,
    about: recipe.about,
    impact: recipe.impact,
    howItGoes: recipe.howItGoes,
    fix: recipe.fix,
    source: recipe.source,
    // Optional pieces show only when found; a missing one is not something they would need.
    pieces: match.cards.filter((c) => !(c.optional && c.state === "missing")),
    found: match.found,
    total: match.total,
  };
}

function joinList(items) {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "Government ID number" -> "government ID number"; leaves "IBAN …" alone. */
function lowerFirst(label) {
  return label.length > 1 && label[1] === label[1].toLowerCase() ? label[0].toLowerCase() + label.slice(1) : label;
}

/**
 * The closest card under the calm headline: no impact label and no "How it goes", so it never reads as a full
 * story. It names the counted pieces still missing instead.
 */
function toClosestCard(match) {
  const { impact, howItGoes, ...card } = toCard(match);
  const missing = match.cards.filter((c) => !c.optional && c.state === "missing").map((c) => lowerFirst(c.label));
  return { ...card, stillNeed: missing.length ? `They would still need: ${joinList(missing)}.` : null };
}

function alsoLine(pieces, matches, nouns) {
  const used = new Set();
  for (const match of matches) for (const kind of match.usedKinds) used.add(kind);
  const counts = new Map();
  for (const row of pieces) {
    if (!used.has(row.kind)) counts.set(row.kind, (counts.get(row.kind) ?? 0) + row.count);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, ALSO_LIMIT);
  if (!top.length) return null;
  const phrases = top.map(([kind, count]) => {
    const fallback = (KIND_LABELS[kind] ?? kind).toLowerCase();
    const [singular, plural] = nouns[kind] ?? [fallback, fallback];
    return `${count} ${count === 1 ? singular : plural}`;
  });
  return `Also in here: ${joinList(phrases)}.`;
}

export function storyView(report, recipes, nouns = {}) {
  const pieces = piecesFromReport(report);
  const matches = recipes.map((recipe, i) => matchRecipe(recipe, pieces, i));
  const { shown, more, closest } = pickStories(matches);
  const n = shown.length + more.length;
  const things = `${n} ${n === 1 ? "thing" : "things"}`;

  let summary = "Nothing in my file is enough for a common scam.";
  if (n) {
    const counts = IMPACT_ORDER.map((impact) => [
      impact,
      [...shown, ...more].filter((m) => m.recipe.impact === impact).length,
    ]);
    const parts = counts.filter(([, c]) => c).map(([impact, c]) => `${c} ${SUMMARY_PHRASE[impact](c)}`);
    summary = `Someone could try ${things} with my file: ${joinList(parts)}.`;
  }

  return {
    headline: n ? `If this leaked, someone could try ${things}.` : "Not much to build with here.",
    shown: shown.map(toCard),
    more: more.map(toCard),
    closest: closest ? toClosestCard(closest) : null,
    // Kinds that filled any card on the page (shown, behind "more", or the closest) are not repeated here.
    also: alsoLine(pieces, [...shown, ...more, ...(closest ? [closest] : [])], nouns),
    summary,
  };
}
