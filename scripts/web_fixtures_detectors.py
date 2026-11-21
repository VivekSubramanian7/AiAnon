#!/usr/bin/env python3
"""Write tests/web/fixtures/detectors.json and envelope zip fixture from Python."""

from __future__ import annotations

import io
import json
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from lib.scanner.detectors import detect  # noqa: E402
from lib.scanner.envelope import read_envelope  # noqa: E402
from lib.scanner.findings import assemble  # noqa: E402
from tests.detector_cases import CASES  # noqa: E402

OUT = os.path.join(ROOT, "tests", "web", "fixtures", "detectors.json")
ENVELOPE_JSON = os.path.join(ROOT, "tests", "web", "fixtures", "envelope.json")
ZIP_DIR = os.path.join(ROOT, "tests", "web", "fixtures", "zips")
ENVELOPE_ZIP = os.path.join(ZIP_DIR, "envelope.zip")


def finding_rows(text: str, in_code_block: bool) -> list:
    hits = detect(text, in_code_block=in_code_block)
    rows = assemble([], hits)
    out = []
    for row in rows:
        out.append({
            "harm": row["harm"],
            "kind": row["kind"],
            "confidence": row["confidence"],
            "subject": row["subject"],
            "masked": row["masked"],
            "category": row["category"],
            "source": row["source"],
            "inCodeBlock": row["inCodeBlock"],
            "count": row["count"],
            "domains": row["domains"],
        })
    return out


def build_envelope_zip() -> bytes:
    conv = json.dumps([{"mapping": {"a": {"message": {"author": {"role": "user"}, "content": {"parts": ["hi"]}}}}}])
    buf = io.BytesIO()
    def member(name: str) -> zipfile.ZipInfo:
        return zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))  # fixed date: reruns are byte-identical

    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(member("conversations.json"), conv)
        zf.writestr(member("user.json"), json.dumps({"email": "a@example.com", "phone_number": "+1 202 555 0147"}))
        zf.writestr(member("ads.json"), "{}")
        zf.writestr(member("file-abc.dat"), b"bin")
    return buf.getvalue()


def main() -> None:
    cases = []
    for name, text, in_code_block in CASES:
        cases.append({
            "name": name,
            "text": text,
            "inCodeBlock": in_code_block,
            "findings": finding_rows(text, in_code_block),
        })
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"cases": cases}, f, indent=2)
    print(f"Wrote {OUT} ({len(cases)} cases)")

    os.makedirs(ZIP_DIR, exist_ok=True)
    zip_bytes = build_envelope_zip()
    with open(ENVELOPE_ZIP, "wb") as f:
        f.write(zip_bytes)
    env = read_envelope("export.zip", zip_bytes)
    # JSON-serializable envelope for JS parity test (no raw contacts).
    env_out = {k: v for k, v in env.items() if k != "findings"}
    keys = ("harm", "kind", "confidence", "subject", "masked", "category", "inCodeBlock", "count")
    env_out["findings"] = [{k: row[k] for k in keys} for row in env["findings"]]
    with open(ENVELOPE_JSON, "w", encoding="utf-8") as f:
        json.dump(env_out, f, indent=2)
    print(f"Wrote {ENVELOPE_ZIP} and {ENVELOPE_JSON}")


if __name__ == "__main__":
    main()