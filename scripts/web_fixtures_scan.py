"""
Python outputs the browser TMI's JavaScript must reproduce (tests/web/rules.test.mjs, tests/web/scan.test.mjs):

  tests/web/fixtures/rules.json    quick-frisk name rules on a corpus of texts
  tests/web/fixtures/stage1.json   full quick-frisk reports for the mock memories: the real Python pipeline
                                   (pattern rules + NER filters + scanner) with the reference rules in place
                                   of spaCy and Presidio

    .venv/bin/python scripts/web_fixtures_scan.py
"""

import json
import logging
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)
sys.path.insert(0, os.path.join(REPO, "scripts"))
MOCKS = os.path.join(REPO, "samples", "mock-memories")
OUT = os.path.join(REPO, "tests", "web", "fixtures")

MOCK_FILES = [
    "chatgpt-saved-memories.txt", "gemini-saved-info.txt", "bot-answer-what-do-you-remember.txt",
    "clean-memory.txt", "chatgpt-export.zip", "claude-export.zip", "chatgpt-export-large.zip",
]

EXTRA_TEXTS = [
    "Will you check this? Reading is fun.",
    "I met Alan at Google yesterday and then flew from Austin to New York.",
    "My boss Rahul Verma works at Acme Widgets Inc. in San Francisco.",
    "my name is sam miller and I live at 42 Maple Street.",
    "The Bank of America sent a letter. Grace period ends in March.",
    "Dr. Emily Stone and Mrs Patel met at the University of Leeds.",
    "Hi Priya,\nthanks for the notes. Lives in Headingley, Leeds with partner Chris Doyle.",
    "Moved to Victoria last year; Victoria Beckham was not involved.",
    "Thanks Jordan! See you in Austin. Austin Miller says hi.",
    "- Manager Priya Shah is leaving Northern Care Trust next month.\n- Sister Jess Whitfield lives in Manchester.",
    "Works at Home Depot in Atlanta, GA. Studied at Georgia Tech.",
    "named Biscuit, called Max, dear Abigail, my daughter Zoë and my son Ömer",
    "Mr. O'Brien-Smith visited São Paulo and Zürich with McDonald.",
    "She grew up in Port Rhonda near Lake Christopherborough.",
    "My employer: Contoso Health. Client of Fabrikam Ltd. Joined Northwind Traders.",
    "Mark said May is fine. June and April are busy. Rose Tyler and Will Smith too.",
]


def main() -> None:
    logging.disable(logging.WARNING)
    from web_reference_rules import ReferenceRules
    from lib.pipeline import ner_engine as ner_module
    from lib.scanner.envelope import null_envelope, read_envelope
    from lib.scanner.extract import extract_file
    from lib.scanner.scan import scan

    rules = ReferenceRules()

    # Corpus for the rules: every segment of every mock file, plus hand-written edge cases.
    extracted = {}
    corpus = []
    envelopes = {}
    for name in MOCK_FILES:
        with open(os.path.join(MOCKS, name), "rb") as f:
            raw = f.read()
            extracted[name] = extract_file(name, raw)
            envelopes[name] = read_envelope(name, raw) if name.lower().endswith(".zip") else null_envelope()
        if name != "chatgpt-export-large.zip":
            corpus += [s.text for s in extracted[name].segments]
    corpus += EXTRA_TEXTS
    rule_cases = [{"text": t, "entities": rules(t)} for t in corpus]

    # The real pipeline with the reference rules as its NER: what the quick frisk must report.
    ner_module.analyzer = None                 # no Presidio
    ner_module.MODELS_LOADED = True
    ner_module.ner_engine.run_spacy = rules    # same contract as run_spacy
    reports = {}
    for name in MOCK_FILES:
        report = scan(extracted[name], envelope=envelopes[name])
        report.pop("elapsedMs")
        reports[name] = report
        print(f"{name}: {report['totals']['unique']} things, score {report['score']}")

    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "rules.json"), "w") as f:
        json.dump({"cases": rule_cases}, f, ensure_ascii=False, indent=0)
    with open(os.path.join(OUT, "stage1.json"), "w") as f:
        json.dump({"files": MOCK_FILES, "reports": reports}, f, ensure_ascii=False, indent=1)
    print(f"rules: {len(rule_cases)} texts, {sum(len(c['entities']) for c in rule_cases)} entities")


if __name__ == "__main__":
    main()
