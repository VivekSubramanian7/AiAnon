// Turns findings into the scan report: categories, distinct counts, masked examples, a score.
// Port of lib/scanner/report.py. Real values stay inside the worker; examples are masked
// ("S•••• M•••••"), so a screenshot of the result is safe to share.

const MASK = "•";
const W = "[\\p{L}\\p{N}_]";
const isAlnum = (ch) => /[\p{L}\p{N}]/u.test(ch);

export const CATEGORIES = [
  { key: "names", label: "Names", tier: "direct" },
  { key: "emails", label: "Email addresses", tier: "direct" },
  { key: "phones", label: "Phone numbers", tier: "direct" },
  { key: "birthdays", label: "Birth dates", tier: "direct" },
  { key: "bank", label: "Bank accounts", tier: "direct" },
  { key: "handles", label: "Social handles", tier: "direct" },
  { key: "places", label: "Places", tier: "context" },
  { key: "orgs", label: "Companies and organisations", tier: "context" },
  { key: "ages", label: "Ages", tier: "context" },
  { key: "dates", label: "Dates", tier: "context" },
  { key: "links", label: "Links", tier: "context" },
];

const TOKEN_TO_CATEGORY = {
  PERSON: "names", EMAIL: "emails", PHONE: "phones", IBAN: "bank", HANDLE: "handles",
  LOCATION: "places", ORG: "orgs", AGE: "ages", URL: "links",
  // DOB is split by context below; SENDER and BLOCKLIST are not counted
};

const BIRTH_CONTEXT_RE = new RegExp(
  `(?<!${W})born(?!${W})|(?<!${W})birth|(?<!${W})dob(?!${W})|(?<!${W})b-day(?!${W})`, "iu");
// The phone rule runs before the date rule, so "03.05.2026" can come back as PHONE.
export const DATE_LIKE_RE =
  /^\s*(?:\p{Nd}{1,2}[./-]\p{Nd}{1,2}[./-](?:\p{Nd}{2}|\p{Nd}{4})|\p{Nd}{4}[./-]\p{Nd}{1,2}[./-]\p{Nd}{1,2})\s*(?=\n?$)/u;
const BIRTH_CONTEXT_CHARS = 24;

// Words NER likes to tag that say nothing about the user: the chatbots themselves, apps, programming terms.
const NOT_PERSONAL = new Set([
  "chatgpt", "chat gpt", "gpt", "gpt 4", "gpt 4o", "gpt 5", "openai", "claude", "anthropic", "gemini", "bard",
  "copilot", "llama", "mistral", "siri", "alexa", "ai", "llm",
  "instagram", "facebook", "tiktok", "linkedin", "twitter", "x", "whatsapp", "telegram", "snapchat", "reddit",
  "youtube", "github", "gitlab", "gmail", "google", "outlook", "spotify", "netflix", "slack", "zoom", "teams",
  "discord", "notion", "excel", "powerpoint", "iphone", "ipad", "android", "ios", "windows", "linux", "macos",
  "python", "java", "javascript", "typescript", "rust", "golang", "kotlin", "react", "vue", "angular", "node",
  "nodejs", "docker", "kubernetes", "aws", "azure", "sql", "html", "css",
  "iban", "bic", "swift", "ssn", "dob", "pii", "api", "url", "pdf", "json", "csv",
]);
const CODE_IDENTIFIER_RE = /^[A-Za-z]+(?:Error|Exception|Warning)(?=\n?$)/; // KeyError, ValueError, ...

const DIRECT_POINTS = 4;
const CONTEXT_POINTS = 1;
const SCORE_SCALE = 40; // points at which the score reaches ~63/100
const LEVELS = [[80, "biography"], [50, "oversharer"], [20, "chatty"], [1, "mild"], [0, "clean"]];

export function categorize(tokenType, original, context = "") {
  const isBirth = BIRTH_CONTEXT_RE.test(original) || BIRTH_CONTEXT_RE.test(context);
  if (tokenType === "DOB" || (tokenType === "PHONE" && DATE_LIKE_RE.test(original))) {
    return isBirth ? "birthdays" : "dates";
  }
  if (tokenType === "PERSON" || tokenType === "ORG" || tokenType === "LOCATION") {
    if (NOT_PERSONAL.has(normalize("names", original)) || CODE_IDENTIFIER_RE.test(original.trim())) return null;
    if (tokenType === "PERSON" && /\p{Nd}/u.test(original)) return null; // "Austin TX 78704": names have no digits
  }
  return TOKEN_TO_CATEGORY[tokenType] ?? null;
}

/** The few characters before the first occurrence of value, on the same line. */
export function contextBefore(text, value, chars = BIRTH_CONTEXT_CHARS) {
  const index = value ? text.indexOf(value) : -1;
  if (index < 0) return "";
  const before = text.slice(Math.max(0, index - chars), index);
  return before.slice(before.lastIndexOf("\n") + 1);
}

export const CUE_CHARS = 80; // how much text before a finding decides who it is about ("my email is", "his number")

export function cueBefore(text, value) {
  return contextBefore(text, value, CUE_CHARS);
}

/** The DOB rules match both '14.02.1991' and 'born on 14.02.1991'. Keep only the birth-date match. */
export function dropNestedDates(tokens) {
  const births = tokens
    .filter((t) => t.type === "DOB" && t.original && BIRTH_CONTEXT_RE.test(t.original))
    .map((t) => t.original);
  return tokens.filter((t) => !(t.type === "DOB" && t.original && !births.includes(t.original)
    && births.some((b) => b.includes(t.original))));
}

/** Key used to count distinct values: case, spacing and punctuation don't matter. */
export function normalize(category, value) {
  if (category === "phones" || category === "bank") return value.replace(/\P{Nd}/gu, "") || value.toLowerCase();
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function maskWord(word, keep = 1) {
  const chars = Array.from(word);
  const letters = chars.map((ch, i) => (isAlnum(ch) ? i : -1)).filter((i) => i >= 0);
  const keepIdx = new Set(letters.slice(0, keep));
  return chars.map((ch, i) => (keepIdx.has(i) || !isAlnum(ch) ? ch : MASK)).join("");
}

function maskTail(value, visible) {
  const chars = Array.from(value);
  const alnum = chars.map((ch, i) => (isAlnum(ch) ? i : -1)).filter((i) => i >= 0);
  const show = new Set(visible ? alnum.slice(-visible) : []);
  return chars.map((ch, i) => (show.has(i) || !isAlnum(ch) ? ch : MASK)).join("");
}

function pythonSplit(value) {
  return value.split(/\s+/u).filter(Boolean);
}

export function mask(category, raw) {
  const value = raw.trim();
  if (category === "emails" && value.includes("@")) {
    const at = value.indexOf("@");
    const local = value.slice(0, at);
    const domain = value.slice(at + 1);
    const dotAt = domain.lastIndexOf(".");
    const host = dotAt >= 0 ? domain.slice(0, dotAt) : "";
    const dot = dotAt >= 0 ? "." : "";
    const tld = dotAt >= 0 ? domain.slice(dotAt + 1) : domain;
    return `${maskWord(local)}@${maskWord(host || domain)}${dot}${host ? tld : ""}`;
  }
  if (category === "phones" || category === "bank") return maskTail(value, 2);
  if (category === "links") {
    const rest = value.replace(/^https?:\/\//i, "");
    return rest.split("/")[0] + (rest.includes("/") ? `/${MASK.repeat(3)}` : "");
  }
  if (category === "handles") return `@${maskWord(value.replace(/^@+/, ""))}`;
  if (category === "birthdays") return maskTail(value, 0);
  if (category === "dates") return value.replace(/\p{Nd}(?=\p{Nd}*[./-])/gu, MASK);
  if (category === "ages") {
    const digits = value.match(/\p{Nd}+/u);
    return digits ? `${Math.floor(Number(digits[0]) / 10) * 10}s` : MASK.repeat(2);
  }
  return pythonSplit(value).map((w) => maskWord(w)).join(" ");
}

const KIND_TO_CATEGORY = {
  email: "emails",
  phone: "phones",
  iban: "bank",
  profile_url: "links",
  url: "links",
  handle: "handles",
  name: "names",
  self_name: "names",
  child_name: "names",
  place: "places",
  org: "orgs",
  age: "ages",
  date: "dates",
  date_of_birth: "birthdays",
  account_email: "emails",
  account_phone: "phones",
};

const SECRET_PREFIX_LEN = {
  AKIA: 4,
  "sk-": 3,
  ghp_: 4,
  github_pat_: 11,
  eyJ: 3,
};

function maskSecret(value) {
  value = value.trim();
  for (const [prefix, keep] of Object.entries(SECRET_PREFIX_LEN)) {
    if (value.startsWith(prefix)) {
      const rest = value.slice(prefix.length);
      return prefix + MASK.repeat(Math.max(4, Math.min(rest.length, 12)));
    }
  }
  if (value) return value[0] + MASK.repeat(Math.min(value.length - 1, 12));
  return MASK.repeat(4);
}

const PASSWORD_MASK = MASK.repeat(8);

export function maskKind(kind, value) {
  if (KIND_TO_CATEGORY[kind]) return mask(KIND_TO_CATEGORY[kind], value);
  if (["private_key", "aws_access_key", "api_token", "jwt", "password_cue", "tokenized_url"].includes(kind)) {
    if (kind === "aws_access_key") return maskSecret(value);
    if (kind === "jwt" && value.startsWith("eyJ")) return maskSecret(value);
    if (kind === "password_cue") return PASSWORD_MASK; // no first character, no length
    if (kind === "api_token") return maskSecret(value);
    if (kind === "private_key") return "-----BEGIN PRIVATE KEY-----";
    if (kind === "tokenized_url") return mask("links", value);
    return maskSecret(value);
  }
  if (["health", "religion", "sexual_orientation", "children", "immigration"].includes(kind)) {
    return pythonSplit(value).map((w) => maskWord(w)).join(" ");
  }
  if (["payment_card", "national_id", "gps"].includes(kind)) return maskTail(value, 2);
  if (kind === "street_address") return pythonSplit(value).map((w) => maskWord(w)).join(" ");
  if (kind === "os_username") return maskWord(value);
  if (["employer", "compensation"].includes(kind)) return pythonSplit(value).map((w) => maskWord(w)).join(" ");
  return MASK.repeat(3);
}

export class Aggregator {
  constructor() {
    this.mentions = new Map(); // category -> mentions
    this.distinct = new Map(CATEGORIES.map((c) => [c.key, new Map()])); // category -> key -> count
    this.firstSeen = new Map(CATEGORIES.map((c) => [c.key, new Map()])); // category -> key -> original
    this.maxConfidence = new Map(CATEGORIES.map((c) => [c.key, new Map()]));
    this.cueWindow = new Map(CATEGORIES.map((c) => [c.key, new Map()]));
  }

  add(tokenType, original, context = "", confidence = 1.0, cue = "") {
    if (!original || !original.trim()) return null;
    const category = categorize(tokenType, original, context);
    if (category === null) return null;
    const key = normalize(category, original);
    this.mentions.set(category, (this.mentions.get(category) ?? 0) + 1);
    const counts = this.distinct.get(category);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const seen = this.firstSeen.get(category);
    if (!seen.has(key)) seen.set(key, original);
    const prev = this.maxConfidence.get(category).get(key) ?? 0;
    this.maxConfidence.get(category).set(key, Math.max(prev, confidence));
    const window = cue || context;
    if (window) {
      const cues = this.cueWindow.get(category);
      if (!cues.has(key)) cues.set(key, window.slice(-CUE_CHARS));
    }
    return category;
  }

  /** 'Priya' on its own is almost always the 'Priya Natarajan' mentioned elsewhere: count them once. */
  mergeFirstNames() {
    const names = this.distinct.get("names");
    const fullNames = [...names.keys()].filter((k) => k.includes(" "));
    for (const key of [...names.keys()].filter((k) => !k.includes(" "))) {
      const matches = fullNames.filter((f) => f.split(" ")[0] === key);
      if (!matches.length) continue;
      let target = matches[0];
      for (const f of matches) if (names.get(f) > names.get(target)) target = f;
      names.set(target, names.get(target) + names.get(key));
      names.delete(key);
      this.firstSeen.get("names").delete(key);
    }
  }

  /**
   * Distinct finds as normalised values, whatever their category (a place the detective calls a company is
   * the same find). Used inside the worker to compare the two stages; never shown or sent anywhere.
   */
  keys() {
    this.mergeFirstNames();
    const out = new Set();
    for (const counts of this.distinct.values()) for (const key of counts.keys()) out.add(key);
    return out;
  }

  categories(examples = 3) {
    this.mergeFirstNames();
    return CATEGORIES.map((c) => {
      const counts = this.distinct.get(c.key);
      const top = [...counts.entries()]
        .map((entry, order) => [...entry, order])
        .sort((a, b) => b[1] - a[1] || a[2] - b[2])
        .slice(0, examples);
      return {
        key: c.key,
        label: c.label,
        tier: c.tier,
        count: this.mentions.get(c.key) ?? 0,
        unique: counts.size,
        examples: top.map(([k, n]) => ({ masked: mask(c.key, this.firstSeen.get(c.key).get(k)), count: n })),
      };
    });
  }

  totals() {
    this.mergeFirstNames();
    let direct = 0;
    let context = 0;
    for (const c of CATEGORIES) {
      if (c.tier === "direct") direct += this.distinct.get(c.key).size;
      else context += this.distinct.get(c.key).size;
    }
    let mentions = 0;
    for (const n of this.mentions.values()) mentions += n;
    return { mentions, unique: direct + context, directUnique: direct, contextUnique: context };
  }
}

/** Python's round(): halves go to the even neighbour. */
function roundHalfEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

export function exposureScore(directUnique, contextUnique) {
  const points = DIRECT_POINTS * directUnique + CONTEXT_POINTS * contextUnique;
  return Math.min(100, roundHalfEven(100 * (1 - Math.exp(-points / SCORE_SCALE))));
}

export function levelFor(score) {
  for (const [minimum, key] of LEVELS) if (score >= minimum) return key;
  return "clean";
}
