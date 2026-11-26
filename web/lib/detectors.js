// Port of lib/scanner/detectors.py — pure gap detectors (hits only, never API output).

import { DATE_LIKE_RE } from "./report.js";

// Closed fences, or an unclosed one running to the end of the text (as scan.js blanks it).
export const CODE_BLOCK_RE = /```([\s\S]*?)(?:```|$(?![\s\S]))/g;

const PRIVATE_KEY_RE = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const AWS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/;
const API_TOKEN_RE =
  /\b(?:sk-(?:proj-|svcacct-|admin-|ant-[a-z]+\d*-)?[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/;
// "password: x", "password = x" or "my password is x"; word-bounded so "Topspin:" is not a cue.
const PASSWORD_CUE_RE = /\b(?:password|passcode|pin|recovery code)\b(\s+is\b\s*:?|\s*[:=])\s*(\S{6,})/i;
// A signing or token query parameter with a long value; a bare "reset" or "presets" in a path is not one.
const TOKEN_URL_RE =
  /https?:\/\/[^\s?#]+\?[^\s]*?\b(?:X-Amz-Signature|X-Goog-Signature|sig|signature|token|access_token|reset_token|code)=[^\s&#]{20,}/i;

const PAN_RE = /\b(?:\d[ -]*?){13,19}\b/;
const SSN_RE = /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/;
const NINO_RE = /\b[A-CEGHJ-PR-TW-Z]{2}\d{6}[A-D]\b/i;
const AADHAAR_RE = /\b\d{4}\s\d{4}\s\d{4}\b/;

// A short, deliberate list, not a medical dictionary. Left out on purpose: "fever" (cabin fever, World Cup fever)
// and "glasses" (wine glasses).
const HEALTH_RE =
  /\b(?:diabetes|asthma|allerg(?:y|ic)|anxiety|depress(?:ion|ed|ive)|adhd|therapy|medication|prescription|pregnant|disability|epilep(?:sy|tic)|seizure|thrombosis|lazy[- ]eye)\w*\b/i;
// "Visa" alone is also the card brand, so only a kind of visa or a visa process counts ("student visa", "visa
// application"; not "my Visa card", "my Visa expires"). "Right to work from home" is not immigration.
const IMMIGRATION_RE = new RegExp(
  "\\b(?:work permit|blue card|aufenthaltstitel|niederlassungserlaubnis|residence permit|settlement permit|"
    + "permanent residen(?:ce|cy|t)|green card|indefinite leave to remain|right to work(?! (?:from home|remotely))|"
    + "(?:work|student|tourist|visitor|spouse|partner|family|skilled worker|working holiday|transit|h-?1b|schengen) "
    + "visas?|visa (?:applications?|status|sponsor\\w*|renewal|extension|interview|appointment|holder|refus\\w*|denied))\\b",
  "i",
);
const RELIGION_RE = /\b(?:hindu|muslim|christian|sikh|jewish|buddhist)\b/i;
// A child's age in years (under 18), months or weeks, said the way a parent says it: "my then three-year-old.",
// "my 6-month-old is teething". Not "my 10-year-old car": a noun after the age that isn't a child stops it.
const CHILD_AGE =
  "(?:1[0-7]|[1-9]|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|"
  + "sixteen|seventeen)[- ]years?[- ]old|"
  + "(?:\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[- ](?:months?|weeks?)[- ]old";
const CHILD_AGE_END =
  "(?=['’]s\\b|[ \\t]*(?:[\\n.,;:!?)]|$)|"
  + "\\s+(?:sons?|daughters?|boys?|girls?|kids?|child|twins|is|was|has|had|who|and|starts?|started|will)\\b)";
const CHILD_WORDS = "(?:sons?|daughters?|kids?|child(?:ren)?)";
// "(son|daughter) is <Name>": group 1 is the next character, which must be a capital (checked in detectH2H3).
// Not after a possessive: "Jess's son is Leo" is Jess's child.
const CHILDREN_RE = new RegExp(
  `\\b(?:my (?:then )?(?:${CHILD_WORDS}|(?:${CHILD_AGE})${CHILD_AGE_END})|(?:son|daughter)'s name|`
    + `I have (?:a|an|one|two|three|four|five|\\d) (?:young |little |teenage |twin )?(?:${CHILD_WORDS}|twins)|`
    + "(?<!['’]s )(?:son|daughter)(?= is (?:called |named )?(\\S)))\\b",
  "i",
);
const ORIENTATION_RE = /\b(?:gay|lesbian|bisexual|lgbtq)\b/i;
// House number, a capitalised street name, a street word: "18 Elm Grove", "221B Baker Street".
const STREET_RE =
  /\b\d{1,5}[A-Za-z]?\s+(?:[A-Z][a-z'’-]+\s+){1,3}(?:Street|St|Road|Rd|Grove|Avenue|Ave|Lane|Ln|Drive|Dr|Boulevard|Blvd|Way|Close|Crescent|Place|Terrace|Court|Gardens|Row|Square)\b/;
const UK_POSTCODE_RE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/;
const GPS_RE = /\b(-?\d+\.\d{5,}),\s*(-?\d+\.\d{5,})\b/;

const LINKEDIN_RE = /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/([\w-]{3,})/i;
const GITHUB_RE = /(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s?#]+)\/?(?:\s|$|[?#])/i;
const GITHUB_DENY = new Set([
  "about", "features", "topics", "login", "settings", "orgs", "marketplace",
  "apps", "customer", "security", "collections", "sponsors", "explore", "pricing",
]);
const LINKEDIN_DENY = new Set(["pub", "company", "school"]);

const OS_USER_RE = /\/Users\/([^/\s"']+)\//i;
const OS_DENY = new Set([
  "Public", "Shared", "Administrator", "Default", "All Users",
  "username", "user", "name",
]);

const SELF_CUE_MEDIUM = /\b(?:I have|I'm|I've been|my own|my therapist|diagnosed)\b/i;
const GOV_CUE_RE = /(?:ssn|social security|aadhaar|nino|national insurance|passport|tax id|pan card).{0,32}$/i;
const CARD_CUE_RE = /(?:card|visa|mastercard|cvv|pan).{0,24}$/i;

// The organisation must be capitalised: "I work at Acme" yes, "I joined a gym" / "I work at home" no.
const EMPLOYER_RE =
  /\b(?:[Ii] work (?:at|for)|[Ii] joined|[Mm]y employer(?:\s+is)?)\s*:?\s+([A-Z][\w&.\-]*(?:\s+[A-Z][\w&.\-]*){0,5})/g;
const COMPENSATION_RE =
  /\b(?:salary|ctc|compensation|i make|i earn)\b[^\n]{0,40}?((?:[$€£]\s*[\d,]+(?:\.\d{2})?)|(?:[\d,]+(?:\.\d{2})?\s*(?:usd|eur|gbp)\b))/gi;

const EXAMPLE_WORDS = /example|xxxx|your_|redacted|dummy|sample/i;
const FAKE_HOSTS = /example\.(?:com|org)|localhost/i;

function windowBefore(text, start) {
  return text.slice(Math.max(0, start - 80), start);
}

export function fenceSlices(text) {
  const out = [];
  for (const m of text.matchAll(CODE_BLOCK_RE)) if (m[1]) out.push(m[1]);
  return out;
}

function luhn(digits) {
  digits = digits.replace(/\D/g, "");
  if (digits.length < 13) return false;
  let total = 0;
  let flip = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (flip) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    total += n;
    flip = !flip;
  }
  return total % 10 === 0;
}

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

function verhoeff(number) {
  const digits = number.replace(/\D/g, "").split("").map(Number);
  if (digits.length !== 12) return false;
  let c = 0;
  for (let i = 0; i < digits.length; i++) {
    const digit = digits[digits.length - 1 - i];
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][digit]];
  }
  return c === 0;
}

function hit(kind, value, start, end, confidence, inCodeBlock, harm, window) {
  return { kind, value, start, end, confidence, in_code_block: inCodeBlock, harm, window };
}

function detectSecrets(text, inCodeBlock) {
  const out = [];
  const secretPatterns = [
    [PRIVATE_KEY_RE, "private_key", "high"],
    [AWS_KEY_RE, "aws_access_key", "high"],
    [API_TOKEN_RE, "api_token", "high"],
    [JWT_RE, "jwt", "medium"],
    [TOKEN_URL_RE, "tokenized_url", "high"],
  ];
  for (const [pattern, kind, conf] of secretPatterns) {
    for (const m of text.matchAll(new RegExp(pattern.source, pattern.flags + (pattern.global ? "" : "g")))) {
      const val = m[0];
      // "sk-" also starts hyphenated words ("sk-learn-model-selection"): real keys always carry digits
      if (kind === "api_token" && (EXAMPLE_WORDS.test(val) || val.length < 24 || (val.startsWith("sk-") && !/\d/.test(val)))) continue;
      if (kind === "jwt" && EXAMPLE_WORDS.test(text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40))) continue;
      if (kind === "tokenized_url" && FAKE_HOSTS.test(val)) continue;
      out.push(hit(kind, val, m.index, m.index + m[0].length, conf, inCodeBlock, "H1", windowBefore(text, m.index)));
    }
  }
  const passRe = new RegExp(PASSWORD_CUE_RE.source, PASSWORD_CUE_RE.flags.includes("g") ? PASSWORD_CUE_RE.flags : PASSWORD_CUE_RE.flags + "g");
  for (const m of text.matchAll(passRe)) {
    const secret = m[2].replace(/[.,;)]+$/, "");
    if (secret.length < 6) continue;
    const start = m.index + m[0].length - m[2].length;
    const end = start + secret.length;
    if (["password", "secret", "123456"].includes(secret.toLowerCase()) || (secret.length < 8 && /^[a-z]+$/i.test(secret))) continue;
    // "my password is incorrect": after "is", only something that looks like a password counts
    if (m[1].trim().startsWith("is") && !/[^a-z]/.test(secret)) continue;
    out.push(hit("password_cue", secret, start, end, "medium", inCodeBlock, "H1", windowBefore(text, m.index)));
  }
  return out;
}

function panGate(text, m) {
  const raw = m[0];
  if (DATE_LIKE_RE.test(raw.replace(/\s/g, ""))) return false;
  return luhn(raw.replace(/\D/g, ""));
}

function detectH2H3(text) {
  const out = [];

  for (const m of text.matchAll(new RegExp(PAN_RE.source, "g"))) {
    if (!panGate(text, m)) continue;
    const win = windowBefore(text, m.index);
    const conf = CARD_CUE_RE.test(win) ? "high" : "medium";
    out.push(hit("payment_card", m[0], m.index, m.index + m[0].length, conf, false, "H2", win));
  }

  for (const m of text.matchAll(new RegExp(SSN_RE.source, "g"))) {
    const win = windowBefore(text, m.index);
    if (!GOV_CUE_RE.test(win + m[0])) continue;
    out.push(hit("national_id", m[0], m.index, m.index + m[0].length, "medium", false, "H2", win));
  }

  for (const m of text.matchAll(new RegExp(NINO_RE.source, "g"))) {
    const win = windowBefore(text, m.index);
    if (!GOV_CUE_RE.test(win + m[0])) continue;
    out.push(hit("national_id", m[0], m.index, m.index + m[0].length, "medium", false, "H2", win));
  }

  for (const m of text.matchAll(new RegExp(AADHAAR_RE.source, "g"))) {
    const win = windowBefore(text, m.index);
    if (!GOV_CUE_RE.test(win + m[0])) continue;
    if (!verhoeff(m[0])) continue;
    out.push(hit("national_id", m[0], m.index, m.index + m[0].length, "medium", false, "H2", win));
  }

  const lexicon = [
    [HEALTH_RE, "health", "H3"],
    [IMMIGRATION_RE, "immigration", "H3"],
    [CHILDREN_RE, "children", "H3"],
    [ORIENTATION_RE, "sexual_orientation", "H3"],
  ];
  for (const [pattern, kind, harm] of lexicon) {
    for (const m of text.matchAll(new RegExp(pattern.source, pattern.flags + "g"))) {
      if (kind === "children" && m[1] && m[1] === m[1].toLowerCase()) continue; // "son is unwell": only "son is Leo"
      const win = windowBefore(text, m.index);
      let conf = "low";
      if (kind === "health" && SELF_CUE_MEDIUM.test(win + m[0])) conf = "medium";
      if (kind === "children") conf = "medium";
      if (kind === "immigration" && /\b(?:I have|my)\b/i.test(win)) conf = "medium";
      out.push(hit(kind, m[0], m.index, m.index + m[0].length, conf, false, harm, win));
    }
  }

  for (const m of text.matchAll(new RegExp(RELIGION_RE.source, RELIGION_RE.flags + "g"))) {
    const before = text.slice(Math.max(0, m.index - 20), m.index);
    if (!/\b(?:I'm|I am)\s*$/i.test(before)) continue;
    out.push(hit("religion", m[0], m.index, m.index + m[0].length, "medium", false, "H3", windowBefore(text, m.index)));
  }

  for (const m of text.matchAll(new RegExp(STREET_RE.source, STREET_RE.flags + "g"))) {
    const win = windowBefore(text, m.index);
    let conf = "medium";
    const snippet = text.slice(m.index, m.index + m[0].length + 40);
    if (UK_POSTCODE_RE.test(snippet)) conf = "high";
    out.push(hit("street_address", m[0], m.index, m.index + m[0].length, conf, false, "H3", win));
  }

  for (const m of text.matchAll(new RegExp(GPS_RE.source, "g"))) {
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    if (Math.abs(lat) > 180 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) continue;
    out.push(hit("gps", m[0], m.index, m.index + m[0].length, "high", false, "H3", windowBefore(text, m.index)));
  }

  return out;
}

function detectH4H5(text) {
  const out = [];
  for (const m of text.matchAll(new RegExp(LINKEDIN_RE.source, LINKEDIN_RE.flags + "g"))) {
    const slug = m[1].split("/")[0];
    if (LINKEDIN_DENY.has(slug.toLowerCase())) continue;
    out.push(hit("profile_url", m[0], m.index, m.index + m[0].length, "medium", false, "H4", windowBefore(text, m.index)));
  }
  for (const m of text.matchAll(new RegExp(GITHUB_RE.source, GITHUB_RE.flags + "g"))) {
    const user = m[1];
    if (GITHUB_DENY.has(user.toLowerCase())) continue;
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 20);
    if (/^\//.test(after)) continue;
    out.push(hit("profile_url", m[0], m.index, m.index + m[0].length, "medium", false, "H4", windowBefore(text, m.index)));
  }

  const seenUsers = new Map();
  for (const m of text.matchAll(new RegExp(OS_USER_RE.source, OS_USER_RE.flags + "g"))) {
    const name = m[1];
    if (OS_DENY.has(name)) continue;
    seenUsers.set(name, (seenUsers.get(name) ?? 0) + 1);
  }
  for (const [name, count] of seenUsers) {
    out.push(hit("os_username", name, 0, 0, "medium", false, "H4", `/Users/${name}/`));
  }

  for (const m of text.matchAll(new RegExp(EMPLOYER_RE.source, EMPLOYER_RE.flags))) {
    const org = m[1].replace(/[ .,;:]+$/g, "").trim();
    if (!org) continue;
    const start = m.index + m[0].indexOf(m[1]);
    out.push(hit("employer", org, start, start + org.length, "medium", false, "H5", windowBefore(text, m.index)));
  }
  for (const m of text.matchAll(new RegExp(COMPENSATION_RE.source, COMPENSATION_RE.flags))) {
    const amount = m[1].trim();
    if (!amount) continue;
    const start = m.index + m[0].indexOf(m[1]);
    out.push(hit("compensation", amount, start, start + amount.length, "medium", false, "H5", windowBefore(text, m.index)));
  }
  return out;
}

/** @param {string} text @param {{ inCodeBlock?: boolean }} options */
export function detect(text, { inCodeBlock = false } = {}) {
  if (inCodeBlock) return detectSecrets(text, true);
  return [...detectSecrets(text, false), ...detectH2H3(text), ...detectH4H5(text)];
}