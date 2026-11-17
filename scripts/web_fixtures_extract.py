#!/usr/bin/env python3
"""
Dump what lib/scanner/extract.py makes of the mock memories and a set of tricky inputs, so the
JavaScript port (web/lib/extract.js, web/lib/zip.js) can be checked against it.

Writes tests/web/fixtures/extract.json and the synthetic zips in tests/web/fixtures/zips/;
tests/web/extract.test.mjs reads both.

    .venv/bin/python scripts/web_fixtures_extract.py

Cases:
  * every file in samples/mock-memories/ (the large ChatGPT export as counts and a SHA-256 of its segments)
  * synthetic zips: stored, deflated, data descriptors, ZIP64, prepended data, archive comments, cp437 and
    UTF-8 names, the Unicode path extra field, size caps, broken archives
  * small files given inline (HTML, JSON, text), and pasted text
Each case stores the full Extracted, an ExtractError message, or "crash" (any other Python exception;
the site shows its generic message for those).
"""

import base64
import hashlib
import io
import json
import os
import struct
import sys
import zipfile
import zlib

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

from lib.scanner.extract import MAX_MEMBER_BYTES, MAX_TOTAL_BYTES, ExtractError, extract_file, extract_text  # noqa: E402

SAMPLES = "samples/mock-memories"
FIXTURES = "tests/web/fixtures"
ZIP_DIR = FIXTURES + "/zips"
SUMMARISE = {SAMPLES + "/chatgpt-export-large.zip"}  # too many segments to store them all
DATE = (2026, 11, 17, 12, 0, 0)
MB = 2**20


# ---------- results ----------

def segments_sha256(segments) -> str:
    joined = "\x00".join(f"{s.source}\x01{s.text}" for s in segments)
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()


def run(fn, summarise=False) -> dict:
    try:
        out = fn()
    except ExtractError as exc:
        return {"error": {"type": "ExtractError", "message": str(exc)}}
    except Exception as exc:  # noqa: BLE001 - Python gives up; the JavaScript must give up too
        return {"error": {"type": "crash", "pyType": type(exc).__name__, "message": str(exc)}}
    result = {
        "format": out.format,
        "conversations": out.conversations,
        "assistantMessagesSkipped": out.assistant_messages_skipped,
        "filesRead": out.files_read,
    }
    if summarise:
        counts = {}
        for s in out.segments:
            counts[s.source] = counts.get(s.source, 0) + 1
        result["segmentCount"] = len(out.segments)
        result["sourceCounts"] = counts
        result["segmentsSha256"] = segments_sha256(out.segments)
        result["firstSegments"] = [{"text": s.text, "source": s.source} for s in out.segments[:3]]
    else:
        result["segments"] = [{"text": s.text, "source": s.source} for s in out.segments]
    return {"ok": result}


def zip_listing(path: str, raw: bytes) -> dict:
    """What Python's zipfile sees: members (directories left out) and what reading each gives."""
    listing = {"path": path, "isZip": zipfile.is_zipfile(io.BytesIO(raw))}
    if not listing["isZip"]:
        return listing
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except Exception as exc:  # noqa: BLE001
        listing["error"] = type(exc).__name__
        return listing
    members = []
    for info in zf.infolist():
        if info.is_dir():
            continue
        member = {
            "name": info.filename, "size": info.file_size, "compressedSize": info.compress_size,
            "method": info.compress_type, "offset": info.header_offset, "crc": info.CRC, "flags": info.flag_bits,
        }
        try:
            data = zf.read(info)
            member["read"] = {"length": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        except Exception as exc:  # noqa: BLE001
            member["read"] = {"error": type(exc).__name__}
        members.append(member)
    listing["entries"] = members
    return listing


# ---------- export content ----------

def gpt_node(nid, role, parts=None, t=None, content_type="text", **content):
    c = {"content_type": content_type}
    if parts is not None:
        c["parts"] = parts
    c.update(content)
    return nid, {"id": nid, "message": {"id": nid, "author": {"role": role}, "create_time": t, "content": c},
                 "parent": None, "children": []}


def gpt_conv(title, *nodes):
    return {"title": title, "create_time": 1700000000.0, "mapping": dict(nodes)}


PROFILE = gpt_node("ctx", "user", content_type="user_editable_context",
                   user_profile="I'm Priya, a data engineer in Austin.", user_instructions="Keep it short.")

CHATGPT = [
    gpt_conv(
        "Moving",
        ("root", {"id": "root", "message": None, "parent": None, "children": ["a"]}),
        gpt_node("sys", "system", [""], None),
        PROFILE,
        gpt_node("a", "user", ["I'm moving from Austin to Lisbon in May."], 1700000003.5),
        gpt_node("b", "assistant", ["Lisbon is lovely, Priya!"], 1700000004.0),
        gpt_node("c", "user", ["My number is +1 512 555 0142"], 1700000001.25),
        gpt_node("d", "tool", ["search results"], 1700000002.0),
        gpt_node("e", "user", [{"content_type": "image_asset_pointer"}, "What's in this photo?"], 1700000005),
    ),
    gpt_conv("Code", PROFILE, gpt_node("f", "user", None, 1700000100, content_type="code", text="print(42)  ")),
]

CHATGPT_WEIRD = [
    gpt_conv(
        "A",
        ("root", {"id": "root", "message": None, "parent": None, "children": ["n1"]}),
        gpt_node("n3", "user", ["third by time"], 3),
        gpt_node("n1", "user", ["first by time", {"asset_pointer": "file-1"}, "  and more  "], 1.5),
        gpt_node("n2", "assistant", ["assistant reply"], 2),
        gpt_node("sys", "system", ["system prompt"], None),
        ("tool", {"message": {"author": {"role": "tool"}, "content": {"parts": ["tool output"]}}}),
        gpt_node("ctx", "user", content_type="user_editable_context", user_profile="  I am Priya.  ",
                 user_instructions="Be brief."),
        gpt_node("t", "user", None, True, content_type="code", text="  text field only  "),
        gpt_node("chars", "user", "abc", 4),
        gpt_node("keys", "user", {"key one": 1, "key two": 2}, 5),
        ("empty", {}),
        ("nul", None),
        ("zero", 0),
    ),
    gpt_conv("B", gpt_node("ctx2", "user", content_type="user_editable_context", user_profile="I am Priya.",
                           user_instructions="Be kind.")),
    {"title": "C", "mapping": None},
    {"title": "D"},
    "not a conversation",
    42,
]

CLAUDE = [
    {"uuid": "c1", "name": "Move", "chat_messages": [
        {"sender": "human", "text": "  Hello, I'm Marcus from Hamburg.  ",
         "content": [{"type": "text", "text": "ignored, the text field wins"}],
         "attachments": [{"file_name": "cv.txt", "extracted_content": "  Marcus Weber, CV  "},
                         {"extracted_content": "   "}, "string attachment", None, {"extracted_content": 5}]},
        {"sender": "assistant", "text": "Hi Marcus"},
        {"sender": "human", "text": "   ",
         "content": [{"type": "text", "text": "from content one"}, {"type": "tool_use", "text": "nope"},
                     {"type": "text", "text": "from content two"}, "x", {"type": "text", "text": 5}]},
        {"sender": "human", "text": None, "content": "string content"},
        {"sender": None, "text": "no sender"},
        "not a message",
        {"sender": "human", "content": {"type": "text"}},
    ]},
    {"uuid": "c2", "chat_messages": None},
    {"uuid": "c3", "chat_messages": "abc"},
    [],
]

CLAUDE_MEMORIES = [{"conversations_memory": "Marcus moved from Hamburg to Toronto.", "project_memories": {
    "p1": "Works at Kuehne Freight.", "p2": "ok"}}]
CLAUDE_PROJECTS = [{"uuid": "p1", "name": "Job hunt", "description": "Find a logistics job in Toronto",
                    "prompt_template": "You help Marcus.", "docs": [{"filename": "notes.md", "content": "Call Anna Schulz"}]}]
CLAUDE_USERS = [{"uuid": "u1", "full_name": "Marcus Weber", "email_address": "marcus@example.com"}]


def js(data) -> bytes:
    return json.dumps(data, ensure_ascii=False, indent=1).encode("utf-8")


# ---------- building zips ----------

class _Unseekable(io.RawIOBase):
    """Makes zipfile write data descriptors (bit 3), as streaming zip writers do."""

    def __init__(self, buf):
        self.buf = buf

    def writable(self):
        return True

    def write(self, b):
        return self.buf.write(b)


def build_zip(members, compression=zipfile.ZIP_DEFLATED, comment=b"", stream=False) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(_Unseekable(buf) if stream else buf, "w") as zf:
        zf.comment = comment
        for member in members:
            name, data = member[0], member[1]
            info = zipfile.ZipInfo(name, DATE)
            info.compress_type = member[2] if len(member) > 2 else compression
            if len(member) > 3:
                info.extra = member[3]
            zf.writestr(info, data.encode("utf-8") if isinstance(data, str) else data)
    return buf.getvalue()


def build_zip64(members) -> bytes:
    """Every size and offset that can be in a ZIP64 field is, plus the ZIP64 end records."""
    saved = zipfile.ZIP64_LIMIT
    zipfile.ZIP64_LIMIT = 0
    try:
        return build_zip(members)
    finally:
        zipfile.ZIP64_LIMIT = saved


def central_records(data: bytes):
    """(offset, name) of each central directory record (plain archives only)."""
    end = data.rindex(b"PK\x05\x06")
    size_cd, offset_cd = struct.unpack_from("<LL", data, end + 12)
    pos = offset_cd
    while pos < offset_cd + size_cd:
        n, e, c = struct.unpack_from("<HHH", data, pos + 28)
        yield pos, data[pos + 46:pos + 46 + n]
        pos += 46 + n + e + c


def patch_central(data: bytes, name: bytes, fmt: str, field: int, value) -> bytes:
    out = bytearray(data)
    for pos, member in central_records(data):
        if member == name:
            struct.pack_into(fmt, out, pos + field, value)
            return bytes(out)
    raise KeyError(name)


def patch_local(data: bytes, name: bytes, fmt: str, field: int, value) -> bytes:
    out = bytearray(data)
    for pos, member in central_records(data):
        if member == name:
            (header,) = struct.unpack_from("<L", data, pos + 42)
            struct.pack_into(fmt, out, header + field, value)
            return bytes(out)
    raise KeyError(name)


def set_flags(data: bytes, name: bytes, bits: int) -> bytes:
    for patch, field in ((patch_central, 8), (patch_local, 6)):
        for pos, member in central_records(data):
            if member == name:
                flags = struct.unpack_from("<H", data, pos + 8)[0] | bits
        data = patch(data, name, "<H", field, flags)
    return data


def unicode_path_extra(raw_name: bytes, real_name: str, crc=None) -> bytes:
    payload = real_name.encode("utf-8")
    crc = zlib.crc32(raw_name) if crc is None else crc
    return struct.pack("<HHBL", 0x7075, 5 + len(payload), 1, crc) + payload


STUB = b"#!/bin/sh\necho 'self-extracting stub'\nexit 0\n" * 8

NOTES = "﻿My notes\r\n- Lives in Leeds\r\n\r\n```\nsecret = 123\n```\nBad bytes: \udcff end\n"


def notes_bytes() -> bytes:
    return NOTES.encode("utf-8", errors="surrogateescape")  # \udcff -> the invalid byte 0xff


def synthetic_zips() -> dict:
    """name -> (bytes, bytes of the same zip without members JavaScript skips, or None)."""
    zips = {}

    zips["stored"] = build_zip([
        ("conversations.json", b"\xef\xbb\xbf" + js(CLAUDE)),
        ("memories.json", js(CLAUDE_MEMORIES)),
        ("projects.json", js(CLAUDE_PROJECTS)),
        ("users.json", js(CLAUDE_USERS)),
    ], compression=zipfile.ZIP_STORED)

    zips["data-descriptor"] = build_zip([
        ("conversations.json", js(CHATGPT)),
        ("user.json", js({"email": "priya@example.com"})),
        ("chat.html", "<html>not read</html>"),
    ], stream=True)

    zips["zip64"] = build_zip64([
        ("conversations-000.json", js(CHATGPT[:1])),
        ("conversations-001.json", js(CHATGPT[1:])),
        ("notes.txt", "not read: the export files win"),
    ])
    zips["zip64-prefixed"] = STUB + zips["zip64"]
    zips["prefixed-comment"] = STUB + build_zip(
        [("export/conversations.json", js(CLAUDE))], comment=b"Exported by a very helpful robot.")

    zips["export-nested"] = build_zip([
        ("Export/", b""),
        ("Export/Conversations-001.JSON", js(CLAUDE)),
        ("Export/memories/Memory-2024.json", js(CLAUDE_MEMORIES)),
        ("Export/projects.json", js(CLAUDE_PROJECTS)),
        ("Export/notes.txt", "not read: the export files win"),
        ("__MACOSX/Export/._Conversations-001.JSON", b"\x00\x05\x16\x07 binary junk"),
        ("conversations.json.bak", "not read"),
    ])

    # With re.I, Python's "i" matches U+0131, so this is read as the conversations file.
    zips["dotless-i"] = build_zip([
        ("Conversatıons.json", js(CLAUDE)),
        ("notes.txt", "Read only when the name above isn't recognised"),
    ])

    names = build_zip([
        ("folder/", b""),
        ("folder/more.markdown", "- from a markdown file"),
        ("notes-Xber.txt", "cp437 name"),                       # becomes notes-\x81ber.txt below
        ("français-notes.txt", "UTF-8 name"),
        ("evil.txt_.png", "cut at the NUL byte"),               # becomes evil.txt\0.png below
        ("unicode-path-placeholder.bin", "named by the Unicode path field", zipfile.ZIP_DEFLATED,
         unicode_path_extra(b"unicode-path-placeholder.bin", "ünïcode-päth.txt")),
        ("wrong-crc-placeholder.txt", "Unicode path field ignored", zipfile.ZIP_DEFLATED,
         unicode_path_extra(b"wrong-crc-placeholder.txt", "ignored.md", crc=1234)),
        ("folder\\windows.txt", "backslash kept"),
        ("trailing-newline.txt\n", "Python's $ matches before a final newline"),
        ("notes.txt.bak", "not read"),
        ("image.png", b"\x89PNG\r\n\x1a\n"),
        ("user.json", js({"email": "x@example.com"})),
        ("Settings.JSON", js({"theme": "dark"})),
        ("account.json", js({"note": "account files are skipped"})),
        ("data.json", js({"notes": ["Generic JSON in a zip", "ok"], "id": "skip me"})),
        ("README.MD", "# Upper-case extension\n1. counts as text"),
        ("__MACOSX/._notes.txt", b"\x00\x05\x16\x07"),
    ])
    names = names.replace(b"notes-Xber.txt", b"notes-\x81ber.txt").replace(b"evil.txt_.png", b"evil.txt\x00.png")
    zips["names"] = names

    zips["text-members"] = build_zip([
        ("notes.txt", notes_bytes()),
        ("list.md", "* one\n* two\n\n3) three"),
        ("data.json", b"\xef\xbb\xbf" + js({"memories": [{"fact": "Has a cat called Biscuit"}]})),
        ("empty.txt", b""),
    ])

    zips["invalid-member"] = build_zip([("conversations.json", '[{"mapping": ')])
    zips["invalid-utf8-member"] = build_zip([("data.json", b'{"note": "caf\xe9"}')])
    zips["empty"] = build_zip([])
    zips["dirs-only"] = build_zip([("a/", b""), ("a/b/", b"")])

    zips["too-big-member"] = patch_central(
        build_zip([("conversations.json", js(CLAUDE))], compression=zipfile.ZIP_STORED),
        b"conversations.json", "<L", 24, 400 * MB)
    total = build_zip([(f"{d}/conversations.json", js(CLAUDE)) for d in "abc"], compression=zipfile.ZIP_STORED)
    for d in "abc":  # declared 250 MB each: the first two are read (their data is small), the third is over 600 MB
        total = patch_central(total, f"{d}/conversations.json".encode(), "<L", 24, 250 * MB)
    zips["too-big-total"] = total

    zips["bad-crc"] = patch_central(build_zip([("conversations.json", js(CLAUDE))]), b"conversations.json", "<L", 16, 1)
    overlap = build_zip([("conversations.json", js(CLAUDE)), ("z.txt", "after")], compression=zipfile.ZIP_STORED)
    size = len(js(CLAUDE))
    zips["overlap"] = patch_central(overlap, b"conversations.json", "<L", 20, size + 10)

    locator = zips["zip64"].rindex(b"PK\x06\x07")
    multidisk = bytearray(zips["zip64"])
    struct.pack_into("<L", multidisk, locator + 16, 2)
    zips["multidisk"] = bytes(multidisk)
    zips["truncated"] = zips["data-descriptor"][: len(zips["data-descriptor"]) // 2]
    zips["plain-text"] = "Not a zip at all\n- just text with a .zip name\n".encode()

    # Members JavaScript skips: encrypted (Python stops with RuntimeError) and bzip2 (Python reads it).
    keep = [("notes.txt", "Readable notes")]
    zips["encrypted"] = (set_flags(build_zip(keep + [("secret.txt", "encrypted")]), b"secret.txt", 0x1),
                         build_zip(keep))
    zips["bzip2"] = (build_zip(keep + [("more.txt", "bzip2 member", zipfile.ZIP_BZIP2)]), build_zip(keep))
    return zips


# ---------- small files given inline ----------

CHAT_HTML = (
    "<!DOCTYPE html><html><head><meta charset=\"UTF-8\"><title>ChatGPT Data Export</title>\n"
    "<style>body { font-family: sans-serif; }</style></head><body><div id=\"root\"></div>\n"
    "<script>\nvar jsonData = " + json.dumps(CHATGPT) + ";\n"
    "function render(){ return jsonData.length; }\n</script></body></html>\n"
)

CHAT_HTML_BROKEN = (
    "<html><body><h1>Chats</h1>\n<script>\nvar jsonData = [{\"title\": \"Oops\", ];\n</script>\n"
    "<p>Shown when the embedded JSON is broken</p></body></html>\n"
)

PAGE_HTM = (
    "﻿<html><head><STYLE>p { color: red }</style><script type=\"x\">var x = 1;</SCRIPT></head><body>"
    "<h2>About me</h2><p>Lives in Leeds &amp; works at St Mary&#39;s</p><div>Line<br>break<BR/>again<br />end</div>"
    "<ul><li>- bullet in a list</li><li>2. numbered</li></ul><h٣>Arabic-indic heading digit</h٣>"
    "<p>&copy 2026 &notit; &ampx &NotEqualTilde; &unknown; &#x1F600; &#0; &#128; &#xD800; &#1114112; "
    "&#xFFFE; &#65 &#x; &lt;b&gt;</p><scriptx>kept: not a script tag</scriptx>"
    "<pre>```\ncode in pre\n```</pre><p>Bad bytes: \udcff\udcc3 \udce2\udc82 \udced\udca0\udc80 end</p>"
    "<style>unclosed style\n<p>still visible?</p>"
)

INLINE_FILES = {
    "chat.html": CHAT_HTML.encode(),
    "chat-broken.html": CHAT_HTML_BROKEN.encode(),
    "page.htm": PAGE_HTM.encode("utf-8", errors="surrogateescape"),
    "memories.JSON": b"\xef\xbb\xbf" + js(["  First memory  ", "", "Second memory", "  "]),
    "chatgpt-weird.json": js(CHATGPT_WEIRD),
    "claude-weird.json": js(CLAUDE),
    "ordered.json": b'{"10": {"text": "ten text"}, "9": {"text": "nine text"}, "title": "My list title", '
                    b'"2": "two", "1": {"note": "one note"}}',
    "nan.json": b'{"memory": "Likes NaN jokes", "score": NaN, "other": [Infinity, -Infinity]}',
    "broken.json": b'{"note": "caf\xe9"}',
    "double-bom.json": b"\xef\xbb\xbf\xef\xbb\xbf[\"x\"]",
    "trailing-comma.json": b'["a", "b",]',
    "crash.json": b'[{"mapping": {"a": "string node"}}]',
    "notes.txt": notes_bytes().replace(b"\xff", b"?"),
    "latin1.txt": "Café in Zürich".encode("latin-1"),
    "utf16.txt": "﻿Hello".encode("utf-16-le"),
    "memories.md": b"# My memories\n- Lives in Leeds\n```js\nconst id = 123;\n```\n2. Two\n",
    "": b"A file without a name\n",
    "nul-bytes.txt": b"before\x00after\nsecond line",
}


# ---------- pasted text ----------

def user_msg(text, t):
    return {"author": {"role": "user"}, "create_time": t, "content": {"parts": [text]}}


TEXTS = {
    "bullets": "- Lives in Leeds\n* Works as a nurse\n• Has a cat called Biscuit\n· Likes tea\n"
               "1. First numbered\n2) Second numbered\n  10.   Indented ten\n-no space dash\n*\n- \n3.no space\n",
    "fences": "Memory one\n```\ncode 123\n  indented\n```\nMemory two ``` inline ``` after\n"
              "```python\nunclosed fence\nstill code\n",
    "blank-lines": "\n\n   First line   \n\n\n\t Second line\t\n\n\n",
    "crlf": "Line one\r\nLine two\r\n\r\nLine three\rLine four\r\n- Bullet five\r\n",
    "unicode-separators": "Zoë lives in Zürich Ünïcödé line "
                          "José \U0001F600 likes \U0001F32E\x85next after NEL\x1cfile sep\x1dgroup sep"
                          "\x1erecord sep\x0bvertical tab\x0cform feed\x1funit sep stays",
    "unicode-bullets": " - NBSP before dash\n　• ideographic space before bullet\n"
                       "１２. Fullwidth digits\n٣) Arabic-indic digit\n- dash then NBSP\n"
                       "-\x1fdash then unit separator\n﻿BOM-led line\n​zero width space line\n",
    "only-whitespace": " \n\t 　 \x85 \x1c ",
    "bom-only": "﻿",
    "fence-only": "```\n```",
    "json-chatgpt": json.dumps(CHATGPT),
    "json-claude": json.dumps(CLAUDE),
    "json-generic": json.dumps({"memories": [{"id": "m1", "content": "Prefers window seats", "created_at": "2026"},
                                             {"content": "ok"}], "summary": "Frequent flyer"}),
    "json-list-of-strings": '["  a  ", "", "Lives in Leeds", "  "]',
    "json-list-mixed": '["Lives in Leeds", 5]',
    "json-invalid": '[{"broken": true,]\n- but this is a bullet',
    "json-empty-object": "{}",
    "json-empty-list": "  []  ",
    "json-proto": '{"__proto__": {"text": "proto text here"}, "constructor": {"note": "constructor note"}, '
                  '"toString": "x", "valueOf": {"text": ["value of text"]}}',
    "json-integer-keys": '{"10": {"text": "ten text"}, "9": {"text": "nine text"}, "title": "My list title", '
                         '"2": "two", "1": {"note": "one note"}}',
    "json-escaped-integer-keys": '{"b": {"text": "bee text"}, "\\u0031": {"text": "escaped one"}}',
    "json-duplicate-keys": '{"text": "first value", "id": 1, "text": "second value"}',
    "json-nan": '[NaN, "Lives in Leeds"]',
    "json-short-strings": '{"note": "\U0001F600\U0001F600", "text": "ab", "fact": "abc", '
                          '"memory": "\U0001F600\U0001F600\U0001F600", "notes": " 　 xy 　 "}',
    "json-nested-text-keys": '{"data": {"text": {"inner": "nested string skipped", "deep": ["list item kept"], '
                             '"deeper": {"x": {"y": "skipped too"}, "z": [{"w": "skipped in list"}]}}}}',
    "json-skip-keys": '{"Text": "Case-insensitive key", "ID": "skipped id", "URL": "https://example.com", '
                      '"Sender": "skipped sender", "body": {"role": "skipped role", "value": "kept value"}}',
    "json-top-level-string-in-list": '[["nested", "strings"], {"note": "a note here"}]',
    "chatgpt-string-create-times": json.dumps([{"mapping": {
        "a": {"message": user_msg("second", "b")}, "b": {"message": user_msg("first", "a")}}}]),
    "chatgpt-list-create-times": json.dumps([{"mapping": {
        "a": {"message": user_msg("second", [1, 2])}, "b": {"message": user_msg("first", [1, 1])},
        "c": {"message": user_msg("zeroth", [1])}}}]),
    "chatgpt-equal-create-times": json.dumps([{"mapping": {
        "x": {"message": user_msg("one", 5)}, "y": {"message": user_msg("two", 5.0)},
        "z": {"message": user_msg("three", 5)}, "w": {"message": user_msg("zero", -1)}}}]),
    "chatgpt-single-dict-create-time": json.dumps([{"mapping": {"a": {"message": user_msg("only one", {"x": 1})}}}]),
    "chatgpt-falsy-nodes": json.dumps([{"mapping": {
        "a": {"message": False}, "b": {"message": user_msg("kept", None)}, "c": 0, "d": "", "e": [], "f": {}}}]),
    "chatgpt-mapping-empty-list": '[{"mapping": []}]',
    "crash-mapping-list": '[{"mapping": [1]}]',
    "crash-mapping-string-node": '[{"mapping": {"a": "string node"}}]',
    "crash-parts-number": json.dumps([{"mapping": {"a": {"message": {
        "author": {"role": "user"}, "content": {"parts": 5}}}}}]),
    "crash-content-string": json.dumps([{"mapping": {"a": {"message": {
        "author": {"role": "user"}, "content": "just a string"}}}}]),
    "crash-author-string": json.dumps([{"mapping": {"a": {"message": {
        "author": "user", "content": {"parts": ["hi"]}}}}}]),
    "crash-profile-list": json.dumps([{"mapping": {"a": {"message": {"content": {
        "content_type": "user_editable_context", "user_profile": ["x"]}}}}}]),
    "crash-mixed-create-times": json.dumps([{"mapping": {
        "a": {"message": user_msg("x", "2024")}, "b": {"message": user_msg("y", 5)}}}]),
    "crash-two-dict-create-times": json.dumps([{"mapping": {
        "a": {"message": user_msg("x", {"t": 1})}, "b": {"message": user_msg("y", {"t": 2})}}}]),
    "crash-claude-messages-number": '[{"chat_messages": 5}]',
}


# ---------- main ----------

def main():
    os.chdir(REPO)
    os.makedirs(ZIP_DIR, exist_ok=True)
    cases, listings = [], []

    for folder, _dirs, files in sorted(os.walk(SAMPLES)):
        _dirs.sort()
        for name in sorted(files):
            path = f"{folder}/{name}"
            raw = open(path, "rb").read()
            cases.append({"id": f"sample:{path[len(SAMPLES) + 1:]}", "kind": "file", "path": path, "name": name,
                          "expect": run(lambda: extract_file(name, raw), summarise=path in SUMMARISE)})
            if name.endswith(".zip"):
                listings.append(zip_listing(path, raw))

    for zip_name, made in synthetic_zips().items():
        raw, without_skipped = made if isinstance(made, tuple) else (made, None)
        name = f"{zip_name}.zip"
        path = f"{ZIP_DIR}/{name}"
        with open(path, "wb") as f:
            f.write(raw)
        case = {"id": f"zip:{name}", "kind": "file", "path": path, "name": name,
                "expect": run(lambda: extract_file(name, raw))}
        if without_skipped is not None:
            # JavaScript skips members it can't decode; it must match Python on the zip without them.
            case["pythonActual"] = case["expect"]
            case["expect"] = run(lambda: extract_file(name, without_skipped))
        cases.append(case)
        listings.append(zip_listing(path, raw))

    for name, raw in INLINE_FILES.items():
        cases.append({"id": f"file:{name or '(no name)'}", "kind": "file", "name": name,
                      "base64": base64.b64encode(raw).decode(), "expect": run(lambda: extract_file(name, raw))})

    for label, text in TEXTS.items():
        cases.append({"id": f"text:{label}", "kind": "text", "text": text, "expect": run(lambda: extract_text(text))})

    fixture = {
        "generatedBy": "scripts/web_fixtures_extract.py",
        "python": sys.version.split()[0],
        "constants": {"MAX_MEMBER_BYTES": MAX_MEMBER_BYTES, "MAX_TOTAL_BYTES": MAX_TOTAL_BYTES},
        "segmentsSha256": "sha256 of UTF-8 '\\x00'.join(source + '\\x01' + text)",
        "cases": cases,
        "zipListings": listings,
    }
    with open(f"{FIXTURES}/extract.json", "w", encoding="utf-8") as f:
        json.dump(fixture, f, ensure_ascii=False, indent=1)
        f.write("\n")
    errors = sum("error" in c["expect"] for c in cases)
    print(f"{len(cases)} cases ({errors} errors), {len(listings)} zip listings -> {FIXTURES}/extract.json")


if __name__ == "__main__":
    main()
