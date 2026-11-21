/** Build a portable Markdown prompt from a schema v2 scan report (no DOM, no clock). */

export const EXPORT_SCHEMA = "aianon.analysis-prompt.v1";
export const EXPORT_MODES = ["aggregate", "redacted", "detailed"];

const HARMS = ["H1", "H2", "H3", "H4", "H5", "H6"];
const DEFAULT_DOMAINS = [
  "financial", "identity", "health", "professional", "relationships",
  "location", "digital", "interests", "other",
];

function fmt(value) {
  if (value === null || value === undefined || value === "") return "unavailable";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function fmtList(items) {
  if (!items || items.length === 0) return "unavailable";
  return items.join(", ");
}

function instructionsBlock() {
  return `## Instructions for the external AI

You are a privacy threat intelligence analyst. The sections below are the only source of truth.

Start the reply with **Executive privacy exposure summary**, then produce every section under **Expected output**, in that order. Write the count definitions inside the final limitations section. Do not open the reply by restating them.

Cite only numbers, finding IDs, and labels that are printed in this export. Do not invent another exposure total, and do not rename the printed totals.

**How to read the counts**

- Globally unique findings counts each finding once.
- Unique findings by domain can list one finding under more than one domain. Do not add domain counts, or matrix cells, to reach the global total.
- Legacy category uniques are the older 11-category rollup. totals.mentions is repeated hits of those category values, not extra findings and not a count of verified exposures.
- A finding's mention count is how many times that one value was seen.

**Rules**

1. Leave each finding's H1–H6 tier as exported. Correlations do not re-tier a finding.
2. Judge cross-finding risk on Critical, High, Moderate, and Low. Those words are not harm tiers.
3. Correlate findings only when kind, domain, subject, confidence, or mention count supports the same person or entity. Shared presence in one export is not enough.
4. Keep explicit exported fields distinct from inferred combinations.
5. Keep what the export states distinct from hypotheses.
6. Mark every exploitation scenario hypothetical. Cite finding IDs. State assumptions. Do not claim exploitation occurred, and do not add a scenario the fields do not support.
7. Explain the mechanism of each risk.
8. Cite finding IDs for every significant conclusion.
9. Refuse combinations the fields do not tie together.
10. A masked span is a redacted display value. Do not guess the characters underneath. State the sample cap, any coverage lower bound, and any section marked unavailable.

**Expected output (use this order)**

1. Executive privacy exposure summary.
2. Cross-domain correlations the fields support.
3. Identity-reconstruction hypotheses, only where subject, kind, and domain support them.
4. Financial and employment profiling risks.
5. Social engineering and impersonation hypotheses.
6. Physical safety and location exposure risks.
7. Third-party exposure (subject is third_party).
8. Highest-risk combinations.
9. Recommendations, ordered by urgency.
10. Confidence and limitations for each conclusion.

For each threat include: threat title; risk classification (Critical, High, Moderate, or Low); finding IDs; how the fields correlate; hypothetical scenario; assumptions; confidence; mitigation.
`;
}

function renderMatrix(report, mode) {
  const lines = ["## Exposure matrix", ""];
  const matrix = report.domainMatrix;
  const bands = report.bands || {};
  const totals = report.totals || {};

  let globalUnique = 0;
  for (const harm of HARMS) {
    globalUnique += bands[harm]?.unique ?? 0;
  }
  lines.push(`- Globally unique findings: ${globalUnique}`);

  if (matrix) {
    const domains = matrix.domains?.length ? matrix.domains : DEFAULT_DOMAINS;
    lines.push("- Unique findings by domain:");
    for (const domain of domains) {
      const n = matrix.uniqueByDomain?.[domain];
      lines.push(`  - ${domain}: ${fmt(n)}`);
    }
    lines.push(`- Findings in more than one domain (multiDomain): ${fmt(matrix.multiDomain)}`);
  } else {
    lines.push("- Unique findings by domain: unavailable");
    lines.push("- Findings in more than one domain (multiDomain): unavailable");
  }

  lines.push("- Legacy category uniques (11-category rollup, not finding count):");
  lines.push(`  - totals.unique: ${fmt(totals.unique)}`);
  lines.push(`  - totals.directUnique: ${fmt(totals.directUnique)}`);
  lines.push(`  - totals.contextUnique: ${fmt(totals.contextUnique)}`);
  lines.push(`  - totals.mentions: ${fmt(totals.mentions)}`);
  lines.push("");
  lines.push(
    "Do not add per-domain unique counts (or matrix cells) to the globally unique findings total; "
    + "a finding in multiple domains is counted once globally and once per domain.",
  );
  lines.push("");

  if (matrix) {
    const domains = matrix.domains?.length ? matrix.domains : DEFAULT_DOMAINS;
    lines.push("### Matrix cells");
    for (const domain of domains) {
      lines.push(`#### ${domain}`);
      for (const harm of HARMS) {
        const cell = matrix.cells?.[domain]?.[harm];
        lines.push(`- ${harm}: ${fmt(cell)}`);
        const kinds = matrix.kindsByCell?.[domain]?.[harm];
        if (kinds && Object.keys(kinds).length) {
          const parts = Object.entries(kinds).map(([k, c]) => `${k}: ${c}`);
          lines.push(`  - kinds: ${parts.join(", ")}`);
        }
      }
    }
  } else {
    lines.push("### Matrix cells");
    lines.push("unavailable");
  }

  lines.push("");
  lines.push("### Harm bands");
  const findings = mode === "aggregate" ? [] : (report.findings || []);
  for (const harm of HARMS) {
    const band = bands[harm] || {};
    lines.push(`#### ${harm}`);
    lines.push(`- unique: ${fmt(band.unique)}`);
    if (band.byConfidence && Object.keys(band.byConfidence).length) {
      lines.push(`- byConfidence: ${Object.entries(band.byConfidence).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
    } else {
      lines.push("- byConfidence: unavailable");
    }
    if (band.bySubject && Object.keys(band.bySubject).length) {
      lines.push(`- bySubject: ${Object.entries(band.bySubject).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
    } else {
      lines.push("- bySubject: unavailable");
    }
    const exported = findings.filter((f) => f.harm === harm && f.id);
    const m = band.unique ?? 0;
    const n = mode === "aggregate" ? 0 : exported.length;
    lines.push(`- Showing ${n} of ${m} unique findings`);
  }

  lines.push("");
  lines.push("### Readouts");
  const readouts = report.readouts;
  if (readouts) {
    for (const [key, ro] of Object.entries(readouts)) {
      lines.push(`#### ${key}`);
      if (!ro || typeof ro !== "object") {
        lines.push("unavailable");
        continue;
      }
      for (const [fk, fv] of Object.entries(ro)) {
        if (fk === "drivers" && fv && typeof fv === "object") {
          lines.push(`- drivers: ${Object.entries(fv).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
        } else if (fk !== "drivers") {
          lines.push(`- ${fk}: ${fmt(fv)}`);
        }
      }
    }
  } else {
    lines.push("unavailable");
  }

  lines.push("");
  lines.push("### Coverage");
  const coverage = report.coverage;
  if (coverage) {
    for (const [k, v] of Object.entries(coverage)) {
      if (Array.isArray(v)) {
        lines.push(`- ${k}: ${v.length ? v.join(", ") : "unavailable"}`);
      } else {
        lines.push(`- ${k}: ${fmt(v)}`);
      }
    }
  } else {
    lines.push("unavailable");
  }

  lines.push("");
  lines.push("### Source statistics");
  const source = report.source;
  if (source) {
    const fields = [
      ["format label", source.label],
      ["conversations", source.conversations],
      ["pieces scanned", source.piecesScanned],
      ["pieces with finds", source.piecesWithFinds],
      ["characters scanned", source.charactersScanned],
      ["characters skipped", source.charactersSkipped],
      ["truncated", source.truncated],
      ["assistant messages skipped", source.assistantMessagesSkipped],
      ["code blocks skipped", source.codeBlocksSkipped],
      ["failed chunks", source.failedChunks],
    ];
    for (const [label, val] of fields) {
      lines.push(`- ${label}: ${fmt(val)}`);
    }
  } else {
    lines.push("unavailable");
  }

  return lines.join("\n");
}

function renderFindingRow(row, mode) {
  const lines = [`### ${row.id}`, ""];
  lines.push(`- Finding ID: ${row.id}`);
  lines.push(`- Harm: ${fmt(row.harm)}`);
  lines.push(`- Kind: ${fmt(row.kind)} (${fmt(row.label)})`);
  lines.push(`- Domains: ${fmtList(row.domains)}`);
  lines.push(`- Confidence: ${fmt(row.confidence)}`);
  lines.push(`- Subject: ${fmt(row.subject)}`);
  lines.push(`- Mention count: ${fmt(row.count)}`);
  lines.push(`- Source: ${fmt(row.source)}`);
  if (row.inCodeBlock !== undefined && row.inCodeBlock !== null) {
    lines.push(`- In code block: ${fmt(row.inCodeBlock)}`);
  }
  if (row.harm === "H1") {
    lines.push("- Redacted display value: omitted because it is credential-shaped.");
  } else if (mode === "detailed" && row.masked) {
    lines.push(`- Redacted display value: ${row.masked}`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderFindings(report, mode) {
  const lines = ["## Structured findings", ""];
  const all = report.findings || [];
  let omitted = 0;
  const exported = [];

  for (const row of all) {
    if (!row.id) {
      omitted += 1;
      continue;
    }
    exported.push(row);
    lines.push(renderFindingRow(row, mode));
  }

  if (omitted > 0) {
    lines.push(`Rows omitted because the finding ID was unavailable: ${omitted}`);
    lines.push("");
  }

  return { text: lines.join("\n"), exported, omitted };
}

function assertIdIntegrity(findingsText, exported) {
  const allowed = new Set(exported.map((r) => r.id));
  const cited = new Set();
  const re = /\bf-\d+\b/g;
  let m;
  const section = findingsText;
  while ((m = re.exec(section)) !== null) {
    cited.add(m[0]);
  }
  for (const id of cited) {
    if (!allowed.has(id)) {
      throw new Error(`Export cites finding ID ${id} that was not on an exported row`);
    }
  }
  for (const row of exported) {
    if (!section.includes(row.id)) {
      throw new Error(`Exported row ${row.id} missing from findings section`);
    }
  }
}

export function buildAnalysisPrompt(report, options = {}) {
  const mode = options.mode ?? "redacted";
  if (!EXPORT_MODES.includes(mode)) {
    throw new Error(`Unknown export mode: ${mode}`);
  }
  const generatedAt = options.generatedAt ? String(options.generatedAt) : "unavailable";
  const reportSchema = report?.schemaVersion === 2 ? "2" : "unavailable";

  const parts = [
    "# AiAnon privacy analysis export",
    "",
    `- Export schema: ${EXPORT_SCHEMA}`,
    `- Report schema: ${reportSchema}`,
    `- Generated: ${generatedAt}`,
    `- Mode: ${mode}`,
    "",
    instructionsBlock(),
    renderMatrix(report, mode),
    "",
  ];

  if (mode === "aggregate") {
    parts.push("## Structured findings", "", "Finding rows were left out in aggregate mode.", "");
  } else {
    const { text, exported } = renderFindings(report, mode);
    parts.push(text);
    assertIdIntegrity(text, exported);
  }

  return parts.join("\n");
}

if (typeof globalThis !== "undefined") {
  globalThis.buildAnalysisPrompt = buildAnalysisPrompt;
  globalThis.EXPORT_SCHEMA = EXPORT_SCHEMA;
  globalThis.EXPORT_MODES = EXPORT_MODES;
}