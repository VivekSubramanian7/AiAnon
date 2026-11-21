/* TMI front end: upload or paste, poll the scan job, render the verdict. No frameworks, no trackers. */
// The schema v2 report view is shared with the browser TMI: web/lib/report-view.js, served at /static/lib/.
import {
  analysisPromptBlock,
  copyText,
  copyWithButtonFeedback,
  coverageFootnote,
  domainMatrixSheet,
  findingsSheet,
  h,
  isSchemaV2,
  meterSegments,
  partitionFindings,
  readoutsSheet,
  sameFilter,
  standOut,
} from "/static/lib/report-view.js";

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

  let matrixFilter = { domain: null, harm: null };
  let busy = false;
  let lineTimer = null;

  // ---------- helpers ----------

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

  async function copySummary(button, report) {
    await copyWithButtonFeedback(button, summaryText(report), "Copy my results", "Copied. Share responsibly.");
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
      ? ["If this leaked, ", h("mark", {}, headlineMark), ` ${standOut(lead.length)}.`]
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
