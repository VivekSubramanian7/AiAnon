# Text Anonymization Platform (Python)

A serverless Python implementation of text message anonymization using spaCy and Microsoft Presidio for high-accuracy PII detection and redaction.

## Overview

This system processes text messages from various sources (chat apps, SMS, emails, etc.), detects and redacts PII (names, emails, phone numbers, locations, etc.), and provides confidence scoring for routing decisions. Supports multiple text formats including WhatsApp, Telegram, Slack, and plain text.

On top of the anonymizer sits a **private chat**: a prompt is anonymized, only the
anonymized text goes to an AI model, and the original details are put back into the
answer before the user reads it. The model can optionally search the web through
[Exa](https://exa.ai/docs), with every query checked for personal details first.

### Key Features

- **Multi-stage pipeline**: Regex → NER → Blocklist → Scoring → Validation
- **NER**: spaCy `en_core_web_md` (32 MB) + Microsoft Presidio, sharing one loaded model
- **English only**: the German model was removed; see [Model choice](#model-choice)
- **TMI memory scanner**: a website that counts the personal information in a chatbot's memory or chat export, running on your own machine (see below)
- **Confidence scoring**: Weighted scoring with routing decisions (pass/pass_flagged/review)
- **Quasi-identifier detection**: Identifies role + location + age combinations
- **Privacy-preserving**: Age bucketing, location granularity filtering
- **Serverless ready**: Optimized for Vercel deployment with cold start handling
- **Private chat workflow**: Anonymize → any OpenAI-compatible LLM (e.g. LM Studio) → re-enrich, with a web UI at `/chat`
- **Private web search (optional)**: The model can search the web via Exa; queries containing personal details are blocked

## TMI: the memory scanner

Upload your ChatGPT, Claude or Gemini memory (or a whole chat export) and TMI counts every
name, email, phone number, birth date, bank account, handle, place, company, age, date and
link in it. It shows an exposure score, counts per category and masked examples
("S•••• M•••••"), so the results are safe to screenshot.

**Start it (non-technical):** on a Mac, double-click `Start TMI.command` (the first time, right-click
it and choose Open). On Mac or Linux you can also run:

```bash
./start-scanner.sh
```

The first run installs everything into `.venv` (1-2 minutes, needs internet once). After that it
starts in seconds and opens <http://127.0.0.1:8077>. Press Ctrl+C to stop. Needs `uv` or Python 3.10-3.12.

**Start it (developers):**

```bash
uvicorn api.scanner:app --port 8077
```

**What it reads**

| Input | How to get it |
|---|---|
| ChatGPT export (`.zip`, or `conversations.json`, including split `conversations-001.json` files) | Settings → Data controls → Export data |
| ChatGPT saved memories (pasted text) | Settings → Personalization → Manage memories, copy everything |
| Claude export (`.zip` with `conversations.json`, `memories*.json`, `projects.json`) | Settings → Privacy → Export data |
| Anything else | Paste text, or upload `.txt`, `.md`, `.json`, `.html` |

Only text the user wrote is scanned: AI replies, ids, timestamps and account files (`user.json`,
`users.json`) are skipped, and so are fenced code blocks (numbers in code look like phone numbers).
Custom instructions repeated in every ChatGPT conversation are counted once.

**Privacy**

- The page makes no requests to other sites: fonts are self-hosted and a Content-Security-Policy
  allows only the page's own origin.
- Uploads are processed in memory by one background worker and never written to disk or logged.
  A report holds only counts and masked examples, is handed out once, then deleted (any job is
  dropped after 15 minutes regardless).
- On `localhost` the page says everything stays on this computer; on any other host it says
  "processed in memory, never stored". Hosting it publicly means users send their files to that server.

**API**

| Endpoint | |
|---|---|
| `POST /api/scan` | multipart `file` or form field `text`; returns `{"jobId"}` (202) |
| `GET /api/scan/{jobId}` | `{"status": "reading"\|"scanning", "done", "total"}`, then `{"status": "done", "report"}` once |
| `GET /api/config` | `{"local", "maxUploadMb"}` |

Limits: uploads up to 100 MB (`SCANNER_MAX_UPLOAD_MB`), pasted text up to 2 million characters,
the first 5 million characters of an export. A 1-million-character ChatGPT export scans in about
20 seconds on an Apple M5 Pro; the server uses about 450 MB of memory.

**How counting works**

- Counts are distinct values: ten mentions of the same person is one name.
- Direct identifiers (names, emails, phones, birth dates, bank accounts, handles) are worth 4
  points each, context details (places, companies, ages, dates, links) 1 point; the exposure score
  is `100 × (1 − e^(−points/40))`.
- Dates are only "birth dates" when the text says so ("born", "birthday", "DOB"). Dates the
  pipeline mistakes for phone numbers are counted as dates. Chatbot names ("Claude", "ChatGPT")
  and jargon ("IBAN", "API") are not counted as people or companies.

**Known gaps:** most street addresses, health details and ID numbers are not detected, NER sometimes
calls a band a company, and only English is supported.

Code: `api/scanner.py` (app), `lib/scanner/` (reading exports, scanning, report, jobs),
`public/scanner/` (page), tests in `tests/test_scanner.py` and `tests/test_scanner_api.py`.

### TMI in the browser (`web/`)

The same scanner as a static website for Vercel: everything runs in the visitor's browser tab and
nothing is uploaded. It works in two stages:

1. **Quick frisk:** the pattern rules above, ported to JavaScript, plus word lists and phrase rules for
   names, places and companies (about 1 MB). Finds about two thirds of the names spaCy finds.
2. **The detective (opt-in):** `bert-base-NER` (104 MB, downloaded once from Hugging Face, then cached)
   via Transformers.js. In benchmarks it finds more names (89%) and companies (62%) than spaCy (86%, 45%).

```bash
python3 scripts/serve_web.py     # http://localhost:8079, with the same headers as Vercel
node --test tests/web/*.test.mjs        # JavaScript ports checked against the Python outputs
```

Deploy: Vercel project with Root Directory `web`. Details in [web/README.md](web/README.md); design in
[docs/superpowers/specs/2026-11-17-browser-tmi-design.md](docs/superpowers/specs/2026-11-17-browser-tmi-design.md).

## Model choice

The pipeline uses one English spaCy model, `en_core_web_md` (32 MB), loaded once and shared by
Presidio and the NER stage (`SPACY_MODEL` overrides it). It replaced `en_core_web_lg` (382 MB,
which was loaded twice) and `de_core_news_lg` (542 MB, whose findings on message text were always
filtered out). Benchmark on 5,000 records of the Gretel PII test set, run through this pipeline:

| | `en_core_web_lg` | `en_core_web_md` | `en_core_web_sm` |
|---|---|---|---|
| Names fully hidden and labelled PERSON | 83.9% | 85.5% | 72.4% |
| Memory used by the pipeline | 1,366 MB | 621 MB (before sharing the model) | 162 MB |
| Download | 382 MB | 32 MB | 12 MB |

The same benchmark found 2.3% of records crashing because Presidio returned `PHONE_NUMBER`, a type
`RedactionToken` didn't allow. Presidio results are now mapped to the pipeline's types, and NER
placeholders continue numbering after the regex stage's (`[PHONE_03]`, not a second `[PHONE_01]`).

## Architecture

### Pipeline Stages

1. **Regex Stripper** - Extracts structural PII using patterns:
   - Message headers (timestamp + sender from various formats)
   - Phone numbers (using google-libphonenumber)
   - Email addresses (including obfuscated formats)
   - URLs and social media handles
   - IBANs with checksum validation
   - Dates of birth and ages (with bucketing)

2. **NER Engine** - Named entity recognition:
   - Presidio analyzer (primary, high precision)
   - spaCy English model (en_core_web_md), the same loaded model Presidio uses
   - Entity types: PERSON, ORG, LOCATION
   - Location filtering: Countries preserved, cities redacted

3. **Blocklist Matcher** - Custom term matching:
   - Aho-Corasick automaton for efficient multi-pattern matching
   - Case-insensitive, whole-word boundary validation
   - Quasi-identifier detection (role keywords + locations + ages)

4. **Confidence Scorer** - Multi-signal confidence calculation:
   - Regex coverage (30% weight)
   - NER confidence (35% weight)
   - Quasi-identifier score (20% weight)
   - Residual token density (15% weight)
   - Routing: pass (≥0.90), pass_flagged (0.75-0.89), review (<0.75)

5. **Validator** - Output validation:
   - Re-run regex suite to detect PII leakage
   - Token integrity check (format validation)
   - Minimum content check (>60% redaction flagging)

## Installation

### Local Development

1. **Clone repository**
   ```bash
   git clone <repository-url>
   cd AnonymizeItPython
   ```

2. **Create virtual environment**
   ```bash
   python -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   ```

3. **Install dependencies**
   ```bash
   pip install -r requirements.txt
   ```

   **Note:** The spaCy model (`en_core_web_md`, 32 MB) is installed automatically from a direct wheel URL.

4. **Verify installation**
   ```bash
   python -c "import spacy; print(spacy.load('en_core_web_md'))"
   ```

5. **Start Postgres** (used for usage quotas; requires Docker)
   ```bash
   docker run -d --name anonymizeit-postgres -e POSTGRES_PASSWORD=postgres \
     -e POSTGRES_DB=anonymizeit -p 5432:5432 postgres:16-alpine
   docker exec -i anonymizeit-postgres psql -U postgres -d anonymizeit < migrations/001_initial_schema.sql
   ```
   On later runs, `docker start anonymizeit-postgres` is enough.

6. **Configure environment**
   ```bash
   cp .env.example .env
   ```
   Set `POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5432/anonymizeit` and a
   `JWT_SECRET_KEY` (`openssl rand -hex 32`). For the private chat, point `LLM_BASE_URL`
   at your model server; for web search, add `EXA_API_KEY`. See [Environment variables](#environment-variables).
   Never commit `.env`.

7. **Start a model** (for the private chat): load a chat model in
   [LM Studio](https://lmstudio.ai/) and start its server. Models that support tool
   calling (e.g. `qwen/qwen3-vl-8b`) are needed for web search.

### Vercel Deployment

1. **Install Vercel CLI**
   ```bash
   npm install -g vercel
   ```

2. **Deploy**
   ```bash
   vercel deploy
   ```

   **Important:** First deployment may timeout due to model loading. Subsequent requests will be fast (warm containers).

3. **Environment variables** (if needed)
   ```bash
   vercel env add PYTHON_VERSION 3.11
   ```

## Usage

### Local Server

Start the development server:

```bash
uvicorn api.anonymise:app --reload --port 8000
```

Then open:
- `http://localhost:8000/` for the anonymizer
- `http://localhost:8000/chat` for the private chat

`--reload` picks up code changes, but not `.env` changes; restart the server after editing `.env`.

### API Endpoint

**POST** `/api/anonymise`

**Request Body:**
```json
{
  "rawText": "[26/02/2026, 09:14] Sarah: My email is sarah@test.com",
  "blocklist": "Sarah,confidential",
  "sessionId": "test_session_01"
}
```

**Response:**
```json
{
  "result": {
    "messageId": "abc123...",
    "cleanedText": "[SENDER] My email is [EMAIL_01]",
    "tokens": [
      {
        "type": "SENDER",
        "value": "[SENDER]",
        "startIndex": 0,
        "endIndex": 5,
        "confidence": 1.0,
        "lowConfidence": false
      },
      {
        "type": "EMAIL",
        "value": "[EMAIL_01]",
        "startIndex": 13,
        "endIndex": 30,
        "confidence": 1.0,
        "lowConfidence": false
      }
    ],
    "confidence": {
      "overall": 0.92,
      "routing": "pass",
      "signals": {
        "regexCoverage": 0.95,
        "nerConfidence": 0.88,
        "quasiIdentifierCount": 0,
        "residualTokenDensity": 0.75
      },
      "failureReasons": []
    },
    "flags": {
      "quasi_identifier_risk": false,
      "low_signal": false
    },
    "metadata": {
      "original_word_count": 8,
      "cleaned_word_count": 6,
      "token_count": 2
    }
  }
}
```

**Note:** The `original` field in tokens is **never** serialized to the response (server-side only).

### Example Requests

**Basic PII (email + name):**
```bash
curl -X POST http://localhost:8000/api/anonymise \
  -H "Content-Type: application/json" \
  -d '{
    "rawText": "[26/02/2026, 09:14] Sarah Müller: My email is sarah.mueller@gmail.com",
    "blocklist": "",
    "sessionId": "test_01"
  }'
```

**Phone number + handle:**
```bash
curl -X POST http://localhost:8000/api/anonymise \
  -H "Content-Type: application/json" \
  -d '{
    "rawText": "[26/02/2026, 11:32] James: Call me at +44 7911 123456 or follow @jamesobrien",
    "blocklist": "",
    "sessionId": "test_02"
  }'
```

**Blocklist with short names:**
```bash
curl -X POST http://localhost:8000/api/anonymise \
  -H "Content-Type: application/json" \
  -d '{
    "rawText": "[26/02/2026, 13:01] Susi: Mo asked about the feature",
    "blocklist": "Susi,Mo",
    "sessionId": "test_03"
  }'
```

**Clean message (no PII):**
```bash
curl -X POST http://localhost:8000/api/anonymise \
  -H "Content-Type: application/json" \
  -d '{
    "rawText": "[26/02/2026, 10:00] User: The dark mode on Android is broken",
    "blocklist": "",
    "sessionId": "test_04"
  }'
```

### Private Chat Workflow (anonymize → LLM → re-enrich)

```
prompt ──► anonymizer ──► "[PERSON_01] ([EMAIL_01]) …" ──► LLM ──► answer with placeholders
                │                                          │  ▲
                └── vault (in memory, this request only)   │  └── optional Exa web search
                                   │                       ▼      (queries checked first)
                                   └──────────────► re-enrich ──► answer with real details
```

**POST** `/api/chat` anonymizes the prompt, sends only the anonymized text to an
OpenAI-compatible LLM, and restores the original values in the answer. The
placeholder-to-original mapping (the "vault") exists only in memory for that one
request; it is never logged, returned or stored.

Configure the LLM in `.env` (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`,
`LLM_TIMEOUT_SECONDS`). Defaults target LM Studio at `http://localhost:1234/v1`.

```bash
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Draft a two-sentence reply to Marcus Weber (marcus.weber@acmecorp.com) confirming our call on +49 170 555 0198.", "blocklist": "Marcus Weber,Marcus"}'
```

**Request fields:**

| Field | Default | Description |
|---|---|---|
| `prompt` | required | 1–8000 characters |
| `blocklist` | `""` | Extra comma-separated words to hide |
| `strict` | `false` | Refuse to send prompts the anonymizer routes to `review` (HTTP 422); also makes the web search guard block any detection |
| `webSearch` | `false` | Let the model search the web (ignored if `EXA_API_KEY` is not set) |

**Response fields:** `answer` (re-enriched), `anonymizedPrompt` (exactly what the
LLM saw), `anonymizedAnswer`, `placeholdersSent`, `placeholdersRestored`,
`unknownPlaceholders` (placeholders the model invented), `routing`, `flags`, `model`,
`searches` and `sources`.

**Errors:** `401`/`403` quota reached, `422` invalid prompt or strict-mode refusal
(`detail.reasons` explains why), `500` a placeholder could not be safely restored
(nothing was sent), `502` the LLM server could not be reached.

#### Chat UI

`/chat` is a web front end for the same endpoint. Each answer has a **You / The AI**
switch: "You" shows the answer with your details restored (highlighted), "The AI"
shows exactly what the model saw and wrote. A receipt under each answer counts the
hidden and restored details. The composer offers "Hide extra words" (blocklist),
"Don't send if unsure" (strict mode) and, when configured, "Search the web".

#### Web search (optional, via Exa)

Set `EXA_API_KEY` in `.env` (get one at [dashboard.exa.ai](https://dashboard.exa.ai/api-keys))
and restart the server. The chat then shows a "Search the web" toggle;
`GET /api/chat/config` returns `{"webSearch": true}`.

- **The model decides** when to search, through a `web_search` tool, up to 3 searches
  per message. Each search asks Exa `/search` for 5 results with highlights.
- **Every query is checked before it leaves.** It is blocked if it contains a
  placeholder, any of the original values from the prompt, or a detected name, email,
  phone number, IBAN, birth date, handle or blocklisted word. Organizations, places,
  URLs and ages are allowed (normal searches like "ADA guidelines" trigger them),
  except in strict mode, which blocks any detection.
- **Failures never block the answer.** A blocked query or an Exa error is reported to
  the model, which answers without it; the UI shows a notice.
- The response lists every query in `searches` (`query`, `status`: `sent` / `blocked` /
  `failed`, `resultCount`) and the result links in `sources` (`title`, `url`).

```bash
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Search the web for what changed in the 2026 GOLD COPD report, then write a short note to my patient Hans Müller (hans.mueller@gmx.de) explaining what it means for his inhaler.", "webSearch": true}'
```

```json
{
  "anonymizedPrompt": "Search the web for what changed in the 2026 GOLD COPD report, then write a short note to my patient [PERSON_01] ([EMAIL_01]) explaining what it means for his inhaler.",
  "searches": [{"query": "2026 GOLD COPD report changes inhaler guidelines", "status": "sent", "resultCount": 5}],
  "sources": [{"title": "GOLD REPORT 2026 KEY CHANGES SUMMARY", "url": "https://goldcopd.org/..."}],
  "answer": "Dear Hans Müller, …"
}
```

Server logs never contain search queries or results. To audit Exa usage, use the
usage page in the Exa dashboard.

## Token Types

| Type | Description | Example |
|------|-------------|---------|
| `SENDER` | WhatsApp message sender | `[SENDER]` |
| `PHONE` | Phone numbers | `[PHONE_01]`, `[PHONE_02]` |
| `EMAIL` | Email addresses | `[EMAIL_01]` |
| `URL` | Web URLs | `[URL_01]` |
| `HANDLE` | Social media handles | `[HANDLE_01]` |
| `IBAN` | Bank account numbers | `[IBAN_01]` |
| `DOB` | Dates of birth | `[DOB_01]` |
| `AGE` | Ages (bucketed) | `[AGE_30s]`, `[AGE_60s]` |
| `PERSON` | Person names (NER) | `[PERSON_01]` |
| `ORG` | Organizations (NER) | `[ORG_01]` |
| `LOCATION` | Locations (NER, cities only) | `[LOCATION_01]` |
| `BLOCKLIST` | Custom blocklist terms | `[BLOCKLIST_01]` |

## Configuration

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `POSTGRES_URL` | — | Postgres connection string (usage quotas) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | — | Google OAuth login |
| `JWT_SECRET_KEY` | — | Session/JWT signing key |
| `FREE_TIER_LIMIT` | `5` | Requests allowed before login is required |
| `CORS_ORIGINS` | `http://localhost:8000,http://127.0.0.1:8000` | Allowed browser origins |
| `LLM_BASE_URL` | `http://localhost:1234/v1` | OpenAI-compatible server for the private chat |
| `LLM_API_KEY` | `lm-studio` | API key for that server |
| `LLM_MODEL` | empty | Model id; empty picks the first non-embedding model the server lists |
| `LLM_TIMEOUT_SECONDS` | `120` | LLM request timeout |
| `EXA_API_KEY` | empty | Enables web search; leave empty to disable |
| `EXA_TIMEOUT_SECONDS` | `20` | Exa request timeout |

### Confidence Scoring Weights

Adjust weights in `/lib/pipeline/confidence_scorer.py`:

```python
overall = (
    (regex_coverage * 0.30) +
    (ner_confidence * 0.35) +
    (qi_score * 0.20) +
    (residual_density * 0.15)
)
```

### Routing Thresholds

Modify thresholds in `confidence_scorer.py`:

```python
if overall_score >= 0.90:
    return "pass"
elif overall_score >= 0.75:
    return "pass_flagged"
else:
    return "review"
```

### Role Keywords (Quasi-identifiers)

Add/remove keywords in `/lib/pipeline/blocklist.py`:

```python
ROLE_KEYWORDS = {
    "manager", "developer", "designer", ...
}
```

## Performance

### Cold Start
- First request: ~5-10 seconds (model loading)
- Warm requests: <2 seconds

### Memory Usage
- spaCy model: about 300 MB RAM, loaded once and shared with Presidio
- Whole process: about 450 MB after scanning a large export

### Optimization Tips
1. Use module-level model loading (already implemented)
2. Enable Vercel function warming
3. `SPACY_MODEL=en_core_web_sm` halves memory again, but misses about 1 in 9 more names

## Known Limitations

1. **Cold starts**: First request slow on serverless.
   - **Mitigation**: Function warming, health check endpoint.

2. **Language support**: English only.
   - **Future**: Add more spaCy models for additional languages.

3. **Japanese/Asian languages**: No support for non-Latin scripts.
   - **Expected**: Some test cases may fail (acceptable for 17/20 target).

4. **Detection gaps**: Street addresses are often not detected, and some dates of
   birth or ID numbers are labelled as phone numbers (still hidden, but with the
   wrong type). Add such terms to the blocklist, and check "The AI" view in the chat.

5. **Pseudonymization, not anonymization**: Clinical or other context left in the
   text can still identify someone in combination (e.g. age + rare condition +
   postcode). Under GDPR this counts as pseudonymized data. Running the LLM locally
   (e.g. LM Studio) keeps it on your own machine.

6. **No chat memory**: Each private chat message is sent on its own; the model does
   not see earlier messages.

## Testing

### Manual Testing

Use the example curl commands above to test various scenarios:
- ✅ Basic PII (emails, phones, names)
- ✅ Obfuscated formats (email [at] domain dot com)
- ✅ Quasi-identifiers (role + location + age)
- ✅ Clean messages (no over-redaction)

### Automated Testing

```bash
./venv/bin/pytest tests -q --deselect tests/test_sample_cases.py --ignore tests/quick_test.py
```

Covers placeholder integrity, the vault and re-enrichment, input limits, the LLM
client (including tool calls), the private chat workflow, the web search client and
query guard, the `/api/chat` endpoint, the English-only NER setup, and the memory
scanner (reading exports, chunking, masking, scoring, the API). LLM and Exa calls are
faked, so no model server or API key is needed.

`tests/test_sample_cases.py` is the detection benchmark and needs a running server; its
German cases are expected to fail now that the pipeline is English only. `tests/quick_test.py` is a
manual script, not a pytest suite.

## Security

- **Never serializes `original` field** in RedactionToken (Pydantic serializer)
- **Validation layer** prevents PII leakage
- **Serverless isolation** (Vercel containers)
- **No data persistence** (stateless processing)
- **Private chat vault** lives only in memory for one request; never logged, returned or stored
- **Fail closed**: if a placeholder cannot be restored safely, the prompt is not sent
- **Web search guard** blocks queries with placeholders, original values or detected personal details before they reach Exa

## Troubleshooting

### Models not loading

```bash
# Verify models installed
python -m spacy validate

# Reinstall the model
pip install --force-reinstall --no-deps \
  https://github.com/explosion/spacy-models/releases/download/en_core_web_md-3.8.0/en_core_web_md-3.8.0-py3-none-any.whl
```

### Vercel timeout on first request

- Normal behavior (cold start)
- Retry request after 10-15 seconds
- Subsequent requests will be fast

### Private chat says "Couldn't reach the AI model" (HTTP 502)

- Check that LM Studio's server is running and a model is loaded
- Check `LLM_BASE_URL` (LM Studio may serve on your LAN IP rather than `localhost`):
  `curl $LLM_BASE_URL/models`
- Restart uvicorn after changing `.env`

### "Search the web" toggle does not appear

- Set `EXA_API_KEY` in `.env` and restart uvicorn
- `curl http://localhost:8000/api/chat/config` should return `{"webSearch":true}`
- If the model never searches, make sure it supports tool calling, or ask it explicitly to search the web

### "Failed to fetch" in the browser

- Open the app on an origin listed in `CORS_ORIGINS` (default `localhost:8000` / `127.0.0.1:8000`)

### "original field" appearing in response

- Check Pydantic version (must be 2.5.0+)
- Verify `@field_serializer` in `lib/types.py`

## Contributing

1. Fork repository
2. Create feature branch
3. Make changes with tests
4. Submit pull request

## License

[Add license information]

## Contact

[Add contact information]
