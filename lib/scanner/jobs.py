"""
In-memory scan jobs, processed one at a time by a single worker thread.

A job holds the upload only until the worker has read it; afterwards it holds just the
report (counts and masked examples). Finished jobs are dropped once fetched, and any job
older than JOB_TTL_SECONDS is dropped regardless.
"""

import secrets
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Callable, Dict, Optional

from lib.scanner.extract import ExtractError, Extracted
from lib.scanner.scan import scan

JOB_TTL_SECONDS = 15 * 60
MAX_QUEUED_JOBS = 20


class QueueFull(RuntimeError):
    pass


@dataclass
class Job:
    id: str
    status: str = "queued"  # queued, reading, scanning, done, error
    done: int = 0
    total: int = 0
    report: Optional[dict] = None
    error: Optional[str] = None
    created: float = field(default_factory=time.monotonic)


class JobRunner:
    def __init__(self):
        self._jobs: Dict[str, Job] = {}
        self._lock = threading.Lock()
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="scan")

    def submit(self, read: Callable[[], Extracted]) -> Job:
        self._prune()
        with self._lock:
            active = sum(j.status in ("queued", "reading", "scanning") for j in self._jobs.values())
            if active >= MAX_QUEUED_JOBS:
                raise QueueFull("Too many scans running. Try again in a minute.")
            job = Job(id=secrets.token_urlsafe(16))
            self._jobs[job.id] = job
        self._pool.submit(self._run, job, read)
        return job

    def get(self, job_id: str) -> Optional[Job]:
        self._prune()
        with self._lock:
            job = self._jobs.get(job_id)
            if job and job.status in ("done", "error"):
                del self._jobs[job_id]  # results are handed out once
            return job

    def _run(self, job: Job, read: Callable[[], Extracted]) -> None:
        try:
            job.status = "reading"
            extracted = read()
            read = None  # let the upload bytes go
            job.status = "scanning"

            def progress(done: int, total: int) -> None:
                job.done, job.total = done, total

            job.report = scan(extracted, progress)
            job.status = "done"
        except ExtractError as exc:
            job.error, job.status = str(exc), "error"
        except Exception:
            job.error, job.status = "Something broke while scanning. It's not you, it's us.", "error"

    def _prune(self) -> None:
        cutoff = time.monotonic() - JOB_TTL_SECONDS
        with self._lock:
            for job_id in [k for k, j in self._jobs.items() if j.created < cutoff]:
                del self._jobs[job_id]
