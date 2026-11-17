"""
Turn an uploaded file (or pasted text) into the pieces of text the user wrote.

Supported:
  * ChatGPT data export (.zip with conversations.json / conversations-NNN.json, or the JSON alone)
  * Claude data export (.zip with conversations.json, memories*.json, projects.json, or the JSON alone)
  * Saved memories pasted or saved as .txt / .md (one memory per line)
  * Any other JSON: text-like fields are collected
Only text the user wrote is kept: AI replies, ids, timestamps and account files are skipped.
"""

import io
import json
import re
import zipfile
from dataclasses import dataclass, field
from html import unescape
from typing import Iterable, List, Optional

MAX_MEMBER_BYTES = 300 * 2**20   # largest single file read from a zip
MAX_TOTAL_BYTES = 600 * 2**20    # total uncompressed bytes read from a zip

CONVERSATIONS_RE = re.compile(r"(^|/)conversations(-\d+)?\.json$", re.I)
MEMORIES_RE = re.compile(r"(^|/)[^/]*memor(y|ies)[^/]*\.json$", re.I)
PROJECTS_RE = re.compile(r"(^|/)projects\.json$", re.I)
TEXT_FILE_RE = re.compile(r"\.(txt|md|markdown)$", re.I)
ACCOUNT_FILE_RE = re.compile(r"(^|/)(users?|account|settings|message_feedback|shared_conversations)\.json$", re.I)

# Keys whose string values are prose, for JSON we don't recognise.
TEXT_KEYS = {
    "text", "content", "parts", "memory", "memories", "value", "body", "message",
    "summary", "note", "notes", "prompt_template", "description", "title", "fact", "facts",
}
SKIP_KEYS = {
    "id", "uuid", "created_at", "updated_at", "create_time", "update_time", "model", "model_slug",
    "sender", "role", "type", "content_type", "status", "account", "email_address", "url", "file_name",
}


class ExtractError(ValueError):
    """The upload could not be read; the message is safe to show to the user."""


@dataclass
class Segment:
    text: str
    source: str  # "memory", "message", "profile" (custom instructions), "attachment", "project", "document"


@dataclass
class Extracted:
    format: str  # "chatgpt_export", "claude_export", "json", "text"
    segments: List[Segment] = field(default_factory=list)
    conversations: int = 0
    assistant_messages_skipped: int = 0
    files_read: List[str] = field(default_factory=list)


# ---------- ChatGPT ----------

def _is_chatgpt(data) -> bool:
    return isinstance(data, list) and any(isinstance(c, dict) and "mapping" in c for c in data[:20])


def _chatgpt(data: list, out: Extracted, seen_profiles: set) -> None:
    for conv in data:
        if not isinstance(conv, dict):
            continue
        out.conversations += 1
        nodes = (conv.get("mapping") or {}).values()
        for node in sorted(nodes, key=lambda n: ((n or {}).get("message") or {}).get("create_time") or 0):
            msg = (node or {}).get("message") or {}
            content = msg.get("content") or {}
            if content.get("content_type") == "user_editable_context":
                for key in ("user_profile", "user_instructions"):
                    value = (content.get(key) or "").strip()
                    if value and value not in seen_profiles:
                        seen_profiles.add(value)
                        out.segments.append(Segment(value, "profile"))
                continue
            role = (msg.get("author") or {}).get("role")
            if role == "assistant":
                out.assistant_messages_skipped += 1
                continue
            if role != "user":
                continue  # system and tool messages
            parts = content.get("parts") or []
            text = "\n".join(p for p in parts if isinstance(p, str)).strip()
            if not text and isinstance(content.get("text"), str):
                text = content["text"].strip()
            if text:
                out.segments.append(Segment(text, "message"))


# ---------- Claude ----------

def _is_claude(data) -> bool:
    return isinstance(data, list) and any(isinstance(c, dict) and "chat_messages" in c for c in data[:20])


def _claude_text(msg: dict) -> str:
    text = msg.get("text")
    if isinstance(text, str) and text.strip():
        return text.strip()
    pieces = [
        c.get("text", "") for c in msg.get("content") or []
        if isinstance(c, dict) and c.get("type") == "text" and isinstance(c.get("text"), str)
    ]
    return "\n".join(pieces).strip()


def _claude(data: list, out: Extracted) -> None:
    for conv in data:
        if not isinstance(conv, dict):
            continue
        out.conversations += 1
        for msg in conv.get("chat_messages") or []:
            if not isinstance(msg, dict):
                continue
            if msg.get("sender") != "human":
                out.assistant_messages_skipped += 1
                continue
            text = _claude_text(msg)
            if text:
                out.segments.append(Segment(text, "message"))
            for att in msg.get("attachments") or []:
                extracted = (att or {}).get("extracted_content") if isinstance(att, dict) else None
                if isinstance(extracted, str) and extracted.strip():
                    out.segments.append(Segment(extracted.strip(), "attachment"))


# ---------- anything else ----------

def _walk_strings(node, source: str, under_text_key: bool = False) -> Iterable[Segment]:
    if isinstance(node, str):
        if under_text_key and len(node.strip()) >= 3:
            yield Segment(node.strip(), source)
    elif isinstance(node, list):
        for item in node:
            yield from _walk_strings(item, source, under_text_key)
    elif isinstance(node, dict):
        for key, value in node.items():
            k = str(key).lower()
            if k in SKIP_KEYS:
                continue
            yield from _walk_strings(value, source, k in TEXT_KEYS or (under_text_key and not isinstance(value, str)))


def _generic_json(data, source: str, out: Extracted) -> None:
    if isinstance(data, list) and all(isinstance(x, str) for x in data):
        out.segments.extend(Segment(x.strip(), source) for x in data if x.strip())
        return
    out.segments.extend(_walk_strings(data, source))


FENCE_RE = re.compile(r"```.*?(?:```|\Z)", re.S)


def _lines(text: str, source: str) -> List[Segment]:
    segments = []
    for line in text.splitlines():
        line = re.sub(r"^\s*(?:[-*•·]|\d+[.)])\s+", "", line).strip()
        if line:
            segments.append(Segment(line, source))
    return segments


def _text_lines(text: str, source: str) -> List[Segment]:
    """Pasted memories: one memory per line (bullets and numbering stripped).
    A fenced code block stays one piece, so the scanner can skip it whole."""
    segments, pos = [], 0
    for match in FENCE_RE.finditer(text):
        segments += _lines(text[pos:match.start()], source)
        segments.append(Segment(match.group(0), source))
        pos = match.end()
    return segments + _lines(text[pos:], source)


def _html_to_text(html: str) -> str:
    html = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", html)
    html = re.sub(r"(?i)<br\s*/?>|</(p|div|li|h\d)>", "\n", html)
    return unescape(re.sub(r"<[^>]+>", " ", html))


def _load_json(raw: bytes, name: str):
    try:
        return json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ExtractError(f"{name} isn't valid JSON. Upload the file exactly as it came out of the export.")


def _from_json_data(data, out: Extracted, seen_profiles: set, generic_source: str = "document") -> str:
    if _is_chatgpt(data):
        _chatgpt(data, out, seen_profiles)
        return "chatgpt_export"
    if _is_claude(data):
        _claude(data, out)
        return "claude_export"
    _generic_json(data, generic_source, out)
    return "json"


# ---------- entry points ----------

def extract_text(text: str) -> Extracted:
    stripped = text.strip()
    if not stripped:
        raise ExtractError("That's empty. Paste your memories, or drop a file.")
    if stripped[:1] in "[{":
        try:
            data = json.loads(stripped)
        except json.JSONDecodeError:
            data = None
        if data is not None:
            out = Extracted(format="json")
            out.format = _from_json_data(data, out, set(), generic_source="memory")
            return _finish(out)
    out = Extracted(format="text", segments=_text_lines(stripped, "memory"))
    return _finish(out)


def extract_file(filename: str, raw: bytes) -> Extracted:
    name = (filename or "upload").lower()
    if zipfile.is_zipfile(io.BytesIO(raw)):
        return _finish(_from_zip(raw))
    if name.endswith(".json"):
        out = Extracted(format="json", files_read=[filename])
        out.format = _from_json_data(_load_json(raw, filename), out, set(), generic_source="memory")
        return _finish(out)
    if name.endswith((".html", ".htm")):
        html = raw.decode("utf-8", errors="replace")
        embedded = re.search(r"jsonData\s*=\s*(\[.*?\]);\s*\n", html, re.S)  # ChatGPT chat.html
        if embedded:
            try:
                data = json.loads(embedded.group(1))
            except json.JSONDecodeError:
                data = None
            if data is not None:
                out = Extracted(format="json", files_read=[filename])
                out.format = _from_json_data(data, out, set())
                return _finish(out)
        return _finish(Extracted(format="text", segments=_text_lines(_html_to_text(html), "document")))
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise ExtractError("That doesn't look like text. Upload a .zip export, a .json file, or a .txt with your memories.")
    return extract_text(text)


def _from_zip(raw: bytes) -> Extracted:
    out = Extracted(format="json")
    seen_profiles: set = set()
    formats = []
    total = 0
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        infos = [i for i in zf.infolist() if not i.is_dir() and not i.filename.startswith("__MACOSX/")]
        wanted = [i for i in infos if CONVERSATIONS_RE.search(i.filename)]
        wanted += [i for i in infos if MEMORIES_RE.search(i.filename) or PROJECTS_RE.search(i.filename)]
        if not wanted:  # not an export we know: read loose text and JSON, skip account files
            wanted = [
                i for i in infos
                if (TEXT_FILE_RE.search(i.filename) or i.filename.lower().endswith(".json"))
                and not ACCOUNT_FILE_RE.search(i.filename)
            ]
        if not wanted:
            raise ExtractError("Found nothing to read in that zip. Use the export zip from ChatGPT or Claude.")
        for info in wanted:
            if info.file_size > MAX_MEMBER_BYTES or total + info.file_size > MAX_TOTAL_BYTES:
                raise ExtractError("That export is too big to scan in one go (over 600 MB unpacked).")
            total += info.file_size
            data = zf.read(info)
            out.files_read.append(info.filename)
            if TEXT_FILE_RE.search(info.filename):
                out.segments.extend(_text_lines(data.decode("utf-8", errors="replace"), "document"))
                formats.append("text")
                continue
            parsed = _load_json(data, info.filename)
            if MEMORIES_RE.search(info.filename):
                _generic_json(parsed, "memory", out)
                formats.append("json")
            elif PROJECTS_RE.search(info.filename):
                _generic_json(parsed, "project", out)
                formats.append("json")
            else:
                formats.append(_from_json_data(parsed, out, seen_profiles))
    for preferred in ("chatgpt_export", "claude_export", "json", "text"):
        if preferred in formats:
            out.format = preferred
            break
    return out


def _finish(out: Extracted) -> Extracted:
    out.segments = [s for s in out.segments if s.text.strip()]
    if not out.segments:
        raise ExtractError("We couldn't find anything you wrote in there. Nothing to judge. Suspicious.")
    return out
