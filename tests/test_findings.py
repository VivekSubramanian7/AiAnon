"""Unit tests for tiered sensitivity findings (sort, cap, bands, promotion, readouts)."""

import io
import json
import zipfile

import pytest

from lib.scanner.detectors import Hit, detect
from lib.scanner.envelope import prepare_upload, read_envelope
from lib.scanner.extract import extract_file
from lib.scanner.findings import (
    assemble,
    band_counts,
    build_coverage,
    build_readouts,
    cap_findings,
    classify_subject,
    promote,
    sort_findings,
)
from lib.scanner.report import Aggregator, mask_kind


def _row(harm, confidence, subject, kind="test", id_="f-01"):
    return {
        "id": id_,
        "harm": harm,
        "kind": kind,
        "label": "Test",
        "confidence": confidence,
        "subject": subject,
        "masked": "•••",
        "category": None,
        "source": "detector",
        "inCodeBlock": False,
        "count": 1,
    }


def test_sort_is_harm_then_confidence_then_subject():
    rows = [
        _row("H3", "high", "account_holder", kind="health", id_="f-03"),
        _row("H1", "low", "account_holder", kind="jwt", id_="f-02"),
        _row("H1", "high", "account_holder", kind="aws_access_key", id_="f-01"),
    ]
    out = sort_findings(rows)
    assert [r["id"] for r in out] == ["f-01", "f-02", "f-03"]


def test_cap_keeps_twelve_per_band_and_bands_keep_the_rest():
    rows = [
        _row("H6", "low", "unknown", kind="name", id_=f"f-{i:02d}")
        for i in range(1, 14)
    ]
    bands = band_counts(rows)
    assert bands["H6"]["unique"] == 13
    capped = cap_findings(rows, per_band=12)
    h6 = [r for r in capped if r["harm"] == "H6"]
    assert len(h6) == 12


def test_cap_h6_mixes_kinds_not_only_high_confidence_age():
    rows = (
        [_row("H6", "medium", "unknown", kind="age", id_=f"age-{i}") for i in range(20)]
        + [_row("H6", "low", "unknown", kind="name", id_=f"name-{i}") for i in range(5)]
        + [_row("H6", "low", "unknown", kind="org", id_=f"org-{i}") for i in range(5)]
        + [_row("H6", "medium", "unknown", kind="url", id_=f"url-{i}") for i in range(5)]
    )
    capped = cap_findings(rows, per_band=12)
    kinds = {r["kind"] for r in capped if r["harm"] == "H6"}
    assert {"name", "org", "url"}.issubset(kinds)
    h6 = [r for r in capped if r["harm"] == "H6"]
    assert sum(1 for r in h6 if r["kind"] == "age") < len(h6) // 2


def test_mask_kind_secrets_and_health():
    aws = mask_kind("aws_access_key", "AKIAIOSFODNN7EXAMPLE")
    assert aws.startswith("AKIA")
    assert "EXAMPLE" not in aws
    health = mask_kind("health", "asthma")
    assert "sthma" not in health
    card = mask_kind("payment_card", "4242424242424242")
    assert card.endswith("42")
    assert "424242424242" not in card.replace("•", "")


def test_classify_subject_cues():
    assert classify_subject("I have asthma", kind="health") == "account_holder"
    assert classify_subject("my colleague's email", kind="email") == "third_party"
    assert (
        classify_subject("his password is hunter2xx", kind="password_cue") == "third_party"
    )
    assert classify_subject("Zoë called", kind="name") == "unknown"
    assert classify_subject("my daughter Zoë", kind="child_name") == "third_party"
    assert classify_subject("", kind="private_key") == "account_holder"


def test_classify_subject_uses_the_text_before_the_value():
    assert classify_subject("I met ", kind="name") == "unknown"            # someone else's name
    assert classify_subject("My email is ", kind="email") == "account_holder"
    assert classify_subject("my wife's number is ", kind="phone") == "third_party"
    assert classify_subject("", kind="self_name") == "account_holder"


def test_password_mask_hides_first_character_and_length():
    assert mask_kind("password_cue", "Hunter2-Summer!") == "•" * 8
    assert mask_kind("password_cue", "abc12345") == "•" * 8


def test_credentials_score_caps_near_100_for_three_live_secrets():
    rows = [
        {"harm": "H1", "kind": "private_key", "confidence": "high", "subject": "account_holder", "masked": "a", "id": "f-01"},
        {"harm": "H1", "kind": "aws_access_key", "confidence": "high", "subject": "account_holder", "masked": "b", "id": "f-02"},
        {"harm": "H1", "kind": "api_token", "confidence": "high", "subject": "account_holder", "masked": "c", "id": "f-03"},
    ]
    assert build_readouts(rows, 0, "clean", False)["credentials"]["score"] >= 99


def test_build_readouts_floors_and_bridges():
    aws = _row("H1", "high", "account_holder", kind="aws_access_key")
    ro = build_readouts([aws], legacy_score=66, legacy_level="oversharer", lower_bound=True)
    assert ro["credentials"]["score"] >= 80
    assert ro["credentials"]["confidence"] == "high"

    jwts = [_row("H1", "medium", "account_holder", kind="jwt", id_=f"f-{i}") for i in range(5)]
    ro_j = build_readouts(jwts, legacy_score=0, legacy_level="clean", lower_bound=False)
    assert ro_j["credentials"]["score"] <= 40

    lows = [_row("H3", "low", "unknown", kind="health", id_=f"f-{i}") for i in range(10)]
    ro_h = build_readouts(lows, legacy_score=0, legacy_level="clean", lower_bound=False)
    assert ro_h["intimateSafety"]["score"] <= 35
    assert ro_h["intimateSafety"]["confidence"] == "low"

    med_health = _row("H3", "medium", "account_holder", kind="health")
    ro_m = build_readouts([med_health], legacy_score=0, legacy_level="clean", lower_bound=False)
    assert ro_m["intimateSafety"]["score"] > 0

    tp = _row("H4", "medium", "third_party", kind="email", id_="f-tp")
    ah = _row("H4", "medium", "account_holder", kind="email", id_="f-ah")
    ro_b = build_readouts([tp, ah], legacy_score=50, legacy_level="chatty", lower_bound=False)
    ro_ah = build_readouts([ah], legacy_score=50, legacy_level="chatty", lower_bound=False)
    assert ro_b["identityBridges"]["aboutOthers"] == 1
    assert ro_b["identityBridges"]["aboutYou"] == 1
    assert ro_b["identityBridges"]["score"] == ro_ah["identityBridges"]["score"]
    ro_corpus = build_readouts([], legacy_score=66, legacy_level="oversharer", lower_bound=False)
    assert ro_corpus["corpusVolume"]["score"] == 66


def test_promoted_date_is_h6_not_phone_band():
    agg = Aggregator()
    agg.add("PHONE", "03.05.2026")
    rows = promote(agg)
    assert len(rows) == 1
    assert rows[0]["harm"] == "H6" and rows[0]["kind"] == "date"


def test_promoted_birthday_without_extra_date_row():
    agg = Aggregator()
    agg.add("PHONE", "14.02.1991", context="born on ")
    rows = promote(agg)
    kinds = [r["kind"] for r in rows]
    assert kinds == ["date_of_birth"]


def test_two_phones_same_digits_one_h4_high():
    agg = Aggregator()
    agg.add("PHONE", "+44 7700 900123", confidence=1.0)
    agg.add("PHONE", "+447700900123", confidence=0.9)
    rows = {r["key"]: r for r in agg.categories()}
    assert rows["phones"]["unique"] == 1
    findings = promote(agg)
    assert len([f for f in findings if f["kind"] == "phone"]) == 1
    phone = next(f for f in findings if f["kind"] == "phone")
    assert phone["harm"] == "H4" and phone["confidence"] == "high"


def test_self_name_promoted_without_h6_duplicate():
    agg = Aggregator()
    agg.add("PERSON", "Sam Miller", context="my name is ")
    agg.add("PERSON", "Tom Becker")
    findings = promote(agg)
    kinds = {f["kind"] for f in findings}
    assert "self_name" in kinds
    assert sum(1 for f in findings if f["kind"] == "name") == 1


def test_build_coverage_lower_bound_flags():
    cov = build_coverage(
        {"truncated": True, "charactersScanned": 100, "charactersSkipped": 0, "codeBlocksSkipped": 0, "assistantMessagesSkipped": 0},
        None,
    )
    assert cov["lowerBound"] is True
    assert "5M" in (cov["truncationNote"] or "")
    cov2 = build_coverage(
        {"truncated": False, "charactersScanned": 100, "charactersSkipped": 0, "codeBlocksSkipped": 1, "assistantMessagesSkipped": 0},
        {"userJsonPresent": None, "userJsonSkipped": None, "binaryAttachments": None, "unreadMembers": []},
    )
    assert cov2["lowerBound"] is True


def test_assemble_masks_hits():
    promoted = []
    hits = detect("I have asthma")
    assembled = assemble(promoted, hits)
    blob = json.dumps(assembled)
    assert "asthma" not in blob


def test_assemble_attaches_domains_from_kind():
    assembled = assemble([], detect("I have asthma"))
    assert assembled
    assert all("domains" in row for row in assembled)
    health = next(row for row in assembled if row["kind"] == "health")
    assert health["domains"] == ["health"]


def test_assemble_compensation_has_both_domains():
    assembled = assemble([], detect("salary is $120,000"))
    pay = next(row for row in assembled if row["kind"] == "compensation")
    assert pay["domains"] == ["financial", "professional"]
    assert pay["harm"] == "H5"


def test_envelope_zip_masked_contacts():
    conv = json.dumps([{"mapping": {"a": {"message": {"author": {"role": "user"}, "content": {"parts": ["hi"]}}}}}])
    raw = io.BytesIO()
    with zipfile.ZipFile(raw, "w") as zf:
        zf.writestr("conversations.json", conv)
        zf.writestr("user.json", json.dumps({"email": "a@example.com", "phone_number": "+1 202 555 0147"}))
        zf.writestr("ads.json", "{}")
        zf.writestr("file-abc.dat", b"bin")
    payload = raw.getvalue()
    env = read_envelope("export.zip", payload)
    assert env["userJsonPresent"] is True
    assert env["binaryAttachments"] >= 1
    assert "ads.json" in env["unreadMembers"]
    blob = json.dumps(env)
    assert "a@example.com" not in blob
    extracted, _ = prepare_upload("export.zip", payload)
    assert not any("a@example.com" in s.text for s in extracted.segments)