# Sensitivity tiers and multi-axis scoring (TMI / mirror)

**Status:** **Schema v2** is on both scan paths — Python (`lib/scanner/scan.py`) and browser (`web/lib/scan.js`) — with `findings`, `bands`, `domainMatrix`, `readouts`, and `coverage`. Findings carry `harm`, `confidence`, `subject`, and `domains[]` (`lib/scanner/findings.py` + `lib/scanner/domains.py`, ported in `web/lib/sensitivity.js` and `web/lib/domains.js`). Local scanner (`public/scanner/app.js`) and browser UI (`web/app.js`) lead with a sensitivity × life-domain matrix, then harm readouts and H1–H3 findings. `scripts/compute_sensitivity_axes.py` dumps a report's readouts (not a second regex pass).

**Influences:** Gap analysis on a real ChatGPT export; an external model review (harm vs identifiability, confidence, third parties).

---

## Why change?

1. **One exposure score** (driven by unique direct × 4 + context × 1) saturates at biography while **secrets** and **Article 9–style content** stay invisible.
2. **Identifiability ≠ harm** once the zip is already tied to an account (`user.json`).
3. **Tier 7 (“export envelope”)** is not sensitivity — it is **coverage** (what we did not read).
4. **Name and phone unique counts** mix third parties, NER noise, and date collisions with real contact data.

---

## Four axes (every finding carries harm, confidence, subject; domain is multi-label)

| Axis | Question | Values |
|------|----------|--------|
| **Harm if leaked** | How bad if this exact export is exfiltrated? | Harm bands H1–H6 (below) |
| **Life domain** | Which part of life does this sit in? | `financial` · `identity` · `health` · `professional` · `relationships` · `location` · `digital` · `interests` · `other` (a finding may have more than one) |
| **Confidence** | How sure are we this is real PII in *your* text? | `confirmed` · `high` · `medium` · `low` · `unscanned` |
| **Subject** | Who does it refer to? | `account_holder` · `third_party` · `unknown` · `not_applicable` |

`pieces` is a flat tally of the same **uncapped** findings, one row per (kind, subject): `count`, best `confidence`, and one masked `example` (the first of the group in finding sort order). Rows sort by `kind`, then subject. Its counts sum to `totals.unique`. Later "scam story" text is built on it (`build_pieces` in `lib/scanner/findings.py`, `buildPieces` in `web/lib/sensitivity.js`).

`domainMatrix` is built from **uncapped** findings (same as `bands`). A finding with two domains appears in two columns and counts once in `bands` / `totals.unique`. Do not sum cells or `uniqueByDomain` to get the global unique count. `kindsByCell[domain][harm][kind]` is the unique-finding count per PII type in that cell — what the matrix shows on click. `interests` has no kinds in v1, so that column is usually empty. Kind → domain lives in `lib/scanner/domains.py`.

Mirror UI should **lead with H1–H3** and **confirmed/high** only for claims about the account holder. Keyword counts are **low** confidence unless anchored to a masked span.

---

## Harm bands (order matters for mirror narrative)

### H1 — Live credentials

Operational compromise, not embarrassment.

| Signal | Examples | Confidence |
|--------|----------|------------|
| Private key PEM | `BEGIN PRIVATE KEY` | high |
| Cloud secret keys | `AKIA…` (+ secret material if present) | high |
| API tokens | `sk-…`, `ghp_…`, `github_pat_…` | high if live-shaped |
| JWT | `eyJ…` triplets | medium (many dev examples) |
| Password / PIN with cue | `password:`, `PIN is`, recovery codes | medium |
| Tokenized URLs | presigned S3, reset links with tokens | high |

**Not H1 without context:** bare 4-digit numbers, the word “password” in prose.

### H2 — Payment instruments & government IDs

| Signal | Examples | Gate |
|--------|----------|------|
| IBAN / account | checksum-valid IBAN | checksum |
| Payment card | Luhn-valid 16-digit | Luhn |
| National IDs | Aadhaar, SSN, NI, passport **number**, tax ID | format + optional checksum |
| Full date of birth | `DD/MM/YYYY` with birth context or “born on …” | context (today: `birthdays` category) |

`user.json` email / phone / id → **H2 contact** at **confirmed** confidence (envelope source, not chat scan).

### H3 — Special category, safety, precise location

GDPR Art. 9 / 10 and physical safety — can dominate harm **without** re-identifying anyone.

| Signal | Examples | Notes |
|--------|----------|-------|
| Health | conditions, meds, therapy (masked span) | keyword hit ≠ diagnosis |
| Religion, sexual orientation, ethnicity, politics | explicit self-reference | Art. 9 subset |
| Criminal allegations | Art. 10 | rare |
| Children / dependents | “my daughter”, school + child | safety + children’s data |
| Street address + postcode | flat, street, UK full postcode | not “city name only” |
| Precise GPS | 5+ decimal places, repeated | not placeholder `0.0` |
| Immigration **status narrative** | permit, blue card, right to work | sensitive; distinct from passport **number** (H2) |

### H4 — Identity bridges

Links export ↔ public or account identity.

| Signal | Examples | Subject |
|--------|----------|---------|
| Email, phone (validated) | libphonenumber, not date | account_holder if self-context |
| Your LinkedIn / GitHub **profile** URL | `/in/`, `/username` | account_holder when deduped |
| @handles tied to you | | account_holder |
| OS username in **your** paths | `/Users/you/…` | one bridge, deduped count |
| Bank string (masked) | existing `bank` category | account_holder |

**Third-party spill:** other people’s emails/phones/names → same harm band but `subject: third_party`; **must not** feed “about you” copy.

### H5 — Amplifiers (sharp only in combination)

| Signal | Examples |
|--------|----------|
| Employer **as relation** | “I work at”, “join Rakuten”, certificate from X |
| Salary / CTC / compensation | currency amounts |
| UK full postcode | weak alone, strong with address |
| Life-event narrative | resignation, tenancy, HR portal (verbatim themes) |
| Immigration + employer + country combo card | mirror “combo” UI |

### H6 — Weak corpus (volume, not headline)

| Signal | Examples |
|--------|----------|
| NER name bag | 1000+ uniques | split third_party |
| Phone-like strings | date collisions | validate subset |
| Org / place mentions | companies discussed | need relation |
| Ages (decade), generic dates | | |
| Ordinary URLs, dev filenames | `react-dom.development.js` | |
| DE 5-digit regex | noisy | |
| IPv4, generic `C:\Users\` tutorials | | |

Legacy **exposure score 0–100** = **corpus volume index (H6-weighted)** — keep for compat, **do not** use as sole headline.

---

## Coverage bounds (not harm tiers)

Report alongside scores; lowers **confidence** for the whole file:

| Bound | Meaning |
|-------|---------|
| `user.json` not scanned | confirmed account email/phone available in zip |
| Truncation | chars after `MAX_SCAN_CHARS` unscanned |
| Binary attachments | `.dat` / uploads — content unknown |
| `ads.json`, summaries, asset indexes | not in extract path |
| Assistant messages skipped | scope = “what you typed” only |
| Code blocks blanked | PII inside fences may be missed |

Copy: *“Score is a lower bound; N chars and M attachments were not read.”*

---

## Mapping: today’s 11 categories → harm bands

| TMI category | Default harm | Confidence today | Gaps |
|--------------|-------------|------------------|------|
| names | H6 (H4 if self) | low (NER) | split subject |
| emails | H4 | medium | |
| phones | H4/H6 | low–medium | split from dates |
| birthdays | H2 | medium | needs “born” context |
| bank | H2/H4 | medium | checksum gate |
| handles | H4 | medium | merge with profile URLs |
| places | H6 (H3 if precise) | low | street/GPS rules |
| orgs | H6 (H5 if relation) | low | |
| ages | H6 | medium | miss “You’re 29” |
| dates | H6 (H2 if DOB) | medium | phone collision |
| links | H6 (H4 if profile URL) | medium | profile URL detector |
| *(detectors)* | H1 secrets (`aws_access_key`, `jwt`, …) | high–medium | emitted via `lib/scanner/detectors.py` |
| *(detectors)* | H3 health, immigration, religion, children | mostly low | keyword spans, masked |
| *(detectors)* | H3 street / precise location | medium | when pattern matches |
| *(envelope)* | H2 `account_email` / `account_phone` | confirmed | `user.json` namelist only |
| *(detectors)* | H2 gov/payment IDs | high when checks pass | IBAN, Luhn, format gates |

**Still mostly corpus (H6):** NER name bag, unvalidated phones, ordinary links without profile shape.

---

## Three mirror readouts (+ corpus volume)

Scoring lives in `lib/scanner/findings.py` → `build_readouts()`. `scripts/compute_sensitivity_axes.py` writes a report's readouts to `mirror-sensitivity.json` (optional debug dump).

| Readout | Intent | Fed by |
|---------|--------|--------|
| **Credentials** | H1 | unique H1 findings (secrets, tokenized URLs, …) |
| **Intimate & safety** | H3 | H3 detector hits (health, immigration, …) |
| **Identity bridges** | H4 | account-holder H4 + envelope H2 contacts (`aboutYou` / `aboutOthers`) |
| **Corpus volume** | H6 | legacy `exposure_score` (`readouts.corpusVolume.score` === top-level `score`) |
| **Coverage** | bounds | `build_coverage()` — truncation, binaries, `user.json`, fences, assistant skip |

UI copy when `coverage.lowerBound`: *“These findings are a lower bound. Some of the export was not read.”* Append truncation sentence when `truncated`.

---

## Product checklist (from review)

1. Break headline: credentials / intimate / bridges + coverage footnote.
2. Secrets pass before name counts in mirror question order.
3. Precision: phone vs date, dedupe OS username paths, checksum IBAN/card/IDs.
4. Mirror evidence: masked spans; split “about you” vs “about others”.
5. Combo cards: employer + country + profile URL; PNR + surname (future).

---

## Local debug dump (optional)

```bash
# Scan export → mirror-report-data.json (gitignored) + mirror-sensitivity.json
.venv/bin/python scripts/compute_sensitivity_axes.py --zip YOUR.zip
```

Or write only the report JSON:

```bash
.venv/bin/python -c "
import json
from lib.scanner.extract import extract_file
from lib.scanner.scan import scan
with open('YOUR.zip','rb') as f: ex = extract_file('x.zip', f.read())
with open('public/scanner/mirror-report-data.json','w') as out:
    json.dump({'report': scan(ex)}, out)
"
```

---

## References

- Scanner categories: `lib/scanner/report.py`
- Known misses (fixtures): `samples/mock-memories/README.md`
- Browser TMI design: `docs/superpowers/specs/2026-11-17-browser-tmi-design.md`