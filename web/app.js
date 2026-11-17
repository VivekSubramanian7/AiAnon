// TMI in the browser: drop or paste, quick frisk in a worker, then (if asked) the detective.
// No frameworks, no trackers, no uploads. The worker only ever hands back counts and masked examples.

import { MODEL_BYTES, detectiveIsCached, forgetDetective } from "./lib/detective.js";

const $ = (id) => document.getElementById(id);
const els = {
  drop: $("drop"), file: $("file"), choose: $("choose"), pasteToggle: $("paste-toggle"),
  pasteForm: $("paste-form"), pasteText: $("paste-text"), pasteCancel: $("paste-cancel"),
  scanning: $("scanning"), scanLine: $("scan-line"), progress: $("progress"), fill: $("progress-fill"),
  pct: $("progress-pct"), detail: $("progress-detail"), error: $("error"), sample: $("sample"),
  results: $("results"), forget: $("forget"),
};
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const MB = 2 ** 20;
const MODEL_MB = Math.round(MODEL_BYTES / MB);

const FRISK_LINES = [
  "Patting down your memories…",
  "Checking pockets for phone numbers…",
  "Highlighting emails with a tiny yellow pen…",
  "Pretending not to judge…",
  "Judging a little…",
  "Cross-referencing your birthday with your cake requests…",
];
const DETECTIVE_LINES = [
  "Detective is finding the trench coat…",
  "Dusting capital letters for prints…",
  "Questioning every capital letter…",
  "Reading between the lines. Literally.",
  "Following a hunch about your coworker…",
  "Checking alibis for every name…",
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
const FRISK_ZERO_QUIPS = { // the frisk can't rule these out: it only knows names on its list
  names: "None on our list. The detective knows more names.",
  places: "None on our list. The detective might disagree.",
  orgs: "No 'Inc' or 'Ltd' in sight. The detective reads between the lines.",
};
const SOURCE_WORDS = { // exports mix messages, custom instructions, memories, attachments and project notes
  chatgpt_export: "things you wrote", claude_export: "things you wrote", text: "memories", json: "pieces of text",
};

// ---------- state ----------

let worker = null;
let inputSeq = 0;
let currentInput = null; // { id, file } or { id, text }: kept so the detective can rescan
let busy = false;
let lineTimer = null;
let detectiveUi = null; // elements of the detective panel in the current report

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

function setBar(fill, bar, pctEl, ratio) {
  const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  fill.style.width = `${Math.max(pct, 3)}%`;
  bar.setAttribute("aria-valuenow", String(pct));
  if (pctEl) pctEl.textContent = `${pct}%`;
}

function rotateLines(target, lines) {
  clearInterval(lineTimer);
  let i = 0;
  target.textContent = lines[0];
  lineTimer = setInterval(() => {
    i = (i + 1) % lines.length;
    target.textContent = lines[i];
  }, 1900);
}

function stopLines() {
  clearInterval(lineTimer);
  lineTimer = null;
}

const isMetered = () => {
  const c = navigator.connection;
  return Boolean(c && (c.saveData || /(^|-)2g|3g/.test(c.effectiveType || "")))
    || window.matchMedia("(pointer: coarse)").matches;
};

// ---------- worker ----------

function spawnWorker() {
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }) => onWorkerMessage(data);
  worker.onerror = (event) => {
    event.preventDefault?.();
    fail("frisk", "This browser couldn't start the scanner. Try a recent Chrome, Edge, Firefox or Safari.");
  };
  worker.postMessage({ type: "warm" });
}

function onWorkerMessage(data) {
  if (data.type === "progress") onProgress(data);
  else if (data.type === "result" && data.stage === "frisk") onFrisk(data.report);
  else if (data.type === "result" && data.stage === "detective") onDetective(data.report, data.missed, data.dropped);
  else if (data.type === "error") fail(data.stage, data.message, data.retry);
}

function onProgress({ phase, done, total }) {
  if (phase === "reading" || phase === "frisk") {
    setBar(els.fill, els.progress, els.pct, total ? done / total : 0);
    els.detail.textContent = phase === "reading" ? "opening the file"
      : `chunk ${done.toLocaleString()} of ${total.toLocaleString()}`;
    return;
  }
  if (!detectiveUi) return;
  const { fill, bar, meta } = detectiveUi;
  if (phase === "download") {
    setBar(fill, bar, null, total ? done / total : 0);
    meta.textContent = `Detective on the way · ${Math.round(done / MB)} of ${Math.round(total / MB)} MB`;
  } else if (phase === "starting") {
    setBar(fill, bar, null, 1);
    meta.textContent = "Detective is getting settled…";
  } else if (phase === "detective") {
    setBar(fill, bar, null, total ? done / total : 0);
    meta.textContent = `Reading the evidence · ${total ? Math.round((100 * done) / total) : 0}%`;
  }
}

function fail(stage, message, retry) {
  stopLines();
  busy = false;
  if (stage === "detective" && detectiveUi) {
    setDetectiveState("error", message, retry);
    return;
  }
  show("idle");
  showError(message);
  els.file.value = "";
}

// ---------- quick frisk ----------

function frisk(input) {
  if (busy) return;
  busy = true;
  currentInput = { id: ++inputSeq, ...input };
  els.error.hidden = true;
  els.results.hidden = true;
  show("scanning");
  setBar(els.fill, els.progress, els.pct, 0);
  els.detail.textContent = "opening the file";
  rotateLines(els.scanLine, FRISK_LINES);
  worker.postMessage({ type: "frisk", input: currentInput });
}

async function onFrisk(report) {
  stopLines();
  setBar(els.fill, els.progress, els.pct, 1);
  if (!reducedMotion) await new Promise((resolve) => setTimeout(resolve, 250));
  busy = false;
  els.file.value = "";
  show("idle"); // settle the layout before scrolling to the results
  renderReport(report, { stage: "frisk", cached: await detectiveIsCached() });
}

// ---------- detective ----------

function callDetective() {
  if (busy || !currentInput) return;
  busy = true;
  setDetectiveState("working");
  worker.postMessage({ type: "detective", input: currentInput });
}

function callOff() {
  // The worker may be mid-download or mid-model: start a fresh one. The frisk report stays.
  worker.terminate();
  spawnWorker();
  stopLines();
  busy = false;
  setDetectiveState("idle");
}

function onDetective(report, missed, dropped) {
  stopLines();
  busy = false;
  renderReport(report, { stage: "detective", missed, dropped });
  els.forget.hidden = false;
}

function setDetectiveState(state, message, retry) {
  const ui = detectiveUi;
  if (!ui) return;
  ui.idle.hidden = state !== "idle";
  ui.working.hidden = state !== "working";
  ui.error.hidden = state !== "error";
  if (state === "working") {
    setBar(ui.fill, ui.bar, null, 0);
    ui.meta.textContent = "Detective on the way…";
    rotateLines(ui.line, DETECTIVE_LINES);
    ui.cancel.focus({ preventScroll: true });
  } else if (state === "error") {
    ui.errorText.textContent = message;
    ui.retry.hidden = !retry;
  }
}

function detectivePanel(cached) {
  const fine = cached
    ? "Already on this device from last time. No download, straight to work."
    : `${MODEL_MB} MB, one time. Works on your device. Your memories never leave the room.`
      + (isMetered() ? " That's a chunk of mobile data, so Wi-Fi is your friend." : "");
  const button = h("button", { class: "btn btn-primary btn-detective", type: "button" }, "Call in the detective");
  button.addEventListener("click", callDetective);
  const idle = h("div", { class: "detective-idle" },
    h("h2", {}, "The rule-book did its best."),
    h("p", { class: "detective-pitch" },
      "It only recognises names it's seen before and can't tell a company from a coffee shop. "
      + "The detective reads between the lines: in our tests it caught ",
      h("mark", {}, "40% more names"), " and ", h("mark", {}, "3× more companies"), "."),
    h("div", { class: "detective-cta" }, button, h("p", { class: "detective-fine" }, fine)),
  );

  const line = h("p", { class: "scan-line", "aria-live": "polite" }, DETECTIVE_LINES[0]);
  const fill = h("div", { class: "progress-fill" });
  const bar = h("div", { class: "progress", role: "progressbar", "aria-label": "Detective progress", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "0" }, fill);
  const meta = h("span", {}, "Detective on the way…");
  const cancel = h("button", { class: "btn btn-ghost", type: "button" }, "Call it off");
  cancel.addEventListener("click", callOff);
  const working = h("div", { class: "detective-working", hidden: true },
    h("p", { class: "label" }, "Detective at work"), line, bar,
    h("div", { class: "detective-meta" }, meta, cancel));

  const errorText = h("p", {});
  const retry = h("button", { class: "btn btn-primary", type: "button" }, "Try again");
  retry.addEventListener("click", callDetective);
  const error = h("div", { class: "detective-error", hidden: true, role: "alert" }, errorText, retry);

  const box = h("div", { class: "sheet detective" },
    h("div", { class: "sheet-head" }, h("span", {}, "Next step"), h("span", {}, "Form TMI-02")),
    h("div", { class: "detective-body" }, idle, working, error));
  detectiveUi = { box, idle, working, error, errorText, retry, line, fill, bar, meta, cancel };
  return box;
}

// ---------- results ----------

function card(category, index, stage) {
  const zero = category.unique === 0;
  const zeroQuip = stage === "frisk" && FRISK_ZERO_QUIPS[category.key] ? FRISK_ZERO_QUIPS[category.key] : ZERO_QUIPS[category.key];
  const el = h("article", { class: `card${zero ? " is-zero" : ""}` },
    h("div", { class: "card-top" },
      h("span", { class: "card-label" }, category.label),
      h("span", { class: `tier tier-${category.tier}` }, category.tier === "direct" ? "Direct" : "Context"),
    ),
    zero
      ? h("p", { class: "card-num" }, "None")
      : h("p", { class: "card-num" }, category.unique.toLocaleString(), h("small", {}, "different")),
    zero ? null : h("p", { class: "card-sub" }, `mentioned ${plural(category.count, "time", "times")}`),
    h("p", { class: "card-quip" }, zero ? zeroQuip : QUIPS[category.key](category.unique)),
    zero ? null : h("ul", { class: "chips", "aria-label": "Examples, masked" },
      category.examples.map((ex) => h("li", { class: "chip" },
        h("span", {}, ex.masked), ex.count > 1 ? h("b", {}, `×${ex.count.toLocaleString()}`) : null))),
  );
  el.style.setProperty("--i", String(index));
  return el;
}

function group(title, subtitle, categories, stage) {
  const sorted = [...categories].sort((a, b) => (b.unique > 0) - (a.unique > 0) || b.unique - a.unique);
  return h("section", { class: "group" },
    h("div", { class: "group-head" }, h("h2", {}, title), h("p", {}, subtitle)),
    h("div", { class: "cards" }, sorted.map((c, i) => card(c, i, stage))),
  );
}

function summaryText(report, stage) {
  const found = report.categories.filter((c) => c.unique > 0)
    .sort((a, b) => b.unique - a.unique)
    .map((c) => `${c.unique} ${c.label.toLowerCase()}`);
  const level = LEVELS[report.level] || LEVELS.mild;
  return `My chatbot knows ${stage === "frisk" ? "at least " : ""}${plural(report.totals.unique, "thing", "things")} about me`
    + (found.length ? `: ${found.join(", ")}` : "")
    + `. Exposure score ${report.score}/100 (${level.stamp.toLowerCase()}). Checked in my own browser with TMI.`;
}

async function copySummary(button, report, stage) {
  const text = summaryText(report, stage);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = h("textarea", { class: "visually-hidden" }, text);
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  button.textContent = "Copied. Share responsibly.";
  setTimeout(() => { button.textContent = "Copy my results"; }, 2400);
}

function revealLine(missed, dropped) {
  const wrong = dropped ? `, and ${dropped.toLocaleString()} it got wrong` : "";
  if (missed === 0) return dropped ? `Case closed. Nothing new, but the frisk got ${dropped.toLocaleString()} wrong.`
    : "Case closed. The frisk got everything. Rare, but it happens.";
  return `Case closed. ${plural(missed, "thing", "things")} the frisk missed${wrong}.`;
}

function renderReport(report, ctx) {
  const { stage } = ctx;
  const isFrisk = stage === "frisk";
  const level = LEVELS[report.level] || LEVELS.mild;
  const source = report.source;
  const n = report.totals.unique;
  const word = SOURCE_WORDS[source.format] || "pieces of text";
  const share = source.piecesScanned ? Math.round((100 * source.piecesWithFinds) / source.piecesScanned) : 0;

  const segments = Array.from({ length: 20 }, (_, i) => h("i", { class: i < Math.round(report.score / 5) ? "on" : null }));
  const facts = [
    ["Investigation", isFrisk ? "Quick frisk" : "Detective"],
    ["Source", source.label],
    source.conversations ? ["Conversations", source.conversations.toLocaleString()] : null,
    [word.charAt(0).toUpperCase() + word.slice(1), source.piecesScanned.toLocaleString()],
    ["With personal info", `${share}%`],
    source.assistantMessagesSkipped ? ["AI replies ignored", source.assistantMessagesSkipped.toLocaleString()] : null,
    source.codeBlocksSkipped ? ["Code blocks skipped", source.codeBlocksSkipped.toLocaleString()] : null,
    ["Scan time", report.elapsedMs < 100 ? "under 0.1 s" : `${(report.elapsedMs / 1000).toFixed(1)} s`],
  ].filter(Boolean);

  const title = isFrisk
    ? (n === 0 ? ["The frisk found ", h("mark", {}, "nothing"), ". Yet."]
      : ["Your AI knows at least ", h("mark", {}, plural(n, "thing", "things")), " about you."])
    : ["Your AI knows ", h("mark", {}, n === 0 ? "nothing" : plural(n, "thing", "things")), " about you."];
  const stamp = isFrisk ? "Case open" : level.stamp;

  const direct = report.categories.filter((c) => c.tier === "direct");
  const context = report.categories.filter((c) => c.tier === "context");
  const copyButton = h("button", { class: "btn btn-primary", type: "button" }, "Copy my results");
  copyButton.addEventListener("click", () => copySummary(copyButton, report, stage));
  const againButton = h("button", { class: "btn btn-ghost", type: "button" }, "Scan something else");
  againButton.addEventListener("click", () => {
    els.results.hidden = true;
    window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
    els.choose.focus({ preventScroll: true });
  });

  const notes = [];
  if (source.truncated) notes.push("That export was huge, so we scanned the first 5 million characters.");
  if (source.failedChunks) notes.push(`${source.failedChunks} chunk(s) couldn't be read and were skipped.`);

  detectiveUi = null;
  const sections = [
    h("div", { class: `sheet verdict${isFrisk ? " is-frisk" : ""}` },
      h("div", { class: "sheet-head" }, h("span", {}, "Case file"),
        h("span", {}, `${isFrisk ? "Quick frisk" : "Detective's report"} · ${source.label}`)),
      h("div", { class: "verdict-body" },
        h("div", { class: "verdict-top" },
          h("h2", { class: "verdict-title", id: "verdict-title" }, ...title),
          h("p", { class: `stamp${isFrisk ? " is-open" : ""}`, "aria-label": `Verdict: ${stamp}` }, stamp),
        ),
        isFrisk ? null : h("p", { class: "reveal" }, revealLine(ctx.missed ?? 0, ctx.dropped ?? 0)),
        h("p", { class: "verdict-quip" }, level.quip),
        h("div", { class: "meter" },
          h("div", { class: "meter-head" },
            h("span", { class: "label" }, isFrisk ? "Exposure score so far" : "Exposure score"),
            h("span", { class: "meter-value" }, String(report.score), h("small", {}, " / 100")),
          ),
          h("div", { class: `meter-bar${report.score >= 50 ? " is-hot" : ""}`, "aria-hidden": "true" }, segments),
        ),
        h("dl", { class: "facts" }, facts.map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v)))),
      ),
    ),
    isFrisk ? detectivePanel(ctx.cached) : null,
    group("Points straight at you", "Any one of these identifies you on its own.", direct, stage),
    group("Points at you in a crowd", "Harmless alone. Together they narrow it down to you.", context, stage),
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
    h("div", { class: "result-actions" }, copyButton, againButton,
      h("span", { class: "note" }, "The copy is numbers only. No names, no digits, nothing to doxx.")),
    notes.length ? h("p", { class: "caveat" }, notes.join(" ")) : null,
    h("p", { class: "caveat" },
      "Counts are distinct values, so ten mentions of your mum is still one name. "
      + (isFrisk
        ? "The quick frisk only knows names on its list (mostly English-speaking ones) and companies that end in Inc, Ltd and friends. "
        : "")
      + "We're good, not perfect: we miss most street addresses and health details, and sometimes call a band a company. English only."),
  ];
  els.results.replaceChildren(...sections.filter(Boolean));
  els.results.hidden = false;
  const heading = document.getElementById("verdict-title");
  if (heading) { heading.setAttribute("tabindex", "-1"); heading.focus({ preventScroll: true }); }
  requestAnimationFrame(() => {
    els.results.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
  });
}

// ---------- wiring ----------

els.choose.addEventListener("click", (event) => { event.stopPropagation(); els.file.click(); });
els.drop.addEventListener("click", (event) => { if (event.target === els.drop || event.target.closest(".drop-title, .drop-hint")) els.file.click(); });
els.drop.addEventListener("keydown", (event) => {
  if (event.target === els.drop && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); els.file.click(); }
});
els.file.addEventListener("change", () => { if (els.file.files[0]) frisk({ file: els.file.files[0] }); });

["dragenter", "dragover"].forEach((type) => els.drop.addEventListener(type, (event) => {
  event.preventDefault();
  els.drop.classList.add("is-over");
}));
["dragleave", "dragend"].forEach((type) => els.drop.addEventListener(type, () => els.drop.classList.remove("is-over")));
els.drop.addEventListener("drop", (event) => {
  event.preventDefault();
  els.drop.classList.remove("is-over");
  if (event.dataTransfer.files[0]) frisk({ file: event.dataTransfer.files[0] });
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
  frisk({ text });
});

els.sample.addEventListener("click", async () => {
  try {
    const response = await fetch("sample-memory.txt");
    frisk({ text: await response.text() });
  } catch {
    showError("Couldn't load the sample. Ironic.");
  }
});

els.forget.addEventListener("click", async () => {
  const removed = await forgetDetective();
  els.forget.textContent = removed ? `Detective sent home. ${MODEL_MB} MB freed.` : "Nothing to send home.";
  els.forget.disabled = true;
});

spawnWorker();
detectiveIsCached().then((cached) => { els.forget.hidden = !cached; });
