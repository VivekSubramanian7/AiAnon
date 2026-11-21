"""Life-domain axis for schema v2 findings. Kind map only — no model."""

from __future__ import annotations

from typing import Dict, List, Sequence

DOMAINS = (
    "financial",
    "identity",
    "health",
    "professional",
    "relationships",
    "location",
    "digital",
    "interests",
    "other",
)

DOMAIN_LABELS = {
    "financial": "Financial",
    "identity": "Identity",
    "health": "Health",
    "professional": "Professional",
    "relationships": "Relationships",
    "location": "Location",
    "digital": "Digital",
    "interests": "Interests",
    "other": "Other",
}

HARM_ORDER = ("H1", "H2", "H3", "H4", "H5", "H6")

KIND_DOMAINS: Dict[str, Sequence[str]] = {
    "payment_card": ("financial",),
    "iban": ("financial",),
    "compensation": ("financial", "professional"),
    "national_id": ("identity",),
    "date_of_birth": ("identity",),
    "email": ("identity",),
    "phone": ("identity",),
    "handle": ("identity",),
    "profile_url": ("identity",),
    "os_username": ("identity",),
    "name": ("identity",),
    "self_name": ("identity",),
    "account_email": ("identity",),
    "account_phone": ("identity",),
    "religion": ("identity",),
    "sexual_orientation": ("identity",),
    "immigration": ("identity",),
    "age": ("identity",),
    "health": ("health",),
    "employer": ("professional",),
    "org": ("professional",),
    "children": ("relationships",),
    "child_name": ("relationships",),
    "street_address": ("location",),
    "gps": ("location",),
    "place": ("location",),
    "aws_access_key": ("digital",),
    "private_key": ("digital",),
    "api_token": ("digital",),
    "jwt": ("digital",),
    "password_cue": ("digital",),
    "tokenized_url": ("digital",),
    "url": ("digital",),
    "date": ("other",),
}


def assign_domains(kind: str) -> List[str]:
    return list(KIND_DOMAINS.get(kind, ("other",)))


def _empty_cells() -> Dict[str, Dict[str, int]]:
    return {domain: {harm: 0 for harm in HARM_ORDER} for domain in DOMAINS}


def _empty_kinds() -> Dict[str, Dict[str, Dict[str, int]]]:
    return {domain: {harm: {} for harm in HARM_ORDER} for domain in DOMAINS}


def kinds_for_cell(matrix: dict, domain: str, harm: str) -> List[tuple]:
    counts = ((matrix.get("kindsByCell") or {}).get(domain) or {}).get(harm) or {}
    return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))


def build_domain_matrix(findings: Sequence[dict]) -> dict:
    cells = _empty_cells()
    kinds_by_cell = _empty_kinds()
    unique_by_domain = {domain: 0 for domain in DOMAINS}
    multi_domain = 0
    for row in findings:
        domains = row.get("domains") or assign_domains(row.get("kind", ""))
        if len(domains) > 1:
            multi_domain += 1
        harm = row.get("harm") or "H6"
        if harm not in HARM_ORDER:
            harm = "H6"
        kind = row.get("kind") or "other"
        seen = set()
        for domain in domains:
            if domain not in cells:
                domain = "other"
            cells[domain][harm] += 1
            bucket = kinds_by_cell[domain][harm]
            bucket[kind] = bucket.get(kind, 0) + 1
            if domain not in seen:
                unique_by_domain[domain] += 1
                seen.add(domain)
    return {
        "domains": list(DOMAINS),
        "cells": cells,
        "kindsByCell": kinds_by_cell,
        "uniqueByDomain": unique_by_domain,
        "multiDomain": multi_domain,
    }
