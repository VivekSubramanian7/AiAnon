# Mock memories for testing TMI

Fake chatbot memories and exports to drop into the scanner. Everyone in them is invented:
emails use `example.com`/`.org`/`.net`, phone numbers come from ranges reserved for fiction
(`+1 xxx 555 01xx`, `+44 7700 900xxx`), and the IBANs are the standard published example IBANs.

Regenerate them with `python scripts/make_mock_memories.py`. See exactly what each one finds,
real values included, with `python scripts/scan_mock_memories.py`.
`tests/test_mock_memories.py` checks the results below.

The bot answer and the Claude memory summary talk to the user ("you", "your"). The scanner reads memories like
these in the first person, so "your daughter" counts as the user's own (see `lib/scanner/voice.py`).

## The files

| File | What it is | Result |
|---|---|---|
| `chatgpt-saved-memories.txt` | ChatGPT's memory list, as copied from Settings → Personalization → Manage memories (Dana, a nurse in Leeds) | 16 things, score 66, Certified oversharer |
| `gemini-saved-info.txt` | Gemini "Saved info", first-person (Kofi, Accra → London) | 9 things, score 45, Chatty |
| `bot-answer-what-do-you-remember.txt` | A bot's reply to "What do you remember about me?" (Sam, a teacher in Denver) | 11 things, score 52, Certified oversharer |
| `claude-memory-summary.txt` | A memory summary in the style of Claude's memory, written to the user ("Your name is …") in paragraphs under topic headings (Ines, Lyon → Munich) | 9 things, score 45, Chatty |
| `clean-memory.txt` | Only preferences: no names, places or numbers | 0 things, score 0, Suspiciously clean |
| `chatgpt-export.zip` | ChatGPT data export: 6 conversations about Priya in Austin | 16 things, score 66, Certified oversharer |
| `claude-export.zip` | Claude data export: conversations, memories, a project and an attached CV (Marcus, Hamburg → Toronto) | 17 things, score 73, Certified oversharer |
| `chatgpt-export-large.zip` | 1,241 conversations, about 1 million characters you wrote | about 344 things, score 100; takes about 20 seconds |

The exports contain traps the scanner has to avoid:

- **ChatGPT:** AI replies that repeat your name, a system message and a tool message, custom
  instructions repeated in all 6 conversations (counted once), a numeric ID inside a code block,
  an image plus text in one message, and `user.json` with the account's email and phone. All of
  these are skipped.
- **Claude:** AI replies, a message whose text sits only in its `content` list, `users.json` with
  the account details (skipped), plus `memories.json`, `projects.json` and an attachment, which are
  all read.

## What each file should catch

| File | Should find | Known misses |
|---|---|---|
| ChatGPT saved memories | 4 names, email, phone, birth date (03.07.1989), IBAN, @handle, age, 4 places | asthma, St Mary's Hospital |
| Gemini saved info | 2 names, email, phone, birth date (22/01/1995), age, Accra and London, Blue Room Studios | peanut allergy |
| Bot answer | 2 names, 2 emails, phone, birth date (08/04/1997), age, Denver and Colorado, school and bank | |
| Claude memory summary | her name (as yours), phone, email, Munich and Lyon, Lindqvist Freight as employer, the Niederlassungserlaubnis, her daughter and "your then three-year-old", anxiety and thrombosis as health | "lazy-eye" stays low: it is the child's, and nothing says it's hers |
| ChatGPT export | 5 names ("Priya" merges into "Priya Natarajan"), email, phone, birthday (12/09/1993), @handle, GitHub link, age 33, Austin, Lisbon and Texas, 2 employers | the street address "flat 4B at 18 Elm Grove"; the travel date `2026-05-14` |
| Claude export | 6 names, 2 emails, 2 phones, birth date (21.11.1985), IBAN, Hamburg and Toronto, 2 companies, a move-out date | the school name; "Kuehne Freight" gets counted as a name, not a company |

## Broken uploads (`edge-cases/`)

| File | Message the user sees |
|---|---|
| `empty.txt` | That's empty. Paste your memories, or drop a file. |
| `broken-conversations.json` | … isn't valid JSON. Upload the file exactly as it came out of the export. |
| `settings-only.json` | We couldn't find anything you wrote in there. Nothing to judge. Suspicious. |
| `photo.png` | That doesn't look like text. Upload a .zip export, a .json file, or a .txt with your memories. |
| `photos-only.zip` | Found nothing to read in that zip. Use the export zip from ChatGPT or Claude. |
