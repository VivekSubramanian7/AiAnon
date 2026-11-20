"""Pure-function gap detectors for tiered sensitivity (hits only, never API output)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List, Optional, Tuple

from lib.scanner.report import DATE_LIKE_RE

CODE_BLOCK_RE = re.compile(r"```(.*?)```", re.S)

H1_ONLY_WHEN_FENCED = True

PRIVATE_KEY_RE = re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")
AWS_KEY_RE = re.compile(r"\bAKIA[0-9A-Z]{16}\b")
API_TOKEN_RE = re.compile(
    r"\b(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|"
    r"xox[baprs]-[A-Za-z0-9-]{10,})\b"
)
JWT_RE = re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")
PASSWORD_CUE_RE = re.compile(
    r"(?i)(?:password|passcode|pin|recovery code)\s*[:=]\s*(\S{6,})"
)
TOKEN_URL_RE = re.compile(
    r"https?://[^\s]+(?:X-Amz-Signature=|token=|sig=|reset)[^\s]{20,}",
    re.I,
)

PAN_RE = re.compile(r"\b(?:\d[ -]*?){13,19}\b")
SSN_RE = re.compile(r"\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b")
NINO_RE = re.compile(r"\b[A-CEGHJ-PR-TW-Z]{2}\d{6}[A-D]\b", re.I)
AADHAAR_RE = re.compile(r"\b\d{4}\s\d{4}\s\d{4}\b")
PASSPORT_RE = re.compile(r"\b[A-Z0-9]{8,9}\b")

HEALTH_RE = re.compile(
    r"(?i)\b(?:diabetes|asthma|allerg(?:y|ic)|anxiety|depression|adhd|therapy|"
    r"medication|prescription|pregnant|disability)\w*\b"
)
IMMIGRATION_RE = re.compile(
    r"(?i)\b(?:work permit|blue card|aufenthaltstitel|residence permit|right to work)\b"
)
RELIGION_RE = re.compile(r"(?i)\b(?:hindu|muslim|christian|sikh|jewish|buddhist)\b")
CHILDREN_RE = re.compile(r"(?i)\b(?:my (?:son|daughter|kid|child)|(?:son|daughter)'s name)\b")
ORIENTATION_RE = re.compile(r"(?i)\b(?:gay|lesbian|bisexual|lgbtq)\b")
STREET_RE = re.compile(
    r"(?i)\b\d+\s+\w+(?:\s+\w+){0,3}\s+(?:street|st|road|rd|grove|avenue|flat|apt)\b"
)
UK_POSTCODE_RE = re.compile(r"\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b")
GPS_RE = re.compile(r"\b(-?\d+\.\d{5,}),\s*(-?\d+\.\d{5,})\b")

LINKEDIN_RE = re.compile(r"(?:https?://)?(?:www\.)?linkedin\.com/in/([\w-]{3,})", re.I)
GITHUB_RE = re.compile(r"(?:https?://)?(?:www\.)?github\.com/([^/\s?#]+)/?(?:\s|$|[?#])", re.I)
GITHUB_DENY = frozenset({
    "about", "features", "topics", "login", "settings", "orgs", "marketplace",
    "apps", "customer", "security", "collections", "sponsors", "explore", "pricing",
})
LINKEDIN_DENY = frozenset({"pub", "company", "school"})

OS_USER_RE = re.compile(r"/Users/([^/\s\"']+)/", re.I)
OS_DENY = frozenset({
    "Public", "Shared", "Administrator", "Default", "All Users",
    "username", "user", "name",
})

SELF_CUE_MEDIUM = re.compile(
    r"(?i)\b(?:I have|I'm|I've been|my therapist|diagnosed)\b"
)
SELF_RELIGION = re.compile(r"(?i)\b(?:I'm|I am)\s*$")

GOV_CUE_RE = re.compile(
    r"(?i)(?:ssn|social security|aadhaar|nino|national insurance|passport|tax id|pan card).{0,32}$"
)
CARD_CUE_RE = re.compile(r"(?i)(?:card|visa|mastercard|cvv|pan).{0,24}$")
EMPLOYER_CUE_RE = re.compile(r"(?i)\b(?:I work at|I joined|my employer|join)\b.{0,40}$")

EXAMPLE_WORDS = re.compile(r"(?i)example|xxxx|your_|redacted|dummy|sample")
FAKE_HOSTS = re.compile(r"(?i)example\.(?:com|org)|localhost")


@dataclass
class Hit:
    kind: str
    value: str
    start: int
    end: int
    confidence: str
    in_code_block: bool = False
    harm: str = "H1"
    window: str = ""


def fence_slices(text: str) -> List[str]:
    return [m.group(1) for m in CODE_BLOCK_RE.finditer(text) if m.group(1)]


def _window(text: str, start: int) -> str:
    return text[max(0, start - 80):start]


def _luhn(digits: str) -> bool:
    digits = re.sub(r"\D", "", digits)
    if len(digits) < 13:
        return False
    total, flip = 0, False
    for d in reversed(digits):
        n = int(d)
        if flip:
            n *= 2
            if n > 9:
                n -= 9
        total += n
        flip = not flip
    return total % 10 == 0


def _verhoeff(number: str) -> bool:
    d = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
         [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
         [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
         [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
         [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]]
    p = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
         [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
         [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
         [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]]
    inv = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9]
    digits = [int(c) for c in re.sub(r"\D", "", number)]
    if len(digits) != 12:
        return False
    c = 0
    for i, digit in enumerate(reversed(digits)):
        c = d[c][p[i % 8][digit]]
    return c == 0


def _add_hits(out: List[Hit], pattern: re.Pattern, kind: str, text: str, conf: str, harm: str, gate=None):
    for m in pattern.finditer(text):
        val = m.group(0) if m.lastindex is None else m.group(0)
        if gate and not gate(text, m):
            continue
        out.append(Hit(
            kind=kind,
            value=val,
            start=m.start(),
            end=m.end(),
            confidence=conf,
            harm=harm,
            window=_window(text, m.start()),
        ))


def detect_secrets(text: str, in_code_block: bool) -> List[Hit]:
    out: List[Hit] = []
    for pattern, kind, conf in (
        (PRIVATE_KEY_RE, "private_key", "high"),
        (AWS_KEY_RE, "aws_access_key", "high"),
        (API_TOKEN_RE, "api_token", "high"),
        (JWT_RE, "jwt", "medium"),
        (TOKEN_URL_RE, "tokenized_url", "high"),
    ):
        for m in pattern.finditer(text):
            val = m.group(0)
            if kind == "api_token" and (EXAMPLE_WORDS.search(val) or len(val) < 24):
                continue
            if kind == "jwt" and EXAMPLE_WORDS.search(text[max(0, m.start() - 40):m.end() + 40]):
                continue
            if kind == "tokenized_url" and FAKE_HOSTS.search(val):
                continue
            out.append(Hit(kind, val, m.start(), m.end(), conf, in_code_block, "H1", _window(text, m.start())))
    for m in PASSWORD_CUE_RE.finditer(text):
        secret = m.group(1)
        if secret.lower() in ("password", "secret", "123456") or len(secret) < 8 and secret.isalpha():
            continue
        out.append(Hit(
            "password_cue", secret, m.start(1), m.end(1), "medium", in_code_block, "H1", _window(text, m.start()),
        ))
    return out


def detect_h2_h3(text: str) -> List[Hit]:
    out: List[Hit] = []

    def pan_gate(t: str, m: re.Match) -> bool:
        raw = m.group(0)
        if DATE_LIKE_RE.match(re.sub(r"\s", "", raw)):
            return False
        digits = re.sub(r"\D", "", raw)
        if not _luhn(digits):
            return False
        return True

    for m in PAN_RE.finditer(text):
        if not pan_gate(text, m):
            continue
        win = _window(text, m.start())
        conf = "high" if CARD_CUE_RE.search(win) else "medium"
        out.append(Hit("payment_card", m.group(0), m.start(), m.end(), conf, False, "H2", win))

    for m in SSN_RE.finditer(text):
        win = _window(text, m.start())
        if not GOV_CUE_RE.search(win + m.group(0)):
            continue
        out.append(Hit("national_id", m.group(0), m.start(), m.end(), "medium", False, "H2", win))

    for m in NINO_RE.finditer(text):
        win = _window(text, m.start())
        if not GOV_CUE_RE.search(win + m.group(0)):
            continue
        out.append(Hit("national_id", m.group(0), m.start(), m.end(), "medium", False, "H2", win))

    for m in AADHAAR_RE.finditer(text):
        win = _window(text, m.start())
        if not GOV_CUE_RE.search(win + m.group(0)):
            continue
        if not _verhoeff(m.group(0)):
            continue
        out.append(Hit("national_id", m.group(0), m.start(), m.end(), "medium", False, "H2", win))

    for pattern, kind, harm in (
        (HEALTH_RE, "health", "H3"),
        (IMMIGRATION_RE, "immigration", "H3"),
        (CHILDREN_RE, "children", "H3"),
        (ORIENTATION_RE, "sexual_orientation", "H3"),
    ):
        for m in pattern.finditer(text):
            win = _window(text, m.start())
            conf = "low"
            if kind == "health" and SELF_CUE_MEDIUM.search(win + m.group(0)):
                conf = "medium"
            if kind == "children":
                conf = "medium"
            if kind == "immigration" and re.search(r"(?i)\b(?:I have|my)\b", win):
                conf = "medium"
            out.append(Hit(kind, m.group(0), m.start(), m.end(), conf, False, harm, win))

    for m in RELIGION_RE.finditer(text):
        before = text[max(0, m.start() - 20):m.start()]
        if not re.search(r"(?i)\b(?:I'm|I am)\s*$", before):
            continue
        out.append(Hit("religion", m.group(0), m.start(), m.end(), "medium", False, "H3", _window(text, m.start())))

    for m in STREET_RE.finditer(text):
        win = _window(text, m.start())
        conf = "medium"
        snippet = text[m.start(): m.end() + 40]
        if UK_POSTCODE_RE.search(snippet):
            conf = "high"
        out.append(Hit("street_address", m.group(0), m.start(), m.end(), conf, False, "H3", win))

    for m in GPS_RE.finditer(text):
        lat, lon = float(m.group(1)), float(m.group(2))
        if abs(lat) > 180 or abs(lon) > 180 or (lat == 0 and lon == 0):
            continue
        out.append(Hit(
            "gps", m.group(0), m.start(), m.end(), "high", False, "H3", _window(text, m.start()),
        ))

    return out


def detect_h4_h5(text: str) -> List[Hit]:
    out: List[Hit] = []
    for m in LINKEDIN_RE.finditer(text):
        slug = m.group(1).split("/")[0]
        if slug.lower() in LINKEDIN_DENY:
            continue
        out.append(Hit("profile_url", m.group(0), m.start(), m.end(), "medium", False, "H4", _window(text, m.start())))
    for m in GITHUB_RE.finditer(text):
        user = m.group(1)
        if user.lower() in GITHUB_DENY:
            continue
        after = text[m.end(): m.end() + 20]
        if re.match(r"/", after):
            continue
        out.append(Hit("profile_url", m.group(0), m.start(), m.end(), "medium", False, "H4", _window(text, m.start())))

    seen_users: dict = {}
    for m in OS_USER_RE.finditer(text):
        name = m.group(1)
        if name in OS_DENY:
            continue
        seen_users[name] = seen_users.get(name, 0) + 1
    for name, count in seen_users.items():
        out.append(Hit(
            "os_username", name, 0, 0, "medium", False, "H4", f"/Users/{name}/",
        ))
        out[-1].value = name
    return out


def detect(text: str, *, in_code_block: bool = False) -> List[Hit]:
    if in_code_block:
        return detect_secrets(text, True)
    out = detect_secrets(text, False)
    out.extend(detect_h2_h3(text))
    out.extend(detect_h4_h5(text))
    return out