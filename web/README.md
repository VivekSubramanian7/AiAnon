# TMI in the browser

The memory scanner as a static website: everything runs in the visitor's browser tab, nothing is uploaded.
Design: [docs/superpowers/specs/2026-11-17-browser-tmi-design.md](../docs/superpowers/specs/2026-11-17-browser-tmi-design.md).

1. **Quick frisk** (about 1 MB of word lists, seconds): pattern rules for emails, phones, bank numbers, handles,
   links, birthdays, ages and dates, plus name/place/company rules built on word lists and phrases.
2. **The detective** (opt-in, 104 MB once): `Xenova/bert-base-NER` via Transformers.js, downloaded from Hugging Face
   (pinned revision) and cached by the browser. Rescans the same file; names, places and companies now come from
   the model.

No build step and no npm packages. All code runs from this site; the only other host is Hugging Face, for the model.

## Third-party code and downloads

- **`vendor/`** holds Transformers.js 4.3.2 and the ONNX Runtime WebAssembly build it is compiled against
  (`onnxruntime-web` 1.31.0-dev.20260914, a pre-release that Transformers.js pins; its JavaScript is bundled inside
  Transformers.js, so the two can't be upgraded separately). The detective uses the plain CPU build (14 MB, not the
  27 MB WebGPU one). The files are byte for byte the npm packages, which matched npm's published integrity hashes and
  jsDelivr's copies. `vendor/SHA256SUMS` records them and `tests/web/vendor.test.mjs` checks them.
- **The model:** `lib/detective.js` lists every file it may download with its SHA-256 (`MODEL_FILES`, from Hugging
  Face's records for the pinned revision). Transformers.js downloads through `modelFetch`, which requests only those
  files at that revision and errors a download whose size or hash doesn't match, so it is never used or cached.
- **CSP** (`vercel.json`): scripts and workers from this site only; connections to this site and Hugging Face only.
- **Privacy:** Hugging Face sees the visitor's IP address when the detective downloads (the page says so). Nothing
  else leaves the tab.

To update a vendored package: `npm pack <package>@<version>`, check the tarball against
`npm view <package>@<version> dist.integrity`, copy the files, run `shasum -a 256 … > SHA256SUMS` from `web/vendor/`
(check with `shasum -a 256 -c SHA256SUMS`), and update the paths in `lib/detective.js`. To change the model revision, update `MODEL_REVISION` and `MODEL_FILES`
from `https://huggingface.co/api/models/Xenova/bert-base-NER/tree/<revision>?recursive=true` (the LFS `oid` is the
SHA-256; hash the small JSON files after checking their git ids).

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

Vercel's Hobby plan is for personal, non-commercial use; a commercial launch needs Pro. The model is not hosted on
Vercel (Hobby's 100 MB upload limit; and 104 MB per visitor would use up the bandwidth quickly). Vercel serves a few
MB per visit, plus 14 MB the first time a visitor calls the detective (the WebAssembly runtime, then cached for a
year). On Hobby's 100 GB a month, the runtime alone allows about 7,000 first-time detective visitors.

## Word lists

`data/lists.json` is built by `scripts/build_web_lists.py` from the US Census Bureau 1990 name files (public domain),
GeoNames (CC BY 4.0, credited in the page footer), Webster's Second International word list (`/usr/share/dict/words`,
public domain) and spaCy's English stop words (MIT).
