"""
Reference (Python) version of the browser TMI's quick-frisk name rules: web/lib/rules.js must give the
same output. Reads the same lists (web/data/lists.json). Not used by the Python TMI itself.

Returns entities in the shape of the pipeline's run_spacy: {type, text, start, end, score}.

Evidence, strongest first:
  1. street addresses ("221 Baker Street")                          -> LOCATION
  2. a title before a capitalised word ("Dr. Emily Stone")           -> PERSON
  3. "my name is sam miller" in lower case                           -> PERSON
  4. inside a run of capitalised words:
       ends in a company word ("Northern Care Trust", "Acme Inc")    -> ORG
       starts with a known first name ("Dana Whitfield")             -> PERSON
       a known city, region or country ("Leeds", "New York")         -> LOCATION
       a phrase just before it ("my manager X", "works at X",
       "lives in X")                                                  -> PERSON / ORG / LOCATION
Capitalised words with none of this evidence are left alone.
"""

import json
import os
import re

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LISTS = os.path.join(REPO, "web", "data", "lists.json")

L = "a-zà-öø-ÿ"
CAP_WORD = rf"[A-Z][A-Za-z{L}'’\-]*[{L}]"          # must end lowercase: skips IBM, [EMAIL_01]
CONNECTOR = r"(?:of|de|del|da|van|von|der|la|le|du|&)"
SEQ_RE = re.compile(rf"{CAP_WORD}(?:[ ]+(?:{CONNECTOR}[ ]+)?{CAP_WORD})*")
WORD_RE = re.compile(r"\S+")
TITLE_RE = re.compile(rf"\b(?:Mr|Mrs|Ms|Miss|Mx|Dr|Prof|Sir|Dame)\.?[ ]+({CAP_WORD}(?:[ ]+{CAP_WORD}){{0,2}})")
STREET_RE = re.compile(
    rf"\b\d{{1,5}}[ ]+(?:{CAP_WORD}[ ]+){{1,3}}(?:Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr|Boulevard|Blvd|"
    r"Way|Court|Ct|Place|Pl|Terrace|Close|Crescent|Square|Sq|Parkway|Pkwy|Highway|Hwy|Row|Gardens|Grove)\b")
LOWER_NAME_RE = re.compile(r"\bmy name is[ ]+([a-z][a-z'’\-]+)(?:[ ]+([a-z][a-z'’\-]+))?")

ORG_SUFFIX = {w.lower() for w in """Inc Inc. Incorporated LLC Ltd Ltd. Limited GmbH AG SA PLC Plc LLP LP Corp Corp.
    Corporation Co Co. Company Group Holdings Bank University College School Academy Institute Hospital Clinic Trust
    Foundation Partners Associates Technologies Technology Labs Systems Solutions Services Consulting Industries
    Enterprises Ventures Capital Media Studio Studios Agency Council Ministry Department Center Centre Society Club
    Church Insurance Pharmacy Pharmaceuticals Health Healthcare Motors Airlines Bakery Cafe Restaurant Hotel Sons
    Brothers Bros""".split()}

PERSON_TRIGGER = re.compile(
    r"(?:my name is|name is|named|called|call me|i am|i'm|name:|dear|hi|hello|hey|thanks|thank you|"
    r"(?:my |our |his |her |their )?(?:wife|husband|partner|spouse|son|daughter|kid|child|boyfriend|girlfriend|"
    r"fianc[ée]e?|friend|best friend|mom|mum|mother|dad|father|brother|sister|boss|manager|colleague|coworker|"
    r"co-worker|neighbou?r|cousin|uncle|aunt|grandma|grandmother|grandpa|grandfather|niece|nephew|doctor|"
    r"therapist|teacher|roommate|flatmate|landlord|ex))[ ,:]*$")
ORG_TRIGGER = re.compile(
    r"(?:work(?:s|ed|ing)? (?:at|for)|employed (?:at|by)|job at|role at|position at|intern(?:ing|ship)? at|joined|"
    r"stud(?:y|ies|ied|ying) at|student at|graduated from|employer(?: is)?|company(?: is)?|customer of|client of)[ ,:]*$")
PLACE_TRIGGER = re.compile(
    r"(?:live[sd]? in|living in|based in|born in|grew up in|raised in|moved to|moving to|relocat\w* to|trip to|"
    r"travel\w* to|visit(?:ing|ed)?|stay(?:ing|ed)? in|located in|resident of|near|city(?: is)?|town(?: is)?|"
    r"address(?: is)?|from)[ ,:]*$")
NEAR_PREP = re.compile(r"(?:\b(?:in|from|to|near|at|around|outside)|,)[ ]*$")
SENTENCE_START = re.compile(r"(?:^|[.!?:\n•*\-]|\d\.)[ \t\"'“(]*$")
CONNECTOR_RE = re.compile(CONNECTOR)
MAX_PLACE_WORDS = 4


class ReferenceRules:
    def __init__(self, lists_path: str = LISTS):
        with open(lists_path) as f:
            lists = json.load(f)
        self.first = set(lists["firstNames"])
        self.surnames = set(lists["surnames"])
        self.places = set(lists["places"])
        self.ordinary = set(lists["ordinary"])
        self.ambiguous = set(lists["ambiguous"])

    def is_ordinary(self, word: str) -> bool:
        return word.lower().strip("'’.") in self.ordinary

    def longest_place(self, words, i):
        for j in range(min(len(words), i + MAX_PLACE_WORDS), i, -1):
            if " ".join(w for w, _ in words[i:j]).lower() in self.places:
                return j
        return None

    def __call__(self, text: str):
        spans = []  # (start, end, type); earlier passes win overlaps

        def add(start, end, kind):
            if end - start < 3 or any(s < end and start < e for s, e, _ in spans):
                return
            spans.append((start, end, kind))

        for m in STREET_RE.finditer(text):
            add(m.start(), m.end(), "LOCATION")
        for m in TITLE_RE.finditer(text):
            add(m.start(1), m.end(1), "PERSON")
        for m in LOWER_NAME_RE.finditer(text):
            a, b = m.group(1), m.group(2)
            if a in self.first or a not in self.ordinary:
                end = m.end(2) if b and b in self.surnames and b not in self.ordinary else m.end(1)
                add(m.start(1), end, "PERSON")
        for m in SEQ_RE.finditer(text):
            words = [(w.group(0), m.start() + w.start()) for w in WORD_RE.finditer(m.group(0))]
            # the first word of a sentence is capitalised anyway: drop it if it's an ordinary word
            if words and SENTENCE_START.search(text[: words[0][1]]) and self.is_ordinary(words[0][0]):
                words = words[1:]
            self._classify(text, words, add)

        return [{"type": k, "text": text[s:e], "start": s, "end": e, "score": 0.95} for s, e, k in sorted(spans)]

    def _classify(self, text, words, add):
        i, n = 0, len(words)
        while i < n:
            word, start = words[i]
            low = word.lower()
            if CONNECTOR_RE.fullmatch(word):
                i += 1
                continue
            before = text[max(0, start - 40): start].lower()

            # 1. company word later in this run: the run up to it is a company
            suffix_at = next((k for k in range(i + 1, n) if words[k][0].lower() in ORG_SUFFIX), None)
            if suffix_at is not None:
                end_k = suffix_at
                if end_k + 2 < n and words[end_k + 1][0] == "of":  # "University of Leeds"
                    end_k = n - 1
                add(start, words[end_k][1] + len(words[end_k][0]), "ORG")
                i = end_k + 1
                continue
            if low in ORG_SUFFIX and i + 2 < n and words[i + 1][0] == "of":  # "Bank of America"
                add(start, words[-1][1] + len(words[-1][0]), "ORG")
                return

            # 2. first name
            if low in self.first:
                single = n - i == 1
                if low in self.places and single and (NEAR_PREP.search(before) or PLACE_TRIGGER.search(before)):
                    add(start, start + len(word), "LOCATION")
                    i += 1
                    continue
                if low not in self.ambiguous and low not in self.ordinary:
                    j = i + 1
                    while j < n and j <= i + 2 and not CONNECTOR_RE.fullmatch(words[j][0]) \
                            and not self.is_ordinary(words[j][0]):
                        j += 1
                    add(start, words[j - 1][1] + len(words[j - 1][0]), "PERSON")
                    i = j
                    continue
                nxt = words[i + 1][0].lower() if i + 1 < n else ""
                if nxt in self.surnames and nxt not in self.ordinary:
                    add(start, words[i + 1][1] + len(words[i + 1][0]), "PERSON")
                    i += 2
                    continue

            # 3. known place
            j = self.longest_place(words, i)
            if j:
                add(start, words[j - 1][1] + len(words[j - 1][0]), "LOCATION")
                i = j
                continue

            # 4. phrase just before the run
            if not self.is_ordinary(word):
                rest = words[i: i + 3]
                end = rest[-1][1] + len(rest[-1][0])
                if PERSON_TRIGGER.search(before):
                    add(start, end, "PERSON")
                    i += len(rest)
                    continue
                if ORG_TRIGGER.search(before):
                    add(start, words[-1][1] + len(words[-1][0]), "ORG")
                    return
                if PLACE_TRIGGER.search(before):
                    add(start, end, "LOCATION")
                    i += len(rest)
                    continue
            i += 1
