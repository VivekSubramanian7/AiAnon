"""Memories written to the user ("Your name is …", "You're married to …") are read as the account holder's words."""

from lib.scanner.extract import Segment, extract_text
from lib.scanner.findings import assemble
from lib.scanner.detectors import detect
from lib.scanner.voice import memories_in_second_person, read_in_first_person, to_first_person


def test_to_first_person_rewrites_you_and_your():
    assert to_first_person("Your name is Jo Bloggs.") == "My name is Jo Bloggs."
    assert to_first_person("You're married to Sam. Your daughter is Mia.") == "I'm married to Sam. My daughter is Mia."
    assert to_first_person("You’ve asked about your own anxiety") == "I've asked about my own anxiety"
    assert to_first_person("you are 29, you were born in Leeds and the flat is yours") == (
        "I am 29, I was born in Leeds and the flat is mine"
    )
    assert to_first_person("You'd asked yourself; you'll see") == "I'd asked myself; I'll see"


def test_to_first_person_leaves_other_words_alone():
    assert to_first_person("YouTube, young people and yourselves") == "YouTube, young people and yourselves"


def test_only_memories_mostly_written_to_the_user_are_second_person():
    second = [Segment("Your name is Jo.", "memory"), Segment("You live in Leeds.", "memory")]
    first = [Segment("My name is Kofi.", "memory"), Segment("I live in Accra.", "memory"),
             Segment("Your name is Ava.", "memory")]
    assert memories_in_second_person(second)
    assert not memories_in_second_person(first)
    assert not memories_in_second_person([Segment("Prefers short answers.", "memory")])
    # The user's messages to the bot don't count: "you" there is the bot.
    assert not memories_in_second_person([Segment("Your answer was wrong. Your name is Ava.", "message")])


def test_messages_to_the_bot_are_never_rewritten():
    segments = [Segment("Your name is Jo.", "memory"), Segment("Your answer was wrong, your name is Ava now", "message")]
    texts = [s.text for s in segments]
    assert read_in_first_person(texts, segments) == ["My name is Jo.", "Your answer was wrong, your name is Ava now"]


def test_first_person_memories_keep_you_as_the_bot():
    extracted = extract_text("I'm vegetarian.\nMy name is Kofi.\nI live in Accra.\nYour name is Ava.")
    texts = [s.text for s in extracted.segments]
    assert read_in_first_person(texts, extracted.segments) == texts


def _rows(text):
    return {(r["kind"], r["subject"]): r["confidence"] for r in assemble([], detect(text))}


def test_second_person_summary_reads_like_the_first_person():
    summary = to_first_person(
        "You're married to Sam, and your daughter is Mia. You've asked about your own anxiety. "
        "Your Niederlassungserlaubnis came through in March."
    )
    rows = _rows(summary)
    assert rows[("children", "account_holder")] == "medium"
    assert rows[("health", "account_holder")] == "medium"
    assert rows[("immigration", "account_holder")] == "medium"
