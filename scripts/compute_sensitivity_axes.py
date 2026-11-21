#!/usr/bin/env python3
"""
Write mirror-sensitivity.json from schema v2 readouts (no parallel gap regex pass).

    .venv/bin/python scripts/compute_sensitivity_axes.py
    .venv/bin/python scripts/compute_sensitivity_axes.py --zip /path/to/export.zip
"""

from __future__ import annotations

import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from lib.scanner.envelope import prepare_upload  # noqa: E402
from lib.scanner.scan import scan  # noqa: E402

SCANNER = os.path.join(ROOT, "public", "scanner")
REPORT_PATH = os.path.join(SCANNER, "mirror-report-data.json")
OUT_PATH = os.path.join(SCANNER, "mirror-sensitivity.json")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zip", help="ChatGPT export zip: run full scan for v2 report")
    parser.add_argument("--report", default=REPORT_PATH)
    parser.add_argument("--out", default=OUT_PATH)
    args = parser.parse_args()

    if args.zip:
        with open(args.zip, "rb") as f:
            extracted, envelope = prepare_upload(os.path.basename(args.zip), f.read())
        report = scan(extracted, envelope=envelope)
    else:
        with open(args.report, encoding="utf-8") as f:
            wrapped = json.load(f)
        report = wrapped.get("report", wrapped)

    if not report.get("readouts"):
        sys.exit("That report has no readouts: rescan it (schema v2) with --zip.")
    payload = {"modelVersion": "2026-11-19-findings", "readouts": report["readouts"], "coverage": report.get("coverage", {})}
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    print(f"Wrote {args.out}")
    for name, row in payload["readouts"].items():
        print(f"  {name}: {row['score']}/100 ({row.get('harmBand', '')})")


if __name__ == "__main__":
    main()