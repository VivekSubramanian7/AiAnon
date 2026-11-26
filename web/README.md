# TMI in the browser

The memory scanner as a static website: everything runs in the visitor's browser tab, nothing is uploaded.
Design: [docs/superpowers/specs/2026-11-17-browser-tmi-design.md](../docs/superpowers/specs/2026-11-17-browser-tmi-design.md).

1. **Quick frisk** (about 1 MB of word lists, seconds): pattern rules for emails, phones, bank numbers, handles,
   links, birthdays, ages and dates, plus name/place/company rules built on word lists and phrases.
2. **The detective** (opt-in, 104 MB once): `Xenova/bert-base-NER` via Transformers.js, downloaded from Hugging Face
   (pinned revision) and cached by the browser. Rescans the same file; names, places and companies now come from
   the model.

No build step and no npm packages. Transformers.js 4.3.2 and its WebAssembly runtime load from jsDelivr only when
the detective is called.

## Run it locally

```bash
python3 scripts/serve_web.py          # from the repo root; serves web/ with the headers in vercel.json
```

Open http://localhost:8079. The server sends the same cross-origin isolation and CSP headers as Vercel, so
multi-threaded WebAssembly works exactly as in production.

## Tests

```bash
node --test tests/web/*.test.mjs             # Node 22+
```

The JavaScript ports are checked against the Python code they came from. After changing the Python side,
regenerate the fixtures:

```bash
.venv/bin/python scripts/web_fixtures_scan.py       # rules + full quick-frisk reports
.venv/bin/python scripts/web_fixtures_extract.py    # file reading
.venv/bin/python scripts/web_fixtures_patterns.py   # pattern rules
```

## Deploy on Vercel

1. New Project → import this repository.
2. **Root Directory: `web`**. Framework preset: Other. No build command, no output directory.
3. Deploy. `vercel.json` sets the headers (COOP/COEP for multi-threading, CSP, caching).
4. Project → **Analytics** → Enable Web Analytics. `app.js` loads Vercel's script from `/_vercel/insights/script.js`
   (same origin, so the CSP needs no change). It counts page visits without cookies and never sees the scanned file.
   It is skipped on localhost, where that path doesn't exist.

Vercel's Hobby plan is for personal, non-commercial use; a commercial launch needs Pro. The model is not hosted on
Vercel (Hobby's 100 MB upload limit; and 104 MB per visitor would use up the bandwidth quickly), so Vercel only
serves a few MB per visit.

## Word lists

`data/lists.json` is built by `scripts/build_web_lists.py` from the US Census Bureau 1990 name files (public domain),
GeoNames (CC BY 4.0, credited in the page footer), Webster's Second International word list (`/usr/share/dict/words`,
public domain) and spaCy's English stop words (MIT).
