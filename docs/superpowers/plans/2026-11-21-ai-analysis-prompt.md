# AiAnon — Portable AI Privacy Analysis Export

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Sections 1–7 are the spec. Section 6 names the files, the function, and the tests.

**Goal:** Let a user copy a self-contained privacy-analysis prompt from the report already on screen, then paste it into ChatGPT, Claude, or Gemini.

**Architecture:** AiAnon does not host or run a generative model. One pure function, `buildAnalysisPrompt(report, options)`, turns the schema v2 report into Markdown. The browser page and the local scanner page only choose a mode, show a warning, and copy the returned string. No new scan, no new classification, no network call during export.

**Tech Stack:** Browser TMI (`web/lib/analysis-prompt.js`, `web/app.js`, Node test runner `tests/web/*.test.mjs`). Local scanner UI (`public/scanner/app.js`, `public/scanner/index.html`) calls the same module. No new dependencies.

## Global Constraints

- Export generation is client-side. It reads the report object already in the page. It does not fetch, post, or open a socket.
- Do not add a hosted LLM, a backend analysis endpoint, or a new scanner pass.
- Do not retain evidence windows, raw values, normalized keys, or conversation text in order to feed this export.
- Reuse `report.domainMatrix`, `report.bands`, `report.readouts`, `report.coverage`, `report.source`, `report.totals`, and `report.findings`. Do not recompute harm, domain, confidence, or subject.
- The numbers-only "Copy my results" button stays. This feature is a second control.
- Default mode is `redacted`.
- H1 rows never include a `masked` span, in any mode.
- `categories` and `categories[].examples` are never exported.
- Prompt text is provider-neutral. Do not address ChatGPT, Claude, or Gemini inside the copied prompt.
- Report `schemaVersion` stays `2`. The prompt carries its own schema name: `aianon.analysis-prompt.v1`.

---

## Objective

Add a **Copy AI Analysis Prompt** control to the privacy exposure report.

The copied text is a prompt plus the current report. An external assistant does the cross-domain reading. AiAnon only formats data it already has.

## 1. User experience

Place the control in the report actions, beside **Copy my results**, on both screens that render this report:

- `web/app.js` (`renderReport`, the `.result-actions` row)
- `public/scanner/app.js` (the same row)

Button label: **Copy AI Analysis Prompt**

Supporting text, visible before anything is copied:

> Take your privacy report to ChatGPT, Claude, or Gemini for deeper cross-domain threat analysis.

The click opens the export choice. It does not write the clipboard yet.

The choice shows:

- This warning, in full: **Pasting this into an external AI sends that text to the provider. Their privacy policy applies. AiAnon does not receive it.**
- Three modes. **Redacted** is selected when the choice opens.
- A confirm control that copies, and a way to dismiss without copying.

Modes:

| Mode | Control label | What confirm copies |
|---|---|---|
| `aggregate` | Aggregate | Matrix and report statistics. No finding rows. |
| `redacted` | Redacted | Aggregate, plus finding rows without masked spans. Default. |
| `detailed` | Detailed | Redacted, plus the existing `masked` span on non-H1 rows. The user must select this mode. Selecting it is the explicit opt-in. |

Confirm copies, then the button reads **Copied**. If `navigator.clipboard.writeText` rejects, try the existing hidden-textarea fallback once. If that also fails, the button reads **Copy failed**. Restore the original label after the same delay the numbers-only button uses (2.4s).

The numbers-only note ("The copy is numbers only…") stays attached to **Copy my results**.

No mode transmits the report. Building the string and writing the clipboard are the whole feature.

## 2. Export structure

`buildAnalysisPrompt(report, options)` returns one Markdown string.

```js
buildAnalysisPrompt(report, {
  mode: "redacted",          // "aggregate" | "redacted" | "detailed"
  generatedAt: "2026-11-21T08:42:00.000Z",  // caller supplies this; tests pass a fixed value
})
```

Omitted `mode` means `"redacted"`. Omitted or blank `generatedAt` is written as `unavailable`. An unknown `mode` throws.

Header, in this order:

```markdown
# AiAnon privacy analysis export

- Export schema: aianon.analysis-prompt.v1
- Report schema: 2
- Generated: 2026-11-21T08:42:00.000Z
- Mode: redacted
```

`Report schema` is `report.schemaVersion` when it is `2`. Any other value is written as `unavailable`, and the prompt still generates from whatever fields are present. Missing sections are labeled `unavailable`. They are not invented.

### A. Instructions for the external AI

The prompt assigns the role of a privacy threat intelligence analyst and asks for the work in section 4.

It states these limits:

- Correlation may use only kind, life domain, harm tier, confidence, subject, and mention count, plus the matrix and readout aggregates.
- A masked span, when the mode includes one, is a redacted display value. It is not a license to guess the characters underneath.
- H1–H6 is the sensitivity of one finding. Correlations do not move a finding to another tier.
- Cross-finding risk uses Critical, High, Moderate, and Low. Those words are not harm tiers.
- Correlate two findings only when the exported fields give a reasonable reason they concern the same person or entity. Shared presence in one export is not that reason by itself.
- Separate explicit fields from inferred combinations.
- Separate what the export states from a hypothesis.
- Every scenario is hypothetical. It cites finding IDs. It states assumptions. It does not say that exploitation has happened.
- Do not invent findings, relationships, facts, or scenarios that the export does not support.
- Explain the mechanism of each risk.
- Cite the finding IDs behind every significant conclusion.
- Do not treat every combination as a threat.
- Name missing information. The finding list is a capped sample. Coverage may mark the scan as a lower bound.

### B. Exposure matrix

Include the matrix from `report.domainMatrix` and the counts from `report.bands`. Domain order and harm order stay as stored (`financial`, `identity`, `health`, `professional`, `relationships`, `location`, `digital`, `interests`, `other`, and H1–H6).

Print three totals, with these labels, and do not treat them as the same number:

| Label in the prompt | Source |
|---|---|
| Globally unique findings | Sum of `bands[H1].unique` … `bands[H6].unique` |
| Unique findings by domain | `domainMatrix.uniqueByDomain` for each domain. A finding in two domains counts in each. `domainMatrix.multiDomain` is the number of findings that appear in more than one domain. |
| Legacy category uniques | `totals.unique`, `totals.directUnique`, `totals.contextUnique`, `totals.mentions`. This is the 11-category rollup, not the finding count. |

Also include:

- Every matrix cell (`domainMatrix.cells[domain][harm]`).
- Kind counts per cell (`domainMatrix.kindsByCell`) as counts of kinds, not values.
- Per-band `unique`, `byConfidence`, and `bySubject`.
- For each harm band, the line `Showing N of M unique findings`, where M is `bands[harm].unique` and N is how many rows of that harm are in the finding section. Aggregate mode still prints this line, with N = 0.
- `readouts` (credentials, intimate & safety, identity bridges, corpus volume): score, confidence, `lowerBound`, driver counts, and any `note`.
- `coverage` flags and counts, including `lowerBound`.
- `source` statistics that are already counts or labels: format label, conversations, pieces scanned, pieces with finds, characters scanned, characters skipped, truncated, assistant messages skipped, code blocks skipped, failed chunks. No text body.

Do not sum cells or `uniqueByDomain` into the global unique total. The prompt says so in one sentence under the matrix.

### C. Structured findings

Aggregate mode omits this section and says the finding rows were left out.

Redacted and detailed modes list `report.findings` only. That array is already capped at 12 rows per harm band. Do not uncap it, and do not load findings that the report dropped.

For each emitted row, include the fields that are present:

| Prompt label | Report field | Notes |
|---|---|---|
| Finding ID | `id` | Use the stored `f-NN` value. Do not renumber. |
| Harm | `harm` | Unchanged. |
| Kind | `kind` and `label` | |
| Domains | `domains` | A list. One finding may have several. |
| Confidence | `confidence` | |
| Subject | `subject` | `account_holder`, `third_party`, `unknown`, or `not_applicable`. |
| Mention count | `count` | Times this value was counted. Detector rows are often `1`. This is not a conversation count. |
| Source | `source` | `detector`, `envelope`, or the promoted-category source already on the row. |
| In code block | `inCodeBlock` | When the field is present. |

Detailed mode adds `masked` for rows whose `harm` is not `H1`. The prompt calls it a redacted display value.

H1 rows, in every mode, include kind, label, harm, confidence, subject, domains, and mention count. They do not include `masked`. The row says the span was omitted because it is credential-shaped.

A missing field is the word `unavailable`. Do not look up a replacement from another structure.

There is no relationship field and no evidence snippet on a finding. Do not add headings for them.

Do not include raw conversation exports, transcripts, evidence windows, or normalized keys. Normalized keys are still the identifier (a lowercased email, a digit-only phone). They stay in the worker.

### D. ID check

Before returning, collect every finding ID written in the findings section. Each one must appear on an exported row. Dropping a row, or printing an ID that was not on a row, fails the check and the function throws. Rows with a missing `id` are omitted from the findings section and counted in a single line, `Rows omitted because the finding ID was unavailable: N`.

## 3. Analysis rules

The instruction block in section A is the whole rule set. The external model is told to:

1. Leave each finding's H1–H6 tier as exported.
2. Judge cross-finding risk separately, on Critical / High / Moderate / Low.
3. Correlate findings only when kind, domain, subject, confidence, or mention count supports it.
4. Keep explicit fields distinct from inferred combinations.
5. Keep exported facts distinct from hypotheses.
6. Mark every exploitation scenario as hypothetical. Cite finding IDs. State assumptions. Do not claim the exploitation occurred, and do not add a scenario the fields do not support.
7. Explain the mechanism.
8. Cite finding IDs for every significant conclusion.
9. Refuse combinations that the fields do not tie together.
10. State the sample cap, any `coverage.lowerBound` limits, and any section marked `unavailable`.

## 4. Expected AI output

The prompt asks for these sections, in this order:

- Executive privacy exposure summary.
- Cross-domain correlations that the fields support.
- Identity-reconstruction hypotheses, only where subject, kind, and domain support them.
- Financial and employment profiling risks.
- Social engineering and impersonation hypotheses.
- Physical safety and location exposure risks.
- Third-party exposure (`subject` is `third_party`).
- Highest-risk combinations.
- Recommendations, ordered by urgency.
- Confidence and limitations for each conclusion.

For each threat, ask for:

- Threat title.
- Risk classification: Critical, High, Moderate, or Low.
- Finding IDs.
- How the fields correlate.
- Hypothetical scenario.
- Assumptions.
- Confidence.
- Mitigation.

## 5. Export privacy and safety

Modes are the table in section 1.

Never export:

- Passwords, API keys, authentication tokens, private keys, recovery codes, or other live credentials. The report does not store those live values. The export also drops H1 `masked` spans, which can still show a secret prefix, a first character, or a token shape.
- `categories[].examples`, which repeat masked personal values outside `findings`.
- Full transcripts, evidence windows, and normalized keys.

Detailed mode may include a non-H1 `masked` span. That span is what the on-screen finding list already shows (first letter and length, last digits of a phone, host of a URL). The warning in section 1 covers it. Redacted mode leaves those spans out so the external model sees structure only.

Health, religion, and similar keyword masks are length-revealing. That is why they are absent in the default mode.

## 6. Technical requirements

### Module

Create `web/lib/analysis-prompt.js`.

```js
export const EXPORT_SCHEMA = "aianon.analysis-prompt.v1";
export const EXPORT_MODES = ["aggregate", "redacted", "detailed"];

export function buildAnalysisPrompt(report, options = {}) {
  // returns a string; throws on an unknown mode or an ID that is not on an exported row
}
```

The function does not touch `document`, `navigator`, or the clock. The caller passes `generatedAt`.

`web/app.js` imports `buildAnalysisPrompt`. The local scanner cannot import `web/lib` from its own static root (`public/scanner`, `script-src 'self'`). Serve this one file to that page with a `FileResponse` route for `/static/analysis-prompt.js` registered before the `/static` mount in `api/scanner.py`. The module assigns `globalThis.buildAnalysisPrompt` so `public/scanner/app.js` can call it. `public/scanner/index.html` loads it with `<script type="module" src="/static/analysis-prompt.js">` before `app.js`. Do not copy the function into `public/scanner/app.js`.

Clipboard code stays in the two app files, next to the existing `copyText` helper. The button handler passes `new Date().toISOString()` as `generatedAt`.

### Tests

`tests/web/analysis-prompt.test.mjs`, run with `node --test tests/web/analysis-prompt.test.mjs`.

Cover at least:

- Default mode is redacted and equals an explicit `mode: "redacted"` call.
- The header contains `aianon.analysis-prompt.v1`, the supplied timestamp, and the mode.
- A fixture with `bands` uniques 2 and 3 and one multi-domain finding prints globally unique findings as 5, prints both domains on that finding, and states that domain uniques must not be added to reach the global total.
- `totals.unique` is labeled as the legacy category unique count.
- A band with `unique: 4` and one exported row of that harm prints `Showing 1 of 4 unique findings`.
- Redacted output contains finding ids, kinds, subjects, and mention counts, and does not contain any fixture `masked` string.
- Detailed output contains the non-H1 masked span and does not contain the H1 masked span.
- Aggregate output has no finding ids and still has the matrix numbers.
- No mode contains a fixture category example string.
- A row with no `id` is omitted and the omitted count is printed.
- `mode: "full"` throws.
- A missing `domainMatrix` is the word `unavailable`, and the function still returns the instruction block.

Use a small inline fixture. Do not scan a real export. Do not change `tests/web/fixtures/stage1.json`.

### UI

Match the existing button classes (`btn`, `btn-primary` or `btn-ghost` so the numbers-only button remains the primary share). The mode choice can be a `dialog` or a fieldset already inside the results. Confirm is required before `copyText`. Keyboard users can reach the modes, confirm, and dismiss.

After the UI change, exercise both report screens if a browser is available: open the choice, cancel, copy Redacted, switch to Detailed, and confirm the button's success and failure text. Failure can be checked by calling the handler path with clipboard writes stubbed, or by a note in the test plan if the page cannot be opened.

## 7. Acceptance criteria

1. Confirming the choice copies a prompt built from the current report. Opening the choice does not copy.
2. Redacted and detailed copies include the matrix and the capped finding rows. Aggregate includes the matrix and says the rows were left out.
3. The pasted text contains the analyst role, the rules in section 3, and the output list in section 4. The user does not add instructions.
4. The prompt limits correlation to kind, domain, harm, confidence, subject, and mention count, and marks scenarios as hypothetical.
5. Building the prompt performs no network request.
6. The choice opens on Redacted.
7. No mode includes an H1 masked span, a category example, a normalized key, or a transcript.
8. The prompt prints globally unique findings, per-domain uniques, and legacy category uniques as three labeled figures, plus the per-band showing line.
9. The button shows **Copied** or **Copy failed**.
10. The page does not call a generative model.

## Non-goals

- Uncapping `report.findings` or exporting the pre-cap list.
- Stable IDs across scans. `f-NN` values are the display ids already on the capped rows.
- Evidence snippets, finding-to-finding relationship records, or a safer re-masking pass.
- Replacing **Copy my results**.
- A Python port of the prompt. The report is formatted where it is displayed.
