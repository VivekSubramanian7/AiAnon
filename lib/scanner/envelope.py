"""Zip envelope metadata and masked account contacts (not chat segments)."""

from __future__ import annotations

import json
import re
import zipfile
from typing import Optional, Tuple

from lib.scanner.extract import Extracted, extract_file
from lib.scanner.findings import KIND_LABELS
from lib.scanner.report import mask

USER_JSON_RE = re.compile(r"(^|/)user\.json$", re.I)
UNREAD_RE = re.compile(r"(^|/)(ads|summaries|asset_index).*\.json$", re.I)
MAX_MEMBER_BYTES = 2_000_000

EMAIL_SHAPE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
PHONE_SHAPE = re.compile(r"^\+?[0-9][0-9\s\-().]{6,}$")


def null_envelope() -> dict:
    return {
        "userJsonPresent": None,
        "userJsonSkipped": None,
        "binaryAttachments": None,
        "unreadMembers": [],
        "findings": [],
    }


def _contact_findings(email: Optional[str], phone: Optional[str]) -> list:
    out = []
    if email and EMAIL_SHAPE.match(email.strip()):
        out.append({
            "harm": "H2",
            "kind": "account_email",
            "label": KIND_LABELS["account_email"],
            "confidence": "confirmed",
            "subject": "account_holder",
            "masked": mask("emails", email.strip()),
            "category": None,
            "inCodeBlock": False,
            "count": 1,
        })
    if phone and PHONE_SHAPE.match(phone.strip()):
        out.append({
            "harm": "H2",
            "kind": "account_phone",
            "label": KIND_LABELS["account_phone"],
            "confidence": "confirmed",
            "subject": "account_holder",
            "masked": mask("phones", phone.strip()),
            "category": None,
            "inCodeBlock": False,
            "count": 1,
        })
    return out


def read_envelope(filename: str, raw: bytes) -> dict:
    if not filename.lower().endswith(".zip"):
        return null_envelope()
    try:
        zf = zipfile.ZipFile(__import__("io").BytesIO(raw))
    except zipfile.BadZipFile:
        return null_envelope()
    names = zf.namelist()
    user_present = any(USER_JSON_RE.search(n) for n in names)
    unread = [n for n in names if UNREAD_RE.search(n)][:20]
    binaries = sum(1 for n in names if ".dat" in n.lower() or n.split("/")[-1].startswith("file-"))
    findings = []
    email = phone = None
    if user_present:
        user_member = next(n for n in names if USER_JSON_RE.search(n))
        try:
            data = zf.read(user_member)
            if len(data) <= MAX_MEMBER_BYTES:
                payload = json.loads(data.decode("utf-8", errors="replace"))
                if isinstance(payload, dict):
                    for key in ("email", "email_address", "phone_number", "phone"):
                        val = payload.get(key)
                        if isinstance(val, str):
                            if "email" in key:
                                email = val
                            else:
                                phone = val
                findings = _contact_findings(email, phone)
        except (json.JSONDecodeError, KeyError, UnicodeDecodeError):
            pass
    return {
        "userJsonPresent": user_present,
        "userJsonSkipped": user_present,
        "binaryAttachments": binaries,
        "unreadMembers": unread,
        "findings": findings,
    }


def prepare_upload(filename: str, raw: bytes) -> Tuple[Extracted, dict]:
    extracted = extract_file(filename, raw)
    envelope = read_envelope(filename, raw)
    return extracted, envelope