"""
Tiered sensitivity findings: sort, cap, bands, promotion, subject, readouts, coverage.

No regex in this module — detectors live in detectors.py.
"""

from __future__ import annotations

import json
import math
import re
from collections import defaultdict
from typing import Any, Dict, List, Optional, Sequence, Tuple

from lib.scanner.domains import assign_domains
from lib.scanner.report import Aggregator, mask, mask_kind, normalize

FINDING_KEYS = (
    "id",
    "harm",
    "kind",
    "label",
    "confidence",
    "subject",
    "masked",
    "category",
    "source",
    "inCodeBlock",
    "count",
    "domains",
)

HARM_ORDER = ("H1", "H2", "H3", "H4", "H5", "H6")
HARM_RANK = {h: i for i, h in enumerate(HARM_ORDER)}

CONFIDENCE_RANK = {
    "confirmed": 0,
    "high": 1,
    "medium": 2,
    "low": 3,
}

SUBJECT_ORDER = {
    "account_holder": 0,
    "unknown": 1,
    "third_party": 2,
    "not_applicable": 3,
}

KIND_LABELS = {
    "aws_access_key": "AWS access key",
    "private_key": "Private key",
    "api_token": "API token",
    "jwt": "JWT",
    "password_cue": "Password",
    "tokenized_url": "Signed URL",
    "payment_card": "Payment card",
    "national_id": "Government ID",
    "health": "Health",
    "religion": "Religion",
    "sexual_orientation": "Sexual orientation",
    "children": "Children",
    "immigration": "Immigration",
    "street_address": "Street address",
    "gps": "GPS coordinates",
    "profile_url": "Profile URL",
    "os_username": "Computer username",
    "employer": "Employer",
    "compensation": "Compensation",
    "date_of_birth": "Date of birth",
    "iban": "IBAN",
    "email": "Email",
    "phone": "Phone number",
    "handle": "Social handle",
    "url": "URL",
    "name": "Name",
    "self_name": "Your name",
    "child_name": "Child's name",
    "place": "Place",
    "org": "Organisation",
    "age": "Age",
    "date": "Date",
    "account_email": "Account email",
    "account_phone": "Account phone",
}

SELF_NAME_RE = re.compile(r"\b(?:my name is|I am)\b", re.I)

THIRD_PARTY_RE = re.compile(
    r"\b(?:his|her|their|colleague's|friend's)\b|"
    r"\bmy (?:colleague|friend|boss|manager|client)\b",
    re.I,
)
SELF_CUE_RE = re.compile(r"\b(?:I|I'm|I've|my|me|mine)\b", re.I)
SELF_NEGATIVE_RE = re.compile(
    r"\bmy (?:colleague|friend|boss|manager|client|son|daughter|kid|"
    r"mom|dad|wife|husband|partner)\b",
    re.I,
)

H1_KINDS = frozenset({
    "private_key", "aws_access_key", "api_token", "jwt", "password_cue", "tokenized_url",
})


def _sort_key(row: dict) -> Tuple:
    return (
        HARM_RANK.get(row["harm"], 99),
        CONFIDENCE_RANK.get(row["confidence"], 99),
        SUBJECT_ORDER.get(row["subject"], 99),
        row.get("kind", ""),
        row.get("id", ""),
    )


def sort_findings(rows: List[dict]) -> List[dict]:
    return sorted(rows, key=_sort_key)


# H6 UI cap: surface corpus-shape kinds, not only decade ages (medium beats name on sort).
H6_CAP_KIND_PRIORITY = ("name", "org", "url", "place", "phone", "date", "age")


def _cap_band_rows(band_rows: List[dict], per_band: int, harm: str) -> List[dict]:
    if not band_rows:
        return []
    if harm != "H6":
        return sort_findings(band_rows)[:per_band]

    by_kind: Dict[str, List[dict]] = defaultdict(list)
    for row in band_rows:
        by_kind[row.get("kind", "")].append(row)
    for kind in by_kind:
        by_kind[kind] = sort_findings(by_kind[kind])

    kind_order = [k for k in H6_CAP_KIND_PRIORITY if k in by_kind]
    kind_order.extend(sorted(k for k in by_kind if k not in H6_CAP_KIND_PRIORITY))

    out: List[dict] = []
    while len(out) < per_band:
        progressed = False
        for kind in kind_order:
            if not by_kind[kind]:
                continue
            out.append(by_kind[kind].pop(0))
            progressed = True
            if len(out) >= per_band:
                break
        if not progressed:
            break
    return out


def cap_findings(rows: List[dict], per_band: int = 12) -> List[dict]:
    by_harm: Dict[str, List[dict]] = defaultdict(list)
    for row in rows:
        by_harm[row["harm"]].append(row)
    out: List[dict] = []
    for harm in HARM_ORDER:
        out.extend(_cap_band_rows(by_harm.get(harm, []), per_band, harm))
    return sort_findings(out)


def band_counts(rows: List[dict]) -> Dict[str, dict]:
    result: Dict[str, dict] = {}
    for harm in HARM_ORDER:
        band_rows = [r for r in rows if r["harm"] == harm]
        by_conf: Dict[str, int] = defaultdict(int)
        by_sub: Dict[str, int] = defaultdict(int)
        for r in band_rows:
            by_conf[r["confidence"]] += 1
            by_sub[r["subject"]] += 1
        result[harm] = {
            "unique": len(band_rows),
            "byConfidence": dict(by_conf),
            "bySubject": dict(by_sub),
        }
    return result


def classify_subject(window: str, *, kind: str) -> str:
    if kind in H1_KINDS or kind == "private_key":
        if not window.strip():
            return "account_holder"
    if kind == "child_name":
        return "third_party"
    if THIRD_PARTY_RE.search(window):
        return "third_party"
    if SELF_CUE_RE.search(window) and not SELF_NEGATIVE_RE.search(window):
        return "account_holder"
    if kind in H1_KINDS:
        return "account_holder"
    return "unknown"


def _phone_harm_and_conf(category: str, max_conf: float) -> Tuple[str, str]:
    conf_label = "high" if max_conf >= 1.0 else "low"
    harm = "H4" if max_conf >= 1.0 else "H6"
    return harm, conf_label


def promote(aggregator: Aggregator) -> List[dict]:
    """Turn aggregator distinct values into promoted finding stubs (pre-subject, pre-id)."""
    rows: List[dict] = []
    for cat in aggregator.distinct:
        for norm_key, count in aggregator.distinct[cat].items():
            original = aggregator.first_seen[cat][norm_key]
            window = aggregator.cue_window.get(cat, {}).get(norm_key, "")
            max_conf = aggregator.max_confidence.get(cat, {}).get(norm_key, 1.0)
            harm, kind, confidence = _promote_one(cat, original, window, max_conf)
            if harm is None:
                continue
            rows.append({
                "harm": harm,
                "kind": kind,
                "label": KIND_LABELS.get(kind, kind.replace("_", " ").title()),
                "confidence": confidence,
                "subject": "unknown",
                "masked": mask(cat, original) if kind not in ("self_name",) else mask("names", original),
                "category": cat,
                "source": "promoted",
                "inCodeBlock": False,
                "count": count,
                "_norm": (cat, norm_key),
                "_window": (window + " " + original)[-80:],
                "_original": original,
            })
    return rows


def _promote_one(
    cat: str, original: str, window: str, max_conf: float
) -> Tuple[Optional[str], str, str]:
    confidence = "medium"
    if cat == "birthdays":
        return "H2", "date_of_birth", "medium"
    if cat == "bank":
        return "H2", "iban", "high"
    if cat == "emails":
        return "H4", "email", "medium"
    if cat == "phones":
        harm, conf = _phone_harm_and_conf(cat, max_conf)
        return harm, "phone", conf
    if cat == "handles":
        return "H4", "handle", "medium"
    if cat == "links":
        return "H6", "url", "medium"
    if cat == "names":
        full_window = (window + " " + original)[-80:]
        if SELF_NAME_RE.search(full_window):
            return "H4", "self_name", "medium"
        return "H6", "name", "low"
    if cat == "places":
        return "H6", "place", "low"
    if cat == "orgs":
        return "H6", "org", "low"
    if cat == "ages":
        return "H6", "age", "medium"
    if cat == "dates":
        return "H6", "date", "medium"
    return None, "", ""


def dedupe_keep_higher_harm(rows: List[dict]) -> List[dict]:
    """Drop lower-harm rows that share normalized identity with a higher-harm row."""
    by_norm: Dict[str, dict] = {}
    out: List[dict] = []
    sorted_rows = sorted(rows, key=lambda r: HARM_RANK.get(r["harm"], 99))
    for row in sorted_rows:
        norm = row.get("_norm")
        if norm:
            key = f"{norm[0]}:{norm[1]}"
        else:
            key = f"{row['kind']}:{row.get('masked', '')}"
        existing = by_norm.get(key)
        if existing and HARM_RANK.get(existing["harm"], 99) <= HARM_RANK.get(row["harm"], 99):
            continue
        if existing:
            out.remove(existing)
        by_norm[key] = row
        out.append(row)
    return out


def apply_subject(rows: List[dict], envelope_force: Optional[dict] = None) -> None:
    for row in rows:
        if envelope_force and row.get("source") == "envelope":
            row["subject"] = "account_holder"
            row["confidence"] = "confirmed"
            continue
        window = row.pop("_window", "")
        if "subject" not in row or row["subject"] == "unknown":
            row["subject"] = classify_subject(window, kind=row["kind"])


def assemble(
    promoted: List[dict],
    hits: List[Any],
    envelope_findings: Optional[List[dict]] = None,
) -> List[dict]:
    """Join promoted category rows, detector hits, and envelope contacts into findings."""
    rows: List[dict] = [dict(r) for r in promoted]
    for hit in hits:
        kind = hit.kind
        rows.append({
            "harm": hit.harm,
            "kind": kind,
            "label": KIND_LABELS.get(kind, kind.replace("_", " ").title()),
            "confidence": hit.confidence,
            "subject": "unknown",
            "masked": mask_kind(kind, hit.value),
            "category": None,
            "source": "detector",
            "inCodeBlock": hit.in_code_block,
            "count": 1,
            "_norm": (kind, normalize(kind, hit.value) if hasattr(hit, "value") else hit.value),
            "_window": getattr(hit, "window", "") or "",
        })
    if envelope_findings:
        for ef in envelope_findings:
            rows.append({**ef, "source": "envelope"})
    rows = dedupe_keep_higher_harm(rows)
    apply_subject(rows)
    for row in rows:
        row.pop("_norm", None)
        row.pop("_window", None)
        row.pop("_original", None)
        row["domains"] = assign_domains(row.get("kind", ""))
    rows = sort_findings(rows)
    for i, row in enumerate(rows, start=1):
        row["id"] = f"f-{i:02d}"
    return rows


CONF_MULT = {"confirmed": 1.0, "high": 1.0, "medium": 0.55, "low": 0.15}

BASE_POINTS = {
    "private_key": 40,
    "aws_access_key": 40,
    "api_token": 40,
    "password_cue": 40,
    "tokenized_url": 40,
    "jwt": 8,
    "health": 22,
    "religion": 22,
    "sexual_orientation": 22,
    "children": 22,
    "immigration": 22,
    "street_address": 22,
    "gps": 22,
    "email": 16,
    "phone": 16,
    "handle": 16,
    "profile_url": 16,
    "os_username": 16,
    "self_name": 16,
    "account_email": 30,
    "account_phone": 30,
}


def _meter_score(points: float, scale: float) -> int:
    return min(100, round(100 * (1 - math.exp(-points / scale))))


def _best_confidence(confs: List[str], default: str = "low") -> str:
    if not confs:
        return default
    return min(confs, key=lambda c: CONFIDENCE_RANK.get(c, 99))


def build_readouts(
    findings: List[dict],
    legacy_score: int,
    legacy_level: str,
    lower_bound: bool,
) -> dict:
    cred_points = 0.0
    h1_confs: List[str] = []
    has_non_jwt_high = False
    intimate_points = 0.0
    h3_confs: List[str] = []
    all_h3_low = True
    bridge_points = 0.0
    bridge_confs: List[str] = []
    about_you = 0
    about_others = 0
    cred_drivers = defaultdict(int)
    intimate_drivers = defaultdict(int)

    for f in findings:
        if f["harm"] == "H4":
            if f["subject"] == "account_holder":
                about_you += 1
            elif f["subject"] == "third_party":
                about_others += 1
        if f["harm"] == "H2" and f["kind"] in ("account_email", "account_phone"):
            about_you += 1

    seen_kind: set = set()
    for f in findings:
        kind = f["kind"]
        conf = f["confidence"]
        harm = f["harm"]
        subj = f["subject"]
        mult = CONF_MULT.get(conf, 0.15)
        base = BASE_POINTS.get(kind, 0)
        uid = (harm, kind, f.get("masked"), subj if harm == "H4" else "")
        if uid in seen_kind:
            continue
        seen_kind.add(uid)

        if harm == "H1":
            cred_drivers[kind] += 1
            cred_points += base * mult
            h1_confs.append(conf)
            if kind != "jwt" and conf in ("confirmed", "high"):
                has_non_jwt_high = True
        if harm == "H3":
            intimate_drivers[kind] += 1
            intimate_points += base * mult
            h3_confs.append(conf)
            if conf != "low":
                all_h3_low = False
        if harm == "H4" and subj == "account_holder":
            bridge_points += base * mult
            bridge_confs.append(conf)
        if harm == "H2" and kind in ("account_email", "account_phone"):
            bridge_points += BASE_POINTS[kind] * mult
            bridge_confs.append("confirmed")

    cred_score = _meter_score(cred_points, 28)
    if has_non_jwt_high:
        cred_score = max(cred_score, 80)
        cred_conf = "high"
    else:
        cred_conf = _best_confidence(h1_confs)

    intimate_score = _meter_score(intimate_points, 36)
    h3_only = [f for f in findings if f["harm"] == "H3"]
    if h3_only and all(f["confidence"] == "low" for f in h3_only):
        intimate_score = min(intimate_score, 35)
        all_h3_low = True
    intimate_conf = "low" if all_h3_low and h3_only else _best_confidence(h3_confs, "low")

    bridge_score = _meter_score(bridge_points, 24)
    bridge_conf = _best_confidence(bridge_confs)

    return {
        "credentials": {
            "harmBand": "H1",
            "score": cred_score,
            "confidence": cred_conf,
            "lowerBound": lower_bound,
            "drivers": {
                "private_key": cred_drivers.get("private_key", 0),
                "aws_access_key": cred_drivers.get("aws_access_key", 0),
                "api_token": cred_drivers.get("api_token", 0),
                "jwt": cred_drivers.get("jwt", 0),
                "password_cue": cred_drivers.get("password_cue", 0),
                "tokenized_url": cred_drivers.get("tokenized_url", 0),
            },
        },
        "intimateSafety": {
            "harmBand": "H3",
            "score": intimate_score,
            "confidence": intimate_conf,
            "lowerBound": lower_bound,
            "note": "Keyword and pattern hits. Not a diagnosis.",
            "drivers": {
                "health": intimate_drivers.get("health", 0),
                "religion": intimate_drivers.get("religion", 0),
                "sexual_orientation": intimate_drivers.get("sexual_orientation", 0),
                "children": intimate_drivers.get("children", 0),
                "precise_location": intimate_drivers.get("street_address", 0) + intimate_drivers.get("gps", 0),
                "immigration": intimate_drivers.get("immigration", 0),
            },
        },
        "identityBridges": {
            "harmBand": "H4",
            "score": bridge_score,
            "confidence": bridge_conf,
            "lowerBound": lower_bound,
            "aboutYou": about_you,
            "aboutOthers": about_others,
            "note": "Account-holder bridges only. Name-bag and unvalidated phones are corpus volume.",
        },
        "corpusVolume": {
            "harmBand": "H6",
            "score": legacy_score,
            "confidence": "low",
            "lowerBound": lower_bound,
            "legacyLevel": legacy_level,
        },
    }


def build_coverage(source: dict, envelope: Optional[dict]) -> dict:
    env = envelope or {}
    truncated = bool(source.get("truncated"))
    chars_scanned = int(source.get("charactersScanned") or 0)
    chars_skipped = int(source.get("charactersSkipped") or 0)
    code_blocks = int(source.get("codeBlocksSkipped") or 0)
    assistant = int(source.get("assistantMessagesSkipped") or 0)
    user_present = env.get("userJsonPresent")
    user_skipped = env.get("userJsonSkipped")
    binaries = env.get("binaryAttachments")
    unread = env.get("unreadMembers") or []

    lower = (
        truncated
        or chars_skipped > 0
        or code_blocks > 0
        or assistant > 0
        or (binaries or 0) > 0
        or (user_present is True and user_skipped is True)
        or len(unread) > 0
    )
    note = None
    if truncated:
        note = "Scanner stopped at 5M characters."

    return {
        "truncated": truncated,
        "charactersScanned": chars_scanned,
        "charactersSkipped": chars_skipped,
        "truncationNote": note,
        "codeBlocksSkipped": code_blocks,
        "assistantMessagesSkipped": assistant,
        "userJsonPresent": user_present,
        "userJsonSkipped": user_skipped,
        "binaryAttachments": binaries,
        "unreadMembers": unread,
        "lowerBound": lower,
    }