"""
Three-axis sensitivity readouts for mirror / reporting (prototype).

Harm bands H1–H6 are defined in docs/sensitivity-tiers.md. This module only
implements capped 0–100 UI scores and coverage metadata — not per-token labels yet.
"""

from __future__ import annotations

from typing import Any, Dict, Optional


def _cap(n: float) -> int:
    return max(0, min(100, round(n)))


def corpus_volume_score(report: Dict[str, Any]) -> int:
    """Legacy exposure score = H6-weighted volume index."""
    return int(report.get("score", 0))


def credentials_score(gaps: Dict[str, int]) -> int:
    """H1 — secrets pass (high-precision counts only)."""
    pem = gaps.get("private_keys", 0)
    aws = gaps.get("aws_keys", 0)
    api = gaps.get("api_keys", 0)
    jwt = gaps.get("jwt", 0)
    # JWT weighted low — many false positives in dev chat
    points = pem * 35 + aws * 40 + api * 35 + jwt * 8
    return _cap(points)


def intimate_safety_score(gaps: Dict[str, int]) -> int:
    """H3 — keyword / pattern hits; always low-confidence in UI."""
    health = gaps.get("health_terms", 0)
    immigration = gaps.get("immigration_terms", 0)
    religion = gaps.get("religion_terms", 0)
    children = gaps.get("children_terms", 0)
    sexual = gaps.get("sexual_orientation_terms", 0)
    points = health * 1.5 + immigration * 2.5 + religion * 3 + children * 8 + sexual * 5
    return _cap(points)


def identity_bridges_score(report: Dict[str, Any], gaps: Dict[str, int]) -> int:
    """H4 — bridges to account identity; excludes name-bag and phone-like volume."""
    cats = {c["key"]: c for c in report.get("categories", [])}

    def u(key: str) -> int:
        return int(cats.get(key, {}).get("unique", 0))

    emails = u("emails")
    handles = u("handles")
    bank = u("bank")
    linkedin = gaps.get("linkedin_profiles", 0)
    os_paths = min(gaps.get("os_username_paths", 0), 1)  # deduped: one username
    # Validated phones not yet split from noise — email-weighted bridges only
    points = emails * 12 + handles * 4 + bank * 25 + linkedin * 6 + (25 if os_paths else 0)
    return _cap(points)


def coverage_bounds(
    source: Dict[str, Any],
    envelope: Dict[str, Any],
) -> Dict[str, Any]:
    return {
        "truncated": bool(source.get("truncated")),
        "charactersScanned": source.get("charactersScanned"),
        "truncationNote": (
            "Scanner stopped at 5M characters; findings are a lower bound."
            if source.get("truncated")
            else None
        ),
        "binaryAttachments": envelope.get("binary_attachments"),
        "userJsonPresent": envelope.get("user_json_present", False),
        "userJsonSkipped": True,
        "assistantMessagesSkipped": source.get("assistantMessagesSkipped"),
    }


def build_axes_payload(
    report: Dict[str, Any],
    gaps: Optional[Dict[str, int]] = None,
    envelope: Optional[Dict[str, int]] = None,
) -> Dict[str, Any]:
    if report.get("readouts"):
        return {
            "modelVersion": "2026-11-19-findings",
            "readouts": report["readouts"],
            "coverage": report.get("coverage", {}),
        }
    gaps = gaps or {}
    envelope = envelope or {}
    source = report.get("source", {})
    return {
        "modelVersion": "2026-11-19",
        "readouts": {
            "credentials": {
                "harmBand": "H1",
                "score": credentials_score(gaps),
                "confidence": "high" if gaps.get("private_keys") or gaps.get("aws_keys") else "medium",
                "drivers": {
                    k: gaps.get(k, 0)
                    for k in (
                        "private_keys",
                        "aws_keys",
                        "api_keys",
                        "jwt",
                    )
                },
            },
            "intimateSafety": {
                "harmBand": "H3",
                "score": intimate_safety_score(gaps),
                "confidence": "low",
                "drivers": {
                    k: gaps.get(k, 0)
                    for k in (
                        "health_terms",
                        "immigration_terms",
                        "religion_terms",
                        "children_terms",
                        "sexual_orientation_terms",
                    )
                },
            },
            "identityBridges": {
                "harmBand": "H4",
                "score": identity_bridges_score(report, gaps),
                "confidence": "medium",
                "note": "Excludes name-bag and unvalidated phone volume (see corpusVolume).",
            },
            "corpusVolume": {
                "harmBand": "H6",
                "score": corpus_volume_score(report),
                "confidence": "low",
                "legacyLevel": report.get("level"),
            },
        },
        "coverage": coverage_bounds(source, envelope),
        "gaps": gaps,
    }