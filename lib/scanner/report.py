"""
Turn pipeline findings into the scan report: categories, counts, masked examples, a score.

Real values never leave this module. Examples are masked (e.g. "S•••• M•••••"), so a
screenshot of the result is safe to share.
"""

import math
import re
from collections import Counter
from dataclasses import dataclass
from typing import Dict, List, Optional

MASK = "•"


@dataclass(frozen=True)
class Category:
    key: str
    label: str
    tier: str  # "direct": identifies you on its own; "context": identifies you in combination


CATEGORIES = [
    Category("names", "Names", "direct"),
    Category("emails", "Email addresses", "direct"),
    Category("phones", "Phone numbers", "direct"),
    Category("birthdays", "Birth dates", "direct"),
    Category("bank", "Bank accounts", "direct"),
    Category("handles", "Social handles", "direct"),
    Category("places", "Places", "context"),
    Category("orgs", "Companies and organisations", "context"),
    Category("ages", "Ages", "context"),
    Category("dates", "Dates", "context"),
    Category("links", "Links", "context"),
]
BY_KEY = {c.key: c for c in CATEGORIES}

TOKEN_TO_CATEGORY = {
    "PERSON": "names",
    "EMAIL": "emails",
    "PHONE": "phones",
    "IBAN": "bank",
    "HANDLE": "handles",
    "LOCATION": "places",
    "ORG": "orgs",
    "AGE": "ages",
    "URL": "links",
    # DOB is split by context below; SENDER and BLOCKLIST are not counted
}

BIRTH_CONTEXT_RE = re.compile(r"\bborn\b|\bbirth|\bdob\b|\bb-day\b", re.I)

# The pipeline's phone rule runs before its date rule, so "03.05.2026" can come back as PHONE.
DATE_LIKE_RE = re.compile(r"^\s*(?:\d{1,2}[./-]\d{1,2}[./-](?:\d{2}|\d{4})|\d{4}[./-]\d{1,2}[./-]\d{1,2})\s*$")

# How far back to look for "born" / "birthday" before a date ("My birthday is on 12/09/1993").
BIRTH_CONTEXT_CHARS = 24

# Words NER likes to tag as people, places or organisations that say nothing about the user:
# the chatbots themselves (people address them by name), apps and platforms, programming terms
# and data-type jargon.
NOT_PERSONAL = {
    "chatgpt", "chat gpt", "gpt", "gpt 4", "gpt 4o", "gpt 5", "openai", "claude", "anthropic", "gemini", "bard",
    "copilot", "llama", "mistral", "siri", "alexa", "ai", "llm",
    "instagram", "facebook", "tiktok", "linkedin", "twitter", "x", "whatsapp", "telegram", "snapchat", "reddit",
    "youtube", "github", "gitlab", "gmail", "google", "outlook", "spotify", "netflix", "slack", "zoom", "teams",
    "discord", "notion", "excel", "powerpoint", "iphone", "ipad", "android", "ios", "windows", "linux", "macos",
    "python", "java", "javascript", "typescript", "rust", "golang", "kotlin", "react", "vue", "angular", "node",
    "nodejs", "docker", "kubernetes", "aws", "azure", "sql", "html", "css",
    "iban", "bic", "swift", "ssn", "dob", "pii", "api", "url", "pdf", "json", "csv",
}
CODE_IDENTIFIER_RE = re.compile(r"^[A-Za-z]+(?:Error|Exception|Warning)$")  # KeyError, ValueError, ...

# Exposure score: each distinct direct identifier is worth 4 points, each context detail 1.
DIRECT_POINTS = 4
CONTEXT_POINTS = 1
SCORE_SCALE = 40  # points at which the score reaches ~63/100

LEVELS = [  # (minimum score, level key)
    (80, "biography"),
    (50, "oversharer"),
    (20, "chatty"),
    (1, "mild"),
    (0, "clean"),
]


def categorize(token_type: str, original: str, context: str = "") -> Optional[str]:
    """context: the text just before the finding on the same line, used to spot birth dates."""
    is_birth = bool(BIRTH_CONTEXT_RE.search(original) or BIRTH_CONTEXT_RE.search(context))
    if token_type == "DOB" or (token_type == "PHONE" and DATE_LIKE_RE.match(original)):
        return "birthdays" if is_birth else "dates"
    if token_type in ("PERSON", "ORG", "LOCATION"):
        if normalize("names", original) in NOT_PERSONAL or CODE_IDENTIFIER_RE.match(original.strip()):
            return None
        if token_type == "PERSON" and any(ch.isdigit() for ch in original):
            return None  # e.g. "Austin TX 78704": names don't contain digits
    return TOKEN_TO_CATEGORY.get(token_type)


def context_before(text: str, value: str) -> str:
    """The few characters before the first occurrence of value, on the same line."""
    index = text.find(value) if value else -1
    if index < 0:
        return ""
    return text[max(0, index - BIRTH_CONTEXT_CHARS):index].rsplit("\n", 1)[-1]


def drop_nested_dates(tokens: list) -> list:
    """The DOB rules match both '14.02.1991' and 'born on 14.02.1991'. Keep only the birth-date match."""
    births = [t.original for t in tokens if t.type == "DOB" and t.original and BIRTH_CONTEXT_RE.search(t.original)]
    return [
        t for t in tokens
        if not (t.type == "DOB" and t.original and t.original not in births and any(t.original in b for b in births))
    ]


def normalize(category: str, value: str) -> str:
    """Key used to count distinct values: case, spacing and punctuation don't matter."""
    if category in ("phones", "bank"):
        return re.sub(r"\D", "", value) or value.lower()
    return re.sub(r"[\W_]+", " ", value.lower()).strip()


def _mask_word(word: str, keep: int = 1) -> str:
    letters = [i for i, ch in enumerate(word) if ch.isalnum()]
    keep_idx = set(letters[:keep])
    return "".join(ch if (i in keep_idx or not ch.isalnum()) else MASK for i, ch in enumerate(word))


def _mask_tail(value: str, visible: int) -> str:
    """Hide every letter/digit except the last `visible`."""
    alnum = [i for i, ch in enumerate(value) if ch.isalnum()]
    show = set(alnum[-visible:]) if visible else set()
    return "".join(ch if (i in show or not ch.isalnum()) else MASK for i, ch in enumerate(value))


KIND_TO_CATEGORY = {
    "email": "emails",
    "phone": "phones",
    "iban": "bank",
    "profile_url": "links",
    "url": "links",
    "handle": "handles",
    "name": "names",
    "self_name": "names",
    "child_name": "names",
    "place": "places",
    "org": "orgs",
    "age": "ages",
    "date": "dates",
    "date_of_birth": "birthdays",
    "account_email": "emails",
    "account_phone": "phones",
}

SECRET_PREFIX_LEN = {
    "AKIA": 4,
    "sk-": 3,
    "ghp_": 4,
    "github_pat_": 11,
    "eyJ": 3,
}


def _mask_secret(value: str) -> str:
    value = value.strip()
    for prefix, keep in SECRET_PREFIX_LEN.items():
        if value.startswith(prefix):
            rest = value[len(prefix):]
            return prefix + MASK * max(4, min(len(rest), 12))
    if value:
        return value[0] + MASK * min(len(value) - 1, 12)
    return MASK * 4


def mask_kind(kind: str, value: str) -> str:
    """Masked span for detector-only kinds; promoted kinds use category via KIND_TO_CATEGORY."""
    if kind in KIND_TO_CATEGORY:
        return mask(KIND_TO_CATEGORY[kind], value)
    if kind in (
        "private_key",
        "aws_access_key",
        "api_token",
        "jwt",
        "password_cue",
        "tokenized_url",
    ):
        if kind == "aws_access_key":
            return _mask_secret(value)
        if kind == "jwt" and value.startswith("eyJ"):
            return _mask_secret(value)
        if kind in ("api_token", "password_cue"):
            return _mask_secret(value)
        if kind == "private_key":
            return "-----BEGIN PRIVATE KEY-----"
        if kind == "tokenized_url":
            return mask("links", value)
        return _mask_secret(value)
    if kind in ("health", "religion", "sexual_orientation", "children", "immigration"):
        return " ".join(_mask_word(w) for w in value.split())
    if kind in ("payment_card", "national_id", "street_address", "gps"):
        return _mask_tail(value, 2) if kind != "street_address" else " ".join(
            _mask_word(w) for w in value.split()
        )
    if kind == "os_username":
        return _mask_word(value)
    if kind in ("employer", "compensation"):
        return " ".join(_mask_word(w) for w in value.split())
    return MASK * 3


def mask(category: str, value: str) -> str:
    value = value.strip()
    if category == "emails" and "@" in value:
        local, _, domain = value.partition("@")
        host, dot, tld = domain.rpartition(".")
        return f"{_mask_word(local)}@{_mask_word(host or domain)}{dot}{tld if host else ''}"
    if category in ("phones", "bank"):
        return _mask_tail(value, 2)
    if category == "links":
        host = re.sub(r"^https?://", "", value, flags=re.I).split("/")[0]
        return host + ("/" + MASK * 3 if "/" in re.sub(r"^https?://", "", value, flags=re.I) else "")
    if category == "handles":
        return "@" + _mask_word(value.lstrip("@"))
    if category in ("birthdays", "dates"):
        return _mask_tail(value, 0) if category == "birthdays" else re.sub(r"\d(?=\d*[./-])", MASK, value)
    if category == "ages":
        digits = re.search(r"\d+", value)
        return f"{int(digits.group()) // 10 * 10}s" if digits else MASK * 2
    return " ".join(_mask_word(w) for w in value.split())


class Aggregator:
    def __init__(self):
        self.mentions: Counter = Counter()                       # category -> mentions
        self.distinct: Dict[str, Counter] = {c.key: Counter() for c in CATEGORIES}
        self.first_seen: Dict[str, Dict[str, str]] = {c.key: {} for c in CATEGORIES}
        self.max_confidence: Dict[str, Dict[str, float]] = {c.key: {} for c in CATEGORIES}
        self.cue_window: Dict[str, Dict[str, str]] = {c.key: {} for c in CATEGORIES}

    def add(
        self,
        token_type: str,
        original: str,
        context: str = "",
        confidence: float = 1.0,
    ) -> Optional[str]:
        if not original or not original.strip():
            return None
        category = categorize(token_type, original, context)
        if category is None:
            return None
        key = normalize(category, original)
        self.mentions[category] += 1
        self.distinct[category][key] += 1
        self.first_seen[category].setdefault(key, original)
        prev = self.max_confidence[category].get(key, 0.0)
        self.max_confidence[category][key] = max(prev, confidence)
        if context:
            self.cue_window[category].setdefault(key, context[-80:])
        return category

    def _merge_first_names(self) -> None:
        """'Priya' on its own is almost always the 'Priya Natarajan' mentioned elsewhere: count them once."""
        names = self.distinct["names"]
        full_names = [k for k in names if " " in k]
        for key in [k for k in names if " " not in k]:
            matches = [f for f in full_names if f.split(" ", 1)[0] == key]
            if matches:
                target = max(matches, key=lambda f: names[f])
                names[target] += names.pop(key)
                self.first_seen["names"].pop(key, None)

    def categories(self, examples: int = 3) -> List[dict]:
        self._merge_first_names()
        rows = []
        for c in CATEGORIES:
            top = self.distinct[c.key].most_common(examples)
            rows.append({
                "key": c.key,
                "label": c.label,
                "tier": c.tier,
                "count": self.mentions[c.key],
                "unique": len(self.distinct[c.key]),
                "examples": [
                    {"masked": mask(c.key, self.first_seen[c.key][k]), "count": n} for k, n in top
                ],
            })
        return rows

    def totals(self) -> dict:
        self._merge_first_names()
        direct = sum(len(self.distinct[c.key]) for c in CATEGORIES if c.tier == "direct")
        context = sum(len(self.distinct[c.key]) for c in CATEGORIES if c.tier == "context")
        return {
            "mentions": sum(self.mentions.values()),
            "unique": direct + context,
            "directUnique": direct,
            "contextUnique": context,
        }


def exposure_score(direct_unique: int, context_unique: int) -> int:
    points = DIRECT_POINTS * direct_unique + CONTEXT_POINTS * context_unique
    return min(100, round(100 * (1 - math.exp(-points / SCORE_SCALE))))


def level_for(score: int) -> str:
    for minimum, key in LEVELS:
        if score >= minimum:
            return key
    return "clean"
