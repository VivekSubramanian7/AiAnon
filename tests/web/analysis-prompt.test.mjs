import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAnalysisPrompt, EXPORT_SCHEMA } from "../../web/lib/analysis-prompt.js";

const GENERATED = "2026-11-21T08:42:00.000Z";
const CATEGORY_EXAMPLE = "FIXTURE_CATEGORY_EXAMPLE_XYZ";
const H1_MASKED = "H1_MASKED_CREDENTIAL_SHAPE";
const H2_MASKED = "H2_MASKED_NON_H1_SPAN";

const fixture = () => ({
  schemaVersion: 2,
  source: {
    format: "text",
    label: "pasted memories",
    conversations: 2,
    piecesScanned: 10,
    piecesWithFinds: 8,
    charactersScanned: 5000,
    charactersSkipped: 100,
    truncated: false,
    failedChunks: 0,
    assistantMessagesSkipped: 1,
    codeBlocksSkipped: 2,
  },
  totals: {
    unique: 42,
    directUnique: 30,
    contextUnique: 12,
    mentions: 55,
  },
  categories: [
    {
      key: "names",
      label: "Names",
      tier: "direct",
      count: 1,
      unique: 1,
      examples: [{ masked: CATEGORY_EXAMPLE, count: 1 }],
    },
  ],
  findings: [
    {
      id: "f-01",
      harm: "H1",
      kind: "api_token",
      label: "API token",
      confidence: "high",
      subject: "account_holder",
      masked: H1_MASKED,
      category: "credentials",
      source: "detector",
      inCodeBlock: false,
      count: 1,
      domains: ["digital"],
    },
    {
      id: "f-02",
      harm: "H2",
      kind: "iban",
      label: "IBAN",
      confidence: "medium",
      subject: "unknown",
      masked: H2_MASKED,
      category: "bank",
      source: "detector",
      inCodeBlock: true,
      count: 2,
      domains: ["financial", "identity"],
    },
    {
      id: "f-03",
      harm: "H4",
      kind: "email",
      label: "Email",
      confidence: "high",
      subject: "account_holder",
      masked: "e•••@example.com",
      category: "emails",
      source: "detector",
      count: 1,
      domains: ["identity"],
    },
    {
      harm: "H4",
      kind: "phone",
      label: "Phone",
      confidence: "medium",
      subject: "third_party",
      masked: "+•• •••• 99",
      category: "phones",
      source: "detector",
      count: 1,
      domains: ["identity"],
    },
  ],
  bands: {
    H1: { unique: 1, byConfidence: { high: 1 }, bySubject: { account_holder: 1 } },
    H2: { unique: 2, byConfidence: { medium: 1, high: 1 }, bySubject: { unknown: 1, account_holder: 1 } },
    H3: { unique: 3, byConfidence: { low: 3 }, bySubject: { unknown: 3 } },
    H4: { unique: 4, byConfidence: { high: 1, medium: 1 }, bySubject: { account_holder: 1, third_party: 1 } },
    H5: { unique: 0, byConfidence: {}, bySubject: {} },
    H6: { unique: 0, byConfidence: {}, bySubject: {} },
  },
  domainMatrix: {
    domains: ["financial", "identity", "health", "professional", "relationships", "location", "digital", "interests", "other"],
    cells: {
      financial: { H1: 0, H2: 1, H3: 0, H4: 0, H5: 0, H6: 0 },
      identity: { H1: 0, H2: 1, H3: 0, H4: 1, H5: 0, H6: 0 },
      health: { H1: 0, H2: 0, H3: 0, H4: 0, H5: 0, H6: 0 },
      professional: { H1: 0, H2: 0, H3: 0, H4: 0, H5: 0, H6: 0 },
      relationships: { H1: 0, H2: 0, H3: 0, H4: 0, H5: 0, H6: 0 },
      location: { H1: 0, H2: 0, H3: 0, H4: 0, H5: 0, H6: 0 },
      digital: { H1: 1, H2: 0, H3: 0, H4: 0, H5: 0, H6: 0 },
      interests: { H1: 0, H2: 0, H3: 0, H4: 0, H5: 0, H6: 0 },
      other: { H1: 0, H2: 0, H3: 0, H4: 0, H5: 0, H6: 0 },
    },
    kindsByCell: {
      financial: { H1: {}, H2: { iban: 1 }, H3: {}, H4: {}, H5: {}, H6: {} },
      identity: { H1: {}, H2: { iban: 1 }, H3: {}, H4: { email: 1 }, H5: {}, H6: {} },
      health: { H1: {}, H2: {}, H3: {}, H4: {}, H5: {}, H6: {} },
      professional: { H1: {}, H2: {}, H3: {}, H4: {}, H5: {}, H6: {} },
      relationships: { H1: {}, H2: {}, H3: {}, H4: {}, H5: {}, H6: {} },
      location: { H1: {}, H2: {}, H3: {}, H4: {}, H5: {}, H6: {} },
      digital: { H1: { api_token: 1 }, H2: {}, H3: {}, H4: {}, H5: {}, H6: {} },
      interests: { H1: {}, H2: {}, H3: {}, H4: {}, H5: {}, H6: {} },
      other: { H1: {}, H2: {}, H3: {}, H4: {}, H5: {}, H6: {} },
    },
    uniqueByDomain: {
      financial: 1,
      identity: 2,
      health: 0,
      professional: 0,
      relationships: 0,
      location: 0,
      digital: 1,
      interests: 0,
      other: 0,
    },
    multiDomain: 1,
  },
  readouts: {
    credentials: {
      harmBand: "H1",
      score: 5,
      confidence: "medium",
      lowerBound: false,
      drivers: { api_token: 1 },
    },
    intimateSafety: {
      harmBand: "H3",
      score: 0,
      confidence: "low",
      lowerBound: true,
      note: "Keyword hits only.",
      drivers: { health: 0 },
    },
    identityBridges: {
      harmBand: "H4",
      score: 10,
      confidence: "high",
      lowerBound: false,
      aboutYou: 1,
      aboutOthers: 0,
      note: "Bridge note.",
    },
    corpusVolume: {
      harmBand: "H6",
      score: 20,
      confidence: "medium",
      lowerBound: false,
      legacyLevel: "mild",
    },
  },
  coverage: {
    truncated: false,
    charactersScanned: 5000,
    charactersSkipped: 100,
    truncationNote: null,
    codeBlocksSkipped: 2,
    assistantMessagesSkipped: 1,
    lowerBound: true,
  },
});

test("default mode is redacted and matches explicit redacted", () => {
  const report = fixture();
  const implicit = buildAnalysisPrompt(report, { generatedAt: GENERATED });
  const explicit = buildAnalysisPrompt(report, { mode: "redacted", generatedAt: GENERATED });
  assert.equal(implicit, explicit);
});

test("header contains schema, timestamp, and mode", () => {
  const out = buildAnalysisPrompt(fixture(), { mode: "detailed", generatedAt: GENERATED });
  assert.ok(out.includes(`Export schema: ${EXPORT_SCHEMA}`));
  assert.ok(out.includes(`Generated: ${GENERATED}`));
  assert.ok(out.includes("Mode: detailed"));
  assert.ok(out.includes("Report schema: 2"));
});

test("global and domain totals with multi-domain finding", () => {
  const report = fixture();
  report.bands.H1.unique = 0;
  report.bands.H4.unique = 0;
  const out = buildAnalysisPrompt(report, { generatedAt: GENERATED });
  assert.match(out, /Globally unique findings:\s*5/);
  assert.match(out, /multiDomain[^:]*:\s*1/);
  assert.ok(out.includes("financial") && out.includes("identity"));
  assert.match(out, /f-02[\s\S]*financial[\s\S]*identity|financial[\s\S]*identity[\s\S]*f-02/);
  assert.ok(
    out.toLowerCase().includes("do not add") || out.toLowerCase().includes("must not be added"),
    "expects sentence that domain uniques must not be added to global total",
  );
});

test("legacy category uniques label", () => {
  const out = buildAnalysisPrompt(fixture(), { generatedAt: GENERATED });
  assert.match(out, /Legacy category uniques/i);
  assert.ok(out.includes("42"));
  assert.ok(out.includes("30"));
  assert.ok(out.includes("12"));
  assert.ok(out.includes("55"));
});

test("per-band showing line", () => {
  const out = buildAnalysisPrompt(fixture(), { generatedAt: GENERATED });
  assert.ok(out.includes("Showing 1 of 4 unique findings"));
});

test("redacted omits masked spans", () => {
  const out = buildAnalysisPrompt(fixture(), { mode: "redacted", generatedAt: GENERATED });
  assert.ok(out.includes("f-01"));
  assert.ok(out.includes("f-02"));
  assert.ok(out.includes("account_holder"));
  assert.ok(out.includes("mention count"));
  assert.equal(out.includes(H2_MASKED), false);
  assert.equal(out.includes(H1_MASKED), false);
});

test("detailed includes non-H1 masked, not H1 masked", () => {
  const out = buildAnalysisPrompt(fixture(), { mode: "detailed", generatedAt: GENERATED });
  assert.ok(out.includes(H2_MASKED));
  assert.equal(out.includes(H1_MASKED), false);
  assert.ok(out.toLowerCase().includes("credential-shaped") || out.includes("credential"));
});

test("aggregate has matrix without finding ids", () => {
  const out = buildAnalysisPrompt(fixture(), { mode: "aggregate", generatedAt: GENERATED });
  assert.ok(out.includes("Globally unique findings"));
  assert.equal(/\bf-\d+\b/.test(out), false);
  assert.ok(out.includes("left out"));
  assert.ok(out.includes("Showing 0 of 4 unique findings"));
});

test("no mode includes category example", () => {
  for (const mode of ["aggregate", "redacted", "detailed"]) {
    const out = buildAnalysisPrompt(fixture(), { mode, generatedAt: GENERATED });
    assert.equal(out.includes(CATEGORY_EXAMPLE), false, mode);
  }
});

test("row without id is omitted and counted", () => {
  const out = buildAnalysisPrompt(fixture(), { generatedAt: GENERATED });
  assert.ok(out.includes("Rows omitted because the finding ID was unavailable: 1"));
});

test("unknown mode throws", () => {
  assert.throws(() => buildAnalysisPrompt(fixture(), { mode: "full" }), /unknown|mode/i);
});

test("instructions lead with the summary and forbid invented totals", () => {
  const out = buildAnalysisPrompt(fixture(), { generatedAt: GENERATED });
  assert.match(out, /Start the reply with \*\*Executive privacy exposure summary\*\*/);
  assert.match(out, /Do not invent another exposure total/);
  assert.equal(out.includes("independently verified"), false);
});

test("missing domainMatrix is unavailable with instructions", () => {
  const report = { ...fixture(), domainMatrix: undefined };
  const out = buildAnalysisPrompt(report, { generatedAt: GENERATED });
  assert.ok(out.includes("unavailable"));
  assert.ok(out.toLowerCase().includes("privacy threat intelligence analyst") || out.includes("Instructions"));
});