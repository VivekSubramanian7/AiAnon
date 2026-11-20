"""
Build public/scanner/mirror-mock.html from mirror-report-data.json + fixed verbatim quotes.
Quotes are taken only from the user's ChatGPT export (user role messages).
"""

from __future__ import annotations

import html
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCANNER = os.path.join(ROOT, "public", "scanner")
REPORT_PATH = os.path.join(SCANNER, "mirror-report-data.json")
SENSITIVITY_PATH = os.path.join(SCANNER, "mirror-sensitivity.json")
OUT_PATH = os.path.join(SCANNER, "mirror-mock.html")

LEVEL_STAMP = {
    "biography": "Unauthorized biography",
    "oversharer": "Certified oversharer",
    "chatty": "Chatty",
    "mild": "Mostly harmless",
    "clean": "Suspiciously clean",
}
LEVEL_QUIP = {
    "biography": "Your chatbot could ghostwrite your memoir. With footnotes.",
    "oversharer": "It could fill in your forms for you. Not legally. Spiritually.",
    "chatty": "You two are close. Group-chat close.",
    "mild": "A few crumbs. It knows your vibe, not your address.",
    "clean": "Either you're a spy or you uploaded the wrong file. We respect both.",
}

# Verbatim user messages from the export (confirmed by search in conversations JSON).
VERBATIM = [
    "As an Indian, can I only have a 1 year contract to work in Germany as a professional if I do not speak German?",
    "This is to inform you that I have received an offer to move to Germany from my current company. "
    "Unfortunately, under these circumstances I will not be able to join Rakuten India.",
    "I would just love to hear the confirmation that I am finalised as the tenant and can move in on the 1st of July? "
    "Also when can we have the key hand over?",
    "I received an email recently to update my documents on the HR portal. Unfortunately, I am not able to login "
    "into the portal.",
    "I need the employment certificate for my last employment in Global Logic Germany GmBH.",
]


def cat(report: dict, key: str) -> dict:
    for row in report["categories"]:
        if row["key"] == key:
            return row
    return {"key": key, "unique": 0, "count": 0, "examples": []}


def chips(key: str, row: dict, limit: int = 8) -> str:
    if not row.get("examples"):
        return "<p class=\"stats\">None in scan.</p>"
    return (
        '<ul class="chips">\n'
        + "\n".join(
            f'<li class="chip"><b>{html.escape(key)}</b><span>{html.escape(ex["masked"])}'
            f' <small>(×{ex["count"]})</small></span></li>'
            for ex in row["examples"][:limit]
        )
        + "\n</ul>"
    )


def meter_segments(score: int) -> str:
    on = max(1, min(20, round(score / 5)))
    return "".join('<i class="on"></i>' if i < on else "<i></i>" for i in range(20))


def load_axes() -> dict | None:
    if not os.path.isfile(SENSITIVITY_PATH):
        return None
    with open(SENSITIVITY_PATH, encoding="utf-8") as f:
        return json.load(f)


HARM_LEAD = frozenset({"H1", "H2", "H3"})
CONF_LEAD = frozenset({"confirmed", "high", "medium"})

HARM_BAND_META = {
    "H1": ("Live credentials", "Keys, tokens, JWTs, password cues — operational compromise if this file leaks."),
    "H2": ("Payment & government IDs", "Cards, IBANs, national IDs, account email/phone from user.json."),
    "H3": ("Intimate, safety & precise location", "Health/immigration themes, street addresses, GPS — Art. 9–style harm."),
    "H4": ("Identity bridges", "Validated phones, emails, profile URLs that link chat text to a real person."),
    "H5": ("Amplifiers", "Employer + compensation narratives that sharpen phishing, not raw identifiers."),
    "H6": ("Weak corpus", "Name bags, noisy phones, dates — volume, not headline harm."),
}


def coverage_copy(coverage: dict) -> str:
    if coverage.get("lowerBound"):
        text = "These findings are a lower bound. Some of the export was not read."
        if coverage.get("truncated"):
            text += " Scanner stopped at 5M characters."
        return text
    parts = []
    if coverage.get("truncated"):
        parts.append(f"Scanned {coverage.get('charactersScanned', 0):,} chars — more in file.")
    if coverage.get("userJsonPresent"):
        parts.append("user.json in zip (account email/phone) was not scanned in chat text.")
    if coverage.get("binaryAttachments"):
        parts.append(f"{coverage['binaryAttachments']} binary attachments not read.")
    return " ".join(parts) or "Full export scanned within cap."


def partition_findings(findings: list[dict]) -> tuple[list[dict], list[dict], list[dict], list[dict]]:
    lead: list[dict] = []
    possible: list[dict] = []
    unsure: list[dict] = []
    for f in findings:
        if f.get("harm") == "H3" and f.get("confidence") == "low":
            possible.append(f)
            continue
        if f.get("harm") in HARM_LEAD and f.get("confidence") in CONF_LEAD:
            lead.append(f)
            continue
        if f.get("subject") == "unknown" and f.get("harm") != "H1":
            unsure.append(f)
    about_you = [
        f for f in lead
        if f.get("subject") == "account_holder"
        or (f.get("harm") == "H1" and f.get("subject") == "unknown")
    ]
    about_others = [f for f in lead if f.get("subject") == "third_party"]
    return about_you, about_others, possible, unsure


def finding_list_html(rows: list[dict]) -> str:
    if not rows:
        return '<p class="stats">None in this group.</p>'
    items = []
    for f in rows:
        extra = f' · ×{f["count"]}' if f.get("count", 1) > 1 else ""
        items.append(
            f'<li class="finding-chip"><span class="finding-label">{html.escape(f["label"])}</span>'
            f'<code class="finding-mask">{html.escape(f["masked"])}</code>'
            f'<small>{html.escape(f["harm"])} · {html.escape(f["confidence"])}{extra}</small></li>'
        )
    return '<ul class="finding-list">\n' + "\n".join(items) + "\n</ul>"


def findings_tiered_sheet(report: dict) -> str:
    findings = report.get("findings") or []
    bands = report.get("bands") or {}
    kinds = {f.get("kind") for f in findings}
    combo_html = (
        '<p class="combo-line">Employer and immigration themes both appear — a common phishing combo.</p>'
        if "employer" in kinds and "immigration" in kinds
        else ""
    )
    tier_blocks: list[str] = []
    for harm in ("H1", "H2", "H3", "H4", "H5", "H6"):
        title, blurb = HARM_BAND_META[harm]
        band = bands.get(harm, {})
        unique = int(band.get("unique", 0))
        rows = [f for f in findings if f.get("harm") == harm]
        open_attr = " open" if harm in ("H1", "H2", "H3") and (unique or rows) else ""
        examples = finding_list_html(rows) if rows else '<p class="stats">No masked examples in the UI cap for this band.</p>'
        tier_blocks.append(
            f"""<details class="tier-band"{open_attr}>
  <summary><span class="tier-label">{harm}</span> {html.escape(title)}
    <span class="tier-count">{unique:,} unique</span></summary>
  <div class="tier-band-body">
    <p class="stats">{html.escape(blurb)}</p>
    {examples}
  </div>
</details>"""
        )
    cap_note = (
        f"Masked examples below: {len(findings)} rows (UI cap). "
        "Band counts are from the full scan — see docs/sensitivity-tiers.md."
    )
    return f"""<article class="sheet findings-sheet" id="sensitivity-tiers">
  <header class="sheet-head"><span>Sensitivity tiers</span><span>H1 → H6</span></header>
  <div class="findings-body">
    <p class="kicker">Harm if this export leaks — ordered most severe first</p>
    {combo_html}
    <p class="stats">{html.escape(cap_note)}</p>
    <div class="tier-stack">{"".join(tier_blocks)}</div>
  </div>
</article>"""


def tier_intro_sheet() -> str:
    return """<article class="sheet tier-intro-sheet">
  <header class="sheet-head"><span>Your export</span><span>Schema v2</span></header>
  <div class="mirror-intro">
    <p class="kicker">Tiered sensitivity · not the old “Acts” storyboard</p>
    <h2>What can leak, in order of harm</h2>
    <p>Scores up top, then H1–H6 findings with masked examples. The theatrical mirror (snitch list, verbatim acts) is tucked at the bottom — expand only if you want that demo.</p>
  </div>
</article>"""


def readouts_sheet_html(readouts: dict, coverage: dict) -> str:
    cards = [
        ("credentials", "Credentials", "H1", "Live secrets in your chats"),
        ("intimateSafety", "Intimate & safety", "H3", "Health, immigration, family (keyword pass — low confidence)"),
        ("identityBridges", "Identity bridges", "H4", "Emails, handles, profile URLs — not name volume"),
        ("corpusVolume", "Corpus volume", "H6", "Old exposure score — noisy names & phones"),
    ]
    meters = []
    for key, title, band, sub in cards:
        row = readouts.get(key, {})
        s = int(row.get("score", 0))
        legacy = key == "corpusVolume"
        hot = " is-hot" if (legacy and s >= 50) or (not legacy and s >= 40) else ""
        legacy_cls = " legacy-score" if legacy else ""
        conf = row.get("confidence", "")
        meters.append(
            f"""<div class="axis-card{legacy_cls}">
  <div class="axis-head"><span class="label">{html.escape(band)}</span>
  <span class="meter-value">{s}<small>/100</small></span></div>
  <h3 class="axis-title">{html.escape(title)}</h3>
  <p class="axis-sub">{html.escape(sub)}</p>
  <div class="meter-bar{hot}">{meter_segments(s)}</div>
  <p class="axis-conf">Confidence: {html.escape(conf)}</p>
</div>"""
        )
    cov = coverage_copy(coverage)
    return f"""<article class="sheet axes-sheet">
        <header class="sheet-head"><span>Harm readouts</span><span>Schema v2</span></header>
        <div class="axes-body">
          <p class="kicker">Three scores · corpus volume last</p>
          <div class="axes-grid">{"".join(meters)}</div>
          <p class="stats coverage-note"><strong>Coverage:</strong> {html.escape(cov)}</p>
        </div>
      </article>"""


def axes_sheet_html(axes: dict) -> str:
    readouts = axes.get("readouts", {})
    coverage = axes.get("coverage", {})
    cards = [
        ("credentials", "Credentials", "H1", "Live secrets in your chats"),
        ("intimateSafety", "Intimate & safety", "H3", "Health, immigration, family (keyword pass — low confidence)"),
        ("identityBridges", "Identity bridges", "H4", "Emails, handles, profile URLs — not name volume"),
        ("corpusVolume", "Corpus volume (legacy)", "H6", "Old exposure score — noisy names & phones"),
    ]
    meters = []
    for key, title, band, sub in cards:
        row = readouts.get(key, {})
        s = int(row.get("score", 0))
        hot = " is-hot" if key != "corpusVolume" and s >= 40 else (" is-hot" if key == "corpusVolume" and s >= 50 else "")
        conf = row.get("confidence", "")
        meters.append(
            f"""<div class="axis-card">
  <div class="axis-head"><span class="label">{html.escape(band)}</span>
  <span class="meter-value">{s}<small>/100</small></span></div>
  <h3 class="axis-title">{html.escape(title)}</h3>
  <p class="axis-sub">{html.escape(sub)}</p>
  <div class="meter-bar{hot}">{meter_segments(s)}</div>
  <p class="axis-conf">Confidence: {html.escape(conf)}</p>
</div>"""
        )
    meters_html = "\n".join(meters)

    cov_parts = []
    if coverage.get("truncated"):
        cov_parts.append(f"Scanned {coverage.get('charactersScanned', 0):,} chars — more in file.")
    if coverage.get("userJsonPresent"):
        cov_parts.append("user.json in zip (account email/phone) was not scanned.")
    if coverage.get("binaryAttachments"):
        cov_parts.append(f"{coverage['binaryAttachments']} binary attachments not read.")
    cov = " ".join(cov_parts) or "Full export scanned within cap."

    return f"""<article class="sheet axes-sheet">
        <header class="sheet-head"><span>Exhibit A</span><span>Harm readouts (spec)</span></header>
        <div class="axes-body">
          <p class="kicker">Three scores · see docs/sensitivity-tiers.md</p>
          <p class="stats">Mirror leads with harm if the zip leaks — not raw name/phone counts.</p>
          <div class="axes-grid">{meters_html}</div>
          <p class="stats coverage-note"><strong>Coverage bound:</strong> {html.escape(cov)}</p>
        </div>
      </article>"""


def corpus_verdict_inner(
    *,
    verdict_label: str,
    score: int,
    level: str,
    hot_meter: str,
    src: dict,
    totals: dict,
) -> str:
    return f"""
          <div class="verdict-top">
            <h2 class="verdict-title">{html.escape(verdict_label)} <mark class="swipe">{score}</mark> / 100</h2>
            <p class="stamp">{html.escape(LEVEL_STAMP.get(level, level))}</p>
          </div>
          <p class="verdict-quip">{html.escape(LEVEL_QUIP.get(level, ""))}</p>
          <div class="meter">
            <div class="meter-head"><span class="label">Exposure</span><span class="meter-value">{score}<small>/100</small></span></div>
            <div class="meter-bar{hot_meter}">{meter_segments(score)}</div>
          </div>
          <dl class="facts">
            <div><dt>Source</dt><dd>{html.escape(src['label'])}</dd></div>
            <div><dt>Pieces scanned</dt><dd>{src['piecesScanned']:,}</dd></div>
            <div><dt>Direct unique</dt><dd>{totals['directUnique']:,}</dd></div>
            <div><dt>Context unique</dt><dd>{totals['contextUnique']:,}</dd></div>
            <div><dt>Total unique findings</dt><dd>{totals['unique']:,}</dd></div>
            <div><dt>Mentions</dt><dd>{totals['mentions']:,}</dd></div>
          </dl>"""


def legacy_narrative_body(
    *,
    src: dict,
    truncated_note: str,
    names: dict,
    emails: dict,
    phones: dict,
    bank: dict,
    handles: dict,
    birthdays: dict,
    places: dict,
    orgs: dict,
    ages: dict,
    dates: dict,
    links: dict,
    score: int,
    level: str,
    totals: dict,
    signal_types: int,
    verbatim_li: str,
) -> str:
    return f"""
        <div class="mirror-intro">
          <p class="kicker">No fictional persona</p>
          <h2>What do I know about you?</h2>
          <p>Early mirror demo — question prompts, snitch counts, and Acts I–III. Schema v2 tiered output is above.</p>
        </div>
        <p class="stats">
          {src['charactersScanned']:,} characters of your text were scanned{html.escape(truncated_note)}.
          {src['assistantMessagesSkipped']:,} assistant messages and account metadata files were skipped by design.
          {src['codeBlocksSkipped']} code blocks were blanked before counting.
        </p>

        <div class="bot-dump">
          <h4>Snitch list (from counts + your words)</h4>
          <ul>
            <li><strong>{names['unique']:,}</strong> distinct names (top masked: {html.escape(names['examples'][0]['masked']) if names['examples'] else '—'}).</li>
            <li><strong>{emails['unique']}</strong> emails, <strong>{phones['unique']:,}</strong> phone-like numbers, <strong>{handles['unique']}</strong> @handles.</li>
            <li><strong>{birthdays['unique']}</strong> birth dates in your writing (account birth_date in user.json is not scanned).</li>
            <li><strong>{bank['unique']}</strong> bank-account-shaped string: {html.escape(bank['examples'][0]['masked']) if bank['examples'] else '—'}.</li>
            <li><strong>{places['unique']}</strong> places · <strong>{orgs['unique']:,}</strong> orgs · <strong>{dates['unique']}</strong> date strings · <strong>{links['unique']}</strong> links.</li>
          </ul>
          <p style="margin:0;font-size:14px;color:var(--ink-2)">You actually asked about (verbatim excerpts):</p>
          <ul>{verbatim_li}</ul>
        </div>

        <div class="act" id="on-file">
          <div class="act-head">
            <p class="act-kicker">Act I · On file</p>
            <h3>What points straight at you?</h3>
          </div>
          <div class="mirror-questions">
            <details class="mirror-q">
              <summary><h4>What's your full contact card?</h4><span class="sub">Emails, phones, handles from your side of chats.</span></summary>
              <div class="mirror-body">
                {chips("email", emails, 5)}
                {chips("phone", phones, 5)}
                {chips("handle", handles, 5)}
                <p class="mirror-punch">{emails['unique']} inboxes and {phones['unique']:,} phone-like strings in text you wrote.</p>
              </div>
            </details>
            <details class="mirror-q">
              <summary><h4>How many people did you name?</h4><span class="sub">Colleagues, landlords, HR — not just you.</span></summary>
              <div class="mirror-body">
                <p><strong>{names['unique']:,}</strong> distinct names across {names['count']:,} mentions.</p>
                {chips("name", names, 6)}
              </div>
            </details>
            <details class="mirror-q">
              <summary><h4>Did you put money details in chat?</h4></summary>
              <div class="mirror-body">
                <p><strong>{bank['unique']}</strong> match in your writing.</p>
                {chips("bank", bank, 2)}
              </div>
            </details>
          </div>
        </div>

        <div class="act" id="deduced">
          <div class="act-head">
            <p class="act-kicker">Act II · Deduced</p>
            <h3>What can be inferred without opening user.json?</h3>
          </div>
          <div class="mirror-questions">
            <details class="mirror-q">
              <summary><h4>What can I deduce about your life from employers and places?</h4></summary>
              <div class="mirror-body">
                <p class="cite">Your messages name employers, moves, and HR issues — in your own prompts.</p>
                <p><strong>{orgs['unique']:,}</strong> organisation strings and <strong>{places['unique']}</strong> place strings detected.</p>
                {chips("org", orgs, 5)}
                {chips("place", places, 5)}
              </div>
            </details>
            <details class="mirror-q">
              <summary><h4>What dates and ages show up?</h4></summary>
              <div class="mirror-body">
                <p><strong>{dates['unique']}</strong> distinct date strings · ages bucket: {html.escape(ages['examples'][0]['masked']) if ages.get('examples') else 'none'} ({ages['unique']} unique age mentions).</p>
                {chips("date", dates, 4)}
              </div>
            </details>
          </div>
        </div>

        <div class="act" id="leverage">
          <div class="act-head">
            <p class="act-kicker">Act III · Leverage</p>
            <h3>What does this data enable?</h3>
          </div>
          <div class="checklist">
            <div class="check-item"><span class="check-badge check-yes">In your text</span><div><b>Targeted work / immigration phishing</b><p>Themes your messages repeat (contracts, HR, relocation).</p></div></div>
            <div class="check-item"><span class="check-badge check-yes">Scan found</span><div><b>Recovery or invoice scams</b><p>{emails['unique']} emails and {phones['unique']:,} phone-like strings you pasted into chats.</p></div></div>
            <div class="check-item"><span class="check-badge check-maybe">Scan found</span><div><b>Financial detail exposure</b><p>{bank['unique']} bank-account-shaped string in messages you wrote.</p></div></div>
          </div>
          <details class="mirror-q" style="margin:0 28px 24px">
            <summary><h4>Am I you yet?</h4><span class="sub">Score {score} · level {html.escape(level)}</span></summary>
            <div class="mirror-body">
              <p><strong>{totals['unique']:,}</strong> distinct personal-detail findings across {src['conversations']:,} conversations — score capped at 100.</p>
              <p class="mirror-punch">{html.escape(LEVEL_QUIP.get(level, ""))}</p>
            </div>
          </details>
        </div>

        <div class="act" id="compare">
          <div class="act-head"><p class="act-kicker">Compare</p><h3>Signal types: random blog vs this export</h3></div>
          <div class="compare">
            <div class="compare-row"><span>Typical blog comment</span><div class="compare-bar"><i style="width:8%"></i></div><b>1</b></div>
            <div class="compare-row"><span>Your export</span><div class="compare-bar is-hot"><i style="width:100%"></i></div><b>{signal_types}</b></div>
          </div>
          <p class="stats">{signal_types} of 11 TMI categories had at least one unique finding (birth dates in your messages: {birthdays['unique']}).</p>
        </div>"""


def main() -> None:
    if not os.path.isfile(REPORT_PATH):
        print(f"Skip: {REPORT_PATH} not found", file=sys.stderr)
        sys.exit(0)
    with open(REPORT_PATH, encoding="utf-8") as f:
        payload = json.load(f)
    report = payload["report"]
    schema_v2 = "findings" in report and "readouts" in report
    src = report["source"]
    totals = report["totals"]
    score = report["score"]
    level = report["level"]

    names, emails, phones, bank, handles = (
        cat(report, k) for k in ("names", "emails", "phones", "bank", "handles")
    )
    places, orgs, ages, dates, links = (
        cat(report, k) for k in ("places", "orgs", "ages", "dates", "links")
    )
    birthdays = cat(report, "birthdays")

    signal_types = sum(1 for row in report["categories"] if row["unique"] > 0)
    truncated_note = " (truncated at 5M characters)" if src.get("truncated") else ""

    verbatim_li = "\n".join(f"<li>{html.escape(q)}</li>" for q in VERBATIM)
    hot_meter = " is-hot" if score >= 50 else ""
    legacy_notice = ""
    intro_html = ""
    corpus_html = ""
    narrative_html = ""
    if schema_v2:
        intro_html = tier_intro_sheet()
        axes_html = readouts_sheet_html(report["readouts"], report.get("coverage", {}))
        findings_html = findings_tiered_sheet(report)
        verdict_label = "Corpus volume (legacy)"
        corpus_inner = corpus_verdict_inner(
            verdict_label=verdict_label,
            score=score,
            level=level,
            hot_meter=hot_meter,
            src=src,
            totals=totals,
        )
        corpus_html = f"""<details class="sheet corpus-fold legacy-score">
        <summary class="sheet-head corpus-summary"><span>Corpus volume (legacy 11 categories)</span><span>{score} / 100 · {html.escape(level)}</span></summary>
        <div class="verdict-body">{corpus_inner}</div>
      </details>"""
        narrative_body = legacy_narrative_body(
            src=src,
            truncated_note=truncated_note,
            names=names,
            emails=emails,
            phones=phones,
            bank=bank,
            handles=handles,
            birthdays=birthdays,
            places=places,
            orgs=orgs,
            ages=ages,
            dates=dates,
            links=links,
            score=score,
            level=level,
            totals=totals,
            signal_types=signal_types,
            verbatim_li=verbatim_li,
        )
        narrative_html = f"""<details class="sheet legacy-mirror-fold" id="legacy-mirror">
        <summary class="sheet-head corpus-summary"><span>Legacy narrative mirror</span><span>Acts · snitch list · verbatim</span></summary>
        <div class="legacy-mirror-body">{narrative_body}
        <div style="padding:20px 28px 28px;border-top:2px solid var(--ink)">
          <a class="btn btn-ghost" href="/" style="border:2px solid var(--ink);padding:10px 16px;border-radius:4px;text-decoration:none;font-weight:700">Back to scanner</a>
        </div>
        </div>
      </details>"""
    else:
        legacy_notice = (
            '<p class="stats"><strong>Schema v1 report.</strong> '
            "Regenerate the report with schema v2 (see docs/sensitivity-tiers.md).</p>"
        )
        axes = load_axes()
        axes_html = axes_sheet_html(axes) if axes else ""
        findings_html = ""
        verdict_label = "Corpus volume (legacy)" if axes else "Exposure"
        corpus_inner = corpus_verdict_inner(
            verdict_label=verdict_label,
            score=score,
            level=level,
            hot_meter=hot_meter,
            src=src,
            totals=totals,
        )
        corpus_html = f"""<article class="sheet verdict legacy-score">
        <header class="sheet-head"><span>Case file</span><span>{src['conversations']:,} conversations</span></header>
        <div class="verdict-body">{corpus_inner}</div>
      </article>"""
        narrative_body = legacy_narrative_body(
            src=src,
            truncated_note=truncated_note,
            names=names,
            emails=emails,
            phones=phones,
            bank=bank,
            handles=handles,
            birthdays=birthdays,
            places=places,
            orgs=orgs,
            ages=ages,
            dates=dates,
            links=links,
            score=score,
            level=level,
            totals=totals,
            signal_types=signal_types,
            verbatim_li=verbatim_li,
        )
        narrative_html = f"""<article class="sheet">
        <header class="sheet-head"><span>Exhibit B</span><span>The mirror</span></header>
        {narrative_body}
        <div style="padding:20px 28px 28px;border-top:2px solid var(--ink)">
          <a class="btn btn-ghost" href="/" style="border:2px solid var(--ink);padding:10px 16px;border-radius:4px;text-decoration:none;font-weight:700">Back to scanner</a>
        </div>
      </article>"""

    page = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TMI · Mirror (your ChatGPT export)</title>
  <meta name="color-scheme" content="light dark">
  <link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/static/styles.css">
  <style>
    .mock-ribbon {{ max-width: 1240px; margin: 0 auto; padding: 10px 0 0; font-family: var(--mono); font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--stamp); }}
    .mock-ribbon span {{ border: 1.5px solid var(--stamp); padding: 4px 10px; border-radius: 3px; display: inline-block; }}
    .mirror {{ display: grid; gap: 28px; padding-block: 8px 56px; }}
    .mirror-intro {{ padding: 24px 28px 8px; display: grid; gap: 10px; }}
    .mirror-intro h2 {{ font-size: clamp(30px, 4vw, 48px); font-weight: 800; }}
    .act {{ border-top: 2px dashed var(--rule-strong); padding-top: 20px; scroll-margin-top: 16px; }}
    .act-head {{ padding: 0 28px 14px; }}
    .act-kicker {{ color: var(--stamp); font-size: 11px; font-family: var(--mono); letter-spacing: 0.1em; text-transform: uppercase; }}
    .act-head h3 {{ font-size: 28px; font-weight: 800; margin: 4px 0; }}
    .mirror-questions {{ padding: 0 28px 20px; display: grid; gap: 10px; }}
    .mirror-q {{ border: 1.5px solid var(--rule-strong); border-radius: 6px; background: var(--sheet); }}
    .mirror-q summary {{ list-style: none; cursor: pointer; padding: 14px 16px; display: grid; gap: 6px; }}
    .mirror-q summary::-webkit-details-marker {{ display: none; }}
    .mirror-q h4 {{ margin: 0; font-size: 17px; font-weight: 800; }}
    .mirror-q .sub {{ font-size: 13px; color: var(--ink-2); }}
    .mirror-body {{ border-top: 2px dashed var(--rule); padding: 14px 16px; font-size: 15px; display: grid; gap: 10px; }}
    .mirror-punch {{ font-family: var(--serif); font-style: italic; font-size: 18px; margin: 0; }}
    .bot-dump {{ margin: 0 28px 20px; padding: 18px 20px; border: 2px solid var(--ink); border-radius: 6px; display: grid; gap: 10px; }}
    .bot-dump h4 {{ margin: 0; font-size: 20px; font-weight: 800; }}
    .bot-dump ul {{ margin: 0; padding-left: 1.2em; display: grid; gap: 8px; }}
    .stats {{ padding: 0 28px 14px; color: var(--ink-2); font-size: 14px; max-width: 52em; }}
    .checklist {{ padding: 0 28px 20px; display: grid; gap: 8px; }}
    .check-item {{ display: grid; grid-template-columns: auto 1fr; gap: 12px; padding: 12px; border: 1.5px solid var(--rule-strong); border-radius: 6px; background: var(--sheet); }}
    .check-badge {{ font-family: var(--mono); font-size: 10px; border: 1.5px solid; padding: 3px 6px; border-radius: 3px; height: fit-content; }}
    .check-yes {{ color: var(--stamp); border-color: var(--stamp); }}
    .check-maybe {{ color: var(--ink-2); }}
    .compare {{ padding: 0 28px 24px; display: grid; gap: 10px; }}
    .compare-row {{ display: grid; grid-template-columns: 150px 1fr 3rem; gap: 10px; align-items: center; font-size: 14px; }}
    .compare-bar {{ height: 12px; background: var(--rule); border-radius: 2px; overflow: hidden; }}
    .compare-bar i {{ display: block; height: 100%; background: var(--ink); }}
    .compare-bar.is-hot i {{ background: var(--stamp); }}
    .cite {{ font-size: 14px; color: var(--ink-2); border-left: 3px solid var(--marker); padding: 8px 0 8px 12px; margin: 0; }}
    .chip small {{ opacity: 0.65; font-weight: 400; }}
    .axes-sheet .axes-body {{ padding: 20px 28px 24px; display: grid; gap: 16px; }}
    .axes-grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; }}
    .axis-card {{ border: 1.5px solid var(--rule-strong); border-radius: 6px; padding: 14px 16px; background: var(--sheet); display: grid; gap: 8px; }}
    .axis-head {{ display: flex; justify-content: space-between; align-items: baseline; }}
    .axis-title {{ margin: 0; font-size: 18px; font-weight: 800; }}
    .axis-sub {{ margin: 0; font-size: 13px; color: var(--ink-2); }}
    .axis-conf {{ margin: 0; font-family: var(--mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-2); }}
    .coverage-note {{ border-top: 2px dashed var(--rule); padding-top: 12px; }}
    .legacy-score {{ opacity: 0.85; }}
    .tier-stack {{ display: grid; gap: 10px; padding: 0 28px 8px; }}
    .tier-band {{ border: 1.5px solid var(--rule-strong); border-radius: 6px; background: var(--sheet); }}
    .tier-band summary {{ cursor: pointer; padding: 14px 16px; font-weight: 700; list-style: none; display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }}
    .tier-band summary::-webkit-details-marker {{ display: none; }}
    .tier-label {{ font-family: var(--mono); font-size: 11px; letter-spacing: 0.08em; color: var(--stamp); }}
    .tier-count {{ margin-left: auto; font-family: var(--mono); font-size: 11px; color: var(--ink-2); font-weight: 400; }}
    .tier-band-body {{ border-top: 2px dashed var(--rule); padding: 12px 16px 16px; }}
    .corpus-fold summary, .legacy-mirror-fold summary {{ cursor: pointer; list-style: none; }}
    .corpus-fold summary::-webkit-details-marker, .legacy-mirror-fold summary::-webkit-details-marker {{ display: none; }}
    .corpus-fold .verdict-body, .legacy-mirror-body {{ padding: 0 0 8px; }}
  </style>
</head>
<body>
  <p class="mock-ribbon"><span>ChatGPT export · scanned on this machine{html.escape(truncated_note)}</span></p>
  <header class="topbar">
    <a class="logo" href="/"><span class="logo-mark">TMI</span><span class="logo-dot">.</span></a>
    <span class="status"><i class="status-dot"></i><span>Mirror · real data</span></span>
  </header>
  <main>
    <section class="results mirror">
      {legacy_notice}
      {intro_html}
      {axes_html}
      {findings_html}
      {corpus_html}
      {narrative_html}
    </section>
  </main>
  <footer class="footer"><p>Spec: <code>docs/sensitivity-tiers.md</code> · Build: <code>build_mirror_mock.py</code></p></footer>
</body>
</html>
"""

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        f.write(page)
    print(f"Wrote {OUT_PATH} (score={score}, level={level})")


if __name__ == "__main__":
    main()