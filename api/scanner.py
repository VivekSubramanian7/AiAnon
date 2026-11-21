"""
TMI: the memory scanner website.

Upload a chatbot memory or chat export, get a count of the personal information in it.
Runs without a database, login or LLM. Start it with:

    uvicorn api.scanner:app --port 8077

Nothing uploaded is written to disk or logged; reports hold counts and masked examples only.
"""

import ipaddress
import os
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from lib.scanner.envelope import prepare_upload
from lib.scanner.extract import extract_file, extract_text
from lib.scanner.jobs import JobRunner, QueueFull

MAX_UPLOAD_MB = int(os.getenv("SCANNER_MAX_UPLOAD_MB", "100"))
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 2**20
MAX_PASTE_CHARS = 2_000_000

SITE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "scanner")
ANALYSIS_PROMPT_JS = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web", "lib", "analysis-prompt.js"
)

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; "
    "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
)

app = FastAPI(title="TMI memory scanner", docs_url=None, redoc_url=None, openapi_url=None)
jobs = JobRunner()


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["Content-Security-Policy"] = CSP
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


def _is_local(request: Request) -> bool:
    host = (request.url.hostname or "").lower()
    if host in ("localhost",) or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


@app.get("/")
def home():
    return FileResponse(os.path.join(SITE_DIR, "index.html"))


@app.get("/static/analysis-prompt.js")
def analysis_prompt_js():
    return FileResponse(ANALYSIS_PROMPT_JS, media_type="application/javascript")


app.mount("/static", StaticFiles(directory=SITE_DIR), name="static")


@app.get("/api/config")
def config(request: Request):
    return {"local": _is_local(request), "maxUploadMb": MAX_UPLOAD_MB}


async def _read_capped(upload: UploadFile) -> bytes:
    data = bytearray()
    while chunk := await upload.read(1024 * 1024):
        data += chunk
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, f"That file is over {MAX_UPLOAD_MB} MB. Even we have limits.")
    return bytes(data)


@app.post("/api/scan", status_code=202)
async def start_scan(file: Optional[UploadFile] = File(None), text: Optional[str] = Form(None)):
    if file is not None and file.filename:
        raw = await _read_capped(file)
        name = file.filename
        if name.lower().endswith(".zip"):
            read = lambda: prepare_upload(name, raw)  # noqa: E731
        else:
            read = lambda: extract_file(name, raw)  # noqa: E731
    elif text and text.strip():
        if len(text) > MAX_PASTE_CHARS:
            raise HTTPException(413, "That's a lot of pasting. Upload it as a file instead.")
        read = lambda: extract_text(text)  # noqa: E731
    else:
        raise HTTPException(422, "Give us a file or some text. We can't judge thin air.")
    try:
        job = jobs.submit(read)
    except QueueFull as exc:
        raise HTTPException(503, str(exc))
    return {"jobId": job.id}


@app.get("/api/scan/{job_id}")
def scan_status(job_id: str):
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "That scan doesn't exist (or already self-destructed).")
    if job.status == "error":
        return JSONResponse({"status": "error", "message": job.error}, status_code=422)
    body = {"status": job.status, "done": job.done, "total": job.total}
    if job.status == "done":
        report = dict(job.report)
        # Delete TMI_LEGACY_REPORT after the web UI ships; do not extend the strip list without a failing API test.
        if os.getenv("TMI_LEGACY_REPORT") == "1":
            for key in ("schemaVersion", "findings", "bands", "readouts", "coverage"):
                report.pop(key, None)
        body["report"] = report
    return body
