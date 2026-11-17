"""
The mock memories in samples/mock-memories/ scan the way the README there says.
Regenerate them with: python scripts/make_mock_memories.py
"""

import json
import os

import pytest

from lib.scanner.extract import ExtractError, extract_file
from lib.scanner.scan import scan

MOCKS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "samples", "mock-memories")


def load(name):
    with open(os.path.join(MOCKS, name), "rb") as f:
        return f.read()


def run(name):
    report = scan(extract_file(name, load(name)))
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


def test_clean_memory_is_suspiciously_clean():
    report, _ = run("clean-memory.txt")
    assert report["totals"]["unique"] == 0
    assert report["level"] == "clean"


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
