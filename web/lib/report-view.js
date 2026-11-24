// Schema v2 results: sensitivity × life-domain matrix, harm readouts, findings and the analysis prompt.
// Shared by the browser TMI (web/app.js) and the local app (public/scanner/app.js, served at /static/lib/)
// so the two front ends render the same report the same way.

import { DOMAINS, DOMAIN_LABELS, kindsForCell } from "./domains.js";
import { KIND_LABELS } from "./sensitivity.js";
import { buildAnalysisPrompt } from "./analysis-prompt.js";
import { storyView } from "./stories.js";
import { RECIPES, KIND_NOUNS } from "./stories-data.js";

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const HARM_LEAD = new Set(["H1", "H2", "H3"]);
const CONF_LEAD = new Set(["confirmed", "high", "medium"]);
const HARM_ORDER = ["H1", "H2", "H3", "H4", "H5", "H6"];
const HARM_SHORT = {
  H1: "Credentials", H2: "IDs", H3: "Intimate", H4: "Bridges", H5: "Amplifiers", H6: "Corpus",
};
const READOUT_CARDS = [
  ["credentials", "Credentials", "H1", "Live secrets in your chats"],
  ["intimateSafety", "Intimate & safety", "H3", "Health, immigration, family — keyword pass, not a diagnosis"],
  ["identityBridges", "Identity bridges", "H4", "Emails, handles, profile URLs — not name volume"],
  ["corpusVolume", "Corpus volume", "H6", "Legacy exposure score — noisy names and phones"],
];

export const isSchemaV2 = (report) => report.schemaVersion === 2 && report.readouts && report.findings;

export function meterSegments(score) {
  const on = Math.max(1, Math.min(20, Math.round(score / 5)));
  return Array.from({ length: 20 }, (_, i) => h("i", { class: i < on ? "on" : null }));
}

export function coverageFootnote(coverage) {
  if (!coverage?.lowerBound) return null;
  let text = "These findings are a lower bound. Some of the export was not read.";
  if (coverage.truncated) text += " Scanner stopped at 5M characters.";
  return text;
}

export function partitionFindings(findings) {
  const lead = [];
  const possible = [];
  const unsure = [];
  for (const f of findings) {
    if (f.harm === "H3" && f.confidence === "low") {
      possible.push(f);
      continue;
    }
    if (HARM_LEAD.has(f.harm) && CONF_LEAD.has(f.confidence)) {
      lead.push(f);
      continue;
    }
    if (f.subject === "unknown" && f.harm !== "H1") unsure.push(f);
  }
  const aboutYou = lead.filter((f) => f.subject === "account_holder"
    || (f.harm === "H1" && f.subject === "unknown"));
  const aboutOthers = lead.filter((f) => f.subject === "third_party");
  return { aboutYou, aboutOthers, possible, unsure, lead };
}

function findingRow(f) {
  return h("li", { class: "finding-chip" },
    h("span", { class: "finding-label" }, f.label),
    h("code", { class: "finding-mask" }, f.masked),
    f.count > 1 ? h("b", {}, `×${f.count.toLocaleString()}`) : null,
    h("span", { class: "finding-meta" }, `${f.harm} · ${f.confidence}`),
  );
}

function findingGroup(title, subtitle, rows) {
  return h("div", { class: "finding-group" },
    h("h3", {}, title),
    subtitle ? h("p", { class: "finding-sub" }, subtitle) : null,
    rows.length
      ? h("ul", { class: "finding-list", "aria-label": title }, rows.map(findingRow))
      : h("p", { class: "finding-empty" }, "None in this group."),
  );
}

export function readoutsSheet(readouts, coverage) {
  const cards = READOUT_CARDS.map(([key, title, band, sub], index) => {
    const row = readouts[key] || {};
    const score = row.score ?? 0;
    const isLegacy = key === "corpusVolume";
    const hot = isLegacy ? score >= 50 : score >= 40;
    // CSP (style-src 'self') blocks inline style attributes: set the custom property through the CSSOM
    const card = h("article", { class: `readout-card${isLegacy ? " legacy-score" : ""}` },
      h("div", { class: "readout-head" },
        h("span", { class: "label" }, band),
        h("span", { class: "meter-value" }, String(score), h("small", {}, " / 100")),
      ),
      h("h3", { class: "readout-title" }, title),
      h("p", { class: "readout-sub" }, sub),
      h("div", { class: `meter-bar${hot ? " is-hot" : ""}`, "aria-hidden": "true" }, meterSegments(score)),
      h("p", { class: "readout-conf" }, `Confidence: ${row.confidence || "low"}`),
      row.note ? h("p", { class: "readout-note" }, row.note) : null,
    );
    card.style.setProperty("--i", String(index));
    return card;
  });
  const foot = coverageFootnote(coverage);
  return h("div", { class: "sheet readouts-sheet" },
    h("div", { class: "sheet-head" }, h("span", {}, "Harm readouts"), h("span", {}, "Schema v2")),
    h("div", { class: "readouts-body" },
      h("p", { class: "kicker" }, "Three scores that matter if this file leaks — plus corpus volume."),
      h("div", { class: "readouts-grid" }, cards),
      foot ? h("p", { class: "coverage-footnote" }, foot) : null,
    ),
  );
}

function bandClass(harm) {
  if (harm === "H1" || harm === "H2") return "h12";
  if (harm === "H3" || harm === "H4") return "h34";
  return "h56";
}

function cellLevel(n) {
  if (n === 1) return "n1";
  if (n <= 4) return "n2";
  return "n3";
}

function uniqueFindingCount(report) {
  return Object.values(report.bands || {}).reduce((n, band) => n + (band.unique || 0), 0);
}

function findingWord(n) {
  return n === 1 ? "finding" : "findings";
}

function kindLabel(kind) {
  return KIND_LABELS[kind] || String(kind || "").replaceAll("_", " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function matrixDetail(report, filter) {
  if (!filter?.domain || !filter?.harm) {
    return h("aside", { class: "matrix-detail is-idle", "aria-live": "polite" },
      h("p", { class: "matrix-detail-kicker" }, "In this cell"),
      h("p", { class: "matrix-detail-hint" }, "Click a numbered cell to see which kinds of personal info sit there."),
    );
  }
  const n = report.domainMatrix?.cells?.[filter.domain]?.[filter.harm] || 0;
  let kinds = kindsForCell(report.domainMatrix, filter.domain, filter.harm);
  if (!kinds.length) {
    const counts = {};
    for (const f of filteredFindings(report, filter)) counts[f.kind] = (counts[f.kind] || 0) + 1;
    kinds = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }
  return h("aside", { class: "matrix-detail", "aria-live": "polite" },
    h("p", { class: "matrix-detail-kicker" }, `${DOMAIN_LABELS[filter.domain]} · ${filter.harm} ${HARM_SHORT[filter.harm]}`),
    h("p", { class: "matrix-detail-count" }, `${n.toLocaleString()} ${findingWord(n)} in this cell`),
    kinds.length
      ? h("ul", { class: "matrix-kinds", "aria-label": "Kinds of personal info in this cell" },
        kinds.map(([kind, count]) => h("li", {},
          h("span", {}, kindLabel(kind)),
          h("b", {}, count.toLocaleString()),
        )))
      : h("p", { class: "matrix-detail-hint" }, "No kind breakdown for this cell."),
  );
}

function filteredFindings(report, filter) {
  let rows = report.findings || [];
  if (filter?.domain) rows = rows.filter((f) => (f.domains || []).includes(filter.domain));
  if (filter?.harm) rows = rows.filter((f) => f.harm === filter.harm);
  return rows;
}

function filterCapNote(report, filter, shown) {
  if (!filter?.domain && !filter?.harm) return null;
  let total = shown;
  if (filter.domain && filter.harm) total = report.domainMatrix?.cells?.[filter.domain]?.[filter.harm] ?? shown;
  else if (filter.domain) total = report.domainMatrix?.uniqueByDomain?.[filter.domain] ?? shown;
  else total = report.bands?.[filter.harm]?.unique ?? shown;
  if (total <= shown) return null;
  return `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} unique findings in this slice.`;
}

export function sameFilter(a, b) {
  return a.domain === b.domain && a.harm === b.harm;
}

export function domainMatrixSheet(report, filter, onSelect) {
  const matrix = report.domainMatrix;
  if (!matrix) return null;
  const uniqueTotal = uniqueFindingCount(report);
  const thead = h("thead", {},
    h("tr", {},
      h("th", { scope: "col", class: "matrix-corner" }, h("span", { class: "matrix-axis" }, "Harm"), h("span", { class: "matrix-axis-x" }, "Domain")),
      ...DOMAINS.map((domain) => {
        const selected = filter.domain === domain && !filter.harm;
        const btn = h("button", {
          type: "button",
          class: "matrix-head",
          "aria-pressed": selected ? "true" : "false",
          "aria-label": `${DOMAIN_LABELS[domain]}, all harm tiers, ${matrix.uniqueByDomain[domain] || 0} ${findingWord(matrix.uniqueByDomain[domain] || 0)}`,
        }, DOMAIN_LABELS[domain]);
        btn.addEventListener("click", () => onSelect({ domain, harm: null }));
        return h("th", { scope: "col" }, btn);
      }),
    ),
  );
  const tbody = h("tbody", {},
    ...HARM_ORDER.map((harm) => {
      const rowSelected = filter.harm === harm && !filter.domain;
      const rowBtn = h("button", {
        type: "button",
        class: "matrix-row-label",
        "aria-pressed": rowSelected ? "true" : "false",
        "aria-label": `${harm} ${HARM_SHORT[harm]}, all domains, ${report.bands?.[harm]?.unique ?? 0} ${findingWord(report.bands?.[harm]?.unique ?? 0)}`,
      }, h("b", {}, harm), h("span", {}, HARM_SHORT[harm]));
      rowBtn.addEventListener("click", () => onSelect({ domain: null, harm }));
      const cells = DOMAINS.map((domain) => {
        const n = matrix.cells?.[domain]?.[harm] || 0;
        if (!n) return h("td", { class: "matrix-empty" });
        const selected = filter.domain === domain && filter.harm === harm;
        const kindNames = kindsForCell(matrix, domain, harm).map(([kind]) => kindLabel(kind));
        const btn = h("button", {
          type: "button",
          class: `matrix-cell is-${bandClass(harm)} is-${cellLevel(n)}`,
          "aria-pressed": selected ? "true" : "false",
          "aria-label": `${DOMAIN_LABELS[domain]}, ${harm}, ${n} ${findingWord(n)}${kindNames.length ? `: ${kindNames.join(", ")}` : ""}`,
        }, String(n));
        btn.addEventListener("click", () => onSelect({ domain, harm }));
        return h("td", {}, btn);
      });
      return h("tr", {}, h("th", { scope: "row" }, rowBtn), ...cells);
    }),
  );
  const captionBits = [`${uniqueTotal.toLocaleString()} unique findings globally — columns can overlap.`];
  if (matrix.multiDomain) {
    const n = matrix.multiDomain;
    captionBits.push(`${n.toLocaleString()} ${n === 1 ? "finding appears" : "findings appear"} in more than one column.`);
  }
  if (filter.domain || filter.harm) {
    const clear = h("button", { type: "button", class: "matrix-clear" }, "Show all");
    clear.addEventListener("click", () => onSelect({ domain: null, harm: null }));
    captionBits.push(clear);
  }
  return h("div", { class: "sheet matrix-sheet" },
    h("div", { class: "sheet-head" }, h("span", {}, "Sensitivity × life domain"), h("span", {}, "H1–H6")),
    h("div", { class: "matrix-body" },
      h("p", { class: "kicker" }, "Click a cell to see the kinds of personal info there. Rows and columns filter the list below. Colour marks the harm tier, not a score."),
      h("div", { class: "matrix-scroll" }, h("table", { class: "domain-matrix" }, thead, tbody)),
      matrixDetail(report, filter),
      h("p", { class: "matrix-caption" }, ...captionBits.flatMap((bit, i) => (i && typeof bit === "string" ? [" ", bit] : [bit]))),
    ),
  );
}

export function findingsSheet(report, filter = {}) {
  const rows = filteredFindings(report, filter);
  const { aboutYou, aboutOthers, possible, unsure, lead } = partitionFindings(rows);
  const kinds = new Set(report.findings.map((f) => f.kind));
  const combo = kinds.has("employer") && kinds.has("immigration");
  const capNote = filterCapNote(report, filter, rows.length);
  const sections = [
    findingGroup("About you", "Account-holder spans and secrets you pasted.", aboutYou),
    findingGroup("About others", "Third parties mentioned in your chats.", aboutOthers),
  ];
  if (possible.length) {
    sections.push(h("details", { class: "finding-details" },
      h("summary", {}, "Possible mentions (not confirmed)"),
      h("div", { class: "finding-details-body" },
        h("p", { class: "finding-sub" }, "Low-confidence H3 keyword hits — shown masked, not as diagnosis."),
        h("ul", { class: "finding-list" }, possible.map(findingRow)),
      ),
    ));
  }
  if (unsure.length) {
    sections.push(h("details", { class: "finding-details" },
      h("summary", {}, "Not sure who"),
      h("div", { class: "finding-details-body" },
        h("ul", { class: "finding-list" }, unsure.map(findingRow)),
      ),
    ));
  }
  return h("div", { class: "sheet findings-sheet" },
    h("div", { class: "sheet-head" }, h("span", {}, "What stands out"), h("span", {}, `H1–H3 · ${lead.length} lead rows`)),
    h("div", { class: "findings-body" },
      combo ? h("p", { class: "combo-line" }, "Employer and immigration themes both appear — a common phishing combo.") : null,
      capNote ? h("p", { class: "finding-sub" }, capNote) : null,
      ...sections,
    ),
  );
}

/** "1 serious lead stands out", "3 serious leads stand out", "nothing critical stands out". */
export function standOut(n) {
  return n <= 1 ? "stands out" : "stand out";
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = h("textarea", { class: "visually-hidden" }, text);
      document.body.append(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export async function copyWithButtonFeedback(button, text, originalLabel, copiedLabel = "Copied") {
  const ok = await copyText(text);
  button.textContent = ok ? copiedLabel : "Copy failed";
  setTimeout(() => { button.textContent = originalLabel; }, 2400);
  return ok;
}

export function analysisPromptBlock(report) {
  const label = "Copy AI Analysis Prompt";
  const lede = h("p", { class: "analysis-prompt-lede" },
    "Take your privacy report to ChatGPT, Claude, or Gemini for deeper cross-domain threat analysis.");
  const button = h("button", { class: "btn btn-ghost", type: "button" }, label);
  const choice = h("div", { class: "analysis-prompt-choice", hidden: true });
  const warning = h("p", { class: "analysis-prompt-warning" },
    "Pasting this into an external AI sends that text to the provider. Their privacy policy applies. AiAnon does not receive it.");
  const fieldset = h("fieldset", { class: "analysis-prompt-modes" });
  fieldset.append(h("legend", {}, "Export mode"));
  const modes = [["aggregate", "Aggregate"], ["redacted", "Redacted"], ["detailed", "Detailed"]];
  const group = `analysis-mode-${Math.random().toString(36).slice(2, 9)}`;
  let selected = "redacted";
  for (const [value, text] of modes) {
    const id = `${group}-${value}`;
    const input = h("input", { type: "radio", name: group, value, id });
    if (value === "redacted") input.checked = true;
    input.addEventListener("change", () => { if (input.checked) selected = value; });
    fieldset.append(h("label", { for: id }, input, ` ${text}`));
  }
  const confirm = h("button", { class: "btn btn-primary", type: "button" }, "Copy prompt");
  const dismiss = h("button", { class: "btn btn-ghost", type: "button" }, "Dismiss");
  const actions = h("div", { class: "analysis-prompt-choice-actions" }, confirm, dismiss);
  choice.append(warning, fieldset, actions);

  button.addEventListener("click", () => {
    choice.hidden = false;
    selected = "redacted";
    for (const input of fieldset.querySelectorAll("input")) {
      input.checked = input.value === "redacted";
    }
  });
  dismiss.addEventListener("click", () => { choice.hidden = true; });
  confirm.addEventListener("click", async () => {
    const text = buildAnalysisPrompt(report, { mode: selected, generatedAt: new Date().toISOString() });
    choice.hidden = true;
    await copyWithButtonFeedback(button, text, label);
  });

  return h("div", { class: "analysis-prompt-wrap" }, lede, button, choice);
}

const PIECE_STATES = {
  yours: ["\u2713", "yours"],
  "looks-yours": ["\u2713", "looks like yours"],
  others: ["\u2713", "in your file"],
  missing: ["\u2717", "not found"],
};

function storyPiece(piece) {
  const [symbol, text] = PIECE_STATES[piece.state] || PIECE_STATES.missing;
  const found = piece.state !== "missing";
  return h("li", { class: `story-piece is-${found ? "found" : "missing"}` },
    h("span", { class: "story-piece-mark", "aria-hidden": "true" }, symbol),
    h("span", { class: "story-piece-label" }, piece.label),
    h("span", { class: "story-piece-state" }, text),
    piece.example ? h("code", { class: "story-piece-example" }, piece.example) : null,
  );
}

function storyCard(card, number) {
  return h("article", { class: "story" },
    h("div", { class: "story-head" },
      number ? h("span", { class: "story-num" }, String(number)) : null,
      h("h3", { class: "story-title" }, card.title),
      h("span", { class: "story-impact" }, card.impact),
    ),
    h("p", { class: "story-scam" }, card.scam, " \u00b7 ",
      h("a", { href: card.source.url, target: "_blank", rel: "noreferrer" }, card.source.name)),
    card.about === "others" ? h("p", { class: "label story-about" }, "About people you mention") : null,
    h("ul", { class: "story-pieces" }, card.pieces.map(storyPiece)),
    h("h4", { class: "label story-sub" }, "How it goes"),
    h("p", { class: "story-text" }, card.howItGoes),
    h("h4", { class: "label story-sub" }, "What stops it"),
    h("ul", { class: "story-fix" }, card.fix.map((line) => h("li", {}, line))),
  );
}

export function storySheet(report, { reveal = null } = {}) {
  const view = storyView(report, RECIPES, KIND_NOUNS);
  const body = h("div", { class: "story-body" },
    h("h2", { class: "verdict-title", id: "verdict-title", tabindex: "-1" }, view.headline),
    reveal ? h("p", { class: "reveal" }, reveal) : null,
    view.shown.map((card, i) => storyCard(card, i + 1)),
  );
  if (view.more.length) {
    const n = view.more.length;
    body.append(h("details", { class: "story-more" },
      h("summary", {}, `${n} more ${n === 1 ? "thing" : "things"} someone could try`),
      view.more.map((card, i) => storyCard(card, view.shown.length + i + 1)),
    ));
  }
  if (!view.shown.length && view.closest) {
    body.append(h("p", { class: "story-closest-intro" }, "The closest someone could get:"),
      storyCard(view.closest, null));
  }
  if (view.also) body.append(h("p", { class: "story-also" }, view.also));
  return h("div", { class: "sheet story-sheet" },
    h("div", { class: "sheet-head" }, h("span", {}, "Case file"), h("span", {}, "What a stranger could do")),
    body,
  );
}

export function evidenceToggle(...children) {
  const id = `evidence-${Math.random().toString(36).slice(2, 9)}`;
  const button = h("button", { class: "btn btn-ghost", type: "button", "aria-expanded": "false", "aria-controls": id },
    "Show the evidence");
  const region = h("div", { class: "evidence-region", id, hidden: true }, children);
  button.addEventListener("click", () => {
    const open = region.hidden;
    region.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    button.textContent = open ? "Hide the evidence" : "Show the evidence";
  });
  return h("div", { class: "evidence-toggle" }, button, region);
}
