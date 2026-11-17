"""Memory scanner: reading exports, chunking, masking, scoring and a full scan."""

import io
import json
import zipfile

import pytest

from lib.scanner.extract import ExtractError, extract_file, extract_text
from lib.scanner.report import Aggregator, exposure_score, level_for, mask
from lib.scanner.scan import MAX_CHUNK_CHARS, build_chunks, scan

CHATGPT_EXPORT = [
    {
        "title": "Trip planning",
        "mapping": {
            "a": {"message": {"author": {"role": "system"}, "content": {"content_type": "text", "parts": [""]}}},
            "b": {"message": {
                "author": {"role": "user"}, "create_time": 1,
                "content": {"content_type": "user_editable_context",
                            "user_profile": "I'm Dana Whitfield, a nurse in Leeds.",
                            "user_instructions": "Keep answers short."},
            }},
            "c": {"message": {"author": {"role": "user"}, "create_time": 2,
                              "content": {"content_type": "text", "parts": ["Email me at dana.w@example.com"]}}},
            "d": {"message": {"author": {"role": "assistant"}, "create_time": 3,
                              "content": {"content_type": "text", "parts": ["Sure, Dana Whitfield!"]}}},
            "e": {"message": {"author": {"role": "user"}, "create_time": 4,
                              "content": {"content_type": "multimodal_text",
                                          "parts": [{"asset_pointer": "file://x"}, "Here's my photo"]}}},
        },
    },
    {
        "title": "Second chat",
        "mapping": {
            "f": {"message": {
                "author": {"role": "user"}, "create_time": 1,
                "content": {"content_type": "user_editable_context",
                            "user_profile": "I'm Dana Whitfield, a nurse in Leeds."},
            }},
        },
    },
]

CLAUDE_EXPORT = [
    {
        "uuid": "1", "name": "Chat",
        "chat_messages": [
            {"sender": "human", "text": "My number is +44 7700 900123",
             "attachments": [{"file_name": "cv.txt", "extracted_content": "Dana Whitfield, Leeds"}]},
            {"sender": "assistant", "text": "Got it, Dana."},
            {"sender": "human", "text": "", "content": [{"type": "text", "text": "I was born in 1988."}]},
        ],
    }
]


def zip_bytes(files: dict) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return buf.getvalue()


# ---------- extract ----------

def test_chatgpt_export_keeps_only_user_text_and_dedupes_profile():
    out = extract_file("conversations.json", json.dumps(CHATGPT_EXPORT).encode())
    texts = [(s.source, s.text) for s in out.segments]
    assert out.format == "chatgpt_export"
    assert out.conversations == 2
    assert out.assistant_messages_skipped == 1
    assert ("message", "Email me at dana.w@example.com") in texts
    assert ("message", "Here's my photo") in texts
    assert sum(1 for s, t in texts if t == "I'm Dana Whitfield, a nurse in Leeds.") == 1
    assert ("profile", "Keep answers short.") in texts
    assert not any("Sure, Dana" in t for _, t in texts)


def test_chatgpt_zip_with_split_conversation_files():
    half = json.dumps(CHATGPT_EXPORT[:1])
    raw = zip_bytes({
        "export/conversations-001.json": half,
        "export/conversations-002.json": json.dumps(CHATGPT_EXPORT[1:]),
        "export/user.json": json.dumps({"email": "dana@example.com"}),
        "export/chat.html": "<html></html>",
    })
    out = extract_file("export.zip", raw)
    assert out.format == "chatgpt_export"
    assert out.conversations == 2
    assert not any("dana@example.com" == s.text for s in out.segments)  # account file skipped


def test_claude_export_with_memories_and_attachments():
    raw = zip_bytes({
        "conversations.json": json.dumps(CLAUDE_EXPORT),
        "memories.json": json.dumps([{"content": "Dana has a cat called Biscuit", "created_at": "2026-01-01"}]),
        "users.json": json.dumps([{"email_address": "dana@example.com"}]),
    })
    out = extract_file("data.zip", raw)
    texts = {(s.source, s.text) for s in out.segments}
    assert out.format == "claude_export"
    assert out.assistant_messages_skipped == 1
    assert ("message", "My number is +44 7700 900123") in texts
    assert ("message", "I was born in 1988.") in texts
    assert ("attachment", "Dana Whitfield, Leeds") in texts
    assert ("memory", "Dana has a cat called Biscuit") in texts
    assert not any("2026-01-01" in t or "dana@example.com" == t for _, t in texts)


def test_pasted_memories_one_per_line():
    out = extract_text("- Lives in Leeds\n- Works as a nurse\n\n3. Has a cat called Biscuit\n")
    assert out.format == "text"
    assert [s.text for s in out.segments] == ["Lives in Leeds", "Works as a nurse", "Has a cat called Biscuit"]


def test_pasted_code_block_stays_one_piece():
    out = extract_text("Lives in Leeds\n```python\nprint(1234567890)\nx = 2\n```\nHas a cat")
    assert [s.text for s in out.segments] == [
        "Lives in Leeds", "```python\nprint(1234567890)\nx = 2\n```", "Has a cat",
    ]


def test_pasted_json_list_of_memories():
    out = extract_text(json.dumps(["Lives in Leeds", "Is 36 years old"]))
    assert [s.text for s in out.segments] == ["Lives in Leeds", "Is 36 years old"]


def test_empty_and_unreadable_uploads_raise_friendly_errors():
    with pytest.raises(ExtractError):
        extract_text("   \n ")
    with pytest.raises(ExtractError):
        extract_file("conversations.json", b"{not json")
    with pytest.raises(ExtractError):
        extract_file("photo.png", bytes(range(256)) * 4)
    with pytest.raises(ExtractError):
        extract_file("empty.zip", zip_bytes({"image.png": "x"}))


# ---------- chunking ----------

def test_chunks_respect_the_limit_and_keep_segment_spans():
    texts = ["short one", "x" * 100, ("word " * 4000).strip(), "tail"]
    chunks = build_chunks(texts, limit=1000)
    assert all(len(c.text) <= 1000 for c in chunks)
    for c in chunks:
        for s, e, index in c.spans:
            assert c.text[s:e] in texts[index]
    joined = "".join(c.text for c in chunks).replace("\n", "").replace(" ", "")
    assert joined == "".join(texts).replace(" ", "")


def test_long_unbroken_line_is_hard_split():
    chunks = build_chunks(["a" * 2500], limit=1000)
    assert [len(c.text) for c in chunks] == [1000, 1000, 500]


# ---------- report ----------

@pytest.mark.parametrize("category,value,expected", [
    ("names", "Sarah Müller", "S•••• M•••••"),
    ("emails", "sarah.mueller@gmail.com", "s••••.•••••••@g••••.com"),
    ("phones", "+44 7911 123456", "+•• •••• ••••56"),
    ("bank", "DE89 3704 0044 0532 0130 00", "•••• •••• •••• •••• •••• 00"),
    ("links", "https://linkedin.com/in/sarah", "linkedin.com/•••"),
    ("handles", "@sarahm", "@s•••••"),
    ("ages", "I'm 34", "30s"),
    ("birthdays", "born on 12.03.1987", "•••• •• ••.••.••••"),
])
def test_masking_hides_values(category, value, expected):
    assert mask(category, value) == expected


def test_aggregator_counts_mentions_and_distinct_values():
    agg = Aggregator()
    for token_type, original in [
        ("PERSON", "Dana Whitfield"), ("PERSON", "dana  whitfield"), ("PERSON", "Sam"),
        ("PHONE", "+44 7700 900123"), ("PHONE", "+447700900123"),
        ("DOB", "born 1988"), ("DOB", "03/05/2024"),
        ("SENDER", "Dana"), ("BLOCKLIST", "secret"),
    ]:
        agg.add(token_type, original)
    rows = {r["key"]: r for r in agg.categories()}
    assert (rows["names"]["count"], rows["names"]["unique"]) == (3, 2)
    assert rows["names"]["examples"][0] == {"masked": "D••• W••••••••", "count": 2}
    assert (rows["phones"]["count"], rows["phones"]["unique"]) == (2, 1)
    assert rows["birthdays"]["count"] == 1 and rows["dates"]["count"] == 1
    assert agg.totals() == {"mentions": 7, "unique": 5, "directUnique": 4, "contextUnique": 1}


def test_chatbot_names_and_jargon_are_not_personal():
    agg = Aggregator()
    for token_type, original in [("PERSON", "Claude"), ("ORG", "ChatGPT"), ("ORG", "IBAN"), ("PERSON", "Gemini"),
                                 ("PERSON", "Mia Ellery")]:
        agg.add(token_type, original)
    rows = {r["key"]: r for r in agg.categories()}
    assert rows["names"]["unique"] == 1 and rows["orgs"]["unique"] == 0


def test_dates_misread_as_phones_count_as_dates():
    agg = Aggregator()
    for original in ("03.05.2026", "2026-05-03", "+44 7700 900123"):
        agg.add("PHONE", original)
    rows = {r["key"]: r for r in agg.categories()}
    assert rows["dates"]["count"] == 2 and rows["phones"]["count"] == 1


def test_words_before_a_date_mark_it_as_a_birthday():
    agg = Aggregator()
    agg.add("PHONE", "12/09/1993", context="My birthday is on ")
    agg.add("DOB", "22/01/1995", context="I'm 31 and my birthday is ")
    agg.add("DOB", "03.05.2026", context="Dentist on ")
    rows = {r["key"]: r for r in agg.categories()}
    assert rows["birthdays"]["count"] == 2 and rows["dates"]["count"] == 1


def test_first_name_alone_merges_into_full_name():
    agg = Aggregator()
    for name in ("Priya Natarajan", "Priya", "Priya", "Leo", "Maya Chen"):
        agg.add("PERSON", name)
    rows = {r["key"]: r for r in agg.categories()}
    assert rows["names"]["unique"] == 3  # Priya Natarajan, Leo, Maya Chen
    assert rows["names"]["examples"][0] == {"masked": "P•••• N••••••••", "count": 3}
    assert agg.totals()["unique"] == 3


def test_apps_code_words_and_addresses_are_not_names():
    agg = Aggregator()
    for token_type, original in [("PERSON", "Instagram"), ("ORG", "TypeScript"), ("ORG", "KeyError"),
                                 ("PERSON", "Austin TX 78704"), ("PERSON", "Tom Becker")]:
        agg.add(token_type, original)
    assert agg.totals()["unique"] == 1


def test_birth_date_is_not_also_counted_as_a_date():
    report = scan(extract_text("Was born on 14.02.1991.\nDentist appointment on 03.05.2026."))
    rows = {r["key"]: r for r in report["categories"]}
    assert rows["birthdays"]["count"] == 1
    assert rows["dates"]["count"] == 1  # the dentist, not the birthday again


def test_score_and_levels():
    assert exposure_score(0, 0) == 0 and level_for(0) == "clean"
    assert level_for(exposure_score(1, 0)) == "mild"
    assert level_for(exposure_score(5, 5)) == "chatty"
    assert level_for(exposure_score(10, 10)) == "oversharer"
    assert exposure_score(100, 100) == 100 and level_for(100) == "biography"


# ---------- full scan (real pipeline) ----------

def test_scan_finds_personal_details_in_memories():
    memories = "\n".join([
        "User's name is Dana Whitfield.",
        "Email: dana.whitfield@example.com, phone +44 7700 900123.",
        "Lives in Manchester and works at Northwind Health.",
        "Was born on 14.02.1988.",
        "Likes hiking and bad puns.",
        "```python\nprint(1234567890)\n```",
    ])
    report = scan(extract_text(memories))
    rows = {r["key"]: r for r in report["categories"]}
    assert rows["emails"]["unique"] == 1
    assert rows["phones"]["unique"] >= 1
    assert rows["names"]["unique"] >= 1
    assert rows["birthdays"]["unique"] == 1
    assert report["source"]["codeBlocksSkipped"] == 1
    assert 0 < report["score"] <= 100
    assert report["source"]["piecesWithFinds"] >= 3
    serialized = json.dumps(report)
    for secret in ("Dana Whitfield", "dana.whitfield@example.com", "900123", "14.02.1988"):
        assert secret not in serialized


def test_scan_handles_text_longer_than_one_chunk():
    line = "Call Priya Natarajan on +1 415 555 0134 about the Denver office. "
    report = scan(extract_text((line * 400).strip()))
    assert report["source"]["charactersScanned"] > MAX_CHUNK_CHARS
    assert report["source"]["failedChunks"] == 0
    rows = {r["key"]: r for r in report["categories"]}
    assert rows["phones"]["count"] >= 400
