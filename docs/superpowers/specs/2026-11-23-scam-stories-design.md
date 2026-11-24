# Scam stories: design

Date: 2026-11-23. Branch: `feature/scam-stories` (from AiAnon `main`).

## Intent

TMI's results page opens with a harm × life-domain grid (H1–H6 × nine domains), then four 0–100 meters, then
lists of findings. That reads as data-science output. Most visitors can't turn it into "so what could actually
happen to me?"

The results page should open with **stories**: short, plain-English accounts of what a stranger could do with this
file. Each story is a real, well-known scam, assembled from the pieces the scan found. The reader should understand
the danger (how a financial detail can be misused, what can be built from it) **without being frightened**. The
grid stays one click away for anyone who wants the detail.

No language model. Stories come from fixed rules over the scan's findings, so they run in the browser and the local
app, and the same file always gives the same stories.

## Who it's for

Anyone who drops a ChatGPT, Claude or Gemini memory or export into TMI. They are not security people. Assume they
don't know what an IBAN check, SIM swap or phishing is.

## Success

- After reading, a visitor can say in one sentence the most harmful realistic thing someone could do with their
  file, and one thing they can do about it.
- Nobody is told a story the file doesn't support: every "found" piece is a finding at medium confidence or above.
- The 6 mock memories each produce the stories listed in the builder's expectation table (see Testing), and a file
  with nothing serious gets a calm "not much to build with" result.

## Goals, non-goals, anti-goals

**Goals**
- Stories first, grid behind a toggle.
- Stories cover the account holder **and** people they mention (decided by Vivek).
- Each story shows: the pieces a con artist would need, which ones are in the file (with the masked value), how the
  scam goes, how bad it would be, and what stops it.
- Rule-based and testable; the wording is editable without touching the matching code.

**Non-goals (v1)**
- New detectors. v1 uses only the kinds the scanners already produce. Recipes that would need new detectors (a
  child's name or school, mother's maiden name, pet names, travel dates) are listed under Later. *(My call; see
  "Calls made".)*
- Changing harm bands, scores, the grid itself, or the "Copy AI analysis prompt" feature.
- Languages other than English.

**Anti-goals (a failure even if it works)**
- Fear: red alarms, skulls, countdowns, "hackers", "you could lose everything", all-caps warnings, percentages of doom.
- Saying something **will** happen. Stories say what someone **could try** and what they **would need**.
- A story about someone else that describes physical harm to them. Stories about others describe the trick and how
  to block it, nothing more.
- A story built on a guess: a low-confidence keyword ("anxiety" in a work email) never fills a piece.
- Showing any unmasked value.

## Constraints

- Static site, CSP `script-src 'self'`, `style-src 'self'`: no inline styles (set custom properties through the
  CSSOM, as `report-view.js` already does), no new third-party code.
- `web/lib/report-view.js` is shared by the browser TMI (`web/app.js`) and the local app (`public/scanner/app.js`,
  which gets its report from the Python scanner). Anything the stories read must exist in both reports.
- The Python and JavaScript scanners are kept in step by fixture tests (`scripts/web_fixtures_scan.py`,
  `tests/web/scan.test.mjs`).
- "Only official or proven" parts: every recipe is a documented scam with an official source (government,
  regulator, police or consumer body).

## Approaches considered

1. **Scam recipes** (chosen by Vivek). A fixed library of about a dozen real scams, each listing the pieces it
   needs; the file's findings tick them off; the most harmful, most complete matches are shown. Every story is a real
   scam, easy to explain and test, and the words are editable. Cost: each story must be written well, and only
   pre-written combinations appear.
2. **One paragraph per life area.** Fill-in-the-blank sentences per grid column. Quick and complete, but reads as a
   report, and misses that the danger is in combinations across areas.
3. **Unlock chains.** A graph of what each piece unlocks (email → password reset → accounts), with computed paths.
   Most story-like, but far more to build, and a computed chain can make an unlikely path look certain.

Recipes were chosen because they give the step-by-step feel of (3) inside each hand-written story, limited to scams
that really happen. A one-line roll-up per life area, in the spirit of (2), covers what no story uses.

## Design

### 1. What the stories read: a full tally of pieces

`report.findings` is capped at 12 per harm band (`capFindings`), so a story built on it could miss pieces in a busy
file. Both scanners add one field, built from the **uncapped** findings, next to `domainMatrix`:

```
report.pieces = [
  { kind: "date_of_birth", subject: "account_holder", count: 1, confidence: "medium", example: "14/0•/19••" },
  { kind: "phone", subject: "third_party", count: 3, confidence: "high", example: "+44 •••• ••• 789" },
  ...
]
```

One row per (kind, subject). `confidence` is the best confidence among that row's findings; `example` is the
masked value of the best one (sorted as `sortFindings` sorts). Additive to schema v2; no version bump. If `pieces`
is missing (an older report), stories fall back to `report.findings`.

Python: `lib/scanner/findings.py` (`build_pieces`) and `lib/scanner/scan.py`. JavaScript: `web/lib/sensitivity.js`
(`buildPieces`) and `web/lib/scan.js`. Fixtures regenerated so the two match.

### 2. Recipes

A plain data file, `web/lib/stories-data.js`, exports the recipe list. Editing wording means editing text in that
file only. Each recipe:

| Field | Meaning |
|---|---|
| `id` | stable id, e.g. `bank-call` |
| `title` | ≤ 8 words, what the stranger could do: "Call your bank, pretending to be you" |
| `scam` | the scam's common name: "Bank impersonation call" |
| `about` | `you` or `others` |
| `impact` | how bad it would be if it happened, one of three calm labels: **A hassle**, **Costly**, **Hard to undo**. Drives the sort (§3). |
| `pieces` | list of `{ label, kinds[], who, key, optional }`: `who` is `you` or `others`; `key: true` marks the piece without which the story can't happen; `optional: true` pieces show when found but don't count towards the total |
| `howItGoes` | 2–3 sentences, ≤ 50 words, second person, "could"/"would" |
| `fix` | 1–2 concrete actions that break the chain |
| `source` | `{ name, url }`: an official page describing this scam |

**v1 recipe list** (wording here is a draft; the builder writes the final text to the rules in §4 and confirms each
source):

Kind shorthands used below:
- **your name** = `self_name` only ("My name is…"), and **always optional**. No scanner reads a name from the
  export's account file, and a con artist can usually guess a name from an email address anyway, so a missing name
  must never keep a story from showing, and a found one never tips a story over the line on its own.
- **your phone** = `phone` or `account_phone`; **your email** = `email` or `account_email`; **address** =
  `street_address` or `gps`.

| # | Title (draft) | About | Counted pieces (kinds) | Key | Optional | Impact |
|---|---|---|---|---|---|---|
| 1 | Sign in with what you pasted | you | password or key: `password_cue`, `api_token`, `aws_access_key`, `private_key`, `tokenized_url`, `jwt` | password or key | | Costly |
| 2 | Use your card online | you | card `payment_card`; address | card | your name | Costly |
| 3 | Take money from your bank account by direct debit | you | `iban`; address | IBAN | your name | Costly |
| 4 | Open accounts in your name | you | ID number `national_id`; date of birth `date_of_birth`; address | ID | your name | Hard to undo |
| 5 | Call your bank, pretending to be you | you | date of birth; your phone or email; address | date of birth | your name | Costly |
| 6 | Move your phone number to their SIM | you | your phone; date of birth; address | phone | your name | Hard to undo |
| 7 | A call "from immigration" | you | `immigration`; your phone or email; `employer` | immigration | your name | Costly |
| 8 | A message "from work" asking for money or logins | you | `employer`; your email; `profile_url` | employer | your name, salary `compensation` | Costly |
| 9 | Knock on your door, sounding official | you | address | address | your name | A hassle |
| 10 | A fake insurer or pharmacy | you | `health` (medium only); your phone or email | health | your name | Costly |
| 11 | A text from your "child" on a new number | others | you mention a child `children`; your phone | child | your name | Costly |
| 12 | Your friends get a message "from you" | others | other people's `email`/`phone`/`handle` (subject `third_party`) | contacts | your name | Costly |

Recipes whose only counted piece is the key (1, 9, 12) show whenever the key is found.

Notes on specific recipes:
- **3**: an account number and a name are enough to set up a debit in many countries. The fix ("check your
  statements; your bank can usually reverse a debit you didn't agree to") must hold wherever the visitor lives; the
  rules differ (SEPA refunds in the euro area, the Direct Debit Guarantee in the UK). See Country.
- **9** is a doorstep con (fake official, courier, tradesperson), not stalking.
- **11** is the "Hi Mum/Dad" scam. It targets the parent, never describes harm to the child.
- **12** includes WhatsApp-style account-hijack messages to contacts.

### 3. Matching and ranking (`web/lib/stories.js`, pure functions)

**Filling a piece**
- A piece is **found** if `report.pieces` has a row whose kind is in the piece's `kinds`, whose confidence is
  `confirmed`, `high` or `medium`, and whose subject fits:
  - `who: you` accepts `account_holder` (shown as **yours**) and `unknown` (shown as **looks like yours**). Never
    `third_party`.
  - `who: others` accepts `third_party` only (for `children`, any subject: the detector only fires on "my son/
    daughter/kid/child").
  - `account_email` / `account_phone` (from the export's account file) count as **yours**, confirmed.
- When more than one row fits, show the best (confidence, then `account_holder` over `unknown`) and its masked
  `example`.

**When a story shows**
- Its key piece is found, **and** at least half of its counted pieces are found (optional pieces don't count, but
  do show when found).
- Sort by `impact` (Hard to undo, then Costly, then A hassle), then by share of counted pieces found, then by table
  order. This puts "the most harmful realistic thing" first, which is the first success criterion.
- Show the top **3**. If any `others` story qualifies, the best one always takes the third place (or a lower one if
  it already ranks higher), so stories about people you mention are never hidden behind the fold.
- The rest sit behind "N more things someone could try".

**Nothing qualifies:** show a calm result: "Not much to build with here." Then the recipe with the most pieces
found, presented as "the closest someone could get", with its missing pieces, so the visitor still learns what to
keep out of their chats.

**Everything else:** below the stories, one line per life area that has findings no shown story used, e.g. "Also
in here: 4 places and 2 organisations." Counts only, from `report.pieces`.

### 4. Writing rules (for every recipe)

- Plain English, reading age about 12. Name the scam in everyday words; explain any term once ("moving your number
  to their SIM card").
- Second person. "Someone could…", "they would need…". Never "will", "hackers", "criminals are…".
- The danger is concrete and real (what they'd do, what it would cost you), not dramatic.
- Always end with the fix, as actions the visitor can take today.
- Stories about others: the trick and how to block it; no physical harm, no detail about the other person.
- The `impact` label carries the seriousness so the prose doesn't have to.

### 5. The results page

New order (both front ends):

```
┌ Case file ─────────────────────────────────────────────┐
│ If this leaked, someone could try 3 things.            │  ← headline (replaces "N serious leads")
│                                                        │
│ 1  Call your bank, pretending to be you   Costly       │
│    Bank impersonation call · a common scam  [source]   │
│    What they'd need        In your file?               │
│    Your full name          ✓ yours                     │
│    Date of birth           ✓ looks like yours 14/0•/19••│
│    Your phone or email     ✓ yours  +44 •••• ••• 789   │
│    Home address            ✗ not found                 │
│    How it goes   2–3 sentences                         │
│    What stops it 1–2 actions                           │
│                                                        │
│ 2  …        3  … (about people you mention, labelled)  │
│ ▸ 2 more things someone could try                      │
│ Also in here: 4 places, 2 organisations.               │
└────────────────────────────────────────────────────────┘
  Case facts (source, conversations, scan time)  ← existing verdict facts
  Detective panel (frisk stage only, unchanged)
  [ Show the evidence ]  ← toggle; collapsed by default
     grid · harm meters · findings lists · corpus detail
  Now what · result actions · caveats (unchanged)
```

- "Show the evidence" is a button with `aria-expanded` controlling one region that holds the existing grid, readout
  meters, findings sheet and corpus detail, unchanged inside.
- Found / not found is shown with text and symbol, never colour alone.
- The story sheet uses the existing sheet styles ("case file" look); new CSS lives with the other report styles.
- After the detective runs, stories are rebuilt from the new report like everything else.
- "Copy my results" stays numbers only, keeping the promise next to the button ("No names, no digits, nothing to
  doxx"): "Someone could try 3 things with my file: 1 hard to undo, 2 costly." No story titles, since titles such
  as "A call from immigration" or "A fake pharmacy" would reveal sensitive topics.
- The existing case-file extras:
  - The "Case closed. N things the frisk missed" line (detective stage) stays, directly under the story headline:
    it's the payoff for the download.
  - The stamp ("Certified oversharer", "Case open") and the joke line move down into the case facts block, away
    from the stories, so the playful voice doesn't sit next to a scam.

### 6. Testing

- `tests/web/stories.test.mjs`: matching rules (key piece, half-rule, optional pieces, ranking, top 3, nothing-
  qualifies fallback), subject rules (third-party never fills a "you" piece; unknown shows as "looks like yours"),
  confidence rule (low never fills), fallback to `report.findings` when `pieces` is absent.
- Recipe data checks: every kind named in a recipe exists in `KIND_LABELS`; every recipe has a key piece, a fix and a
  source URL; titles ≤ 8 words; `howItGoes` ≤ 50 words; no banned words (`will`, `hacker`, …).
- Parity: `pieces` equal between Python and JavaScript on the scan fixtures.
- An expectation table for the 6 mock memories (which stories each shows), produced by the builder and checked in a
  test, reviewed by Vivek.
- Browser: both front ends, both stages, light and dark, phone width; the toggle works by keyboard.

## Later

- Detectors that would unlock better recipes: child's name and school, mother's maiden name, pet names, travel
  dates (burglary while away), car registration.
- A shareable story card.
- Per-country fixes and sources, chosen from the country of an IBAN or phone number in the file.

## Country (decided by Vivek, 2026-11-24): works anywhere

Visitors can be anywhere, so every `fix` and `howItGoes` must hold in any country:
- Name the action, not the local rule: "ask your bank to reverse it; most banks can for a debit you didn't agree
  to", not "SEPA refunds within 8 weeks". "Ask your mobile provider for a SIM lock or port-out PIN", not a
  specific carrier's setting. "Check with the authority's official website", not a named agency.
- No phone numbers, deadlines or amounts that only apply in one country.
- `source` is one official page per scam: an international body (such as Europol) where one covers it, otherwise a
  national government, police or consumer-protection page, in English. The source illustrates that the scam is
  real; the fix must not depend on it.
- Per-country advice (choosing text by the IBAN or phone prefix) is under Later.

## Calls made (for Vivek to check)

- v1 uses existing detectors only.
- `unknown` subject fills "you" pieces, shown as "looks like yours". Strictly requiring "account_holder" would hide
  most stories, since few findings carry an explicit "my".
- "Your name" is always optional: only `self_name` fills it, and the export's account email or phone never does.
- Top 3 stories shown; a story needs its key piece and half its counted pieces.
- Sort by impact first, so the most harmful story leads; one of the three places is kept for a story about others.
- Story text is fixed per recipe; masked values appear only in the pieces list, not woven into sentences.
- Three impact labels (A hassle / Costly / Hard to undo) instead of a score.
- The harm meters and findings lists move behind the toggle together with the grid.
- "Copy my results" stays numbers only; no story titles.
- "Case closed" line kept under the headline; stamp and joke line move down to the case facts.
