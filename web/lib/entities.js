// Turns found entities (people, places, companies) into tokens, with the same filters as the Python
// pipeline's NER stage (lib/pipeline/ner_engine.py, minus Presidio, which doesn't run in a browser).
// The finder is either the quick-frisk rules or the detective model.

const EXISTING_PLACEHOLDER_RE = /\[([A-Z]+)_(\d+)\]/g;

// Countries are not redacted by the pipeline (location granularity rule).
const COUNTRIES = new Set([
  "germany", "united kingdom", "united states", "france", "spain", "italy",
  "canada", "australia", "japan", "china", "india", "brazil", "mexico",
  "russia", "south africa", "argentina", "netherlands", "belgium", "sweden",
  "norway", "denmark", "finland", "poland", "austria", "switzerland",
  "portugal", "greece", "czech republic", "hungary", "romania", "ukraine",
  "turkey", "egypt", "nigeria", "kenya", "thailand", "vietnam", "indonesia",
  "philippines", "singapore", "malaysia", "new zealand", "ireland", "scotland",
  "wales", "england", "iceland", "croatia", "serbia", "bulgaria",
]);

// Product names and words the models mistake for organisations or places.
const TECH_TERMS = new Set([
  "android", "ios", "windows", "linux", "macos", "ubuntu",
  "iphone", "ipad", "macbook", "chromebook", "pixel",
  "chrome", "firefox", "safari", "edge", "opera",
  "google", "facebook", "twitter", "instagram", "linkedin", "github",
  "youtube", "netflix", "spotify", "zoom", "slack", "teams",
  "javascript", "python", "java", "react", "vue", "angular",
  "docker", "kubernetes", "aws", "azure", "api", "sdk",
  "app", "application", "website", "platform", "software", "hardware",
  "dark", "light", "new", "old", "love", "user", "admin", "guest",
  "german", "english", "french", "spanish", "italian", "japanese",
  "american", "british", "european", "asian", "african",
  "gruppe", "das", "der", "die", "ist", "nicht", "und", "aber",
  "format", "system", "feature", "update", "version",
]);

const COMMON_WORDS = new Set([
  "hi", "hey", "hello", "everyone", "just", "joined", "love", "new",
  "the", "and", "but", "can", "will", "should", "could", "would",
  "signed", "up", "dark", "light", "mode", "update", "feature",
]);

const PLACEHOLDER_PREFIXES = [
  "AGE_", "DOB_", "PHONE_", "EMAIL_", "PERSON_", "LOCATION_",
  "SENDER", "HANDLE_", "URL_", "IBAN_", "BLOCKLIST_",
];

/** Port of NEREngine.filter_locations: drops placeholders, short words, tech terms, countries, weak places. */
export function filterEntities(entities) {
  const kept = [];
  for (const entity of entities) {
    const text = entity.text;
    const lower = text.toLowerCase().trim();
    if (text.includes("[") || text.includes("]")) continue;
    if (PLACEHOLDER_PREFIXES.some((p) => text.startsWith(p) || lower.startsWith(p.toLowerCase()))) continue;
    if (lower.length <= 2) continue;
    if (COMMON_WORDS.has(lower)) continue;
    if ((entity.type === "ORG" || entity.type === "LOCATION") && TECH_TERMS.has(text.toLowerCase())) continue;
    if (entity.type === "LOCATION") {
      if (COUNTRIES.has(text.toLowerCase())) continue;
      const score = entity.score ?? 0.85;
      if (score >= 0.9) kept.push(entity);
      else if (score >= 0.85 && !COMMON_WORDS.has(lower)) kept.push(entity);
      continue;
    }
    kept.push(entity);
  }
  return kept;
}

/**
 * Port of NEREngine.process (without Presidio): tokens for the people, places and companies in text.
 * findEntities(text) -> [{type, text, start, end, score}] (may be async).
 */
export async function nameTokens(text, senderName, findEntities) {
  const counters = new Map();
  for (const [, kind, number] of text.matchAll(EXISTING_PLACEHOLDER_RE)) {
    counters.set(kind, Math.max(counters.get(kind) ?? 0, Number(number)));
  }
  const next = (kind) => {
    const n = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, n);
    return `[${kind}_${String(n).padStart(2, "0")}]`;
  };

  const tokens = [];
  if (senderName && senderName.trim() && senderName.toLowerCase() !== "user") {
    const people = (await findEntities(senderName)).filter((e) => e.type === "PERSON");
    if (people.length) {
      tokens.push({
        type: "PERSON", value: next("PERSON"), original: senderName, start: 0, end: senderName.length,
        confidence: Math.max(...people.map((e) => e.score)),
      });
    }
  }
  for (const entity of filterEntities(await findEntities(text))) {
    tokens.push({
      type: entity.type, value: next(entity.type), original: entity.text,
      start: entity.start, end: entity.end, confidence: entity.score,
    });
  }
  return tokens;
}
