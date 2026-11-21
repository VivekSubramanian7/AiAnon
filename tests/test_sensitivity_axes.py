from lib.scanner.findings import build_readouts
from lib.scanner.sensitivity_axes import build_axes_payload, credentials_score


def test_credentials_score_cap():
    rows = [
        {"harm": "H1", "kind": "private_key", "confidence": "high", "subject": "account_holder", "masked": "a", "id": "f-01"},
        {"harm": "H1", "kind": "aws_access_key", "confidence": "high", "subject": "account_holder", "masked": "b", "id": "f-02"},
        {"harm": "H1", "kind": "api_token", "confidence": "high", "subject": "account_holder", "masked": "c", "id": "f-03"},
    ]
    assert build_readouts(rows, 0, "clean", False)["credentials"]["score"] >= 99


def test_build_axes_prefers_report_readouts():
    report = {
        "score": 10,
        "readouts": {"credentials": {"score": 5}},
        "coverage": {"lowerBound": True},
    }
    payload = build_axes_payload(report)
    assert payload["modelVersion"] == "2026-11-19-findings"
    assert payload["readouts"]["credentials"]["score"] == 5


def test_build_axes_has_four_readouts():
    report = {
        "score": 100,
        "level": "biography",
        "source": {"truncated": True, "charactersScanned": 5_000_000, "assistantMessagesSkipped": 10},
        "categories": [
            {"key": "emails", "unique": 3, "count": 3, "examples": []},
            {"key": "handles", "unique": 2, "count": 2, "examples": []},
            {"key": "bank", "unique": 0, "count": 0, "examples": []},
        ],
    }
    payload = build_axes_payload(report, gaps={"health_terms": 5}, envelope={"user_json_present": True})
    assert set(payload["readouts"]) == {"credentials", "intimateSafety", "identityBridges", "corpusVolume"}
    assert payload["coverage"]["userJsonPresent"] is True