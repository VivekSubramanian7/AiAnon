// Port of lib/scanner/voice.py — memories written to the user are read as if the user wrote them.
// "Your daughter is Mia" -> "My daughter is Mia", so the first-person rules ("my name is", "my daughter", "I have")
// apply. Only memory segments, and only when they say "you/your" more than "I/my": in the user's own messages,
// and in first-person saved info, "you" is the bot ("your name is ChatGPT"). The rewritten text is never shown.

const MEMORY_SOURCE = "memory";

const SECOND_PERSON_RE = /\b[Yy]ou(?:r|rs|rself)?\b/g;
const FIRST_PERSON_RE = /\bI\b|\b(?:[Mm]e|[Mm]y|[Mm]ine|[Mm]yself)\b/g;

// Longest forms first: "you're" before "you", "yours" before "your". "Yourselves" and "YouTube" are left alone.
const YOU_RE = /\b(?:you(?:['’](?:re|ve|d|ll)|\s+(?:are|were))?|your(?:s|self)?)\b/gi;
const FIRST_PERSON = {
  "you're": "I'm",
  "you are": "I am",
  "you were": "I was",
  "you've": "I've",
  "you'd": "I'd",
  "you'll": "I'll",
  you: "I",
  yourself: "myself",
  yours: "mine",
  your: "my",
};

function firstPerson(said) {
  const mine = FIRST_PERSON[said.toLowerCase().replace(/’/g, "'").replace(/\s+/g, " ")];
  const upper = said[0] !== said[0].toLowerCase();
  return upper ? mine[0].toUpperCase() + mine.slice(1) : mine;
}

/** "Your daughter is Mia" -> "My daughter is Mia"; "You're 29" -> "I'm 29". */
export function toFirstPerson(text) {
  return text.replace(YOU_RE, firstPerson);
}

function talksToYou(texts) {
  let second = 0;
  let first = 0;
  for (const text of texts) {
    second += (text.match(SECOND_PERSON_RE) ?? []).length;
    first += (text.match(FIRST_PERSON_RE) ?? []).length;
  }
  return second > first;
}

/** Do the memories talk to the user ("you", "your") more than they speak as the user ("I", "my")? */
export function memoriesInSecondPerson(segments) {
  return talksToYou(segments.filter((s) => s.source === MEMORY_SOURCE).map((s) => s.text));
}

/**
 * texts[i] is segments[i] as the scanner reads it (code blanked). Memories written to the user become first
 * person; everything else is returned unchanged.
 */
export function readInFirstPerson(texts, segments) {
  const memories = [];
  segments.slice(0, texts.length).forEach((s, i) => {
    if (s.source === MEMORY_SOURCE) memories.push(i);
  });
  const read = [...texts];
  if (talksToYou(memories.map((i) => read[i]))) for (const i of memories) read[i] = toFirstPerson(read[i]);
  return read;
}
