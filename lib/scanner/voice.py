"""
Memories written to the user are read as if the user wrote them.

Claude's memory, and a bot's answer to "what do you remember about me?", talk to the account holder:
"Your name is Jo Bloggs.", "You're married to Sam. Your daughter is Mia." Every subject and keyword rule in the
scanner is written for the first person ("my name is", "my daughter", "I have"), so those memories are rewritten
word for word into the first person before they are read: "Your daughter is Mia" -> "My daughter is Mia". The
rewritten text is never shown; findings only ever hold masked values.

Who "you" is depends on who is talking, so only some text is rewritten:
  * memories only (pasted text, memory files in an export): never the user's own messages, profile or project
    instructions, where "you" is the bot ("your name is ChatGPT", "your answer was wrong");
  * and only when those memories say "you/your" more often than "I/my". First-person saved info ("I'm vegetarian.
    My name is Kofi. Your name is Ava.") keeps "you" as the bot; third-person lists ("Name is Dana.") have neither.
The JavaScript port is web/lib/voice.js.
"""

from __future__ import annotations

import re
from typing import Iterable, List, Sequence

MEMORY_SOURCE = "memory"

SECOND_PERSON_RE = re.compile(r"\b[Yy]ou(?:r|rs|rself)?\b")
FIRST_PERSON_RE = re.compile(r"\bI\b|\b(?:[Mm]e|[Mm]y|[Mm]ine|[Mm]yself)\b")

# Longest forms first: "you're" before "you", "yours" before "your". "Yourselves" and "YouTube" are left alone.
YOU_RE = re.compile(r"\b(?:you(?:['’](?:re|ve|d|ll)|\s+(?:are|were))?|your(?:s|self)?)\b", re.I)
FIRST_PERSON = {
    "you're": "I'm",
    "you are": "I am",
    "you were": "I was",
    "you've": "I've",
    "you'd": "I'd",
    "you'll": "I'll",
    "you": "I",
    "yourself": "myself",
    "yours": "mine",
    "your": "my",
}


def _first_person(match: re.Match) -> str:
    said = match.group(0)
    key = re.sub(r"\s+", " ", said.lower().replace("’", "'"))
    mine = FIRST_PERSON[key]
    return mine[0].upper() + mine[1:] if said[0].isupper() else mine


def to_first_person(text: str) -> str:
    """ "Your daughter is Mia" -> "My daughter is Mia"; "You're 29" -> "I'm 29"."""
    return YOU_RE.sub(_first_person, text)


def _talks_to_you(texts: Iterable[str]) -> bool:
    second = first = 0
    for text in texts:
        second += len(SECOND_PERSON_RE.findall(text))
        first += len(FIRST_PERSON_RE.findall(text))
    return second > first


def memories_in_second_person(segments: Iterable) -> bool:
    """Do the memories talk to the user ("you", "your") more than they speak as the user ("I", "my")?"""
    return _talks_to_you(s.text for s in segments if s.source == MEMORY_SOURCE)


def read_in_first_person(texts: Sequence[str], segments: Sequence) -> List[str]:
    """texts[i] is segments[i] as the scanner reads it (code blanked). Memories written to the user become first
    person; everything else is returned unchanged."""
    memories = [i for i, s in enumerate(segments[:len(texts)]) if s.source == MEMORY_SOURCE]
    read = list(texts)
    if _talks_to_you(read[i] for i in memories):
        for i in memories:
            read[i] = to_first_person(read[i])
    return read
