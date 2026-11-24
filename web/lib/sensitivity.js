// Port of lib/scanner/findings.py — sort, cap, bands, promotion, subject, readouts, coverage.

import { assignDomains } from "./domains.js";
import { Aggregator, mask, maskKind, normalize } from "./report.js";

export const FINDING_KEYS = [
  "id", "harm", "kind", "label", "confidence", "subject", "masked",
  "category", "source", "inCodeBlock", "count", "domains",
];

export const HARM_ORDER = ["H1", "H2", "H3", "H4", "H5", "H6"];
const HARM_RANK = Object.fromEntries(HARM_ORDER.map((h, i) => [h, i]));

const CONFIDENCE_RANK = { confirmed: 0, high: 1, medium: 2, low: 3 };
const SUBJECT_ORDER = { account_holder: 0, unknown: 1, third_party: 2, not_applicable: 3 };

export const KIND_LABELS = {
  aws_access_key: "AWS access key",
  private_key: "Private key",
  api_token: "API token",
  jwt: "JWT",
  password_cue: "Password",
  tokenized_url: "Signed URL",
  payment_card: "Payment card",
  national_id: "Government ID",
  health: "Health",
  religion: "Religion",
  sexual_orientation: "Sexual orientation",
  children: "Children",
  immigration: "Immigration",
  street_address: "Street address",
  gps: "GPS coordinates",
  profile_url: "Profile URL",
  os_username: "Computer username",
  employer: "Employer",
  compensation: "Compensation",
  date_of_birth: "Date of birth",
  iban: "IBAN",
  email: "Email",
  phone: "Phone number",
  handle: "Social handle",
  url: "URL",
  name: "Name",
  self_name: "Your name",
  child_name: "Child's name",
  place: "Place",
  org: "Organisation",
  age: "Age",
  date: "Date",
  account_email: "Account email",
  account_phone: "Account phone",
};

// "My name is X", "Name is X" (saved-memory style), "I am X", "I'm X", "call me X": the cue ends right before X.
const SELF_NAME_RE = /(?:\bmy name is|(?<![A-Za-z'’] )\bname is|\bI am|\bI'm|\bcall me)\s*[:,]?\s*$/i;
const THIRD_PARTY_RE =
  /\b(?:his|her|their|colleague's|friend's)\b|\bmy (?:colleague|friend|boss|manager|client)\b/i;
const SELF_CUE_RE = /\b(?:I|I'm|I've|my|me|mine)\b/i;
const SELF_NEGATIVE_RE =
  /\bmy (?:colleague|friend|boss|manager|client|son|daughter|kid|mom|dad|wife|husband|partner)\b/i;
const H1_KINDS = new Set(["private_key", "aws_access_key", "api_token", "jwt", "password_cue", "tokenized_url"]);

function sortKey(row) {
  return [
    HARM_RANK[row.harm] ?? 99,
    CONFIDENCE_RANK[row.confidence] ?? 99,
    SUBJECT_ORDER[row.subject] ?? 99,
    row.kind ?? "",
    row.id ?? "",
  ];
}

export function sortFindings(rows) {
  return [...rows].sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    return 0;
  });
}

/** H6 cap: names/orgs/URLs first — not only decade ages (medium confidence sorts above name). */
const H6_CAP_KIND_PRIORITY = ["name", "org", "url", "place", "phone", "date", "age"];

function capBandRows(bandRows, perBand, harm) {
  if (!bandRows.length) return [];
  if (harm !== "H6") return sortFindings(bandRows).slice(0, perBand);

  const byKind = new Map();
  for (const row of bandRows) {
    const k = row.kind ?? "";
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k).push(row);
  }
  for (const [k, list] of byKind) byKind.set(k, sortFindings(list));

  const kindOrder = H6_CAP_KIND_PRIORITY.filter((k) => byKind.has(k));
  for (const k of [...byKind.keys()].sort()) {
    if (!kindOrder.includes(k)) kindOrder.push(k);
  }

  const out = [];
  while (out.length < perBand) {
    let progressed = false;
    for (const kind of kindOrder) {
      const pool = byKind.get(kind);
      if (!pool?.length) continue;
      out.push(pool.shift());
      progressed = true;
      if (out.length >= perBand) break;
    }
    if (!progressed) break;
  }
  return out;
}

export function capFindings(rows, perBand = 12) {
  const byHarm = new Map(HARM_ORDER.map((h) => [h, []]));
  for (const row of rows) byHarm.get(row.harm)?.push(row);
  const out = [];
  for (const harm of HARM_ORDER) {
    out.push(...capBandRows(byHarm.get(harm) ?? [], perBand, harm));
  }
  return sortFindings(out);
}

export function bandCounts(rows) {
  const result = {};
  for (const harm of HARM_ORDER) {
    const bandRows = rows.filter((r) => r.harm === harm);
    const byConf = {};
    const bySub = {};
    for (const r of bandRows) {
      byConf[r.confidence] = (byConf[r.confidence] ?? 0) + 1;
      bySub[r.subject] = (bySub[r.subject] ?? 0) + 1;
    }
    result[harm] = { unique: bandRows.length, byConfidence: byConf, bySubject: bySub };
  }
  return result;
}

export function buildPieces(findings) {
  const groups = new Map();
  for (const row of sortFindings(findings)) {
    const key = JSON.stringify([row.kind, row.subject]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const pieces = [...groups.values()].map((rows) => ({
    kind: rows[0].kind,
    subject: rows[0].subject,
    count: rows.length,
    confidence: rows.map((r) => r.confidence).reduce((a, b) => ((CONFIDENCE_RANK[a] ?? 99) <= (CONFIDENCE_RANK[b] ?? 99) ? a : b)),
    example: rows[0].masked,
  }));
  return pieces.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return (SUBJECT_ORDER[a.subject] ?? 99) - (SUBJECT_ORDER[b.subject] ?? 99);
  });
}

// Another person's name stays "unknown" next to "I" or "my" ("I met Tom" is not about Tom being you).
const NOT_SELF_KINDS = new Set(["name"]);

export function classifySubject(window, { kind }) {
  if (H1_KINDS.has(kind) && !window.trim()) return "account_holder";
  if (kind === "self_name") return "account_holder";
  if (kind === "child_name") return "third_party";
  if (THIRD_PARTY_RE.test(window) || SELF_NEGATIVE_RE.test(window)) return "third_party";
  if (NOT_SELF_KINDS.has(kind)) return "unknown";
  if (SELF_CUE_RE.test(window)) return "account_holder";
  if (H1_KINDS.has(kind)) return "account_holder";
  return "unknown";
}

function phoneHarmAndConf(maxConf) {
  return { harm: maxConf >= 1.0 ? "H4" : "H6", confidence: maxConf >= 1.0 ? "high" : "low" };
}

function promoteOne(cat, original, window, maxConf) {
  if (cat === "birthdays") return { harm: "H2", kind: "date_of_birth", confidence: "medium" };
  if (cat === "bank") return { harm: "H2", kind: "iban", confidence: "high" };
  if (cat === "emails") return { harm: "H4", kind: "email", confidence: "medium" };
  if (cat === "phones") {
    const { harm, confidence } = phoneHarmAndConf(maxConf);
    return { harm, kind: "phone", confidence };
  }
  if (cat === "handles") return { harm: "H4", kind: "handle", confidence: "medium" };
  if (cat === "links") return { harm: "H6", kind: "url", confidence: "medium" };
  if (cat === "names") {
    if (SELF_NAME_RE.test(window)) return { harm: "H4", kind: "self_name", confidence: "medium" };
    return { harm: "H6", kind: "name", confidence: "low" };
  }
  if (cat === "places") return { harm: "H6", kind: "place", confidence: "low" };
  if (cat === "orgs") return { harm: "H6", kind: "org", confidence: "low" };
  if (cat === "ages") return { harm: "H6", kind: "age", confidence: "medium" };
  if (cat === "dates") return { harm: "H6", kind: "date", confidence: "medium" };
  return null;
}

export function promote(aggregator) {
  const rows = [];
  for (const c of aggregator.distinct.keys()) {
    const counts = aggregator.distinct.get(c);
    for (const [normKey, count] of counts) {
      const original = aggregator.firstSeen.get(c).get(normKey);
      const window = aggregator.cueWindow.get(c)?.get(normKey) ?? "";
      const maxConf = aggregator.maxConfidence.get(c)?.get(normKey) ?? 1.0;
      const promoted = promoteOne(c, original, window, maxConf);
      if (!promoted) continue;
      const { harm, kind, confidence } = promoted;
      rows.push({
        harm,
        kind,
        label: KIND_LABELS[kind] ?? kind.replaceAll("_", " ").replace(/\b\w/g, (ch) => ch.toUpperCase()),
        confidence,
        subject: "unknown",
        masked: kind === "self_name" ? mask("names", original) : mask(c, original),
        category: c,
        source: "promoted",
        inCodeBlock: false,
        count,
        _norm: [c, normKey],
        _window: window, // text before the value only: "My Chemical Romance" is not about you
        _original: original,
      });
    }
  }
  return rows;
}

function dedupeKeepHigherHarm(rows) {
  const byNorm = new Map();
  const out = [];
  const sorted = [...rows].sort((a, b) => (HARM_RANK[a.harm] ?? 99) - (HARM_RANK[b.harm] ?? 99));
  for (const row of sorted) {
    const norm = row._norm;
    const key = norm ? `${norm[0]}:${norm[1]}` : `${row.kind}:${row.masked ?? ""}`;
    const existing = byNorm.get(key);
    if (existing && (HARM_RANK[existing.harm] ?? 99) <= (HARM_RANK[row.harm] ?? 99)) continue;
    if (existing) {
      const idx = out.indexOf(existing);
      if (idx >= 0) out.splice(idx, 1);
    }
    byNorm.set(key, row);
    out.push(row);
  }
  return out;
}

function applySubject(rows) {
  for (const row of rows) {
    if (row.source === "envelope") {
      row.subject = "account_holder";
      row.confidence = "confirmed";
      continue;
    }
    const window = row._window ?? "";
    delete row._window;
    if (!row.subject || row.subject === "unknown") row.subject = classifySubject(window, { kind: row.kind });
  }
}

export function assemble(promoted, hits, envelopeFindings = null) {
  const rows = promoted.map((r) => ({ ...r }));
  for (const h of hits) {
    const kind = h.kind;
    rows.push({
      harm: h.harm,
      kind,
      label: KIND_LABELS[kind] ?? kind.replaceAll("_", " ").replace(/\b\w/g, (ch) => ch.toUpperCase()),
      confidence: h.confidence,
      subject: "unknown",
      masked: maskKind(kind, h.value),
      category: null,
      source: "detector",
      inCodeBlock: h.in_code_block ?? false,
      count: 1,
      _norm: [kind, normalize(kind, h.value)],
      _window: h.window ?? "",
    });
  }
  if (envelopeFindings) {
    for (const ef of envelopeFindings) rows.push({ ...ef, source: "envelope" });
  }
  let merged = dedupeKeepHigherHarm(rows);
  applySubject(merged);
  for (const row of merged) {
    delete row._norm;
    delete row._original;
    row.domains = assignDomains(row.kind ?? "");
  }
  merged = sortFindings(merged);
  for (let i = 0; i < merged.length; i++) merged[i].id = `f-${String(i + 1).padStart(2, "0")}`;
  return merged;
}

const CONF_MULT = { confirmed: 1.0, high: 1.0, medium: 0.55, low: 0.15 };
const BASE_POINTS = {
  private_key: 40, aws_access_key: 40, api_token: 40, password_cue: 40, tokenized_url: 40, jwt: 8,
  health: 22, religion: 22, sexual_orientation: 22, children: 22, immigration: 22, street_address: 22, gps: 22,
  email: 16, phone: 16, handle: 16, profile_url: 16, os_username: 16, self_name: 16,
  account_email: 30, account_phone: 30,
};

function meterScore(points, scale) {
  return Math.min(100, Math.round(100 * (1 - Math.exp(-points / scale))));
}

function bestConfidence(confs, defaultConf = "low") {
  if (!confs.length) return defaultConf;
  return confs.reduce((a, b) => (CONFIDENCE_RANK[a] < CONFIDENCE_RANK[b] ? a : b));
}

export function buildReadouts(findings, legacyScore, legacyLevel, lowerBound) {
  let credPoints = 0;
  const h1Confs = [];
  let hasNonJwtHigh = false;
  let intimatePoints = 0;
  const h3Confs = [];
  let bridgePoints = 0;
  const bridgeConfs = [];
  let aboutYou = 0;
  let aboutOthers = 0;
  const credDrivers = {};
  const intimateDrivers = {};

  for (const f of findings) {
    if (f.harm === "H4") {
      if (f.subject === "account_holder") aboutYou += 1;
      else if (f.subject === "third_party") aboutOthers += 1;
    }
    if (f.harm === "H2" && (f.kind === "account_email" || f.kind === "account_phone")) aboutYou += 1;
  }

  const seen = new Set();
  for (const f of findings) {
    const { kind, confidence: conf, harm, subject: subj } = f;
    const mult = CONF_MULT[conf] ?? 0.15;
    const base = BASE_POINTS[kind] ?? 0;
    const uid = `${harm}:${kind}:${f.masked}:${harm === "H4" ? subj : ""}`;
    if (seen.has(uid)) continue;
    seen.add(uid);

    if (harm === "H1") {
      credDrivers[kind] = (credDrivers[kind] ?? 0) + 1;
      credPoints += base * mult;
      h1Confs.push(conf);
      if (kind !== "jwt" && (conf === "confirmed" || conf === "high")) hasNonJwtHigh = true;
    }
    if (harm === "H3") {
      intimateDrivers[kind] = (intimateDrivers[kind] ?? 0) + 1;
      intimatePoints += base * mult;
      h3Confs.push(conf);
    }
    if (harm === "H4" && subj === "account_holder") {
      bridgePoints += base * mult;
      bridgeConfs.push(conf);
    }
    if (harm === "H2" && (kind === "account_email" || kind === "account_phone")) {
      bridgePoints += BASE_POINTS[kind] * mult;
      bridgeConfs.push("confirmed");
    }
  }

  let credScore = meterScore(credPoints, 28);
  let credConf;
  if (hasNonJwtHigh) {
    credScore = Math.max(credScore, 80);
    credConf = "high";
  } else credConf = bestConfidence(h1Confs);

  let intimateScore = meterScore(intimatePoints, 36);
  const h3Only = findings.filter((f) => f.harm === "H3");
  const allH3Low = h3Only.length > 0 && h3Only.every((f) => f.confidence === "low");
  if (allH3Low) intimateScore = Math.min(intimateScore, 35);
  const intimateConf = allH3Low && h3Only.length ? "low" : bestConfidence(h3Confs, "low");

  const bridgeScore = meterScore(bridgePoints, 24);
  const bridgeConf = bestConfidence(bridgeConfs);

  return {
    credentials: {
      harmBand: "H1",
      score: credScore,
      confidence: credConf,
      lowerBound,
      drivers: {
        private_key: credDrivers.private_key ?? 0,
        aws_access_key: credDrivers.aws_access_key ?? 0,
        api_token: credDrivers.api_token ?? 0,
        jwt: credDrivers.jwt ?? 0,
        password_cue: credDrivers.password_cue ?? 0,
        tokenized_url: credDrivers.tokenized_url ?? 0,
      },
    },
    intimateSafety: {
      harmBand: "H3",
      score: intimateScore,
      confidence: intimateConf,
      lowerBound,
      note: "Keyword and pattern hits. Not a diagnosis.",
      drivers: {
        health: intimateDrivers.health ?? 0,
        religion: intimateDrivers.religion ?? 0,
        sexual_orientation: intimateDrivers.sexual_orientation ?? 0,
        children: intimateDrivers.children ?? 0,
        precise_location: (intimateDrivers.street_address ?? 0) + (intimateDrivers.gps ?? 0),
        immigration: intimateDrivers.immigration ?? 0,
      },
    },
    identityBridges: {
      harmBand: "H4",
      score: bridgeScore,
      confidence: bridgeConf,
      lowerBound,
      aboutYou,
      aboutOthers,
      note: "Account-holder bridges only. Name-bag and unvalidated phones are corpus volume.",
    },
    corpusVolume: {
      harmBand: "H6",
      score: legacyScore,
      confidence: "low",
      lowerBound,
      legacyLevel: legacyLevel,
    },
  };
}

export function buildCoverage(source, envelope = {}) {
  const truncated = Boolean(source.truncated);
  const charsScanned = Number(source.charactersScanned ?? 0);
  const charsSkipped = Number(source.charactersSkipped ?? 0);
  const codeBlocks = Number(source.codeBlocksSkipped ?? 0);
  const assistant = Number(source.assistantMessagesSkipped ?? 0);
  const userPresent = envelope.userJsonPresent;
  const userSkipped = envelope.userJsonSkipped;
  const binaries = envelope.binaryAttachments;
  const unread = envelope.unreadMembers ?? [];

  const lower =
    truncated ||
    charsSkipped > 0 ||
    codeBlocks > 0 ||
    assistant > 0 ||
    (binaries ?? 0) > 0 ||
    (userPresent === true && userSkipped === true) ||
    unread.length > 0;

  return {
    truncated,
    charactersScanned: charsScanned,
    charactersSkipped: charsSkipped,
    truncationNote: truncated ? "Scanner stopped at 5M characters." : null,
    codeBlocksSkipped: codeBlocks,
    assistantMessagesSkipped: assistant,
    userJsonPresent: userPresent,
    userJsonSkipped: userSkipped,
    binaryAttachments: binaries,
    unreadMembers: unread,
    lowerBound: lower,
  };
}
