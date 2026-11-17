"""
Dump what the Python pattern stage (lib/pipeline/regex_stripper.py) returns, for the JavaScript
port in web/lib/patterns.js to match (tests/web/patterns.test.mjs).

    python scripts/web_fixtures_patterns.py            # writes tests/web/fixtures/patterns.json
    python scripts/web_fixtures_patterns.py --report   # also lists every phone difference

Corpus: the mock memories (raw files and the chunks the scanner feeds the pipeline, exports included),
the messages in tests/test_cases.py, string inputs from tests/test_scanner.py and
tests/test_placeholder_integrity.py, about 400 synthetic sentences (phone formats and look-alikes),
every region's example numbers from phonenumbers, and Unicode edge cases.

Phones: Python runs `phonenumbers.PhoneNumberMatcher` (DE, GB, US) before a fallback regex, and so
does the JavaScript port (vendored libphonenumber-js 1.10.53, the release whose metadata matches
phonenumbers 8.13.27). The fixture holds Python's normal output (PHONE_MODE). The script also runs
everything with the matcher switched off and stores how much that changes in
meta.libraryComparison: that measurement is why the port carries a phone library.

Token start/end are converted to UTF-16 code units (what JavaScript strings use); Python counts code
points. They only differ when a character outside the Basic Multilingual Plane (an emoji, say) comes
before the token.
"""

import ast
import contextlib
import json
import os
import sys
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import phonenumbers  # noqa: E402

from lib.pipeline.regex_stripper import RegexStripper  # noqa: E402
from lib.scanner.extract import extract_file, extract_text  # noqa: E402

# lib.scanner.scan imports the full pipeline (spaCy). Only its chunking is needed here.
_stubbed = "lib.pipeline.index" not in sys.modules
if _stubbed:
    sys.modules["lib.pipeline.index"] = types.ModuleType("lib.pipeline.index")
    sys.modules["lib.pipeline.index"].run_pipeline = None
from lib.scanner.scan import CODE_BLOCK_RE, build_chunks  # noqa: E402
if _stubbed:
    del sys.modules["lib.pipeline.index"]

OUT = os.path.join(ROOT, "tests", "web", "fixtures", "patterns.json")
MOCKS = os.path.join(ROOT, "samples", "mock-memories")
PHONE_MODE = "phonenumbers"  # what web/lib/patterns.js implements: matcher, then fallback regex
JS_PHONE_LIBRARY = "libphonenumber-js 1.10.53 (max metadata)"
LARGE_EXPORT_CHUNKS_IN_FIXTURE = 12  # all of them are measured; only the first ones go in the fixture
STAGES = ["extract_whatsapp_header", "extract_ibans", "extract_phone_numbers", "extract_emails",
          "extract_urls", "extract_handles", "extract_dob", "extract_ages"]


# ---------- running the Python stage ----------

@contextlib.contextmanager
def phone_library(enabled: bool):
    if enabled:
        yield
        return
    original = phonenumbers.PhoneNumberMatcher
    phonenumbers.PhoneNumberMatcher = lambda text, region: iter(())
    try:
        yield
    finally:
        phonenumbers.PhoneNumberMatcher = original


def utf16(text: str, index: int) -> int:
    return len(text[:index].encode("utf-16-le")) // 2


def run(raw_text: str, library: bool) -> dict:
    """RegexStripper().process(raw_text), with every token's indexes in UTF-16 units of the text
    its stage worked on (the stages run one after another on the text the previous one left)."""
    stripper = RegexStripper()
    stage_inputs = {}  # id(token) -> text the stage that made it worked on

    def wrap(method):
        def wrapped(text):
            result = method(text)
            for token in result[1]:
                stage_inputs[id(token)] = text
            return result
        return wrapped

    for name in STAGES:
        setattr(stripper, name, wrap(getattr(stripper, name)))
    with phone_library(library):
        text, tokens = stripper.process(raw_text)
    sender = next((t.original for t in tokens if t.type == "SENDER"), "")
    return {
        "text": text,
        "tokens": [{
            "type": t.type, "value": t.value, "original": t.original,
            "start": utf16(stage_inputs[id(t)], t.startIndex),
            "end": utf16(stage_inputs[id(t)], t.endIndex),
            "confidence": t.confidence,
        } for t in tokens],
        "senderName": sender,
    }


# ---------- corpus ----------

def scanner_chunks(extracted) -> list:
    """The chunk texts lib/scanner/scan.py hands the pipeline (code blocks blanked, packed to 7,500)."""
    texts = [CODE_BLOCK_RE.sub(" ", s.text).strip() for s in extracted.segments]
    return [c.text for c in build_chunks(texts)]


def string_literals(path: str, min_len: int = 6) -> list:
    """String constants in a test file that look like text (a space, digit or @ in them)."""
    with open(path, encoding="utf-8") as f:
        tree = ast.parse(f.read())
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            s = node.value
            if len(s) >= min_len and any(c in s for c in " @0123456789") and s not in found:
                found.append(s)
    return found


PHONES = [
    # UK
    "+44 7700 900123", "+44 7911 123456", "+447700900456", "+44-7700-900789", "+44.7700.900321",
    "0044 7700 900654", "+44 (0)20 7946 0018", "+44 20 7946 0958", "07700 900123", "07700900123",
    "07700-900-123", "020 7946 0018", "(020) 7946 0991", "0161 496 0123", "0113 496 0000",
    # Germany
    "+49 30 901820", "+49 160 98765432", "+49 (0)30 12345678", "0049 (0) 160 9876 5432",
    "0160 98765432", "030 12345678", "030/12345678", "0171-1234567", "+49-171-1234567",
    "0049 89 1234567", "089 / 123 456 78", "+49 170 555 0198", "+491705550198", "0170 5550198",
    # US
    "(555) 123-4567", "555-123-4567", "555.123.4567", "+1 555 123 4567", "+1-415-555-0134",
    "1-800-555-0199", "+1 (303) 555-0119", "415 555 0134", "(415)555-0134", "4155550134",
    "+1 512 555 0147", "+15125550147", "1 (800) 555-0100", "212-555-0175",
    # India
    "+91 98765 43210", "+91-98765-43210", "098765 43210", "+919876543210", "+91 22 2345 6789",
    # elsewhere
    "+33 6 12 34 56 78", "+353 87 123 4567", "+61 412 345 678", "+233 20 555 0187", "+31 6 12345678",
    "+34 612 34 56 78", "+81 90-1234-5678", "+41 44 668 18 00", "+43 664 1234567", "+48 512 345 678",
    "+39 312 345 6789", "+55 11 91234-5678", "+27 82 123 4567", "+65 8123 4567", "+86 138 0013 8000",
]

PHONE_TEMPLATES = [
    "Call me on {} if anything changes.",
    "My number is {}, text me the plan.",
    "Reach me at {} or by email.",
    "Mobile: {}",
    "{}",
    "WhatsApp me ({}) tomorrow after 6pm.",
]

NEAR_MISSES = [
    # dates and times
    "03.05.2026", "12/09/1993", "2026-05-14", "14.02.1991", "1/2/2025", "2024-12-31T10:00",
    "31.12.99", "16:40:31", "10:30 - 11:45", "May 3, 2026",
    # bank and card numbers
    "DE89 3704 0044 0532 0130 00", "GB82 WEST 1234 5698 7654 32", "DE89370400440532013000",
    "FR14 2004 1010 0505 0001 3M02 606", "NL91ABNA0417164300", "4111 1111 1111 1111",
    "5500-0000-0000-0004", "4111111111111111", "3782 822463 10005", "sort code 20-00-00, account 55779911",
    # order, ticket and reference numbers
    "order #123-456-7890", "Order 2024-000123", "invoice INV-2026-004512", "ticket 88812345",
    "tracking 1Z999AA10123456784", "ref 4500123456", "case 2026/00123/45", "PO 7781-2290-11",
    "booking ABC123456", "customer no. 100 200 300",
    # years, prices, quantities
    "from 2015 to 2019", "in 1999", "the 1990s", "$1,299.99", "EUR 1.234,56", "GBP 12.50",
    "USD 12,345,678", "1.000.000 users", "12 345 678 steps", "5.5 kg",
    # versions, addresses, codes
    "v2.4.1", "version 10.15.7", "1.2.3456", "Python 3.12.15", "build 22631.4460", "192.168.1.100",
    "10.0.0.1", "Austin TX 78704", "SW1A 1AA", "10115 Berlin", "978-3-16-148410-0", "52.5200, 13.4050",
    "123-45-6789", "1234567890", "12345678901234", "2026 2027 2028", "room 1204, floor 12",
]

NEAR_MISS_TEMPLATES = [
    "The number on the form was {} last month.",
    "Please check {} before Friday.",
]

MIXED = [
    "Order 2024-000123 arrived; call +44 7700 900123 if it didn't.",
    "Born 14.02.1991, mobile 0160 98765432, IBAN DE89 3704 0044 0532 0130 00.",
    "Card 4111 1111 1111 1111 expires 12/27, call (555) 123-4567 to cancel.",
    "Version 2.4.1 crashed at 16:40:31; my number is +1 415 555 0134.",
    "Flight LH 400 on 2026-05-14, seat 23A, phone +49 170 555 0198.",
    "Paid $1,299.99 on 03.05.2026 - receipt 4500123456 - questions to 07700 900123.",
    "Office (020) 7946 0991, fax (020) 7946 0992, mobile 07700 900321.",
    "Call 0049 (0) 160 9876 5432 or 0160 98765432 or +49 160 98765432.",
    "Numbers: 555-123-4567, 555.123.4567, 555 123 4567 and 5551234567.",
    "IP 192.168.1.100, port 8080, phone 030 12345678.",
    "My number is +44 7911 123456 if anyone wants to chat directly. Also follow me @jamesobrien_dev.",
    "Tel.: +49 (0)30 12345678 / Fax: +49 (0)30 12345679",
    "Mon-Fri 9-17 Uhr unter 089 / 123 456 78 erreichbar.",
    "I'm 34, born in 1991, and my number is +33 6 12 34 56 78.",
    "Customer 100 200 300 called from +91 98765 43210 about order #123-456-7890.",
    "Reach me at jonas dot weber at protonmail dot com or +49 171 1234567.",
    "+44 7700 900123+44 7700 900124",
    "Call +44 7700 900123 ext. 204 or 1-800-555-0199 x12.",
    "Coordinates 52.5200, 13.4050 and phone 030 901820.",
    "ISBN 978-3-16-148410-0, call 0171-1234567 to order.",
]

UNICODE_CASES = [
    "Ruf an: +49 160 98765432 (NBSP)",
    "Thin spaces: +44 7700 900123",
    "Byte order mark: 0160﻿98765432 and 0160\u0085 98765432",
    "Separators: 0160\x1c98765432 and 0160\x1f98765432",
    "رقمي ٠١٦٠ ٩٨٧٦٥٤٣٢",
    "Fullwidth ０１６０ ９８７６５４３２ ok",
    "I'm ٣٤ and aged २३, born in १९९०.",
    "Math digits \U0001d7ce\U0001d7cf\U0001d7d0\U0001d7d1\U0001d7d2\U0001d7d3\U0001d7d4 here",
    "\U0001f600 Call +44 7700 900123 \U0001f600 or mail a.b@example.com \U0001f389 @handle_x https://x.example.com/\U0001f600",
    "\U0001f469‍\U0001f4bb born 14.02.1991, I'm 34 \U0001f382 IBAN DE89 3704 0044 0532 0130 00",
    "info@straße.de and straße.de/path and müller.de",
    "BORN IN 1990, Born İn 1991, born ın 1992",
    "İ'm 34 and ı'm 25 and I'M 41 and i am 52",
    "ſam@example.com, Kelvin Kate@example.com and ſ.weber at gmail dot com",
    "Søren dot Hansen at firma dot dk; JOSÉ@example.com",
    "Ages: 34 YEARS OLD, 7 year old, 99 Years Old, 0 years old, 00 years old, aged 0",
    "IBAN DE89 3704 0044 0532 0130 00\nnext line",
    "IBAN DE89 3704 0044 0532 0130 00\tafter a tab",
    "IBAN DE89 3704 0044 0532 0130 00 with NBSP",
    "Visit über.example.com or café.org/menu or example.com/äöü?x=1.",
    "Mail äbc@example.com or abc@äxample.com or abc@example.cöm",
    "张伟的电话是 138 0013 8000，邮箱 zhang@example.cn",
    "हिन्दी: मेरा नंबर +91 98765 43210 है",
    "Tab\tseparated\t+44 7700 900123\tand　ideographic　space 0160　98765432",
    "Line separator 0160 98765432 and para sep",
]

HEADER_CASES = [
    "[26/02/2026, 09:14] Sarah Müller: My number is +44 7911 123456",
    "[24.01.26, 16:40:31] Jonas Weber: Ich bin 34 Jahre alt",
    "[1/2/2026, 9:05] A : spaced colon",
    "[24.01.2026, 16:40] Name With Spaces   :   lots of space",
    "[26/02/2026, 09:14] \U0001f600 Emoji Name: call +44 7700 900123",
    "[26/02/2026, 09:14]Sarah:no spaces 0160 98765432",
    "[26/02/26, 09:14] Two digit year with slash: not a header",
    "Not at start [26/02/2026, 09:14] Sarah: hi",
    "[26/02/2026, 09:14] Line\nbreak name: hi",
    "﻿[26/02/2026, 09:14] BOM: hi",
    "[٢٦/٠٢/٢٠٢٦, ٠٩:١٤] Arabic digits: hi",
    "[26/02/2026, 09:14] Sarah: ",
    "[26/02/2026, 09:14] Sarah:",
]

OTHER_PATTERN_CASES = [
    "Emails: a@b.co, first.last+tag@sub.example.co.uk, weird%name@x-y.org, no@tld, a@b.c",
    "Write to jonas dot weber at protonmail dot com or jonas[dot]weber[at]proton[dot]me or "
    "jonas(dot)weber(at)proton(dot)me",
    "Short: jo at gm dot com, joe at gmail dot com, j.o_e at gmail dot com, joe(at)gmail(dot)com",
    "Links: https://example.com/a?b=c, http://x.org, HTTPS://EXAMPLE.ORG/PATH, www.example.net, "
    "example.io/path, example.io, foo.bar.co.uk, sub.domain.de/x/y/, test.museum",
    "URL then text: https://linkedin.com/in/sarah. Next sentence (see https://a.example.com/x).",
    "linkedin.com/in/fatima-al-hassan-pm or github.com/someone/ and my.site.org.",
    "Handles @ab @abc @abc_def @123 user@example.com @ end @_x_",
    "IBANs: DE89370400440532013000, GB82WEST12345698765432, gb82 west 1234 5698 7654 32, "
    "DE89 3704 0044 0532 0130 00 12 34, XX00 0000 0000 0000",
    "IBAN-like: ABCD 1234 5678 9012 3456, AB12 CDEF GHIJ KLMN OPQR STUV WXYZ 1234 5678",
    "Dates: 1.2.2026, 01/02/26, 1/2/3, 12.12.12, 2026/01/02, born 1990, born in 1990, born on 15.03.1990, "
    "Born on 3/4/90, BORN 15.03.1990",
    "Ages: I'm 34, I am 41, 34 years old, aged 41, I'm  7, I'm 120, I'm 05, 1 year old, 123 years old",
    "I'm 34 years old and aged 34",
    "Everything: [SENDER] [PHONE_01] already placeholders, user@example.com, +44 7700 900123, @someone",
    "",
    "   ",
    "\n\n",
]


def example_numbers() -> list:
    """Every region's example fixed-line, mobile and toll-free number, written three ways."""
    types_ = (phonenumbers.PhoneNumberType.FIXED_LINE, phonenumbers.PhoneNumberType.MOBILE,
              phonenumbers.PhoneNumberType.TOLL_FREE)
    formats = (phonenumbers.PhoneNumberFormat.INTERNATIONAL, phonenumbers.PhoneNumberFormat.NATIONAL,
               phonenumbers.PhoneNumberFormat.E164)
    texts = []
    for region in sorted(phonenumbers.SUPPORTED_REGIONS):
        for number_type in types_:
            number = phonenumbers.example_number_for_type(region, number_type)
            if number is None:
                continue
            for fmt in formats:
                text = f"{region}: call me on {phonenumbers.format_number(number, fmt)} today."
                if text not in texts:
                    texts.append(text)
    return texts


def synthetic() -> list:
    out = []
    for i, phone in enumerate(PHONES):
        for k in range(3):
            out.append(PHONE_TEMPLATES[(i + k) % len(PHONE_TEMPLATES)].format(phone))
    for i, value in enumerate(NEAR_MISSES):
        for template in NEAR_MISS_TEMPLATES:
            out.append(template.format(value))
    return out + MIXED


def corpus() -> list:
    """[(id, source, text, in_fixture)]"""
    items = []

    def add(source, text, in_fixture=True):
        items.append((f"{source}#{sum(1 for i in items if i[1] == source) + 1}", source, text, in_fixture))

    for name in sorted(os.listdir(MOCKS)):
        path = os.path.join(MOCKS, name)
        if not os.path.isfile(path) or not name.endswith((".txt", ".zip")):
            continue
        with open(path, "rb") as f:
            raw = f.read()
        if name.endswith(".txt"):
            add(f"mock:{name}", raw.decode("utf-8"))
        for i, chunk in enumerate(scanner_chunks(extract_file(name, raw))):
            in_fixture = "large" not in name or i < LARGE_EXPORT_CHUNKS_IN_FIXTURE
            add(f"mock-chunk:{name}", chunk, in_fixture)

    from tests.test_cases import get_all_test_cases
    for case in get_all_test_cases():
        add(f"test_cases:{case['id']}", case["input"]["rawText"])

    for test_file in ("test_scanner.py", "test_placeholder_integrity.py"):
        for s in string_literals(os.path.join(ROOT, "tests", test_file)):
            add(f"literal:{test_file}", s)
    # Texts tests/test_scanner.py hands scan(), as the pipeline sees them.
    memories = "\n".join([
        "User's name is Dana Whitfield.",
        "Email: dana.whitfield@example.com, phone +44 7700 900123.",
        "Lives in Manchester and works at Northwind Health.",
        "Was born on 14.02.1988.",
        "Likes hiking and bad puns.",
        "```python\nprint(1234567890)\n```",
    ])
    line = "Call Priya Natarajan on +1 415 555 0134 about the Denver office. "
    for text in (memories, "Was born on 14.02.1991.\nDentist appointment on 03.05.2026.", (line * 400).strip()):
        for chunk in scanner_chunks(extract_text(text)):
            add("scan-chunk:test_scanner.py", chunk)

    for text in synthetic():
        add("synthetic:phones", text)
    for text in HEADER_CASES:
        add("synthetic:header", text)
    for text in OTHER_PATTERN_CASES:
        add("synthetic:patterns", text)
    for text in UNICODE_CASES:
        add("synthetic:unicode", text)
    for text in example_numbers():
        add("synthetic:example-numbers", text)
    return items


# ---------- comparing the two phone modes ----------

def phone_spans(result) -> list:
    return [(t["start"], t["end"], t["original"]) for t in result["tokens"] if t["type"] == "PHONE"]


def group_of(source: str) -> str:
    """'realistic' (mock memories and the repo's tests) or the synthetic group's name."""
    return source if source.startswith("synthetic:") else "realistic"


def compare(items) -> dict:
    """Run every text with and without phonenumbers.PhoneNumberMatcher; count what changes."""
    groups, differences = {}, []
    for item_id, source, text, _ in items:
        lib, plain = run(text, True), run(text, False)
        a, b = phone_spans(lib), phone_spans(plain)
        only_a, only_b = sorted(set(a) - set(b)), sorted(set(b) - set(a))
        for name in (group_of(source), "all"):
            g = groups.setdefault(name, dict.fromkeys((
                "texts", "textsWithPhones", "phoneTokensWithLibrary", "phoneTokensWithoutLibrary",
                "phoneTokensFoundByLibrary", "phoneTokensOnlyWithLibrary", "phoneTokensOnlyWithoutLibrary",
                "textsWithDifferentPhoneTokens", "textsWithDifferentOutputText"), 0))
            g["texts"] += 1
            g["textsWithPhones"] += bool(a or b)
            g["phoneTokensWithLibrary"] += len(a)
            g["phoneTokensWithoutLibrary"] += len(b)
            g["phoneTokensFoundByLibrary"] += sum(
                1 for t in lib["tokens"] if t["type"] == "PHONE" and t["confidence"] == 1.0)
            g["phoneTokensOnlyWithLibrary"] += len(only_a)
            g["phoneTokensOnlyWithoutLibrary"] += len(only_b)
            g["textsWithDifferentPhoneTokens"] += bool(only_a or only_b)
            g["textsWithDifferentOutputText"] += lib["text"] != plain["text"]
        if (only_a or only_b) and source != "synthetic:example-numbers":  # those are only counted
            differences.append({
                "id": item_id, "text": text if len(text) < 300 else None,
                "onlyWithLibrary": [o for _, _, o in only_a],
                "onlyWithoutLibrary": [o for _, _, o in only_b],
            })
    for g in groups.values():
        g["shareOfPhoneTokensThatDiffer"] = round(
            (g["phoneTokensOnlyWithLibrary"] + g["phoneTokensOnlyWithoutLibrary"])
            / max(1, g["phoneTokensWithLibrary"] + g["phoneTokensOnlyWithoutLibrary"]), 4)
    return {"groups": groups, "differences": differences}


def write_fixture(fixture: dict) -> None:
    """JSON with one case per line, so diffs stay readable."""
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    dump = lambda value: json.dumps(value, ensure_ascii=False, separators=(",", ":"))  # noqa: E731
    with open(OUT, "w", encoding="utf-8") as f:
        f.write('{"meta":' + json.dumps(fixture["meta"], ensure_ascii=False, indent=1) + ',\n"cases":[\n')
        f.write(",\n".join(dump(case) for case in fixture["cases"]))
        f.write("\n]}\n")


def main():
    items = corpus()
    comparison = compare(items)
    if "--report" in sys.argv:
        for d in comparison["differences"]:
            print(f"{d['id']}: library {d['onlyWithLibrary']} | regex only {d['onlyWithoutLibrary']}")
            if d["text"]:
                print(f"    {d['text']!r}")
    print(json.dumps(comparison["groups"], indent=2))

    library = PHONE_MODE == "phonenumbers"
    cases = [{"id": item_id, "source": source, "input": text, "expected": run(text, library)}
             for item_id, source, text, in_fixture in items if in_fixture]
    write_fixture({
        "meta": {
            "generator": "scripts/web_fixtures_patterns.py",
            "python": sys.version.split()[0],
            "phonenumbers": phonenumbers.__version__,
            "phoneMode": PHONE_MODE,
            "javascriptPhoneLibrary": JS_PHONE_LIBRARY,
            "phoneModeNote": "Expected outputs are RegexStripper.process() as the pipeline runs it: "
                             "phonenumbers.PhoneNumberMatcher (DE, GB, US), then the fallback regex.",
            "indexes": "start/end are UTF-16 code units in the text of the stage that made the token "
                       "(Python counts code points).",
            "largeExportChunks": f"all {sum(1 for i in items if 'large' in i[1])} chunks of "
                                 "chatgpt-export-large.zip are measured; the first "
                                 f"{LARGE_EXPORT_CHUNKS_IN_FIXTURE} are in the fixture",
            "libraryComparison": comparison,
        },
        "cases": cases,
    })
    print(f"wrote {len(cases)} cases to {os.path.relpath(OUT, ROOT)}")


if __name__ == "__main__":
    main()
