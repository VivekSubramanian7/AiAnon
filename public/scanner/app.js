/* TMI front end: upload or paste, poll the scan job, render the verdict. No frameworks, no trackers. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const els = {
    status: $("status"), statusText: $("status-text"), privacy: $("privacy"), maxMb: $("max-mb"),
    drop: $("drop"), file: $("file"), choose: $("choose"), pasteToggle: $("paste-toggle"),
    pasteForm: $("paste-form"), pasteText: $("paste-text"), pasteCancel: $("paste-cancel"),
    scanning: $("scanning"), scanLine: $("scan-line"), progress: $("progress"), fill: $("progress-fill"),
    pct: $("progress-pct"), detail: $("progress-detail"), error: $("error"), sample: $("sample"),
    results: $("results"),
  };
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const SCAN_LINES = [
    "Reading your 3 a.m. messages…",
    "Counting how often you typed your own name…",
    "Highlighting phone numbers with a tiny yellow pen…",
    "Pretending not to judge…",
    "Judging a little…",
    "Finding the time you pasted your whole CV…",
    "Asking spaCy to read faster…",
    "Cross-referencing your birthday with your cake requests…",
  ];

  const LEVELS = {
    clean: { stamp: "Suspiciously clean", quip: "Either you're a spy or you uploaded the wrong file. We respect both." },
    mild: { stamp: "Mostly harmless", quip: "A few crumbs. It knows your vibe, not your address." },
    chatty: { stamp: "Chatty", quip: "You two are close. Group-chat close." },
    oversharer: { stamp: "Certified oversharer", quip: "It could fill in your forms for you. Not legally. Spiritually." },
    biography: { stamp: "Unauthorized biography", quip: "Your chatbot could ghostwrite your memoir. With footnotes." },
  };

  const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  const QUIPS = {
    names: (n) => n === 1 ? "One name. Probably yours. Bold." : `${plural(n, "person", "different people")}. Your chatbot knows the whole group chat.`,
    emails: (n) => `${plural(n, "inbox", "inboxes")} exposed. Inbox zero, privacy also zero.`,
    phones: (n) => `${plural(n, "number", "numbers")}. It still won't call you back.`,
    birthdays: () => "It knows your birthday. Expect zero cake.",
    bank: () => "Bank details. In a chat. Bold strategy.",
    handles: () => "Your @ is showing.",
    places: (n) => `${plural(n, "place", "places")}. It could plan your commute.`,
    orgs: (n) => `${plural(n, "company", "companies")}. LinkedIn wishes it knew you this well.`,
    ages: () => "It knows how old you are. Rude.",
    dates: (n) => `${plural(n, "date", "dates")}. Your calendar, but chattier.`,
    links: (n) => `${plural(n, "link", "links")}. At least one of them is probably you.`,
  };
  const ZERO_QUIPS = {
    names: "Not a single name. Who are you?", emails: "No emails. Nice.", phones: "No phone numbers. Respect.",
    birthdays: "No birthday. It'll never know when to say happy birthday.", bank: "No bank details. As it should be.",
    handles: "No handles. Very mysterious.", places: "No places. Do you even go outside?", orgs: "No companies. Unemployed or careful.",
    ages: "Ageless. Iconic.", dates: "No dates. In both senses?", links: "No links. Clean.",
  };
  const SOURCE_WORDS = {  // exports mix messages, custom instructions, memories, attachments and project notes
    chatgpt_export: "things you wrote", claude_export: "things you wrote", text: "memories", json: "pieces of text",
  };

  const HARM_LEAD = new Set(["H1", "H2", "H3"]);
  const CONF_LEAD = new Set(["confirmed", "high", "medium"]);
  const HARM_ORDER = ["H1", "H2", "H3", "H4", "H5", "H6"];
  const HARM_SHORT = {
    H1: "Credentials", H2: "IDs", H3: "Intimate", H4: "Bridges", H5: "Amplifiers", H6: "Corpus",
  };
  const DOMAINS = [
    "financial", "identity", "health", "professional", "relationships",
    "location", "digital", "interests", "other",
  ];
  const DOMAIN_LABELS = {
    financial: "Financial", identity: "Identity", health: "Health",
    professional: "Professional", relationships: "Relationships", location: "Location",
    digital: "Digital", interests: "Interests", other: "Other",
  };
  const KIND_LABELS = {
    aws_access_key: "AWS access key", private_key: "Private key", api_token: "API token",
    jwt: "JWT", password_cue: "Password", tokenized_url: "Signed URL",
    payment_card: "Payment card", national_id: "Government ID", health: "Health",
    religion: "Religion", sexual_orientation: "Sexual orientation", children: "Children",
    immigration: "Immigration", street_address: "Street address", gps: "GPS coordinates",
    profile_url: "Profile URL", os_username: "Computer username", employer: "Employer",
    compensation: "Compensation", date_of_birth: "Date of birth", iban: "IBAN",
    email: "Email", phone: "Phone number", handle: "Social handle", url: "URL",
    name: "Name", self_name: "Your name", child_name: "Child's name", place: "Place",
    org: "Organisation", age: "Age", date: "Date",
    account_email: "Account email", account_phone: "Account phone",
  };
  let matrixFilter = { domain: null, harm: null };
  const READOUT_CARDS = [
    ["credentials", "Credentials", "H1", "Live secrets in your chats"],
    ["intimateSafety", "Intimate & safety", "H3", "Health, immigration, family — keyword pass, not a diagnosis"],
    ["identityBridges", "Identity bridges", "H4", "Emails, handles, profile URLs — not name volume"],
    ["corpusVolume", "Corpus volume", "H6", "Legacy exposure score — noisy names and phones"],
  ];

  const isSchemaV2 = (report) => report.schemaVersion === 2 && report.readouts && report.findings;

  function meterSegments(score) {
    const on = Math.max(1, Math.min(20, Math.round(score / 5)));
    return Array.from({ length: 20 }, (_, i) => h("i", { class: i < on ? "on" : null }));
  }

  function coverageFootnote(coverage) {
    if (!coverage?.lowerBound) return null;
    let text = "These findings are a lower bound. Some of the export was not read.";
    if (coverage.truncated) text += " Scanner stopped at 5M characters.";
    return text;
  }

  function partitionFindings(findings) {
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

  function readoutsSheet(readouts, coverage) {
    const cards = READOUT_CARDS.map(([key, title, band, sub], index) => {
      const row = readouts[key] || {};
      const score = row.score ?? 0;
      const isLegacy = key === "corpusVolume";
      const hot = isLegacy ? score >= 50 : score >= 40;
      return h("article", { class: `readout-card${isLegacy ? " legacy-score" : ""}`, style: { "--i": String(index) } },
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

  function kindsForCell(matrix, domain, harm) {
    const counts = matrix?.kindsByCell?.[domain]?.[harm] || {};
    return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
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

  function sameFilter(a, b) {
    return a.domain === b.domain && a.harm === b.harm;
  }

  function domainMatrixSheet(report, filter, onSelect) {
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

  function findingsSheet(report, filter = {}) {
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

  let busy = false;
  let lineTimer = null;

  // ---------- helpers ----------

  function h(tag, attrs, ...children) {
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

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function show(state) {
    els.drop.hidden = state !== "idle";
    els.pasteForm.hidden = state !== "paste";
    els.scanning.hidden = state !== "scanning";
    els.sample.hidden = state === "scanning";
  }

  function showError(message) {
    els.error.textContent = message;
    els.error.hidden = false;
  }

  function setProgress(done, total, status) {
    const ratio = total > 0 ? done / total : 0;
    const pct = Math.round(ratio * 100);
    els.fill.style.width = `${Math.max(pct, status === "scanning" ? 3 : 0)}%`;
    els.progress.setAttribute("aria-valuenow", String(pct));
    els.pct.textContent = `${pct}%`;
    els.detail.textContent = status === "reading" || status === "queued" ? "opening the file"
      : total > 0 ? `chunk ${done.toLocaleString()} of ${total.toLocaleString()}` : "warming up";
  }

  function startLines() {
    let i = 0;
    els.scanLine.textContent = SCAN_LINES[0];
    lineTimer = setInterval(() => {
      i = (i + 1) % SCAN_LINES.length;
      els.scanLine.textContent = SCAN_LINES[i];
    }, 1900);
  }

  function stopLines() {
    clearInterval(lineTimer);
    lineTimer = null;
  }

  // ---------- scanning ----------

  async function startScan(form) {
    if (busy) return;
    busy = true;
    els.error.hidden = true;
    show("scanning");
    setProgress(0, 0, "reading");
    startLines();
    try {
      const response = await fetch("/api/scan", { method: "POST", body: form });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "The upload didn't go through. Try again?");
      const report = await poll(data.jobId);
      show("idle"); // settle the layout before scrolling to the results
      renderReport(report);
    } catch (err) {
      show("idle");
      showError(err.message || "Something went wrong. It's not you, it's us.");
    } finally {
      busy = false;
      stopLines();
      els.file.value = "";
    }
  }

  async function poll(jobId) {
    for (;;) {
      await sleep(350);
      const response = await fetch(`/api/scan/${encodeURIComponent(jobId)}`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (data.status === "done") {
        setProgress(1, 1, "scanning");
        await sleep(reducedMotion ? 0 : 250);
        return data.report;
      }
      if (!response.ok || data.status === "error") {
        throw new Error(data.message || data.detail || "The scan fell over. Try again?");
      }
      setProgress(data.done || 0, data.total || 0, data.status);
    }
  }

  function scanFile(file) {
    if (!file) return;
    const form = new FormData();
    form.append("file", file, file.name);
    startScan(form);
  }

  function scanText(text) {
    const form = new FormData();
    form.append("text", text);
    startScan(form);
  }

  // ---------- results ----------

  function card(category, index) {
    const zero = category.unique === 0;
    const el = h("article", { class: `card${zero ? " is-zero" : ""}` },
      h("div", { class: "card-top" },
        h("span", { class: "card-label" }, category.label),
        h("span", { class: `tier tier-${category.tier}` }, category.tier === "direct" ? "Direct" : "Context"),
      ),
      zero
        ? h("p", { class: "card-num" }, "None")
        : h("p", { class: "card-num" }, category.unique.toLocaleString(), h("small", {}, "different")),
      zero ? null : h("p", { class: "card-sub" }, `mentioned ${plural(category.count, "time", "times")}`),
      h("p", { class: "card-quip" }, zero ? ZERO_QUIPS[category.key] : QUIPS[category.key](category.unique)),
      zero ? null : h("ul", { class: "chips", "aria-label": "Examples, masked" },
        category.examples.map((ex) => h("li", { class: "chip" },
          h("span", {}, ex.masked), ex.count > 1 ? h("b", {}, `×${ex.count.toLocaleString()}`) : null))),
    );
    el.style.setProperty("--i", String(index));
    return el;
  }

  function group(title, subtitle, categories) {
    const sorted = [...categories].sort((a, b) => (b.unique > 0) - (a.unique > 0) || b.unique - a.unique);
    return h("section", { class: "group" },
      h("div", { class: "group-head" }, h("h2", {}, title), h("p", {}, subtitle)),
      h("div", { class: "cards" }, sorted.map(card)),
    );
  }

  function summaryText(report) {
    const level = LEVELS[report.level] || LEVELS.mild;
    if (isSchemaV2(report)) {
      const ro = report.readouts;
      const { lead } = partitionFindings(report.findings);
      const leadPhrase = lead.length === 0
        ? "nothing critical stands out"
        : `${plural(lead.length, "serious lead", "serious leads")} ${lead.length === 1 ? "stands" : "stand"} out`;
      const conf = (key) => ro[key]?.confidence || "low";
      const corpus = ro.corpusVolume?.score ?? report.score;
      let text = `If this leaked, ${leadPhrase}. TMI: `
        + `Credentials ${ro.credentials.score}/100 (${conf("credentials")}); `
        + `Intimate & safety ${ro.intimateSafety.score}/100 (${conf("intimateSafety")}); `
        + `Identity bridges ${ro.identityBridges.score}/100 (${conf("identityBridges")}); `
        + `Corpus volume ${corpus}/100 (${level.stamp.toLowerCase()}).`;
      const foot = coverageFootnote(report.coverage);
      if (foot) text += ` ${foot}`;
      return `${text} Scanned on my own machine.`;
    }
    const found = report.categories.filter((c) => c.unique > 0)
      .sort((a, b) => b.unique - a.unique)
      .map((c) => `${c.unique} ${c.label.toLowerCase()}`);
    return `My chatbot knows ${plural(report.totals.unique, "thing", "things")} about me`
      + (found.length ? `: ${found.join(", ")}` : "")
      + `. Exposure score ${report.score}/100 (${level.stamp.toLowerCase()}). Scanned on my own machine with TMI.`;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = h("textarea", { class: "visually-hidden" }, text);
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
  }

  async function copySummary(button, report) {
    await copyText(summaryText(report));
    button.textContent = "Copied. Share responsibly.";
    setTimeout(() => { button.textContent = "Copy my results"; }, 2400);
  }

  async function copyWithButtonFeedback(button, text, originalLabel) {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      try {
        const area = h("textarea", { class: "visually-hidden" }, text);
        document.body.append(area);
        area.select();
        ok = document.execCommand("copy");
        area.remove();
      } catch {
        ok = false;
      }
    }
    button.textContent = ok ? "Copied" : "Copy failed";
    setTimeout(() => { button.textContent = originalLabel; }, 2400);
    return ok;
  }

  function analysisPromptBlock(report) {
    const build = globalThis.buildAnalysisPrompt;
    if (typeof build !== "function") return null;
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
      const text = build(report, { mode: selected, generatedAt: new Date().toISOString() });
      choice.hidden = true;
      await copyWithButtonFeedback(button, text, label);
    });

    return h("div", { class: "analysis-prompt-wrap" }, lede, button, choice);
  }

  function renderReport(report) {
    const v2 = isSchemaV2(report);
    const level = LEVELS[report.level] || LEVELS.mild;
    const source = report.source;
    const n = report.totals.unique;
    const word = SOURCE_WORDS[source.format] || "pieces of text";
    const share = source.piecesScanned ? Math.round((100 * source.piecesWithFinds) / source.piecesScanned) : 0;

    const segments = meterSegments(report.score);
    const facts = [
      ["Source", source.label],
      source.conversations ? ["Conversations", source.conversations.toLocaleString()] : null,
      [word.charAt(0).toUpperCase() + word.slice(1), source.piecesScanned.toLocaleString()],
      ["With personal info", `${share}%`],
      source.assistantMessagesSkipped ? ["AI replies ignored", source.assistantMessagesSkipped.toLocaleString()] : null,
      source.codeBlocksSkipped ? ["Code blocks skipped", source.codeBlocksSkipped.toLocaleString()] : null,
      ["Scan time", report.elapsedMs < 100 ? "under 0.1 s" : `${(report.elapsedMs / 1000).toFixed(1)} s`],
    ].filter(Boolean);

    const direct = report.categories.filter((c) => c.tier === "direct");
    const context = report.categories.filter((c) => c.tier === "context");
    const copyButton = h("button", { class: "btn btn-primary", type: "button" }, "Copy my results");
    copyButton.addEventListener("click", () => copySummary(copyButton, report));
    const againButton = h("button", { class: "btn btn-ghost", type: "button" }, "Scan something else");
    againButton.addEventListener("click", () => {
      els.results.hidden = true;
      window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
      els.choose.focus({ preventScroll: true });
    });

    const notes = [];
    if (source.truncated) notes.push("That export was huge, so we scanned the first 5 million characters.");
    if (source.failedChunks) notes.push(`${source.failedChunks} chunk(s) couldn't be read and were skipped.`);

    const { lead } = v2 ? partitionFindings(report.findings) : { lead: [] };
    const headlineMark = v2
      ? (lead.length === 0 ? "nothing critical" : plural(lead.length, "serious lead", "serious leads"))
      : (n === 0 ? "nothing" : plural(n, "thing", "things"));
    const verdictTitle = v2
      ? ["If this leaked, ", h("mark", {}, headlineMark), " stands out."]
      : ["Your AI knows ", h("mark", {}, headlineMark), " about you."];

    matrixFilter = { domain: null, harm: null };
    const matrixHost = h("div", { class: "matrix-host" });
    const findingsHost = h("div", { class: "findings-host" });
    const paintMatrix = () => {
      if (!v2) return;
      const onSelect = (next) => {
        matrixFilter = sameFilter(matrixFilter, next) ? { domain: null, harm: null } : next;
        paintMatrix();
      };
      matrixHost.replaceChildren(domainMatrixSheet(report, matrixFilter, onSelect) || "");
      findingsHost.replaceChildren(findingsSheet(report, matrixFilter));
    };
    paintMatrix();

    const verdictSheet = h("div", { class: `sheet verdict${v2 ? " is-v2" : ""}` },
      h("div", { class: "sheet-head" }, h("span", {}, "Case file"), h("span", {}, `Exhibit A · ${source.label}`)),
      h("div", { class: "verdict-body" },
        h("div", { class: "verdict-top" },
          h("h2", { class: "verdict-title", id: "verdict-title" }, ...verdictTitle),
          h("p", { class: "stamp", "aria-label": `Verdict: ${level.stamp}` }, level.stamp),
        ),
        h("p", { class: "verdict-quip" }, level.quip),
        v2 ? null : h("div", { class: "meter" },
          h("div", { class: "meter-head" },
            h("span", { class: "label" }, "Exposure score"),
            h("span", { class: "meter-value" }, String(report.score), h("small", {}, " / 100")),
          ),
          h("div", { class: `meter-bar${report.score >= 50 ? " is-hot" : ""}`, "aria-hidden": "true" }, segments),
        ),
        h("dl", { class: "facts" }, facts.map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v)))),
      ),
    );

    const corpusGroups = v2
      ? h("details", { class: "sheet corpus-detail" },
        h("summary", { class: "corpus-summary" }, h("span", {}, "Corpus detail"), h("span", { class: "corpus-hint" }, "Legacy 11 categories · volume, not headline")),
        h("div", { class: "corpus-detail-body" },
          group("Points straight at you", "Any one of these identifies you on its own.", direct),
          group("Points at you in a crowd", "Harmless alone. Together they narrow it down to you.", context),
        ),
      )
      : null;

    const sections = [
      v2 ? matrixHost : null,
      v2 ? readoutsSheet(report.readouts, report.coverage) : null,
      v2 ? findingsHost : null,
      verdictSheet,
      v2 ? corpusGroups : group("Points straight at you", "Any one of these identifies you on its own.", direct),
      v2 ? null : group("Points at you in a crowd", "Harmless alone. Together they narrow it down to you.", context),
      h("div", { class: "sheet next" },
        h("div", { class: "sheet-head" }, h("span", {}, "Now what"), h("span", {}, "Damage control")),
        h("div", { class: "next-body" },
          h("h2", {}, "Tidy up before it writes your biography."),
          h("ol", {},
            h("li", {}, h("b", {}, "Prune the memory."), "Open your chatbot's memory settings and delete anything a stranger shouldn't know."),
            h("li", {}, h("b", {}, "Check the data controls."), "Most apps let you opt out of training on your chats. Five clicks, tops."),
            h("li", {}, h("b", {}, "Go incognito for the spicy stuff."), "Temporary or private chats don't feed the memory."),
            h("li", {}, h("b", {}, "Stop pasting bank details."), "We say this with love."),
          ),
        ),
      ),
      h("div", { class: "result-actions" }, copyButton, v2 ? analysisPromptBlock(report) : null, againButton,
        h("span", { class: "note" }, "The copy is numbers only. No names, no digits, nothing to doxx.")),
      notes.length ? h("p", { class: "caveat" }, notes.join(" ")) : null,
      h("p", { class: "caveat" },
        v2
          ? "Counts are distinct values. Harm readouts use masked findings; corpus detail is the legacy category roll-up. English only."
          : "Counts are distinct values, so ten mentions of your mum is still one name. We're good, not perfect: "
            + "we miss most street addresses and health details, and sometimes call a band a company. English only."),
    ];
    els.results.replaceChildren(...sections.filter(Boolean));
    els.results.hidden = false;
    const title = document.getElementById("verdict-title");
    if (title) { title.setAttribute("tabindex", "-1"); title.focus({ preventScroll: true }); }
    requestAnimationFrame(() => {
      els.results.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
    });
  }

  // ---------- wiring ----------

  async function loadConfig() {
    try {
      const response = await fetch("/api/config", { cache: "no-store" });
      const config = await response.json();
      if (config.maxUploadMb) els.maxMb.textContent = String(config.maxUploadMb);
      if (!config.local) {
        els.status.classList.add("is-remote");
        els.statusText.textContent = "Processed in memory, never stored";
        els.privacy.textContent = "Processed in memory on this server and thrown away straight after. No logs, no copies, no snooping. We have enough problems.";
      }
    } catch {
      /* keep the defaults */
    }
  }

  els.choose.addEventListener("click", (event) => { event.stopPropagation(); els.file.click(); });
  els.drop.addEventListener("click", (event) => { if (event.target === els.drop || event.target.closest(".drop-title, .drop-hint")) els.file.click(); });
  els.drop.addEventListener("keydown", (event) => {
    if (event.target === els.drop && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); els.file.click(); }
  });
  els.file.addEventListener("change", () => scanFile(els.file.files[0]));

  ["dragenter", "dragover"].forEach((type) => els.drop.addEventListener(type, (event) => {
    event.preventDefault();
    els.drop.classList.add("is-over");
  }));
  ["dragleave", "dragend"].forEach((type) => els.drop.addEventListener(type, () => els.drop.classList.remove("is-over")));
  els.drop.addEventListener("drop", (event) => {
    event.preventDefault();
    els.drop.classList.remove("is-over");
    scanFile(event.dataTransfer.files[0]);
  });
  // A file dropped anywhere else shouldn't make the browser navigate away.
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => event.preventDefault());

  els.pasteToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    show("paste");
    els.pasteText.focus();
  });
  els.pasteCancel.addEventListener("click", () => show("idle"));
  els.pasteForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = els.pasteText.value.trim();
    if (!text) { showError("That's empty. Paste something first. We can't judge thin air."); return; }
    scanText(text);
  });

  els.sample.addEventListener("click", async () => {
    try {
      const response = await fetch("/static/sample-memory.txt", { cache: "no-store" });
      scanText(await response.text());
    } catch {
      showError("Couldn't load the sample. Ironic.");
    }
  });

  document.querySelectorAll(".copy-prompt").forEach((button) => {
    const hint = button.querySelector(".copy-prompt-hint");
    const defaultHint = hint?.textContent ?? "Copy";
    button.addEventListener("click", async () => {
      const text = button.dataset.copy ?? button.querySelector("q")?.textContent ?? "";
      if (!text) return;
      await copyText(text);
      button.classList.add("is-copied");
      if (hint) hint.textContent = "Copied";
      setTimeout(() => {
        button.classList.remove("is-copied");
        if (hint) hint.textContent = defaultHint;
      }, 2400);
    });
  });

  loadConfig();
})();
