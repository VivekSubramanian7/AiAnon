"""
The mock memories in samples/mock-memories/ scan the way the README there says.
Regenerate them with: python scripts/make_mock_memories.py
"""

import json
import os

import pytest

from lib.scanner.envelope import prepare_upload
from lib.scanner.extract import ExtractError, extract_file
from lib.scanner.scan import scan

MOCKS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "samples", "mock-memories")


def load(name):
    with open(os.path.join(MOCKS, name), "rb") as f:
        return f.read()


def run(name):
    raw = load(name)
    if name.endswith(".zip"):
        extracted, envelope = prepare_upload(name, raw)
        report = scan(extracted, envelope=envelope)
    else:
        report = scan(extract_file(name, raw))
    return report, {r["key"]: r["unique"] for r in report["categories"]}


@pytest.mark.parametrize("name,expected", [
    ("chatgpt-saved-memories.txt", {"emails": 1, "phones": 1, "bank": 1, "handles": 1, "birthdays": 1}),
    ("gemini-saved-info.txt", {"emails": 1, "phones": 1, "birthdays": 1, "ages": 1}),
    ("bot-answer-what-do-you-remember.txt", {"emails": 2, "phones": 1, "birthdays": 1}),
])
def test_pasted_memories(name, expected):
    report, found = run(name)
    assert report["source"]["format"] == "text"
    for key, count in expected.items():
        assert found[key] == count, key
    assert found["names"] >= 2
    assert report["level"] in ("chatty", "oversharer")


def test_claude_memory_summary_is_read_as_the_account_holders():
    """Written to the user ("Your name is …", "your daughter"): every fact is hers, so the stories can use them."""
    report, found = run("claude-memory-summary.txt")
    assert report["source"]["format"] == "text"
    assert (found["emails"], found["phones"]) == (1, 1)
    pieces = {(p["kind"], p["subject"]): p["confidence"] for p in report["pieces"]}
    for kind in ("self_name", "children", "health", "immigration", "email"):
        assert pieces.get((kind, "account_holder")) == "medium", kind
    assert pieces.get(("phone", "account_holder")) == "high"
    assert any(kind == "employer" for kind, _ in pieces)
    # Her husband and daughter come up in the same paragraph as her number: it stays hers.
    assert not [k for k in pieces if k[1] == "third_party" and k[0] in ("phone", "email", "children")]
    serialized = json.dumps(report)
    for real in ("Ines", "Moreau", "Margaux", "0142", "ines.moreau", "Niederlassungserlaubnis", "thrombosis"):
        assert real not in serialized


def test_your_name_in_a_message_to_the_bot_is_not_yours():
    message = "From now on your name is Ava Lindgren. Your last answer was wrong."
    export = [{"mapping": {"a": {"message": {"author": {"role": "user"}, "content": {"parts": [message]}}}}}]
    in_chat = scan(extract_file("conversations.json", json.dumps(export).encode()))
    assert in_chat["source"]["kinds"] == {"message": 1}
    assert not any(f["kind"] == "self_name" for f in in_chat["findings"])
    # The same words in a pasted memory summary are the bot talking to you.
    pasted = scan(extract_file("memory.txt", b"Your name is Ava Lindgren. You live in Oslo."))
    assert any(f["kind"] == "self_name" for f in pasted["findings"])


def test_clean_memory_is_suspiciously_clean():
    report, _ = run("clean-memory.txt")
    assert report["totals"]["unique"] == 0
    assert report["level"] == "clean"
    assert report["readouts"]["credentials"]["score"] == 0
    assert all(report["bands"][h]["unique"] == 0 for h in report["bands"])


def test_chatgpt_saved_memories_health_finding():
    report, _ = run("chatgpt-saved-memories.txt")
    health = [f for f in report["findings"] if f["kind"] == "health"]
    assert health
    assert health[0]["label"] == "Health"
    assert "asthma" not in json.dumps(report)


def test_gemini_saved_info_allergy_health():
    report, _ = run("gemini-saved-info.txt")
    assert any(f["kind"] == "health" for f in report["findings"])
    assert "peanut" not in json.dumps(report)


def test_chatgpt_export():
    report, found = run("chatgpt-export.zip")
    source = report["source"]
    assert source["format"] == "chatgpt_export"
    assert source["conversations"] == 6
    assert source["assistantMessagesSkipped"] == 7
    assert source["codeBlocksSkipped"] == 1
    assert source["kinds"] == {"profile": 2, "message": 9}  # custom instructions counted once, not 6 times
    assert (found["emails"], found["phones"], found["birthdays"], found["handles"], found["links"]) == (1, 1, 1, 1, 1)
    assert 4 <= found["names"] <= 6
    serialized = json.dumps(report)
    for real in ("Priya Natarajan", "priya.n@example.org", "0147", "12/09/1993", "Tom Becker"):
        assert real not in serialized
    assert any(f["kind"] == "street_address" for f in report["findings"])
    assert any(f["source"] == "envelope" for f in report["findings"])
    assert found["emails"] == 1


def test_claude_export():
    report, found = run("claude-export.zip")
    source = report["source"]
    assert source["format"] == "claude_export"
    assert source["assistantMessagesSkipped"] == 3
    assert source["kinds"] == {"message": 4, "attachment": 1, "memory": 3, "project": 2}
    assert (found["emails"], found["phones"], found["bank"], found["birthdays"]) == (2, 2, 1, 1)
    assert found["places"] >= 2


def test_large_export_reads_quickly():
    extracted = extract_file("chatgpt-export-large.zip", load("chatgpt-export-large.zip"))
    assert extracted.format == "chatgpt_export"
    assert extracted.conversations > 600
    assert sum(len(s.text) for s in extracted.segments) > 1_000_000


@pytest.mark.parametrize("name,message", [
    ("edge-cases/empty.txt", "That's empty"),
    ("edge-cases/broken-conversations.json", "isn't valid JSON"),
    ("edge-cases/settings-only.json", "couldn't find anything you wrote"),
    ("edge-cases/photo.png", "doesn't look like text"),
    ("edge-cases/photos-only.zip", "Found nothing to read"),
])
def test_edge_cases_give_friendly_errors(name, message):
    with pytest.raises(ExtractError, match=message):
        extract_file(os.path.basename(name), load(name))
