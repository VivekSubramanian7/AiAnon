"""
Run the anonymization pipeline over extracted text and build the report.

Text is packed into chunks below the pipeline's 8,000-character limit. Fenced code blocks
are skipped (numbers in code look like phone numbers). Nothing is stored: the report only
holds counts and masked examples.
"""

import re
import threading
import time
from dataclasses import dataclass
from typing import Callable, List, Optional, Tuple

from lib.pipeline.index import run_pipeline
from lib.scanner.detectors import detect, fence_slices
from lib.scanner.extract import Extracted, Segment
from lib.scanner.findings import (
    assemble,
    band_counts,
    build_coverage,
    build_readouts,
    cap_findings,
    promote,
)
from lib.scanner.report import Aggregator, context_before, drop_nested_dates, exposure_score, level_for
from lib.types import PipelineInput

MAX_CHUNK_CHARS = 7500
MAX_SCAN_CHARS = 5_000_000  # beyond this the rest of the export is skipped and the report says so
CODE_BLOCK_RE = re.compile(r"```.*?(```|$)", re.S)

# The pipeline's stages keep per-call counters in module-level objects: one call at a time.
PIPELINE_LOCK = threading.Lock()

ProgressFn = Callable[[int, int], None]

FORMAT_LABELS = {
    "chatgpt_export": "ChatGPT export",
    "claude_export": "Claude export",
    "json": "JSON file",
    "text": "pasted memories",
}


@dataclass
class Chunk:
    text: str
    spans: List[Tuple[int, int, int]]  # (start, end, segment index) inside text


def _split_long(text: str, limit: int) -> List[str]:
    """Split text longer than limit at line breaks, then spaces, then hard."""
    pieces, current = [], ""
    for line in text.splitlines(keepends=True):
        while len(line) > limit:  # one line longer than a whole chunk
            if current:
                pieces.append(current)
                current = ""
            cut = line.rfind(" ", 0, limit)
            if cut <= limit // 2:
                cut = limit
            pieces.append(line[:cut])
            line = line[cut:]
        if len(current) + len(line) > limit:
            pieces.append(current)
            current = ""
        current += line
    if current:
        pieces.append(current)
    return [p for p in pieces if p.strip()]


def build_chunks(texts: List[str], limit: int = MAX_CHUNK_CHARS) -> List[Chunk]:
    chunks: List[Chunk] = []
    buf, spans = "", []
    sep = "\n\n"
    for index, text in enumerate(texts):
        if not text.strip():
            continue
        for piece in (_split_long(text, limit) if len(text) > limit else [text]):
            needed = len(piece) + (len(sep) if buf else 0)
            if buf and len(buf) + needed > limit:
                chunks.append(Chunk(buf, spans))
                buf, spans = "", []
            if buf:
                buf += sep
            spans.append((len(buf), len(buf) + len(piece), index))
            buf += piece
    if buf:
        chunks.append(Chunk(buf, spans))
    return chunks


def _segments_containing(chunk: Chunk, value: str) -> set:
    found = set()
    start = chunk.text.find(value)
    while start >= 0:
        for s, e, index in chunk.spans:
            if s <= start < e:
                found.add(index)
        start = chunk.text.find(value, start + 1)
    return found


def scan(
    extracted: Extracted,
    progress: Optional[ProgressFn] = None,
    envelope: Optional[dict] = None,
    char_budget: int = MAX_SCAN_CHARS,
) -> dict:
    started = time.perf_counter()
    code_blocks = 0
    blanked_texts: List[str] = []
    original_pieces: List[str] = []
    chars_skipped = 0
    budget = char_budget
    truncated = False
    total_prepared = 0

    for segment in extracted.segments:
        raw = segment.text
        total_prepared += len(raw)
        if budget <= 0:
            truncated = True
            chars_skipped += len(raw)
            continue
        piece = raw
        if len(piece) > budget:
            truncated = True
            chars_skipped += len(piece) - budget
            piece = piece[:budget]
        budget -= len(piece)
        original_pieces.append(piece)
        blanked, n = CODE_BLOCK_RE.subn(" ", piece)
        code_blocks += n
        blanked_texts.append(blanked.strip())

    chunks = build_chunks(blanked_texts)
    agg = Aggregator()
    segments_with_finds: set = set()
    failed_chunks = 0
    detector_hits = []

    for i, chunk in enumerate(chunks):
        try:
            with PIPELINE_LOCK:
                result = run_pipeline(PipelineInput(rawText=chunk.text, blocklist="", sessionId="scan"))
        except Exception:
            failed_chunks += 1
        else:
            for token in drop_nested_dates(result.tokens):
                original = token.original or ""
                context = context_before(chunk.text, original) if token.type in ("DOB", "PHONE") else ""
                if agg.add(token.type, original, context, confidence=token.confidence):
                    segments_with_finds |= _segments_containing(chunk, original)
        if progress:
            progress(i + 1, len(chunks))

    for piece in original_pieces:
        for slice_text in fence_slices(piece):
            detector_hits.extend(detect(slice_text, in_code_block=True))
    for piece in blanked_texts:
        if piece:
            detector_hits.extend(detect(piece, in_code_block=False))

    env = envelope or {}
    promoted = promote(agg)
    all_findings = assemble(promoted, detector_hits, env.get("findings"))
    bands = band_counts(all_findings)
    findings = cap_findings(all_findings)
    for i, row in enumerate(findings, start=1):
        row["id"] = f"f-{i:02d}"

    totals = agg.totals()
    score = exposure_score(totals["directUnique"], totals["contextUnique"])
    scanned = len([t for t in blanked_texts if t])
    characters_scanned = sum(len(t) for t in blanked_texts)
    source = {
        "format": extracted.format,
        "label": FORMAT_LABELS.get(extracted.format, extracted.format),
        "conversations": extracted.conversations,
        "piecesScanned": scanned,
        "piecesWithFinds": len(segments_with_finds),
        "kinds": _kinds(extracted.segments),
        "assistantMessagesSkipped": extracted.assistant_messages_skipped,
        "codeBlocksSkipped": code_blocks,
        "charactersScanned": characters_scanned,
        "charactersSkipped": chars_skipped,
        "truncated": truncated,
        "failedChunks": failed_chunks,
    }
    lower = build_coverage(source, env).get("lowerBound", False)
    readouts = build_readouts(all_findings, score, level_for(score), lower)
    coverage = build_coverage(source, env)

    return {
        "schemaVersion": 2,
        "source": source,
        "totals": totals,
        "score": score,
        "level": level_for(score),
        "categories": agg.categories(),
        "findings": findings,
        "bands": bands,
        "readouts": readouts,
        "coverage": coverage,
        "elapsedMs": round((time.perf_counter() - started) * 1000),
    }


def _kinds(segments: List[Segment]) -> dict:
    kinds: dict = {}
    for s in segments:
        kinds[s.source] = kinds.get(s.source, 0) + 1
    return kinds