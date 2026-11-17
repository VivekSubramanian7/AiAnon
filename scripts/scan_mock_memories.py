"""
Scan every mock memory file and print what was found, with the real values (they're fake),
so you can judge each finding. Edge cases print the error message a user would see.

    python scripts/scan_mock_memories.py             # all files
    python scripts/scan_mock_memories.py --summary   # one line per file
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib.pipeline.index import run_pipeline  # noqa: E402
from lib.scanner import scan as scan_module  # noqa: E402
from lib.scanner.extract import ExtractError, extract_file  # noqa: E402
from lib.scanner.report import Aggregator  # noqa: E402

MOCKS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "samples", "mock-memories")


class RecordingAggregator(Aggregator):
    """Also keeps the real values per category, for this script only."""

    def __init__(self):
        super().__init__()
        self.real = {}

    def add(self, token_type, original, *args, **kwargs):
        category = super().add(token_type, original, *args, **kwargs)
        if category:
            self.real.setdefault(category, set()).add(original.strip())
        return category


def main():
    summary = "--summary" in sys.argv
    names = sorted(n for n in os.listdir(MOCKS) if os.path.isfile(os.path.join(MOCKS, n)))
    names += sorted("edge-cases/" + n for n in os.listdir(os.path.join(MOCKS, "edge-cases")))
    for name in names:
        with open(os.path.join(MOCKS, name), "rb") as f:
            raw = f.read()
        try:
            extracted = extract_file(name, raw)
        except ExtractError as exc:
            print(f"{name:42s} -> error shown to user: {exc}")
            continue
        recorder = RecordingAggregator()
        original = scan_module.Aggregator
        scan_module.Aggregator = lambda: recorder
        try:
            report = scan_module.scan(extracted)
        finally:
            scan_module.Aggregator = original
        t, s = report["totals"], report["source"]
        print(f"{name:42s} -> {s['label']}, {s['piecesScanned']} pieces, {t['unique']} things "
              f"({t['directUnique']} direct), score {report['score']} [{report['level']}], "
              f"{report['elapsedMs']} ms")
        if summary:
            continue
        print(f"    skipped: {s['assistantMessagesSkipped']} AI replies, {s['codeBlocksSkipped']} code blocks; "
              f"kinds: {s['kinds']}")
        for row in report["categories"]:
            if row["unique"]:
                values = sorted(recorder.real.get(row["key"], []))
                print(f"    {row['label']:28s} {row['unique']:>3}  {values[:8]}{' ...' if len(values) > 8 else ''}")
        print()


if __name__ == "__main__":
    main()
