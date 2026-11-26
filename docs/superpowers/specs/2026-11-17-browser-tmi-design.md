# Browser TMI: design

Date: 2026-11-17. Branch: `feature/memory-scanner` (kept separate from `feature/private-chat-workflow`).

## Goal

A public website (Vercel) where anyone drops their ChatGPT, Claude or Gemini memory and sees how much
personal information it holds. The scan runs inside the visitor's browser tab; the file is never uploaded.
English only. Only official or proven parts.

## Two stages

1. **Quick frisk** (no model, about 1 MB of word lists). Pattern rules (emails, phones, bank numbers, handles,
   links, birthdays, ages, dates) plus name/place/company rules built on word lists and phrases. Runs in seconds.
   The report says "at least N" and carries a CASE OPEN stamp. Benchmark: 62.7% of names, 17.8% of companies.
2. **Call in the detective** (opt-in). Downloads `Xenova/bert-base-NER` (104 MB, 8-bit, MIT) once from
   Hugging Face, pinned to revision `8e892123e8b7c2c0c2bd1dcb598b7d244c4e53aa`, and rescans the same file.
   Names, places and companies now come from the model (replacing the frisk's, not added to them);
   the pattern rules are unchanged. Benchmark: 89.2% of names, 61.6% of companies. The reveal says how many
   things the frisk missed.

Voice: detective. "Quick frisk", "Call in the detective", "Case closed. 5 things the frisk missed."

## Architecture

```
web/                       static site, Vercel project root
  index.html styles.css app.js       page and UI (main thread)
  worker.js                          module Web Worker: reads the file, runs both stages, posts progress
  lib/zip.js                         zip reader over random access (File.slice), DecompressionStream
  lib/extract.js                     port of lib/scanner/extract.py
  lib/patterns.js                    port of lib/pipeline/regex_stripper.py
  lib/rules.js                       name/place/company rules (no model)
  lib/entities.js                    port of ner_engine.py post-processing (filters, sender name)
  lib/report.js                      port of lib/scanner/report.py
  lib/scan.js                        port of lib/scanner/scan.py, async, finder passed in
  lib/detective.js                   Transformers.js 4.3.2 token classification, character offsets
  data/lists.json                    first names, surnames, places, ordinary words
  vercel.json                        COOP/COEP (multi-threaded WASM), CSP, caching
scripts/build_web_lists.py           rebuilds data/lists.json from Census 1990 + GeoNames + word list
scripts/serve_web.py                 local server with the same headers as vercel.json
scripts/web_fixtures_*.py            dump Python outputs the JavaScript tests must match
tests/web/*.test.mjs                 node --test (Node 22, no npm packages)
```

- The worker holds the extracted text between stages, so the detective rescans without re-reading the file.
- Transformers.js and the ONNX Runtime WebAssembly are served from `web/vendor` (byte for byte the npm
  packages, recorded in `vendor/SHA256SUMS`) and load only when the detective is called. The model loads from
  Hugging Face at the pinned revision; each file is checked against its SHA-256 before use (`modelFetch` in
  `lib/detective.js`) and kept in the browser cache, where it is checked again each time it is read back
  (`checkedCache`). The CSP allows scripts from this site only. How to update the vendored packages or the model
  revision and fingerprints: `web/README.md`, "Third-party code and downloads".
  (Changed 2026-11-23: they first loaded from jsDelivr, unchecked.)
- Vercel serves the page, code and lists (a few MB per visit) and the 14 MB WebAssembly runtime once per detective
  visitor. The model can't be on Vercel: Hobby's upload limit is 100 MB and its 100 GB/month bandwidth would last
  about 950 detective downloads.

## Behaviour carried over from the Python TMI

Same inputs (ChatGPT/Claude exports as .zip or .json, .txt/.md/.html, pasted text), same 11 categories,
distinct counting, masked examples, exposure score and levels, code blocks skipped, 5 million character cap.
The JavaScript ports must reproduce the Python outputs on the mock memories and test cases (fixture tests).

## Errors and limits

- Unreadable files keep the Python version's friendly messages.
- Model download fails (offline, blocked): the frisk report stays, with a message and a retry button.
- Detective running: progress (download MB, then text read), cancel button (terminates the worker; the frisk
  report stays).
- Phones and metered connections: the detective button states the 104 MB size before downloading.

## Out of scope

Anonymous statistics to a database (separate project), languages other than English, distilbert.

## Testing

- Node fixture tests: extract, patterns, rules and full stage-1 reports equal the Python outputs.
- Browser: both stages on the mock memories through the local server with Vercel's headers; detective
  counts close to the Python bert benchmark (17, 10, 11, 0, 19, 18).
