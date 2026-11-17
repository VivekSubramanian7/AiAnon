/**
 * Pattern stage: a port of lib/pipeline/regex_stripper.py (RegexStripper.process).
 *
 * Finds the WhatsApp header, IBANs, phone numbers, emails, links, handles, birth dates and ages,
 * in that order, and replaces each with a placeholder such as [PHONE_01]. Every stage works on the
 * text the previous stage left, so a token's start/end point into that intermediate text, exactly
 * like the Python version (the SENDER token points into the raw text).
 *
 * Kept identical to Python on purpose, quirks included: overlapping matches inside a stage are all
 * kept and replaced from the end using their original indexes; counters run in discovery order.
 * tests/web/patterns.test.mjs checks the output against Python's (scripts/web_fixtures_patterns.py).
 *
 * Phone numbers: like Python, libphonenumber's matcher first (vendored libphonenumber-js 1.10.53,
 * whose metadata matches the pipeline's phonenumbers==8.13.27; upgrade both together), then the
 * fallback regex. The regex alone misses whole numbers such as "+33 6 12 34 56 78" and
 * "089 / 123 456 78" (the fixture's meta.libraryComparison has the numbers).
 *
 * Differences from Python:
 *  - start/end count UTF-16 code units (JavaScript strings), Python counts code points. They differ
 *    only after a character outside the Basic Multilingual Plane, such as an emoji.
 *  - Python's \d, \w, \s and \b follow Python's Unicode tables (Unicode 15.0 in Python 3.12);
 *    here \p{Nd}, \p{L}, \p{N} follow the browser's. Characters added to Unicode later may differ.
 *
 * Python's `re` semantics are reproduced explicitly instead of relying on JavaScript's:
 *  - \s is Python's whitespace set (JavaScript's \s differs: it has U+FEFF, lacks U+001C-U+001F
 *    and U+0085);
 *  - \d is \p{Nd} (JavaScript's \d is ASCII only);
 *  - \b is a Unicode word boundary on [\p{L}\p{N}_] (JavaScript's \b is ASCII only);
 *  - re.IGNORECASE is spelled out per letter, with Python's extra matches: i also matches U+0130
 *    and U+0131, k matches U+212A (Kelvin sign), s matches U+017F (long s);
 *  - Python's `$` also matches before a final newline (used by the IBAN check).
 */

import { Metadata, PhoneNumberMatcher } from '../vendor/libphonenumber-js-1.10.53.max.js';

// ---------- Python `re` building blocks ----------

const SPACE = String.raw`\t\n\v\f\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;
const S = `[${SPACE}]`;
const D = String.raw`\p{Nd}`;
const WORD = String.raw`[\p{L}\p{N}_]`;
const B = `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;
const AZ_I = String.raw`A-Za-z\u0130\u0131\u017f\u212a`; // [A-Za-z] under re.IGNORECASE
const CASE_EXTRA = { i: String.raw`\u0130\u0131`, k: String.raw`\u212a`, s: String.raw`\u017f` };

/** A literal under re.IGNORECASE: every ASCII letter becomes a class of its case variants. */
function ci(literal) {
  return literal.replace(/[A-Za-z]/g, (ch) => {
    const lower = ch.toLowerCase();
    return `[${lower}${lower.toUpperCase()}${CASE_EXTRA[lower] || ''}]`;
  });
}

const finder = (source) => new RegExp(source, 'gu');
const STRIP = new RegExp(`^${S}+|${S}+$`, 'gu');
const pyStrip = (value) => value.replace(STRIP, '');
const codePoints = (value) => [...value].length;

const ND = /^\p{Nd}$/u;

/** int() of a string of Unicode decimal digits (Python accepts any Nd digit). */
function pyInt(digits) {
  let value = 0;
  for (const ch of digits) {
    const cp = ch.codePointAt(0);
    let zero = cp;
    if (cp >= 0x30 && cp <= 0x39) {
      zero = 0x30;
    } else {
      // Nd digits come in contiguous runs of whole 0-9 sets.
      while (ND.test(String.fromCodePoint(zero - 1))) zero -= 1;
    }
    value = value * 10 + ((cp - zero) % 10);
  }
  return value;
}

// ---------- patterns (same order and meaning as regex_stripper.py) ----------

const HEADER_PATTERNS = [
  // [26/02/2026, 09:14] Name:
  new RegExp(String.raw`^\[(${D}{1,2}/${D}{1,2}/${D}{4}),${S}*(${D}{1,2}:${D}{2})\]${S}*([^:]+):${S}*`, 'du'),
  // [24.01.26, 16:40:31] Name:
  new RegExp(String.raw`^\[(${D}{1,2}\.${D}{1,2}\.${D}{2,4}),${S}*(${D}{1,2}:${D}{2}(?::${D}{2})?)\]${S}*([^:]+):${S}*`, 'du'),
];

const PHONE = finder(String.raw`(\+?${D}{1,4}[${SPACE}\-.]?)?\(?${D}{2,4}\)?[${SPACE}\-.]?${D}{3,4}[${SPACE}\-.]?${D}{3,4}`);

const DOT = String.raw`${ci('dot')}|\[${ci('dot')}\]|\(${ci('dot')}\)`;
const AT = String.raw`\[${ci('at')}\]|\(${ci('at')}\)| ${ci('at')} `;
const EMAIL = finder(String.raw`${B}[${AZ_I}0-9._%+\-]+@[${AZ_I}0-9.\-]+\.[${AZ_I}|]{2,}${B}`);
const EMAIL_OBFUSCATED = [
  // jonas dot weber at protonmail dot com
  finder(String.raw`${B}[${AZ_I}0-9]{2,}${S}*(?:${DOT})${S}*[${AZ_I}0-9]{2,}${S}*(?:${AT})${S}*[${AZ_I}0-9]+${S}*(?:${DOT})${S}*[${AZ_I}]{2,}${B}`),
  // jonas at gmail dot com
  finder(String.raw`${B}[${AZ_I}0-9._]{3,}${S}*(?:${AT})${S}*[${AZ_I}0-9]+${S}*(?:${DOT})${S}*[${AZ_I}]{2,}${B}`),
];

const URL = finder(String.raw`${ci('http')}${ci('s')}?://[^${SPACE}<>"{}|\\^\x60\[\]]+`);
const DOMAIN = finder(String.raw`${B}(?:[a-zA-Z0-9\-]+\.)+[a-zA-Z]{2,}(?:/[^${SPACE}]*)?${B}`);
const URL_TLDS = ['.com', '.org', '.net', '.de', '.co.uk'];

const HANDLE = finder(String.raw`@[A-Za-z0-9_]{3,}`);

const IBAN = finder(String.raw`${B}[A-Z]{2}${S}*[0-9]{2}[${SPACE}0-9A-Z]{13,32}${B}`);
const IBAN_SHAPE = /^[A-Z]{2}[0-9]{2}[A-Z0-9]+\n?$/; // Python's `$` also matches before a final \n

const DOB_PATTERNS = [
  finder(String.raw`${B}${D}{1,2}[./]${D}{1,2}[./]${D}{4}${B}`),
  finder(String.raw`${B}${D}{1,2}[./]${D}{1,2}[./]${D}{2}${B}`),
  finder(String.raw`${B}${ci('born')}${S}+(?:${ci('in')}${S}+)?${D}{4}${B}`),
  finder(String.raw`${B}${ci('born')}${S}+(?:${ci('on')}${S}+)?${D}{1,2}[./]${D}{1,2}[./]${D}{2,4}${B}`),
];

const AGE_PATTERNS = [
  finder(String.raw`${ci("I'm")}${S}+(${D}{1,2})${B}`),
  finder(String.raw`${ci('I am')}${S}+(${D}{1,2})${B}`),
  finder(String.raw`(${D}{1,2})${S}+${ci('year')}${ci('s')}?${S}+${ci('old')}`),
  finder(String.raw`${ci('aged')}${S}+(${D}{1,2})${B}`),
];

// ---------- phone numbers: the library pass ----------
//
// Python runs phonenumbers.PhoneNumberMatcher(text, region) for DE, GB and US (leniency VALID,
// max_tries 65535). libphonenumber-js ports the same matcher, but its VALID leniency skips one
// check that Python (and Google's Java original) makes: a number written in national format must
// carry the national prefix when that country's format uses one ("030 1234567" is a number,
// "30 1234567" is not). Without it, dates such as "2026-05-14" pass as German numbers. The check
// is added back below, following _is_national_prefix_present_if_required() in
// phonenumbers/phonenumbermatcher.py.

const PHONE_REGIONS = ['DE', 'GB', 'US'];
const PHONE_MAX_TRIES = 65535;

const fullMatch = (pattern, value) => new RegExp(`^(?:${pattern})$`).test(value);

/** phonenumbers' normalize_digits_only(): the digits of a string, as ASCII. */
const digitsOnly = (value) => [...value].filter((ch) => ND.test(ch)).map((ch) => pyInt(ch)).join('');

/** _maybe_strip_national_prefix_carrier_code(number, metadata)[2]: can a national prefix be stripped? */
function stripsNationalPrefix(number, plan) {
  const forParsing = plan.nationalPrefixForParsing();
  if (!number || !forParsing) return false;
  const prefix = new RegExp(`^(?:${forParsing})`);
  const match = prefix.exec(number);
  if (!match) return false;
  const general = plan.nationalNumberPattern();
  const viable = (value) => Boolean(general) && fullMatch(general, value);
  const groups = match.length - 1;
  const transform = plan.nationalPrefixTransformRule();
  const rest = !transform || match[groups] === undefined
    ? number.slice(match[0].length)
    : number.replace(prefix, transform);
  return !(viable(number) && !viable(rest));
}

/** _is_national_prefix_present_if_required(numobj) from phonenumbers/phonenumbermatcher.py. */
function nationalPrefixPresentIfRequired(phoneNumber, candidate) {
  // libphonenumber-js leaves the source unset when the calling code came from the default country
  // (Python: CountryCodeSource.FROM_DEFAULT_COUNTRY). International formats need no prefix.
  if (phoneNumber.__countryCallingCodeSource) return true;
  const metadata = new Metadata();
  metadata.selectNumberingPlan(phoneNumber.countryCallingCode);
  const plan = metadata.numberingPlan;
  const nsn = phoneNumber.nationalNumber;
  const format = plan.formats().find((f) => {
    const leading = f.leadingDigitsPatterns();
    return (leading.length === 0 || new RegExp(`^(?:${leading[leading.length - 1]})`).test(nsn))
      && fullMatch(f.pattern(), nsn);
  });
  if (!format || !format.nationalPrefixFormattingRule()) return true;
  if (format.nationalPrefixIsOptionalWhenFormattingInNationalFormat()) return true;
  if (!format.usesNationalPrefix()) return true; // the rule is only "$1": no prefix to look for
  return stripsNationalPrefix(digitsOnly(candidate), plan);
}

/** Spans phonenumbers.PhoneNumberMatcher(text, region) finds, in order. */
function* libraryPhoneSpans(text, region) {
  const matcher = new PhoneNumberMatcher(text, { defaultCountry: region, maxTries: PHONE_MAX_TRIES, v2: true });
  const valid = matcher.leniency;
  matcher.leniency = (phoneNumber, context) =>
    valid(phoneNumber, context) && nationalPrefixPresentIfRequired(phoneNumber, context.candidate);
  while (matcher.hasNext()) {
    const found = matcher.next();
    yield [found.startsAt, found.endsAt];
  }
}

// ---------- stages ----------

const token = (type, value, original, start, end, confidence) => ({ type, value, original, start, end, confidence });
const covers = (tokens, index) => tokens.some((t) => t.start <= index && index < t.end);

/** Sort by start, last first (stable, like Python's sort(reverse=True)), and splice the placeholders in. */
function replaceFromEnd(text, tokens) {
  tokens.sort((a, b) => b.start - a.start);
  for (const t of tokens) text = text.slice(0, t.start) + t.value + text.slice(t.end);
  return text;
}

function extractWhatsappHeader(text) {
  for (const pattern of HEADER_PATTERNS) {
    const m = pattern.exec(text);
    if (m) {
      const sender = pyStrip(m[3]);
      const [start, end] = m.indices[3];
      return { text: text.slice(m[0].length), tokens: [token('SENDER', '[SENDER]', sender, start, end, 1.0)], sender };
    }
  }
  return { text, tokens: [], sender: '' };
}

function extractIbans(text, next) {
  const tokens = [];
  for (const m of text.matchAll(IBAN)) {
    const normalized = m[0].replaceAll(' ', '');
    const length = codePoints(normalized);
    if (length >= 15 && length <= 34 && IBAN_SHAPE.test(normalized)) {
      tokens.push(token('IBAN', next('IBAN'), m[0], m.index, m.index + m[0].length, 0.95));
    }
  }
  return { text: replaceFromEnd(text, tokens), tokens };
}

function extractPhoneNumbers(text, next) {
  const tokens = [];
  const seen = new Set();
  for (const region of PHONE_REGIONS) {
    try {
      for (const [start, end] of libraryPhoneSpans(text, region)) {
        const key = `${start}:${end}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tokens.push(token('PHONE', next('PHONE'), text.slice(start, end), start, end, 1.0));
      }
    } catch {
      // Python ignores matcher errors too (bare except), keeping what was found before.
    }
  }
  for (const m of text.matchAll(PHONE)) {
    if (!covers(tokens, m.index) && codePoints(m[0].replace(/[ .-]/g, '')) >= 7) {
      tokens.push(token('PHONE', next('PHONE'), m[0], m.index, m.index + m[0].length, 0.9));
    }
  }
  return { text: replaceFromEnd(text, tokens), tokens };
}

function extractEmails(text, next) {
  const tokens = [];
  for (const m of text.matchAll(EMAIL)) {
    tokens.push(token('EMAIL', next('EMAIL'), m[0], m.index, m.index + m[0].length, 1.0));
  }
  for (const pattern of EMAIL_OBFUSCATED) {
    for (const m of text.matchAll(pattern)) {
      if (!covers(tokens, m.index)) {
        tokens.push(token('EMAIL', next('EMAIL'), m[0], m.index, m.index + m[0].length, 0.95));
      }
    }
  }
  return { text: replaceFromEnd(text, tokens), tokens };
}

function extractUrls(text, next) {
  const tokens = [];
  for (const m of text.matchAll(URL)) {
    tokens.push(token('URL', next('URL'), m[0], m.index, m.index + m[0].length, 1.0));
  }
  for (const m of text.matchAll(DOMAIN)) {
    const url = m[0];
    if (!covers(tokens, m.index) && (url.includes('/') || URL_TLDS.some((tld) => url.includes(tld)))) {
      tokens.push(token('URL', next('URL'), url, m.index, m.index + url.length, 0.9));
    }
  }
  return { text: replaceFromEnd(text, tokens), tokens };
}

function extractHandles(text, next) {
  const tokens = [];
  for (const m of text.matchAll(HANDLE)) {
    tokens.push(token('HANDLE', next('HANDLE'), m[0], m.index, m.index + m[0].length, 1.0));
  }
  return { text: replaceFromEnd(text, tokens), tokens };
}

function extractDob(text, next) {
  const tokens = [];
  for (const pattern of DOB_PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      if (!covers(tokens, m.index)) {
        tokens.push(token('DOB', next('DOB'), m[0], m.index, m.index + m[0].length, 0.9));
      }
    }
  }
  return { text: replaceFromEnd(text, tokens), tokens };
}

function extractAges(text) {
  const tokens = [];
  for (const pattern of AGE_PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      const age = pyInt(m[1]);
      if (age >= 1 && age <= 120 && !covers(tokens, m.index)) {
        const decade = Math.floor(age / 10) * 10;
        tokens.push(token('AGE', `[AGE_${decade}s]`, m[0], m.index, m.index + m[0].length, 0.95));
      }
    }
  }
  return { text: replaceFromEnd(text, tokens), tokens };
}

/**
 * Port of RegexStripper.process().
 * @param {string} rawText
 * @returns {{text: string, tokens: {type: string, value: string, original: string, start: number, end: number, confidence: number}[], senderName: string}}
 */
export function stripPatterns(rawText) {
  const counters = new Map();
  const next = (type) => {
    const n = (counters.get(type) || 0) + 1;
    counters.set(type, n);
    return `[${type}_${String(n).padStart(2, '0')}]`;
  };

  const header = extractWhatsappHeader(rawText);
  let { text } = header;
  const tokens = [...header.tokens];
  for (const stage of [extractIbans, extractPhoneNumbers, extractEmails, extractUrls, extractHandles, extractDob, extractAges]) {
    const result = stage(text, next);
    text = result.text;
    for (const t of result.tokens) tokens.push(t);
  }
  if (header.tokens.length) text = `[SENDER] ${text}`;
  return { text, tokens, senderName: header.sender };
}
