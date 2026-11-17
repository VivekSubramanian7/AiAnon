/**
 * Port of lib/scanner/extract.py: turn an uploaded file (or pasted text) into the pieces of text the user wrote.
 *
 * Supported:
 *   * ChatGPT data export (.zip with conversations.json / conversations-NNN.json, or the JSON alone)
 *   * Claude data export (.zip with conversations.json, memories*.json, projects.json, or the JSON alone)
 *   * Saved memories pasted or saved as .txt / .md (one memory per line)
 *   * Any other JSON: text-like fields are collected
 * Only text the user wrote is kept: AI replies, ids, timestamps and account files are skipped.
 *
 * tests/web/extract.test.mjs checks the output equals the Python version's (scripts/web_fixtures_extract.py).
 * Python semantics kept on purpose: str.strip()/splitlines()/re \s and \d are Unicode-aware, json.loads
 * keeps key order and accepts NaN/Infinity, `x or y` truthiness, and malformed exports that make Python
 * raise (AttributeError, TypeError) throw a plain TypeError here (the page shows its generic message for
 * anything that isn't an ExtractError).
 */

import { isZip, listZip, readZipEntry, ZipError } from "./zip.js";

export const MAX_MEMBER_BYTES = 300 * 2 ** 20; // largest single file read from a zip
export const MAX_TOTAL_BYTES = 600 * 2 ** 20; // total uncompressed bytes read from a zip

/** The upload could not be read; the message is safe to show to the user. */
export class ExtractError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExtractError";
  }
}

// ---------- Python's character classes ----------

// re's \s and str.isspace() (they are the same set).
const SPACE = "[\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
// re's \d: Unicode decimal digits (category Nd) as of Python 3.12's Unicode 15.0.
const DIGIT =
  "[\\u{30}-\\u{39}\\u{660}-\\u{669}\\u{6f0}-\\u{6f9}\\u{7c0}-\\u{7c9}\\u{966}-\\u{96f}\\u{9e6}-\\u{9ef}" +
  "\\u{a66}-\\u{a6f}\\u{ae6}-\\u{aef}\\u{b66}-\\u{b6f}\\u{be6}-\\u{bef}\\u{c66}-\\u{c6f}\\u{ce6}-\\u{cef}" +
  "\\u{d66}-\\u{d6f}\\u{de6}-\\u{def}\\u{e50}-\\u{e59}\\u{ed0}-\\u{ed9}\\u{f20}-\\u{f29}\\u{1040}-\\u{1049}" +
  "\\u{1090}-\\u{1099}\\u{17e0}-\\u{17e9}\\u{1810}-\\u{1819}\\u{1946}-\\u{194f}\\u{19d0}-\\u{19d9}" +
  "\\u{1a80}-\\u{1a89}\\u{1a90}-\\u{1a99}\\u{1b50}-\\u{1b59}\\u{1bb0}-\\u{1bb9}\\u{1c40}-\\u{1c49}" +
  "\\u{1c50}-\\u{1c59}\\u{a620}-\\u{a629}\\u{a8d0}-\\u{a8d9}\\u{a900}-\\u{a909}\\u{a9d0}-\\u{a9d9}" +
  "\\u{a9f0}-\\u{a9f9}\\u{aa50}-\\u{aa59}\\u{abf0}-\\u{abf9}\\u{ff10}-\\u{ff19}\\u{104a0}-\\u{104a9}" +
  "\\u{10d30}-\\u{10d39}\\u{11066}-\\u{1106f}\\u{110f0}-\\u{110f9}\\u{11136}-\\u{1113f}\\u{111d0}-\\u{111d9}" +
  "\\u{112f0}-\\u{112f9}\\u{11450}-\\u{11459}\\u{114d0}-\\u{114d9}\\u{11650}-\\u{11659}\\u{116c0}-\\u{116c9}" +
  "\\u{11730}-\\u{11739}\\u{118e0}-\\u{118e9}\\u{11950}-\\u{11959}\\u{11c50}-\\u{11c59}\\u{11d50}-\\u{11d59}" +
  "\\u{11da0}-\\u{11da9}\\u{11f50}-\\u{11f59}\\u{16a60}-\\u{16a69}\\u{16ac0}-\\u{16ac9}\\u{16b50}-\\u{16b59}" +
  "\\u{1d7ce}-\\u{1d7ff}\\u{1e140}-\\u{1e149}\\u{1e2f0}-\\u{1e2f9}\\u{1e4f0}-\\u{1e4f9}\\u{1e950}-\\u{1e959}" +
  "\\u{1fbf0}-\\u{1fbf9}]";
// With re.I, Python's "i" also matches U+0130 and U+0131; JavaScript's case folding doesn't.
const I = "[i\\u0130\\u0131]";
// Python's $ also matches before a final newline.
const END = "(?=\\n?$)";

function isSpaceCode(c) {
  return (
    (c >= 0x09 && c <= 0x0d) || (c >= 0x1c && c <= 0x20) || c === 0x85 || c === 0xa0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000
  );
}

/** str.strip(): unlike String.prototype.trim, keeps U+FEFF and removes \x1c-\x1f and \x85. */
function strip(s) {
  let start = 0;
  let end = s.length;
  while (start < end && isSpaceCode(s.charCodeAt(start))) start++;
  while (end > start && isSpaceCode(s.charCodeAt(end - 1))) end--;
  return start === 0 && end === s.length ? s : s.slice(start, end);
}

function hasNonSpace(s) {
  for (let i = 0; i < s.length; i++) if (!isSpaceCode(s.charCodeAt(i))) return true;
  return false;
}

/** len(s) >= 3, counting code points like Python (an emoji is one character, not two). */
function atLeastThreeChars(s) {
  if (s.length < 3) return false;
  if (s.length >= 6) return true;
  let count = 0;
  for (const _ of s) if (++count >= 3) return true;
  return false;
}

// ---------- file name patterns (re.I) ----------

const CONVERSATIONS_RE = new RegExp(`(?:^|/)conversat${I}ons(?:-${DIGIT}+)?\\.json${END}`, "iu");
const MEMORIES_RE = new RegExp(`(?:^|/)[^/]*memor(?:y|${I}es)[^/]*\\.json${END}`, "iu");
const PROJECTS_RE = new RegExp(`(?:^|/)projects\\.json${END}`, "iu");
const TEXT_FILE_RE = new RegExp(`\\.(?:txt|md|markdown)${END}`, "iu");
const ACCOUNT_FILE_RE = new RegExp(
  `(?:^|/)(?:users?|account|sett${I}ngs|message_feedback|shared_conversat${I}ons)\\.json${END}`,
  "iu",
);

// Keys whose string values are prose, for JSON we don't recognise.
const TEXT_KEYS = new Set([
  "text", "content", "parts", "memory", "memories", "value", "body", "message",
  "summary", "note", "notes", "prompt_template", "description", "title", "fact", "facts",
]);
const SKIP_KEYS = new Set([
  "id", "uuid", "created_at", "updated_at", "create_time", "update_time", "model", "model_slug",
  "sender", "role", "type", "content_type", "status", "account", "email_address", "url", "file_name",
]);

// ---------- Python data model over parsed JSON ----------
// Objects are plain objects (JSON.parse) or Maps (pyJsonParse, when key order needs keeping).

const isDict = (x) => x instanceof Map || (x !== null && typeof x === "object" && !Array.isArray(x));
const isStr = (x) => typeof x === "string";

/** dict.get(key) */
function get(d, key) {
  if (d instanceof Map) return d.get(key);
  return Object.hasOwn(d, key) ? d[key] : undefined;
}

function has(d, key) {
  return d instanceof Map ? d.has(key) : Object.hasOwn(d, key);
}

function entries(d) {
  return d instanceof Map ? [...d.entries()] : Object.entries(d);
}

function typeName(x) {
  if (x === null || x === undefined) return "NoneType";
  if (typeof x === "boolean") return "bool";
  if (typeof x === "number") return Number.isInteger(x) ? "int" : "float";
  if (isStr(x)) return "str";
  if (Array.isArray(x)) return "list";
  return "dict";
}

/** Python truthiness (NaN is true, empty containers are false). */
function truthy(x) {
  if (x === null || x === undefined || x === false) return false;
  if (x === true) return true;
  if (typeof x === "number") return x !== 0;
  if (isStr(x) || Array.isArray(x)) return x.length > 0;
  if (x instanceof Map) return x.size > 0;
  for (const _ in x) return true;
  return false;
}

/** `x or fallback` */
const or = (x, fallback) => (truthy(x) ? x : fallback);

/** The object a `.get()`/`.values()` is called on: Python raises AttributeError when it isn't a dict. */
function dict(x, method = "get") {
  if (isDict(x)) return x;
  throw new TypeError(`'${typeName(x)}' object has no attribute '${method}'`);
}

/** `x.strip()` where Python raises AttributeError for anything but a str. */
function stripStr(x) {
  if (isStr(x)) return strip(x);
  throw new TypeError(`'${typeName(x)}' object has no attribute 'strip'`);
}

/** `for item in x`: lists give items, dicts their keys, strings their characters. */
function iterate(x) {
  if (Array.isArray(x)) return x;
  if (isStr(x)) return Array.from(x);
  if (isDict(x)) return x instanceof Map ? [...x.keys()] : Object.keys(x);
  throw new TypeError(`'${typeName(x)}' object is not iterable`);
}

const EMPTY = new Map();

const isNumber = (x) => typeof x === "number" || typeof x === "boolean";

function compareCodePoints(a, b) {
  let i = 0;
  while (i < a.length && i < b.length) {
    const x = a.codePointAt(i), y = b.codePointAt(i);
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
  }
  return a.length === b.length ? 0 : i >= a.length ? -1 : 1;
}

/** Python's == between JSON values. */
function pyEq(a, b) {
  if (a === b) return true;
  if (isNumber(a) && isNumber(b)) return Number(a) === Number(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => pyEq(x, b[i]));
  if (isDict(a) && isDict(b)) {
    const ea = entries(a);
    if (ea.length !== entries(b).length) return false;
    return ea.every(([k, v]) => has(b, k) && pyEq(v, get(b, k)));
  }
  return false;
}

/** Python's < between JSON values: TypeError for types that don't compare (str and int, two dicts...). */
function pyLt(a, b) {
  if (isNumber(a) && isNumber(b)) return Number(a) < Number(b);
  if (isStr(a) && isStr(b)) return compareCodePoints(a, b) < 0;
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let k = 0; k < n; k++) if (!pyEq(a[k], b[k])) return pyLt(a[k], b[k]);
    return a.length < b.length;
  }
  throw new TypeError(`'<' not supported between instances of '${typeName(a)}' and '${typeName(b)}'`);
}

/** sorted(items, key=keyFn): keys computed first, stable. */
function sortedBy(items, keyFn) {
  const keyed = items.map((item) => ({ item, key: keyFn(item) }));
  if (keyed.length < 2) return keyed.map((k) => k.item);
  if (keyed.every((k) => isNumber(k.key) && !Number.isNaN(k.key))) {
    keyed.sort((p, q) => {
      const a = Number(p.key), b = Number(q.key);
      return a < b ? -1 : b < a ? 1 : 0;
    });
  } else {
    keyed.sort((p, q) => (pyLt(p.key, q.key) ? -1 : pyLt(q.key, p.key) ? 1 : 0));
  }
  return keyed.map((k) => k.item);
}

// ---------- JSON like Python's json.loads ----------

class JsonSyntaxError extends SyntaxError {}

// A key made only of digits (written plainly or as \u003X escapes): JSON.parse would move it to the front.
const DIGIT_KEY_RE = /"(?:[0-9]|\\u003[0-9])+"[ \t\n\r]*:/;

/** json.loads, or NOT_JSON where Python raises JSONDecodeError. */
const NOT_JSON = Symbol("not json");

function parseJson(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    // Python also accepts NaN, Infinity and -Infinity.
    try {
      return pyJsonParse(text);
    } catch (err) {
      if (err instanceof JsonSyntaxError) return NOT_JSON;
      throw err;
    }
  }
  // Objects with integer-like keys lose their order in JSON.parse; Python's dicts keep it.
  return DIGIT_KEY_RE.test(text) ? pyJsonParse(text) : value;
}

/** Order-keeping JSON parser with Python's json.loads rules (objects become Maps). */
function pyJsonParse(text) {
  const n = text.length;
  let i = 0;
  const fail = (what) => {
    throw new JsonSyntaxError(`${what}: char ${i}`);
  };
  const skipSpace = () => {
    for (let c = text.charCodeAt(i); c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d; c = text.charCodeAt(++i));
  };
  const isDigit = (c) => c >= 0x30 && c <= 0x39;

  function value() {
    const c = text.charCodeAt(i);
    if (c === 0x22) return string();
    if (c === 0x7b) return object();
    if (c === 0x5b) return array();
    if (c === 0x6e && text.startsWith("null", i)) return (i += 4), null;
    if (c === 0x74 && text.startsWith("true", i)) return (i += 4), true;
    if (c === 0x66 && text.startsWith("false", i)) return (i += 5), false;
    if (c === 0x4e && text.startsWith("NaN", i)) return (i += 3), NaN;
    if (c === 0x49 && text.startsWith("Infinity", i)) return (i += 8), Infinity;
    if (c === 0x2d && text.startsWith("-Infinity", i)) return (i += 9), -Infinity;
    if (c === 0x2d || isDigit(c)) return number();
    return fail("Expecting value");
  }

  function number() {
    const start = i;
    if (text.charCodeAt(i) === 0x2d) i++;
    const first = text.charCodeAt(i);
    if (first === 0x30) i++;
    else if (first >= 0x31 && first <= 0x39) while (isDigit(text.charCodeAt(i))) i++;
    else {
      i = start;
      return fail("Expecting value");
    }
    if (text.charCodeAt(i) === 0x2e && isDigit(text.charCodeAt(i + 1))) {
      i += 2;
      while (isDigit(text.charCodeAt(i))) i++;
    }
    const e = text.charCodeAt(i);
    if (e === 0x65 || e === 0x45) {
      let j = i + 1;
      const sign = text.charCodeAt(j);
      if (sign === 0x2b || sign === 0x2d) j++;
      if (isDigit(text.charCodeAt(j))) {
        while (isDigit(text.charCodeAt(j))) j++;
        i = j;
      }
    }
    return Number(text.slice(start, i));
  }

  function string() {
    i++;
    let out = "";
    let start = i;
    for (;;) {
      if (i >= n) fail("Unterminated string starting at");
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        out += text.slice(start, i++);
        return out;
      }
      if (c < 0x20) fail("Invalid control character at");
      if (c !== 0x5c) {
        i++;
        continue;
      }
      out += text.slice(start, i);
      const esc = text[i + 1];
      if (esc === "u") {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("Invalid \\uXXXX escape");
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
      } else {
        const ch = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[esc];
        if (ch === undefined) fail("Invalid \\escape");
        out += ch;
        i += 2;
      }
      start = i;
    }
  }

  function object() {
    i++;
    const map = new Map();
    skipSpace();
    if (text.charCodeAt(i) === 0x7d) return i++, map;
    for (;;) {
      if (text.charCodeAt(i) !== 0x22) fail("Expecting property name enclosed in double quotes");
      const key = string();
      skipSpace();
      if (text.charCodeAt(i) !== 0x3a) fail("Expecting ':' delimiter");
      i++;
      skipSpace();
      map.set(key, value());
      skipSpace();
      const c = text.charCodeAt(i);
      if (c === 0x7d) return i++, map;
      if (c !== 0x2c) fail("Expecting ',' delimiter");
      i++;
      skipSpace();
    }
  }

  function array() {
    i++;
    const list = [];
    skipSpace();
    if (text.charCodeAt(i) === 0x5d) return i++, list;
    for (;;) {
      list.push(value());
      skipSpace();
      const c = text.charCodeAt(i);
      if (c === 0x5d) return i++, list;
      if (c !== 0x2c) fail("Expecting ',' delimiter");
      i++;
      skipSpace();
    }
  }

  skipSpace();
  const result = value();
  skipSpace();
  if (i !== n) fail("Extra data");
  return result;
}

// ---------- Extracted ----------

function newExtracted(format, filesRead = []) {
  return { format, segments: [], conversations: 0, assistantMessagesSkipped: 0, filesRead };
}

// ---------- ChatGPT ----------

function isChatgpt(data) {
  return Array.isArray(data) && data.slice(0, 20).some((c) => isDict(c) && has(c, "mapping"));
}

function chatgpt(data, out, seenProfiles) {
  for (const conv of data) {
    if (!isDict(conv)) continue;
    out.conversations += 1;
    const mapping = dict(or(get(conv, "mapping"), EMPTY), "values");
    const nodes = mapping instanceof Map ? [...mapping.values()] : Object.values(mapping);
    const byTime = sortedBy(nodes, (n) => or(get(dict(or(get(dict(or(n, EMPTY)), "message"), EMPTY)), "create_time"), 0));
    for (const node of byTime) {
      const msg = dict(or(get(dict(or(node, EMPTY)), "message"), EMPTY));
      const content = dict(or(get(msg, "content"), EMPTY));
      if (get(content, "content_type") === "user_editable_context") {
        for (const key of ["user_profile", "user_instructions"]) {
          const value = stripStr(or(get(content, key), ""));
          if (value && !seenProfiles.has(value)) {
            seenProfiles.add(value);
            out.segments.push({ text: value, source: "profile" });
          }
        }
        continue;
      }
      const role = get(dict(or(get(msg, "author"), EMPTY)), "role");
      if (role === "assistant") {
        out.assistantMessagesSkipped += 1;
        continue;
      }
      if (role !== "user") continue; // system and tool messages
      const parts = or(get(content, "parts"), []);
      let text = strip(iterate(parts).filter(isStr).join("\n"));
      if (!text && isStr(get(content, "text"))) text = strip(get(content, "text"));
      if (text) out.segments.push({ text, source: "message" });
    }
  }
}

// ---------- Claude ----------

function isClaude(data) {
  return Array.isArray(data) && data.slice(0, 20).some((c) => isDict(c) && has(c, "chat_messages"));
}

function claudeText(msg) {
  const text = get(msg, "text");
  if (isStr(text) && strip(text)) return strip(text);
  const pieces = iterate(or(get(msg, "content"), []))
    .filter((c) => isDict(c) && get(c, "type") === "text" && isStr(get(c, "text")))
    .map((c) => get(c, "text"));
  return strip(pieces.join("\n"));
}

function claude(data, out) {
  for (const conv of data) {
    if (!isDict(conv)) continue;
    out.conversations += 1;
    for (const msg of iterate(or(get(conv, "chat_messages"), []))) {
      if (!isDict(msg)) continue;
      if (get(msg, "sender") !== "human") {
        out.assistantMessagesSkipped += 1;
        continue;
      }
      const text = claudeText(msg);
      if (text) out.segments.push({ text, source: "message" });
      for (const att of iterate(or(get(msg, "attachments"), []))) {
        const extracted = isDict(att) ? get(att, "extracted_content") : null;
        if (isStr(extracted) && strip(extracted)) out.segments.push({ text: strip(extracted), source: "attachment" });
      }
    }
  }
}

// ---------- anything else ----------

function walkStrings(node, source, underTextKey, segments) {
  if (isStr(node)) {
    if (underTextKey) {
      const text = strip(node);
      if (atLeastThreeChars(text)) segments.push({ text, source });
    }
  } else if (Array.isArray(node)) {
    for (const item of node) walkStrings(item, source, underTextKey, segments);
  } else if (isDict(node)) {
    for (const [key, value] of entries(node)) {
      const k = key.toLowerCase();
      if (SKIP_KEYS.has(k)) continue;
      walkStrings(value, source, TEXT_KEYS.has(k) || (underTextKey && !isStr(value)), segments);
    }
  }
}

function genericJson(data, source, out) {
  if (Array.isArray(data) && data.every(isStr)) {
    for (const x of data) {
      const text = strip(x);
      if (text) out.segments.push({ text, source });
    }
    return;
  }
  walkStrings(data, source, false, out.segments);
}

// ---------- text ----------

const FENCE_RE = /```[\s\S]*?(?:```|$)/g;
// str.splitlines() boundaries
const LINE_BREAK_RE = /\r\n|[\n\v\f\r\x1c-\x1e\x85\u2028\u2029]/;
const BULLET_RE = new RegExp(`^${SPACE}*(?:[-*\\u2022\\u00b7]|${DIGIT}+[.)])${SPACE}+`, "u");

function lines(text, source, segments) {
  for (const raw of text.split(LINE_BREAK_RE)) {
    const line = strip(raw.replace(BULLET_RE, ""));
    if (line) segments.push({ text: line, source });
  }
}

/** Pasted memories: one memory per line (bullets and numbering stripped).
 *  A fenced code block stays one piece, so the scanner can skip it whole. */
function textLines(text, source) {
  const segments = [];
  let pos = 0;
  for (const match of text.matchAll(FENCE_RE)) {
    lines(text.slice(pos, match.index), source, segments);
    segments.push({ text: match[0], source });
    pos = match.index + match[0].length;
  }
  lines(text.slice(pos), source, segments);
  return segments;
}

// ---------- HTML ----------

const SCRIPT_STYLE_RE = new RegExp(`<(scr${I}pt|style)(?![\\p{L}\\p{N}_])[\\s\\S]*?</\\1>`, "giu");
const BREAK_RE = new RegExp(`<br${SPACE}*/?>|</(?:p|d${I}v|l${I}|h${DIGIT})>`, "giu");
const TAG_RE = /<[^>]+>/g;
const EMBEDDED_JSON_RE = new RegExp(`jsonData${SPACE}*=${SPACE}*(\\[[\\s\\S]*?\\]);${SPACE}*\\n`, "u"); // ChatGPT chat.html

function htmlToText(html) {
  html = html.replace(SCRIPT_STYLE_RE, " ");
  html = html.replace(BREAK_RE, "\n");
  return unescapeHtml(html.replace(TAG_RE, " "));
}

// html.unescape: HTML5 named and numeric character references.
const CHARREF_RE = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/gu;
const INVALID_CHARREFS = new Map(
  "0:fffd,d:d,80:20ac,81:81,82:201a,83:192,84:201e,85:2026,86:2020,87:2021,88:2c6,89:2030,8a:160,8b:2039,8c:152,8d:8d,8e:17d,8f:8f,90:90,91:2018,92:2019,93:201c,94:201d,95:2022,96:2013,97:2014,98:2dc,99:2122,9a:161,9b:203a,9c:153,9d:9d,9e:17e,9f:178"
    .split(",")
    .map((pair) => pair.split(":").map((hex) => parseInt(hex, 16)))
    .map(([num, cp]) => [num, String.fromCodePoint(cp)]),
);

function isInvalidCodepoint(num) {
  return (
    (num >= 0x1 && num <= 0x8) || num === 0xb || (num >= 0xe && num <= 0x1f) || (num >= 0x7f && num <= 0x9f) ||
    (num >= 0xfdd0 && num <= 0xfdef) || (num & 0xfffe) === 0xfffe
  );
}

let html5 = null; // name (without ";") -> text, and the legacy names that also work without ";"
function html5Entity(name) {
  if (!html5) {
    const table = new Map();
    for (const item of HTML5_ENTITIES.split(/[,\s]+/)) {
      if (!item) continue;
      const [key, value] = item.split("=");
      table.set(key, String.fromCodePoint(...value.split(".").map((hex) => parseInt(hex, 16))));
    }
    html5 = { table, legacy: new Set(HTML5_LEGACY.split(" ")) };
  }
  if (name.endsWith(";")) return html5.table.get(name.slice(0, -1));
  return html5.legacy.has(name) ? html5.table.get(name) : undefined;
}

function replaceCharref(s) {
  if (s[0] === "#") {
    let num;
    if (s[1] === "x" || s[1] === "X") num = parseInt(s.slice(2).replace(/;+$/, ""), 16);
    else {
      const digits = s.slice(1).replace(/;+$/, "");
      // Python's int() refuses decimal strings over 4300 digits (ValueError: a crash, not a replacement).
      if (digits.length > 4300) throw new RangeError("Exceeds the limit (4300 digits) for integer string conversion");
      num = parseInt(digits, 10);
    }
    if (INVALID_CHARREFS.has(num)) return INVALID_CHARREFS.get(num);
    if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) return "\ufffd";
    if (isInvalidCodepoint(num)) return "";
    return String.fromCodePoint(num);
  }
  const named = html5Entity(s);
  if (named !== undefined) return named;
  // The longest name that starts it (the standard allows a few legacy names without the ";").
  for (let x = s.length - 1; x > 1; x--) {
    const prefix = html5Entity(s.slice(0, x));
    if (prefix !== undefined) return prefix + s.slice(x);
  }
  return "&" + s;
}

function unescapeHtml(s) {
  return s.includes("&") ? s.replace(CHARREF_RE, (_, ref) => replaceCharref(ref)) : s;
}

// ---------- bytes ----------

const READ_CHUNK = 8 * 2 ** 20;

/** Decode a whole source as UTF-8 in chunks. fatal: raw.decode("utf-8-sig"); otherwise
 *  raw.decode("utf-8", errors="replace"), which keeps a byte order mark. */
async function readText(source, fatal) {
  const decoder = new TextDecoder("utf-8", fatal ? { fatal: true } : { ignoreBOM: true });
  let text = "";
  for (let pos = 0; pos < source.size; pos += READ_CHUNK) {
    const chunk = await source.read(pos, Math.min(READ_CHUNK, source.size - pos));
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

const utf8Sig = new TextDecoder("utf-8", { fatal: true });
const utf8Replace = new TextDecoder("utf-8", { ignoreBOM: true });

function invalidJson(name) {
  return new ExtractError(`${name} isn't valid JSON. Upload the file exactly as it came out of the export.`);
}

function loadJson(text, name) {
  const data = parseJson(text);
  if (data === NOT_JSON) throw invalidJson(name);
  return data;
}

function fromJsonData(data, out, seenProfiles, genericSource = "document") {
  if (isChatgpt(data)) {
    chatgpt(data, out, seenProfiles);
    return "chatgpt_export";
  }
  if (isClaude(data)) {
    claude(data, out);
    return "claude_export";
  }
  genericJson(data, genericSource, out);
  return "json";
}

// ---------- entry points ----------

/** Pasted text: JSON when it parses, otherwise one memory per line. */
export function extractText(text) {
  const stripped = strip(text);
  if (!stripped) throw new ExtractError("That's empty. Paste your memories, or drop a file.");
  if (stripped[0] === "[" || stripped[0] === "{") {
    const data = parseJson(stripped);
    if (data !== NOT_JSON) {
      const out = newExtracted("json");
      out.format = fromJsonData(data, out, new Set(), "memory");
      return finish(out);
    }
  }
  const out = newExtracted("text");
  out.segments = textLines(stripped, "memory");
  return finish(out);
}

/** An uploaded file: zip export, .json, .html/.htm or text. */
export async function extractFile(source) {
  const filename = source.name;
  const name = (filename || "upload").toLowerCase();
  if (await isZip(source)) return finish(await fromZip(source));
  if (name.endsWith(".json")) {
    let text;
    try {
      text = await readText(source, true);
    } catch (err) {
      if (err instanceof TypeError) throw invalidJson(filename);
      throw err;
    }
    const out = newExtracted("json", [filename]);
    out.format = fromJsonData(loadJson(text, filename), out, new Set(), "memory");
    return finish(out);
  }
  if (name.endsWith(".html") || name.endsWith(".htm")) {
    const html = await readText(source, false);
    const embedded = EMBEDDED_JSON_RE.exec(html);
    if (embedded) {
      const data = parseJson(embedded[1]);
      if (data !== NOT_JSON) {
        const out = newExtracted("json", [filename]);
        out.format = fromJsonData(data, out, new Set());
        return finish(out);
      }
    }
    const out = newExtracted("text");
    out.segments = textLines(htmlToText(html), "document");
    return finish(out);
  }
  let text;
  try {
    text = await readText(source, true);
  } catch (err) {
    if (err instanceof TypeError) {
      throw new ExtractError("That doesn't look like text. Upload a .zip export, a .json file, or a .txt with your memories.");
    }
    throw err;
  }
  return extractText(text);
}

async function fromZip(source) {
  const out = newExtracted("json");
  const seenProfiles = new Set();
  const formats = [];
  let total = 0;
  const infos = (await listZip(source)).filter((i) => !i.name.startsWith("__MACOSX/"));
  let wanted = infos.filter((i) => CONVERSATIONS_RE.test(i.name));
  wanted = wanted.concat(infos.filter((i) => MEMORIES_RE.test(i.name) || PROJECTS_RE.test(i.name)));
  if (!wanted.length) {
    // not an export we know: read loose text and JSON, skip account files
    wanted = infos.filter(
      (i) => (TEXT_FILE_RE.test(i.name) || i.name.toLowerCase().endsWith(".json")) && !ACCOUNT_FILE_RE.test(i.name),
    );
  }
  if (!wanted.length) throw new ExtractError("Found nothing to read in that zip. Use the export zip from ChatGPT or Claude.");
  for (const info of wanted) {
    if (info.size > MAX_MEMBER_BYTES || total + info.size > MAX_TOTAL_BYTES) {
      throw new ExtractError("That export is too big to scan in one go (over 600 MB unpacked).");
    }
    total += info.size;
    let data;
    try {
      data = await readZipEntry(source, info, MAX_MEMBER_BYTES);
    } catch (err) {
      // Python reads bzip2/lzma members and stops with a crash on encrypted ones; here both are skipped.
      if (err instanceof ZipError && err.skippable) continue;
      throw err;
    }
    out.filesRead.push(info.name);
    if (TEXT_FILE_RE.test(info.name)) {
      for (const segment of textLines(utf8Replace.decode(data), "document")) out.segments.push(segment);
      formats.push("text");
      continue;
    }
    let text;
    try {
      text = utf8Sig.decode(data);
    } catch {
      throw invalidJson(info.name);
    }
    data = null; // let the bytes go before parsing
    const parsed = loadJson(text, info.name);
    if (MEMORIES_RE.test(info.name)) {
      genericJson(parsed, "memory", out);
      formats.push("json");
    } else if (PROJECTS_RE.test(info.name)) {
      genericJson(parsed, "project", out);
      formats.push("json");
    } else {
      formats.push(fromJsonData(parsed, out, seenProfiles));
    }
  }
  for (const preferred of ["chatgpt_export", "claude_export", "json", "text"]) {
    if (formats.includes(preferred)) {
      out.format = preferred;
      break;
    }
  }
  return out;
}

function finish(out) {
  out.segments = out.segments.filter((s) => hasNonSpace(s.text));
  if (!out.segments.length) {
    throw new ExtractError("We couldn't find anything you wrote in there. Nothing to judge. Suspicious.");
  }
  return out;
}

// ---------- sources ----------

/** A browser File or Blob, read a slice at a time. */
export function fileSource(file) {
  return {
    name: file.name ?? "",
    size: file.size,
    read: async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
  };
}

/** Bytes already in memory. */
export function bytesSource(name, bytes) {
  return {
    name,
    size: bytes.length,
    read: async (offset, length) => bytes.subarray(offset, Math.min(offset + length, bytes.length)),
  };
}

// ---------- HTML5 named character references (Python's html.entities.html5) ----------
// name=code point(s) in hex, for names written with a trailing ";"; HTML5_LEGACY also work without it.

const HTML5_LEGACY = 
  "AElig AMP Aacute Acirc Agrave Aring Atilde Auml COPY Ccedil ETH Eacute Ecirc Egrave Euml GT Iacute Icirc " +
  "Igrave Iuml LT Ntilde Oacute Ocirc Ograve Oslash Otilde Ouml QUOT REG THORN Uacute Ucirc Ugrave Uuml Yacute " +
  "aacute acirc acute aelig agrave amp aring atilde auml brvbar ccedil cedil cent copy curren deg divide eacute " +
  "ecirc egrave eth euml frac12 frac14 frac34 gt iacute icirc iexcl igrave iquest iuml laquo lt macr micro middot " +
  "nbsp not ntilde oacute ocirc ograve ordf ordm oslash otilde ouml para plusmn pound quot raquo reg sect shy " +
  "sup1 sup2 sup3 szlig thorn times uacute ucirc ugrave uml uuml yacute yen yuml";

const HTML5_ENTITIES = `
AElig=c6,AMP=26,Aacute=c1,Abreve=102,Acirc=c2,Acy=410,Afr=1d504,Agrave=c0,Alpha=391,Amacr=100,And=2a53,Aogon=104,Aopf=1d538,ApplyFunction=2061,Aring=c5,Ascr=1d49c,Assign=2254,Atilde=c3,Auml=c4,Backslash=2216,Barv=2ae7,Barwed=2306,Bcy=411,Because=2235,Bernoullis=212c,Beta=392,Bfr=1d505,Bopf=1d539,Breve=2d8,Bscr=212c,Bumpeq=224e,CHcy=427,COPY=a9,Cacute=106,Cap=22d2,CapitalDifferentialD=2145,Cayleys=212d,Ccaron=10c,Ccedil=c7,Ccirc=108,Cconint=2230,Cdot=10a,Cedilla=b8,CenterDot=b7,Cfr=212d,Chi=3a7,CircleDot=2299,CircleMinus=2296,CirclePlus=2295,CircleTimes=2297,ClockwiseContourIntegral=2232,CloseCurlyDoubleQuote=201d,CloseCurlyQuote=2019,Colon=2237,Colone=2a74,Congruent=2261,Conint=222f,ContourIntegral=222e,Copf=2102,Coproduct=2210,CounterClockwiseContourIntegral=2233,Cross=2a2f,Cscr=1d49e,Cup=22d3,CupCap=224d,DD=2145,DDotrahd=2911,DJcy=402,DScy=405,DZcy=40f,Dagger=2021,Darr=21a1,Dashv=2ae4,Dcaron=10e,Dcy=414,Del=2207,Delta=394,Dfr=1d507,DiacriticalAcute=b4,DiacriticalDot=2d9,DiacriticalDoubleAcute=2dd,DiacriticalGrave=60,DiacriticalTilde=2dc,Diamond=22c4,DifferentialD=2146,Dopf=1d53b,Dot=a8,DotDot=20dc,DotEqual=2250,DoubleContourIntegral=222f,DoubleDot=a8,DoubleDownArrow=21d3,DoubleLeftArrow=21d0,DoubleLeftRightArrow=21d4,DoubleLeftTee=2ae4,DoubleLongLeftArrow=27f8,DoubleLongLeftRightArrow=27fa,DoubleLongRightArrow=27f9,DoubleRightArrow=21d2,DoubleRightTee=22a8,DoubleUpArrow=21d1,DoubleUpDownArrow=21d5,DoubleVerticalBar=2225,DownArrow=2193,DownArrowBar=2913,DownArrowUpArrow=21f5,DownBreve=311,DownLeftRightVector=2950,DownLeftTeeVector=295e,DownLeftVector=21bd,DownLeftVectorBar=2956,DownRightTeeVector=295f,DownRightVector=21c1,DownRightVectorBar=2957,DownTee=22a4,DownTeeArrow=21a7,Downarrow=21d3,Dscr=1d49f,Dstrok=110,ENG=14a,ETH=d0,Eacute=c9,Ecaron=11a,Ecirc=ca,Ecy=42d,Edot=116,Efr=1d508,Egrave=c8,Element=2208,Emacr=112,EmptySmallSquare=25fb,EmptyVerySmallSquare=25ab,Eogon=118,Eopf=1d53c,Epsilon=395,Equal=2a75,EqualTilde=2242,Equilibrium=21cc,Escr=2130,Esim=2a73,Eta=397,Euml=cb,Exists=2203,ExponentialE=2147,Fcy=424,Ffr=1d509,FilledSmallSquare=25fc,FilledVerySmallSquare=25aa,Fopf=1d53d,ForAll=2200,Fouriertrf=2131,Fscr=2131,GJcy=403,GT=3e,Gamma=393,Gammad=3dc,Gbreve=11e,Gcedil=122,Gcirc=11c,Gcy=413,Gdot=120,Gfr=1d50a,Gg=22d9,Gopf=1d53e,GreaterEqual=2265,GreaterEqualLess=22db,GreaterFullEqual=2267,GreaterGreater=2aa2,GreaterLess=2277,GreaterSlantEqual=2a7e,GreaterTilde=2273,Gscr=1d4a2,Gt=226b,HARDcy=42a,Hacek=2c7,Hat=5e,Hcirc=124,Hfr=210c,HilbertSpace=210b,Hopf=210d,HorizontalLine=2500,Hscr=210b,Hstrok=126,HumpDownHump=224e,HumpEqual=224f,IEcy=415,IJlig=132,IOcy=401,Iacute=cd,Icirc=ce,Icy=418,Idot=130,Ifr=2111,Igrave=cc,Im=2111,Imacr=12a,ImaginaryI=2148,Implies=21d2,Int=222c,Integral=222b,Intersection=22c2,InvisibleComma=2063,InvisibleTimes=2062,Iogon=12e,Iopf=1d540,Iota=399,Iscr=2110,Itilde=128,Iukcy=406,Iuml=cf,Jcirc=134,Jcy=419,Jfr=1d50d,Jopf=1d541,Jscr=1d4a5,Jsercy=408,Jukcy=404,KHcy=425,KJcy=40c,Kappa=39a,Kcedil=136,Kcy=41a,Kfr=1d50e,Kopf=1d542,Kscr=1d4a6,LJcy=409,LT=3c,Lacute=139,Lambda=39b,Lang=27ea,Laplacetrf=2112,Larr=219e,Lcaron=13d,Lcedil=13b,Lcy=41b,LeftAngleBracket=27e8,LeftArrow=2190,LeftArrowBar=21e4,LeftArrowRightArrow=21c6,LeftCeiling=2308,LeftDoubleBracket=27e6,LeftDownTeeVector=2961,LeftDownVector=21c3,LeftDownVectorBar=2959,LeftFloor=230a,LeftRightArrow=2194,LeftRightVector=294e,LeftTee=22a3,LeftTeeArrow=21a4,LeftTeeVector=295a,LeftTriangle=22b2,LeftTriangleBar=29cf,LeftTriangleEqual=22b4,LeftUpDownVector=2951,LeftUpTeeVector=2960,LeftUpVector=21bf,LeftUpVectorBar=2958,LeftVector=21bc,LeftVectorBar=2952,Leftarrow=21d0,Leftrightarrow=21d4,LessEqualGreater=22da,LessFullEqual=2266,LessGreater=2276,LessLess=2aa1,LessSlantEqual=2a7d,LessTilde=2272,Lfr=1d50f,Ll=22d8,Lleftarrow=21da,Lmidot=13f,LongLeftArrow=27f5,LongLeftRightArrow=27f7,LongRightArrow=27f6,Longleftarrow=27f8,Longleftrightarrow=27fa,Longrightarrow=27f9,Lopf=1d543,LowerLeftArrow=2199,LowerRightArrow=2198,Lscr=2112,Lsh=21b0,Lstrok=141,Lt=226a,Map=2905,Mcy=41c,MediumSpace=205f,Mellintrf=2133,Mfr=1d510,MinusPlus=2213,Mopf=1d544,Mscr=2133,Mu=39c,NJcy=40a,Nacute=143,Ncaron=147,Ncedil=145,Ncy=41d,NegativeMediumSpace=200b,NegativeThickSpace=200b,NegativeThinSpace=200b,NegativeVeryThinSpace=200b,NestedGreaterGreater=226b,NestedLessLess=226a,NewLine=a,Nfr=1d511,NoBreak=2060,NonBreakingSpace=a0,Nopf=2115,Not=2aec,NotCongruent=2262,NotCupCap=226d,NotDoubleVerticalBar=2226,NotElement=2209,NotEqual=2260,NotEqualTilde=2242.338,NotExists=2204,NotGreater=226f,NotGreaterEqual=2271,NotGreaterFullEqual=2267.338,NotGreaterGreater=226b.338,NotGreaterLess=2279,NotGreaterSlantEqual=2a7e.338,NotGreaterTilde=2275,NotHumpDownHump=224e.338,NotHumpEqual=224f.338,NotLeftTriangle=22ea,NotLeftTriangleBar=29cf.338,NotLeftTriangleEqual=22ec,NotLess=226e,NotLessEqual=2270,NotLessGreater=2278,NotLessLess=226a.338,NotLessSlantEqual=2a7d.338,NotLessTilde=2274,NotNestedGreaterGreater=2aa2.338,NotNestedLessLess=2aa1.338,NotPrecedes=2280,NotPrecedesEqual=2aaf.338,NotPrecedesSlantEqual=22e0,NotReverseElement=220c,NotRightTriangle=22eb,NotRightTriangleBar=29d0.338,NotRightTriangleEqual=22ed,NotSquareSubset=228f.338,NotSquareSubsetEqual=22e2,NotSquareSuperset=2290.338,NotSquareSupersetEqual=22e3,NotSubset=2282.20d2,NotSubsetEqual=2288,NotSucceeds=2281,NotSucceedsEqual=2ab0.338,NotSucceedsSlantEqual=22e1,NotSucceedsTilde=227f.338,NotSuperset=2283.20d2,NotSupersetEqual=2289,NotTilde=2241,NotTildeEqual=2244,NotTildeFullEqual=2247,NotTildeTilde=2249,NotVerticalBar=2224,Nscr=1d4a9,Ntilde=d1,Nu=39d,OElig=152,Oacute=d3,Ocirc=d4,Ocy=41e,Odblac=150,Ofr=1d512,Ograve=d2,Omacr=14c,Omega=3a9,Omicron=39f,Oopf=1d546,OpenCurlyDoubleQuote=201c,OpenCurlyQuote=2018,Or=2a54,Oscr=1d4aa,Oslash=d8,Otilde=d5,Otimes=2a37,Ouml=d6,OverBar=203e,OverBrace=23de,OverBracket=23b4,OverParenthesis=23dc,PartialD=2202,Pcy=41f,Pfr=1d513,Phi=3a6,Pi=3a0,PlusMinus=b1,Poincareplane=210c,Popf=2119,Pr=2abb,Precedes=227a,PrecedesEqual=2aaf,PrecedesSlantEqual=227c,PrecedesTilde=227e,Prime=2033,Product=220f,Proportion=2237,Proportional=221d,Pscr=1d4ab,Psi=3a8,QUOT=22,Qfr=1d514,Qopf=211a,Qscr=1d4ac,RBarr=2910,REG=ae,Racute=154,Rang=27eb,Rarr=21a0,Rarrtl=2916,Rcaron=158,Rcedil=156,Rcy=420,Re=211c,ReverseElement=220b,ReverseEquilibrium=21cb,ReverseUpEquilibrium=296f,Rfr=211c,Rho=3a1,RightAngleBracket=27e9,RightArrow=2192,RightArrowBar=21e5,RightArrowLeftArrow=21c4,RightCeiling=2309,RightDoubleBracket=27e7,RightDownTeeVector=295d,RightDownVector=21c2,RightDownVectorBar=2955,RightFloor=230b,RightTee=22a2,RightTeeArrow=21a6,RightTeeVector=295b,RightTriangle=22b3,RightTriangleBar=29d0,RightTriangleEqual=22b5,RightUpDownVector=294f,RightUpTeeVector=295c,RightUpVector=21be,RightUpVectorBar=2954,RightVector=21c0,RightVectorBar=2953,Rightarrow=21d2,Ropf=211d,RoundImplies=2970,Rrightarrow=21db,Rscr=211b,Rsh=21b1,RuleDelayed=29f4,SHCHcy=429,SHcy=428,SOFTcy=42c,Sacute=15a,Sc=2abc,Scaron=160,Scedil=15e,Scirc=15c,Scy=421,Sfr=1d516,ShortDownArrow=2193,ShortLeftArrow=2190,ShortRightArrow=2192,ShortUpArrow=2191,Sigma=3a3,SmallCircle=2218,Sopf=1d54a,Sqrt=221a,Square=25a1,SquareIntersection=2293,SquareSubset=228f,SquareSubsetEqual=2291,SquareSuperset=2290,SquareSupersetEqual=2292,SquareUnion=2294,Sscr=1d4ae,Star=22c6,Sub=22d0,Subset=22d0,SubsetEqual=2286,Succeeds=227b,SucceedsEqual=2ab0,SucceedsSlantEqual=227d,SucceedsTilde=227f,SuchThat=220b,Sum=2211,Sup=22d1,Superset=2283,SupersetEqual=2287,Supset=22d1,THORN=de,TRADE=2122,TSHcy=40b,TScy=426,Tab=9,Tau=3a4,Tcaron=164,Tcedil=162,Tcy=422,Tfr=1d517,Therefore=2234,Theta=398,ThickSpace=205f.200a,ThinSpace=2009,Tilde=223c,TildeEqual=2243,TildeFullEqual=2245,TildeTilde=2248,Topf=1d54b,TripleDot=20db,Tscr=1d4af,Tstrok=166,Uacute=da,Uarr=219f,Uarrocir=2949,Ubrcy=40e,Ubreve=16c,Ucirc=db,Ucy=423,Udblac=170,Ufr=1d518,Ugrave=d9,Umacr=16a,UnderBar=5f,UnderBrace=23df,UnderBracket=23b5,UnderParenthesis=23dd,Union=22c3,UnionPlus=228e,Uogon=172,Uopf=1d54c,UpArrow=2191,UpArrowBar=2912,UpArrowDownArrow=21c5,UpDownArrow=2195,UpEquilibrium=296e,UpTee=22a5,UpTeeArrow=21a5,Uparrow=21d1,Updownarrow=21d5,UpperLeftArrow=2196,UpperRightArrow=2197,Upsi=3d2,Upsilon=3a5,Uring=16e,Uscr=1d4b0,Utilde=168,Uuml=dc,VDash=22ab,Vbar=2aeb,Vcy=412,Vdash=22a9,Vdashl=2ae6,Vee=22c1,Verbar=2016,Vert=2016,VerticalBar=2223,VerticalLine=7c,VerticalSeparator=2758,VerticalTilde=2240,VeryThinSpace=200a,Vfr=1d519,Vopf=1d54d,Vscr=1d4b1,Vvdash=22aa,Wcirc=174,Wedge=22c0,Wfr=1d51a,Wopf=1d54e,Wscr=1d4b2,Xfr=1d51b,Xi=39e,Xopf=1d54f,Xscr=1d4b3,YAcy=42f,YIcy=407,YUcy=42e,Yacute=dd,Ycirc=176,Ycy=42b,Yfr=1d51c,Yopf=1d550,Yscr=1d4b4,Yuml=178,ZHcy=416,Zacute=179,Zcaron=17d,Zcy=417,Zdot=17b,ZeroWidthSpace=200b,Zeta=396,Zfr=2128,Zopf=2124,Zscr=1d4b5,aacute=e1,abreve=103,ac=223e,acE=223e.333,acd=223f,acirc=e2,acute=b4,acy=430,aelig=e6,af=2061,afr=1d51e,agrave=e0,alefsym=2135,aleph=2135,alpha=3b1,amacr=101,amalg=2a3f,amp=26,and=2227,andand=2a55,andd=2a5c,andslope=2a58,andv=2a5a,ang=2220,ange=29a4,angle=2220,angmsd=2221,angmsdaa=29a8,angmsdab=29a9,angmsdac=29aa,angmsdad=29ab,angmsdae=29ac,angmsdaf=29ad,angmsdag=29ae,angmsdah=29af,angrt=221f,angrtvb=22be,angrtvbd=299d,angsph=2222,angst=c5,angzarr=237c,aogon=105,aopf=1d552,ap=2248,apE=2a70,apacir=2a6f,ape=224a,apid=224b,apos=27,approx=2248,approxeq=224a,aring=e5,ascr=1d4b6,ast=2a,asymp=2248,asympeq=224d,atilde=e3,auml=e4,awconint=2233,awint=2a11,bNot=2aed,backcong=224c,backepsilon=3f6,backprime=2035,backsim=223d,backsimeq=22cd,barvee=22bd,barwed=2305,barwedge=2305,bbrk=23b5,bbrktbrk=23b6,bcong=224c,bcy=431,bdquo=201e,becaus=2235,because=2235,bemptyv=29b0,bepsi=3f6,bernou=212c,beta=3b2,beth=2136,between=226c,bfr=1d51f,bigcap=22c2,bigcirc=25ef,bigcup=22c3,bigodot=2a00,bigoplus=2a01,bigotimes=2a02,bigsqcup=2a06,bigstar=2605,bigtriangledown=25bd,bigtriangleup=25b3,biguplus=2a04,bigvee=22c1,bigwedge=22c0,bkarow=290d,blacklozenge=29eb,blacksquare=25aa,blacktriangle=25b4,blacktriangledown=25be,blacktriangleleft=25c2,blacktriangleright=25b8,blank=2423,blk12=2592,blk14=2591,blk34=2593,block=2588,bne=3d.20e5,bnequiv=2261.20e5,bnot=2310,bopf=1d553,bot=22a5,bottom=22a5,bowtie=22c8,boxDL=2557,boxDR=2554,boxDl=2556,boxDr=2553,boxH=2550,boxHD=2566,boxHU=2569,boxHd=2564,boxHu=2567,boxUL=255d,boxUR=255a,boxUl=255c,boxUr=2559,boxV=2551,boxVH=256c,boxVL=2563,boxVR=2560,boxVh=256b,boxVl=2562,boxVr=255f,boxbox=29c9,boxdL=2555,boxdR=2552,boxdl=2510,boxdr=250c,boxh=2500,boxhD=2565,boxhU=2568,boxhd=252c,boxhu=2534,boxminus=229f,boxplus=229e,boxtimes=22a0,boxuL=255b,boxuR=2558,boxul=2518,boxur=2514,boxv=2502,boxvH=256a,boxvL=2561,boxvR=255e,boxvh=253c,boxvl=2524,boxvr=251c,bprime=2035,breve=2d8,brvbar=a6,bscr=1d4b7,bsemi=204f,bsim=223d,bsime=22cd,bsol=5c,bsolb=29c5,bsolhsub=27c8,bull=2022,bullet=2022,bump=224e,bumpE=2aae,bumpe=224f,bumpeq=224f,cacute=107,cap=2229,capand=2a44,capbrcup=2a49,capcap=2a4b,capcup=2a47,capdot=2a40,caps=2229.fe00,caret=2041,caron=2c7,ccaps=2a4d,ccaron=10d,ccedil=e7,ccirc=109,ccups=2a4c,ccupssm=2a50,cdot=10b,cedil=b8,cemptyv=29b2,cent=a2,centerdot=b7,cfr=1d520,chcy=447,check=2713,checkmark=2713,chi=3c7,cir=25cb,cirE=29c3,circ=2c6,circeq=2257,circlearrowleft=21ba,circlearrowright=21bb,circledR=ae,circledS=24c8,circledast=229b,circledcirc=229a,circleddash=229d,cire=2257,cirfnint=2a10,cirmid=2aef,cirscir=29c2,clubs=2663,clubsuit=2663,colon=3a,colone=2254,coloneq=2254,comma=2c,commat=40,comp=2201,compfn=2218,complement=2201,complexes=2102,cong=2245,congdot=2a6d,conint=222e,copf=1d554,coprod=2210,copy=a9,copysr=2117,crarr=21b5,cross=2717,cscr=1d4b8,csub=2acf,csube=2ad1,csup=2ad0,csupe=2ad2,ctdot=22ef,cudarrl=2938,cudarrr=2935,cuepr=22de,cuesc=22df,cularr=21b6,cularrp=293d,cup=222a,cupbrcap=2a48,cupcap=2a46,cupcup=2a4a,cupdot=228d,cupor=2a45,cups=222a.fe00,curarr=21b7,curarrm=293c,curlyeqprec=22de,curlyeqsucc=22df,curlyvee=22ce,curlywedge=22cf,curren=a4,curvearrowleft=21b6,curvearrowright=21b7,cuvee=22ce,cuwed=22cf,cwconint=2232,cwint=2231,cylcty=232d,dArr=21d3,dHar=2965,dagger=2020,daleth=2138,darr=2193,dash=2010,dashv=22a3,dbkarow=290f,dblac=2dd,dcaron=10f,dcy=434,dd=2146,ddagger=2021,ddarr=21ca,ddotseq=2a77,deg=b0,delta=3b4,demptyv=29b1,dfisht=297f,dfr=1d521,dharl=21c3,dharr=21c2,diam=22c4,diamond=22c4,diamondsuit=2666,diams=2666,die=a8,digamma=3dd,disin=22f2,div=f7,divide=f7,divideontimes=22c7,divonx=22c7,djcy=452,dlcorn=231e,dlcrop=230d,dollar=24,dopf=1d555,dot=2d9,doteq=2250,doteqdot=2251,dotminus=2238,dotplus=2214,dotsquare=22a1,doublebarwedge=2306,downarrow=2193,downdownarrows=21ca,downharpoonleft=21c3,downharpoonright=21c2,drbkarow=2910,drcorn=231f,drcrop=230c,dscr=1d4b9,dscy=455,dsol=29f6,dstrok=111,dtdot=22f1,dtri=25bf,dtrif=25be,duarr=21f5,duhar=296f,dwangle=29a6,dzcy=45f,dzigrarr=27ff,eDDot=2a77,eDot=2251,eacute=e9,easter=2a6e,ecaron=11b,ecir=2256,ecirc=ea,ecolon=2255,ecy=44d,edot=117,ee=2147,efDot=2252,efr=1d522,eg=2a9a,egrave=e8,egs=2a96,egsdot=2a98,el=2a99,elinters=23e7,ell=2113,els=2a95,elsdot=2a97,emacr=113,empty=2205,emptyset=2205,emptyv=2205,emsp=2003,emsp13=2004,emsp14=2005,eng=14b,ensp=2002,eogon=119,eopf=1d556,epar=22d5,eparsl=29e3,eplus=2a71,epsi=3b5,epsilon=3b5,epsiv=3f5,eqcirc=2256,eqcolon=2255,eqsim=2242,eqslantgtr=2a96,eqslantless=2a95,equals=3d,equest=225f,equiv=2261,equivDD=2a78,eqvparsl=29e5,erDot=2253,erarr=2971,escr=212f,esdot=2250,esim=2242,eta=3b7,eth=f0,euml=eb,euro=20ac,excl=21,exist=2203,expectation=2130,exponentiale=2147,fallingdotseq=2252,fcy=444,female=2640,ffilig=fb03,fflig=fb00,ffllig=fb04,ffr=1d523,filig=fb01,fjlig=66.6a,flat=266d,fllig=fb02,fltns=25b1,fnof=192,fopf=1d557,forall=2200,fork=22d4,forkv=2ad9,fpartint=2a0d,frac12=bd,frac13=2153,frac14=bc,frac15=2155,frac16=2159,frac18=215b,frac23=2154,frac25=2156,frac34=be,frac35=2157,frac38=215c,frac45=2158,frac56=215a,frac58=215d,frac78=215e,frasl=2044,frown=2322,fscr=1d4bb,gE=2267,gEl=2a8c,gacute=1f5,gamma=3b3,gammad=3dd,gap=2a86,gbreve=11f,gcirc=11d,gcy=433,gdot=121,ge=2265,gel=22db,geq=2265,geqq=2267,geqslant=2a7e,ges=2a7e,gescc=2aa9,gesdot=2a80,gesdoto=2a82,gesdotol=2a84,gesl=22db.fe00,gesles=2a94,gfr=1d524,gg=226b,ggg=22d9,gimel=2137,gjcy=453,gl=2277,glE=2a92,gla=2aa5,glj=2aa4,gnE=2269,gnap=2a8a,gnapprox=2a8a,gne=2a88,gneq=2a88,gneqq=2269,gnsim=22e7,gopf=1d558,grave=60,gscr=210a,gsim=2273,gsime=2a8e,gsiml=2a90,gt=3e,gtcc=2aa7,gtcir=2a7a,gtdot=22d7,gtlPar=2995,gtquest=2a7c,gtrapprox=2a86,gtrarr=2978,gtrdot=22d7,gtreqless=22db,gtreqqless=2a8c,gtrless=2277,gtrsim=2273,gvertneqq=2269.fe00,gvnE=2269.fe00,hArr=21d4,hairsp=200a,half=bd,hamilt=210b,hardcy=44a,harr=2194,harrcir=2948,harrw=21ad,hbar=210f,hcirc=125,hearts=2665,heartsuit=2665,hellip=2026,hercon=22b9,hfr=1d525,hksearow=2925,hkswarow=2926,hoarr=21ff,homtht=223b,hookleftarrow=21a9,hookrightarrow=21aa,hopf=1d559,horbar=2015,hscr=1d4bd,hslash=210f,hstrok=127,hybull=2043,hyphen=2010,iacute=ed,ic=2063,icirc=ee,icy=438,iecy=435,iexcl=a1,iff=21d4,ifr=1d526,igrave=ec,ii=2148,iiiint=2a0c,iiint=222d,iinfin=29dc,iiota=2129,ijlig=133,imacr=12b,image=2111,imagline=2110,imagpart=2111,imath=131,imof=22b7,imped=1b5,in=2208,incare=2105,infin=221e,infintie=29dd,inodot=131,int=222b,intcal=22ba,integers=2124,intercal=22ba,intlarhk=2a17,intprod=2a3c,iocy=451,iogon=12f,iopf=1d55a,iota=3b9,iprod=2a3c,iquest=bf,iscr=1d4be,isin=2208,isinE=22f9,isindot=22f5,isins=22f4,isinsv=22f3,isinv=2208,it=2062,itilde=129,iukcy=456,iuml=ef,jcirc=135,jcy=439,jfr=1d527,jmath=237,jopf=1d55b,jscr=1d4bf,jsercy=458,jukcy=454,kappa=3ba,kappav=3f0,kcedil=137,kcy=43a,kfr=1d528,kgreen=138,khcy=445,kjcy=45c,kopf=1d55c,kscr=1d4c0,lAarr=21da,lArr=21d0,lAtail=291b,lBarr=290e,lE=2266,lEg=2a8b,lHar=2962,lacute=13a,laemptyv=29b4,lagran=2112,lambda=3bb,lang=27e8,langd=2991,langle=27e8,lap=2a85,laquo=ab,larr=2190,larrb=21e4,larrbfs=291f,larrfs=291d,larrhk=21a9,larrlp=21ab,larrpl=2939,larrsim=2973,larrtl=21a2,lat=2aab,latail=2919,late=2aad,lates=2aad.fe00,lbarr=290c,lbbrk=2772,lbrace=7b,lbrack=5b,lbrke=298b,lbrksld=298f,lbrkslu=298d,lcaron=13e,lcedil=13c,lceil=2308,lcub=7b,lcy=43b,ldca=2936,ldquo=201c,ldquor=201e,ldrdhar=2967,ldrushar=294b,ldsh=21b2,le=2264,leftarrow=2190,leftarrowtail=21a2,leftharpoondown=21bd,leftharpoonup=21bc,leftleftarrows=21c7,leftrightarrow=2194,leftrightarrows=21c6,leftrightharpoons=21cb,leftrightsquigarrow=21ad,leftthreetimes=22cb,leg=22da,leq=2264,leqq=2266,leqslant=2a7d,les=2a7d,lescc=2aa8,lesdot=2a7f,lesdoto=2a81,lesdotor=2a83,lesg=22da.fe00,lesges=2a93,lessapprox=2a85,lessdot=22d6,lesseqgtr=22da,lesseqqgtr=2a8b,lessgtr=2276,lesssim=2272,lfisht=297c,lfloor=230a,lfr=1d529,lg=2276,lgE=2a91,lhard=21bd,lharu=21bc,lharul=296a,lhblk=2584,ljcy=459,ll=226a,llarr=21c7,llcorner=231e,llhard=296b,lltri=25fa,lmidot=140,lmoust=23b0,lmoustache=23b0,lnE=2268,lnap=2a89,lnapprox=2a89,lne=2a87,lneq=2a87,lneqq=2268,lnsim=22e6,loang=27ec,loarr=21fd,lobrk=27e6,longleftarrow=27f5,longleftrightarrow=27f7,longmapsto=27fc,longrightarrow=27f6,looparrowleft=21ab,looparrowright=21ac,lopar=2985,lopf=1d55d,loplus=2a2d,lotimes=2a34,lowast=2217,lowbar=5f,loz=25ca,lozenge=25ca,lozf=29eb,lpar=28,lparlt=2993,lrarr=21c6,lrcorner=231f,lrhar=21cb,lrhard=296d,lrm=200e,lrtri=22bf,lsaquo=2039,lscr=1d4c1,lsh=21b0,lsim=2272,lsime=2a8d,lsimg=2a8f,lsqb=5b,lsquo=2018,lsquor=201a,lstrok=142,lt=3c,ltcc=2aa6,ltcir=2a79,ltdot=22d6,lthree=22cb,ltimes=22c9,ltlarr=2976,ltquest=2a7b,ltrPar=2996,ltri=25c3,ltrie=22b4,ltrif=25c2,lurdshar=294a,luruhar=2966,lvertneqq=2268.fe00,lvnE=2268.fe00,mDDot=223a,macr=af,male=2642,malt=2720,maltese=2720,map=21a6,mapsto=21a6,mapstodown=21a7,mapstoleft=21a4,mapstoup=21a5,marker=25ae,mcomma=2a29,mcy=43c,mdash=2014,measuredangle=2221,mfr=1d52a,mho=2127,micro=b5,mid=2223,midast=2a,midcir=2af0,middot=b7,minus=2212,minusb=229f,minusd=2238,minusdu=2a2a,mlcp=2adb,mldr=2026,mnplus=2213,models=22a7,mopf=1d55e,mp=2213,mscr=1d4c2,mstpos=223e,mu=3bc,multimap=22b8,mumap=22b8,nGg=22d9.338,nGt=226b.20d2,nGtv=226b.338,nLeftarrow=21cd,nLeftrightarrow=21ce,nLl=22d8.338,nLt=226a.20d2,nLtv=226a.338,nRightarrow=21cf,nVDash=22af,nVdash=22ae,nabla=2207,nacute=144,nang=2220.20d2,nap=2249,napE=2a70.338,napid=224b.338,napos=149,napprox=2249,natur=266e,natural=266e,naturals=2115,nbsp=a0,nbump=224e.338,nbumpe=224f.338,ncap=2a43,ncaron=148,ncedil=146,ncong=2247,ncongdot=2a6d.338,ncup=2a42,ncy=43d,ndash=2013,ne=2260,neArr=21d7,nearhk=2924,nearr=2197,nearrow=2197,nedot=2250.338,nequiv=2262,nesear=2928,nesim=2242.338,nexist=2204,nexists=2204,nfr=1d52b,ngE=2267.338,nge=2271,ngeq=2271,ngeqq=2267.338,ngeqslant=2a7e.338,nges=2a7e.338,ngsim=2275,ngt=226f,ngtr=226f,nhArr=21ce,nharr=21ae,nhpar=2af2,ni=220b,nis=22fc,nisd=22fa,niv=220b,njcy=45a,nlArr=21cd,nlE=2266.338,nlarr=219a,nldr=2025,nle=2270,nleftarrow=219a,nleftrightarrow=21ae,nleq=2270,nleqq=2266.338,nleqslant=2a7d.338,nles=2a7d.338,nless=226e,nlsim=2274,nlt=226e,nltri=22ea,nltrie=22ec,nmid=2224,nopf=1d55f,not=ac,notin=2209,notinE=22f9.338,notindot=22f5.338,notinva=2209,notinvb=22f7,notinvc=22f6,notni=220c,notniva=220c,notnivb=22fe,notnivc=22fd,npar=2226,nparallel=2226,nparsl=2afd.20e5,npart=2202.338,npolint=2a14,npr=2280,nprcue=22e0,npre=2aaf.338,nprec=2280,npreceq=2aaf.338,nrArr=21cf,nrarr=219b,nrarrc=2933.338,nrarrw=219d.338,nrightarrow=219b,nrtri=22eb,nrtrie=22ed,nsc=2281,nsccue=22e1,nsce=2ab0.338,nscr=1d4c3,nshortmid=2224,nshortparallel=2226,nsim=2241,nsime=2244,nsimeq=2244,nsmid=2224,nspar=2226,nsqsube=22e2,nsqsupe=22e3,nsub=2284,nsubE=2ac5.338,nsube=2288,nsubset=2282.20d2,nsubseteq=2288,nsubseteqq=2ac5.338,nsucc=2281,nsucceq=2ab0.338,nsup=2285,nsupE=2ac6.338,nsupe=2289,nsupset=2283.20d2,nsupseteq=2289,nsupseteqq=2ac6.338,ntgl=2279,ntilde=f1,ntlg=2278,ntriangleleft=22ea,ntrianglelefteq=22ec,ntriangleright=22eb,ntrianglerighteq=22ed,nu=3bd,num=23,numero=2116,numsp=2007,nvDash=22ad,nvHarr=2904,nvap=224d.20d2,nvdash=22ac,nvge=2265.20d2,nvgt=3e.20d2,nvinfin=29de,nvlArr=2902,nvle=2264.20d2,nvlt=3c.20d2,nvltrie=22b4.20d2,nvrArr=2903,nvrtrie=22b5.20d2,nvsim=223c.20d2,nwArr=21d6,nwarhk=2923,nwarr=2196,nwarrow=2196,nwnear=2927,oS=24c8,oacute=f3,oast=229b,ocir=229a,ocirc=f4,ocy=43e,odash=229d,odblac=151,odiv=2a38,odot=2299,odsold=29bc,oelig=153,ofcir=29bf,ofr=1d52c,ogon=2db,ograve=f2,ogt=29c1,ohbar=29b5,ohm=3a9,oint=222e,olarr=21ba,olcir=29be,olcross=29bb,oline=203e,olt=29c0,omacr=14d,omega=3c9,omicron=3bf,omid=29b6,ominus=2296,oopf=1d560,opar=29b7,operp=29b9,oplus=2295,or=2228,orarr=21bb,ord=2a5d,order=2134,orderof=2134,ordf=aa,ordm=ba,origof=22b6,oror=2a56,orslope=2a57,orv=2a5b,oscr=2134,oslash=f8,osol=2298,otilde=f5,otimes=2297,otimesas=2a36,ouml=f6,ovbar=233d,par=2225,para=b6,parallel=2225,parsim=2af3,parsl=2afd,part=2202,pcy=43f,percnt=25,period=2e,permil=2030,perp=22a5,pertenk=2031,pfr=1d52d,phi=3c6,phiv=3d5,phmmat=2133,phone=260e,pi=3c0,pitchfork=22d4,piv=3d6,planck=210f,planckh=210e,plankv=210f,plus=2b,plusacir=2a23,plusb=229e,pluscir=2a22,plusdo=2214,plusdu=2a25,pluse=2a72,plusmn=b1,plussim=2a26,plustwo=2a27,pm=b1,pointint=2a15,popf=1d561,pound=a3,pr=227a,prE=2ab3,prap=2ab7,prcue=227c,pre=2aaf,prec=227a,precapprox=2ab7,preccurlyeq=227c,preceq=2aaf,precnapprox=2ab9,precneqq=2ab5,precnsim=22e8,precsim=227e,prime=2032,primes=2119,prnE=2ab5,prnap=2ab9,prnsim=22e8,prod=220f,profalar=232e,profline=2312,profsurf=2313,prop=221d,propto=221d,prsim=227e,prurel=22b0,pscr=1d4c5,psi=3c8,puncsp=2008,qfr=1d52e,qint=2a0c,qopf=1d562,qprime=2057,qscr=1d4c6,quaternions=210d,quatint=2a16,quest=3f,questeq=225f,quot=22,rAarr=21db,rArr=21d2,rAtail=291c,rBarr=290f,rHar=2964,race=223d.331,racute=155,radic=221a,raemptyv=29b3,rang=27e9,rangd=2992,range=29a5,rangle=27e9,raquo=bb,rarr=2192,rarrap=2975,rarrb=21e5,rarrbfs=2920,rarrc=2933,rarrfs=291e,rarrhk=21aa,rarrlp=21ac,rarrpl=2945,rarrsim=2974,rarrtl=21a3,rarrw=219d,ratail=291a,ratio=2236,rationals=211a,rbarr=290d,rbbrk=2773,rbrace=7d,rbrack=5d,rbrke=298c,rbrksld=298e,rbrkslu=2990,rcaron=159,rcedil=157,rceil=2309,rcub=7d,rcy=440,rdca=2937,rdldhar=2969,rdquo=201d,rdquor=201d,rdsh=21b3,real=211c,realine=211b,realpart=211c,reals=211d,rect=25ad,reg=ae,rfisht=297d,rfloor=230b,rfr=1d52f,rhard=21c1,rharu=21c0,rharul=296c,rho=3c1,rhov=3f1,rightarrow=2192,rightarrowtail=21a3,rightharpoondown=21c1,rightharpoonup=21c0,rightleftarrows=21c4,rightleftharpoons=21cc,rightrightarrows=21c9,rightsquigarrow=219d,rightthreetimes=22cc,ring=2da,risingdotseq=2253,rlarr=21c4,rlhar=21cc,rlm=200f,rmoust=23b1,rmoustache=23b1,rnmid=2aee,roang=27ed,roarr=21fe,robrk=27e7,ropar=2986,ropf=1d563,roplus=2a2e,rotimes=2a35,rpar=29,rpargt=2994,rppolint=2a12,rrarr=21c9,rsaquo=203a,rscr=1d4c7,rsh=21b1,rsqb=5d,rsquo=2019,rsquor=2019,rthree=22cc,rtimes=22ca,rtri=25b9,rtrie=22b5,rtrif=25b8,rtriltri=29ce,ruluhar=2968,rx=211e,sacute=15b,sbquo=201a,sc=227b,scE=2ab4,scap=2ab8,scaron=161,sccue=227d,sce=2ab0,scedil=15f,scirc=15d,scnE=2ab6,scnap=2aba,scnsim=22e9,scpolint=2a13,scsim=227f,scy=441,sdot=22c5,sdotb=22a1,sdote=2a66,seArr=21d8,searhk=2925,searr=2198,searrow=2198,sect=a7,semi=3b,seswar=2929,setminus=2216,setmn=2216,sext=2736,sfr=1d530,sfrown=2322,sharp=266f,shchcy=449,shcy=448,shortmid=2223,shortparallel=2225,shy=ad,sigma=3c3,sigmaf=3c2,sigmav=3c2,sim=223c,simdot=2a6a,sime=2243,simeq=2243,simg=2a9e,simgE=2aa0,siml=2a9d,simlE=2a9f,simne=2246,simplus=2a24,simrarr=2972,slarr=2190,smallsetminus=2216,smashp=2a33,smeparsl=29e4,smid=2223,smile=2323,smt=2aaa,smte=2aac,smtes=2aac.fe00,softcy=44c,sol=2f,solb=29c4,solbar=233f,sopf=1d564,spades=2660,spadesuit=2660,spar=2225,sqcap=2293,sqcaps=2293.fe00,sqcup=2294,sqcups=2294.fe00,sqsub=228f,sqsube=2291,sqsubset=228f,sqsubseteq=2291,sqsup=2290,sqsupe=2292,sqsupset=2290,sqsupseteq=2292,squ=25a1,square=25a1,squarf=25aa,squf=25aa,srarr=2192,sscr=1d4c8,ssetmn=2216,ssmile=2323,sstarf=22c6,star=2606,starf=2605,straightepsilon=3f5,straightphi=3d5,strns=af,sub=2282,subE=2ac5,subdot=2abd,sube=2286,subedot=2ac3,submult=2ac1,subnE=2acb,subne=228a,subplus=2abf,subrarr=2979,subset=2282,subseteq=2286,subseteqq=2ac5,subsetneq=228a,subsetneqq=2acb,subsim=2ac7,subsub=2ad5,subsup=2ad3,succ=227b,succapprox=2ab8,succcurlyeq=227d,succeq=2ab0,succnapprox=2aba,succneqq=2ab6,succnsim=22e9,succsim=227f,sum=2211,sung=266a,sup=2283,sup1=b9,sup2=b2,sup3=b3,supE=2ac6,supdot=2abe,supdsub=2ad8,supe=2287,supedot=2ac4,suphsol=27c9,suphsub=2ad7,suplarr=297b,supmult=2ac2,supnE=2acc,supne=228b,supplus=2ac0,supset=2283,supseteq=2287,supseteqq=2ac6,supsetneq=228b,supsetneqq=2acc,supsim=2ac8,supsub=2ad4,supsup=2ad6,swArr=21d9,swarhk=2926,swarr=2199,swarrow=2199,swnwar=292a,szlig=df,target=2316,tau=3c4,tbrk=23b4,tcaron=165,tcedil=163,tcy=442,tdot=20db,telrec=2315,tfr=1d531,there4=2234,therefore=2234,theta=3b8,thetasym=3d1,thetav=3d1,thickapprox=2248,thicksim=223c,thinsp=2009,thkap=2248,thksim=223c,thorn=fe,tilde=2dc,times=d7,timesb=22a0,timesbar=2a31,timesd=2a30,tint=222d,toea=2928,top=22a4,topbot=2336,topcir=2af1,topf=1d565,topfork=2ada,tosa=2929,tprime=2034,trade=2122,triangle=25b5,triangledown=25bf,triangleleft=25c3,trianglelefteq=22b4,triangleq=225c,triangleright=25b9,trianglerighteq=22b5,tridot=25ec,trie=225c,triminus=2a3a,triplus=2a39,trisb=29cd,tritime=2a3b,trpezium=23e2,tscr=1d4c9,tscy=446,tshcy=45b,tstrok=167,twixt=226c,twoheadleftarrow=219e,twoheadrightarrow=21a0,uArr=21d1,uHar=2963,uacute=fa,uarr=2191,ubrcy=45e,ubreve=16d,ucirc=fb,ucy=443,udarr=21c5,udblac=171,udhar=296e,ufisht=297e,ufr=1d532,ugrave=f9,uharl=21bf,uharr=21be,uhblk=2580,ulcorn=231c,ulcorner=231c,ulcrop=230f,ultri=25f8,umacr=16b,uml=a8,uogon=173,uopf=1d566,uparrow=2191,updownarrow=2195,upharpoonleft=21bf,upharpoonright=21be,uplus=228e,upsi=3c5,upsih=3d2,upsilon=3c5,upuparrows=21c8,urcorn=231d,urcorner=231d,urcrop=230e,uring=16f,urtri=25f9,uscr=1d4ca,utdot=22f0,utilde=169,utri=25b5,utrif=25b4,uuarr=21c8,uuml=fc,uwangle=29a7,vArr=21d5,vBar=2ae8,vBarv=2ae9,vDash=22a8,vangrt=299c,varepsilon=3f5,varkappa=3f0,varnothing=2205,varphi=3d5,varpi=3d6,varpropto=221d,varr=2195,varrho=3f1,varsigma=3c2,varsubsetneq=228a.fe00,varsubsetneqq=2acb.fe00,varsupsetneq=228b.fe00,varsupsetneqq=2acc.fe00,vartheta=3d1,vartriangleleft=22b2,vartriangleright=22b3,vcy=432,vdash=22a2,vee=2228,veebar=22bb,veeeq=225a,vellip=22ee,verbar=7c,vert=7c,vfr=1d533,vltri=22b2,vnsub=2282.20d2,vnsup=2283.20d2,vopf=1d567,vprop=221d,vrtri=22b3,vscr=1d4cb,vsubnE=2acb.fe00,vsubne=228a.fe00,vsupnE=2acc.fe00,vsupne=228b.fe00,vzigzag=299a,wcirc=175,wedbar=2a5f,wedge=2227,wedgeq=2259,weierp=2118,wfr=1d534,wopf=1d568,wp=2118,wr=2240,wreath=2240,wscr=1d4cc,xcap=22c2,xcirc=25ef,xcup=22c3,xdtri=25bd,xfr=1d535,xhArr=27fa,xharr=27f7,xi=3be,xlArr=27f8,xlarr=27f5,xmap=27fc,xnis=22fb,xodot=2a00,xopf=1d569,xoplus=2a01,xotime=2a02,xrArr=27f9,xrarr=27f6,xscr=1d4cd,xsqcup=2a06,xuplus=2a04,xutri=25b3,xvee=22c1,xwedge=22c0,yacute=fd,yacy=44f,ycirc=177,ycy=44b,yen=a5,yfr=1d536,yicy=457,yopf=1d56a,yscr=1d4ce,yucy=44e,yuml=ff,zacute=17a,zcaron=17e,zcy=437,zdot=17c,zeetrf=2128,zeta=3b6,zfr=1d537,zhcy=436,zigrarr=21dd,zopf=1d56b,zscr=1d4cf,zwj=200d,zwnj=200c
`;
