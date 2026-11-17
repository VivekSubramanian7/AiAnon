// Quick-frisk name rules: people, places and companies from word lists and phrases, no model.
// JavaScript twin of scripts/web_reference_rules.py; tests/web/rules.test.mjs checks they agree.
//
// Evidence, strongest first:
//   1. street addresses ("221 Baker Street")                       -> LOCATION
//   2. a title before a capitalised word ("Dr. Emily Stone")        -> PERSON
//   3. "my name is sam miller" in lower case                        -> PERSON
//   4. inside a run of capitalised words:
//        ends in a company word ("Northern Care Trust")             -> ORG
//        starts with a known first name ("Dana Whitfield")          -> PERSON
//        a known city, region or country ("Leeds", "New York")      -> LOCATION
//        a phrase just before it ("my manager X", "works at X")     -> PERSON / ORG / LOCATION
// Capitalised words with none of this evidence are left alone.

// Python's \b, \w and \d understand every alphabet; JavaScript's don't, so spell them out.
const W = "[\\p{L}\\p{N}_]";
const NOT_AFTER_WORD = `(?<!${W})`;
const NOT_BEFORE_WORD = `(?!${W})`;
const END = "(?=\\n?$)"; // Python's $ also matches just before a final newline

const L = "a-zà-öø-ÿ";
const CAP_WORD = `[A-Z][A-Za-z${L}'’\\-]*[${L}]`; // must end lowercase: skips IBM, [EMAIL_01]
const CONNECTOR = "(?:of|de|del|da|van|von|der|la|le|du|&)";
const SEQ_RE = new RegExp(`${CAP_WORD}(?:[ ]+(?:${CONNECTOR}[ ]+)?${CAP_WORD})*`, "gu");
const WORD_RE = /\S+/gu;
const TITLE_RE = new RegExp(
  `${NOT_AFTER_WORD}(?:Mr|Mrs|Ms|Miss|Mx|Dr|Prof|Sir|Dame)\\.?[ ]+(${CAP_WORD}(?:[ ]+${CAP_WORD}){0,2})`, "gud");
const STREET_RE = new RegExp(
  `${NOT_AFTER_WORD}\\p{Nd}{1,5}[ ]+(?:${CAP_WORD}[ ]+){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr|` +
  `Boulevard|Blvd|Way|Court|Ct|Place|Pl|Terrace|Close|Crescent|Square|Sq|Parkway|Pkwy|Highway|Hwy|Row|Gardens|` +
  `Grove)${NOT_BEFORE_WORD}`, "gu");
const LOWER_NAME_RE = new RegExp(`${NOT_AFTER_WORD}my name is[ ]+([a-z][a-z'’\\-]+)(?:[ ]+([a-z][a-z'’\\-]+))?`, "gud");

const ORG_SUFFIX = new Set(`Inc Inc. Incorporated LLC Ltd Ltd. Limited GmbH AG SA PLC Plc LLP LP Corp Corp.
  Corporation Co Co. Company Group Holdings Bank University College School Academy Institute Hospital Clinic Trust
  Foundation Partners Associates Technologies Technology Labs Systems Solutions Services Consulting Industries
  Enterprises Ventures Capital Media Studio Studios Agency Council Ministry Department Center Centre Society Club
  Church Insurance Pharmacy Pharmaceuticals Health Healthcare Motors Airlines Bakery Cafe Restaurant Hotel Sons
  Brothers Bros`.split(/\s+/).map((w) => w.toLowerCase()));

const PERSON_TRIGGER = new RegExp(
  "(?:my name is|name is|named|called|call me|i am|i'm|name:|dear|hi|hello|hey|thanks|thank you|" +
  "(?:my |our |his |her |their )?(?:wife|husband|partner|spouse|son|daughter|kid|child|boyfriend|girlfriend|" +
  "fianc[ée]e?|friend|best friend|mom|mum|mother|dad|father|brother|sister|boss|manager|colleague|coworker|" +
  "co-worker|neighbou?r|cousin|uncle|aunt|grandma|grandmother|grandpa|grandfather|niece|nephew|doctor|" +
  `therapist|teacher|roommate|flatmate|landlord|ex))[ ,:]*${END}`, "u");
const ORG_TRIGGER = new RegExp(
  "(?:work(?:s|ed|ing)? (?:at|for)|employed (?:at|by)|job at|role at|position at|intern(?:ing|ship)? at|joined|" +
  `stud(?:y|ies|ied|ying) at|student at|graduated from|employer(?: is)?|company(?: is)?|customer of|client of)[ ,:]*${END}`,
  "u");
const PLACE_TRIGGER = new RegExp(
  `(?:live[sd]? in|living in|based in|born in|grew up in|raised in|moved to|moving to|relocat${W}* to|trip to|` +
  `travel${W}* to|visit(?:ing|ed)?|stay(?:ing|ed)? in|located in|resident of|near|city(?: is)?|town(?: is)?|` +
  `address(?: is)?|from)[ ,:]*${END}`, "u");
const NEAR_PREP = new RegExp(`(?:${NOT_AFTER_WORD}(?:in|from|to|near|at|around|outside)|,)[ ]*${END}`, "u");
const SENTENCE_START = new RegExp(`(?:^|[.!?:\\n•*\\-]|\\p{Nd}\\.)[ \\t"'“(]*${END}`, "u");
const CONNECTOR_FULL = new RegExp(`^${CONNECTOR}$`, "u");
const MAX_PLACE_WORDS = 4;

function stripChars(word, chars) {
  let a = 0;
  let b = word.length;
  while (a < b && chars.includes(word[a])) a++;
  while (b > a && chars.includes(word[b - 1])) b--;
  return word.slice(a, b);
}

/** lists: the parsed web/data/lists.json. Returns findEntities(text) -> [{type, text, start, end, score}]. */
export function createRules(lists) {
  const first = new Set(lists.firstNames);
  const surnames = new Set(lists.surnames);
  const places = new Set(lists.places);
  const ordinary = new Set(lists.ordinary);
  const ambiguous = new Set(lists.ambiguous);

  const isOrdinary = (word) => ordinary.has(stripChars(word.toLowerCase(), "'’."));
  const end = (w) => w[1] + w[0].length;

  function longestPlace(words, i) {
    for (let j = Math.min(words.length, i + MAX_PLACE_WORDS); j > i; j--) {
      if (places.has(words.slice(i, j).map((w) => w[0]).join(" ").toLowerCase())) return j;
    }
    return null;
  }

  function classify(text, words, add) {
    const n = words.length;
    let i = 0;
    while (i < n) {
      const [word, start] = words[i];
      const low = word.toLowerCase();
      if (CONNECTOR_FULL.test(word)) {
        i += 1;
        continue;
      }
      const before = text.slice(Math.max(0, start - 40), start).toLowerCase();

      // 1. company word later in this run: the run up to it is a company
      let suffixAt = null;
      for (let k = i + 1; k < n; k++) {
        if (ORG_SUFFIX.has(words[k][0].toLowerCase())) { suffixAt = k; break; }
      }
      if (suffixAt !== null) {
        let endK = suffixAt;
        if (endK + 2 < n && words[endK + 1][0] === "of") endK = n - 1; // "University of Leeds"
        add(start, end(words[endK]), "ORG");
        i = endK + 1;
        continue;
      }
      if (ORG_SUFFIX.has(low) && i + 2 < n && words[i + 1][0] === "of") { // "Bank of America"
        add(start, end(words[n - 1]), "ORG");
        return;
      }

      // 2. first name
      if (first.has(low)) {
        const single = n - i === 1;
        if (places.has(low) && single && (NEAR_PREP.test(before) || PLACE_TRIGGER.test(before))) {
          add(start, start + word.length, "LOCATION");
          i += 1;
          continue;
        }
        if (!ambiguous.has(low) && !ordinary.has(low)) {
          let j = i + 1;
          while (j < n && j <= i + 2 && !CONNECTOR_FULL.test(words[j][0]) && !isOrdinary(words[j][0])) j++;
          add(start, end(words[j - 1]), "PERSON");
          i = j;
          continue;
        }
        const next = i + 1 < n ? words[i + 1][0].toLowerCase() : "";
        if (surnames.has(next) && !ordinary.has(next)) {
          add(start, end(words[i + 1]), "PERSON");
          i += 2;
          continue;
        }
      }

      // 3. known place
      const j = longestPlace(words, i);
      if (j) {
        add(start, end(words[j - 1]), "LOCATION");
        i = j;
        continue;
      }

      // 4. phrase just before the run
      if (!isOrdinary(word)) {
        const rest = words.slice(i, i + 3);
        const restEnd = end(rest[rest.length - 1]);
        if (PERSON_TRIGGER.test(before)) {
          add(start, restEnd, "PERSON");
          i += rest.length;
          continue;
        }
        if (ORG_TRIGGER.test(before)) {
          add(start, end(words[n - 1]), "ORG");
          return;
        }
        if (PLACE_TRIGGER.test(before)) {
          add(start, restEnd, "LOCATION");
          i += rest.length;
          continue;
        }
      }
      i += 1;
    }
  }

  return function findEntities(text) {
    const spans = []; // [start, end, type]; earlier passes win overlaps
    const add = (start, stop, kind) => {
      if (stop - start < 3 || spans.some(([s, e]) => s < stop && start < e)) return;
      spans.push([start, stop, kind]);
    };

    for (const m of text.matchAll(STREET_RE)) add(m.index, m.index + m[0].length, "LOCATION");
    for (const m of text.matchAll(TITLE_RE)) add(m.indices[1][0], m.indices[1][1], "PERSON");
    for (const m of text.matchAll(LOWER_NAME_RE)) {
      const [, a, b] = m;
      if (first.has(a) || !ordinary.has(a)) {
        const stop = b && surnames.has(b) && !ordinary.has(b) ? m.indices[2][1] : m.indices[1][1];
        add(m.indices[1][0], stop, "PERSON");
      }
    }
    for (const m of text.matchAll(SEQ_RE)) {
      let words = [...m[0].matchAll(WORD_RE)].map((w) => [w[0], m.index + w.index]);
      // the first word of a sentence is capitalised anyway: drop it if it's an ordinary word
      if (words.length && SENTENCE_START.test(text.slice(0, words[0][1])) && isOrdinary(words[0][0])) {
        words = words.slice(1);
      }
      classify(text, words, add);
    }

    spans.sort((x, y) => x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0));
    return spans.map(([s, e, k]) => ({ type: k, text: text.slice(s, e), start: s, end: e, score: 0.95 }));
  };
}
