"""The scanner website's API: upload, poll, get a report; errors and limits."""

import io
import json
import time
import zipfile

import pytest
from fastapi.testclient import TestClient

import api.scanner as scanner_api


@pytest.fixture
def client():
    return TestClient(scanner_api.app)


def wait_for(client, job_id, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        response = client.get(f"/api/scan/{job_id}")
        body = response.json()
        if body.get("status") in ("done", "error"):
            return response
        time.sleep(0.05)
    raise AssertionError("scan did not finish")


def test_home_page_and_security_headers(client):
    response = client.get("/")
    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]
    assert "default-src 'self'" in response.headers["content-security-policy"]
    assert response.headers["referrer-policy"] == "no-referrer"


def test_config_reports_local_for_loopback(client):
    assert client.get("/api/config").json()["local"] is False  # TestClient host is "testserver"
    local = TestClient(scanner_api.app, base_url="http://127.0.0.1:8077")
    assert local.get("/api/config").json()["local"] is True


def test_paste_scan_returns_report_once(client):
    response = client.post("/api/scan", data={"text": "My name is Priya Natarajan, call me on +1 415 555 0134."})
    assert response.status_code == 202
    job_id = response.json()["jobId"]
    done = wait_for(client, job_id)
    body = done.json()
    assert body["status"] == "done"
    rows = {r["key"]: r for r in body["report"]["categories"]}
    assert rows["phones"]["count"] == 1
    assert "Priya" not in json.dumps(body)
    assert done.headers["cache-control"] == "no-store"
    assert client.get(f"/api/scan/{job_id}").status_code == 404  # handed out once


def test_file_upload_zip_export(client):
    conversations = [{"chat_messages": [{"sender": "human", "text": "Email me at kai@example.org"}]}]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("conversations.json", json.dumps(conversations))
    response = client.post("/api/scan", files={"file": ("data.zip", buf.getvalue(), "application/zip")})
    body = wait_for(client, response.json()["jobId"]).json()
    assert body["report"]["source"]["format"] == "claude_export"
    assert {r["key"]: r for r in body["report"]["categories"]}["emails"]["count"] == 1


def test_unreadable_file_reports_friendly_error(client):
    response = client.post("/api/scan", files={"file": ("conversations.json", b"{nope", "application/json")})
    result = wait_for(client, response.json()["jobId"])
    assert result.status_code == 422
    assert "isn't valid JSON" in result.json()["message"]


def test_missing_input_and_oversized_upload(client, monkeypatch):
    assert client.post("/api/scan", data={"text": "  "}).status_code == 422
    monkeypatch.setattr(scanner_api, "MAX_UPLOAD_BYTES", 10)
    response = client.post("/api/scan", files={"file": ("m.txt", b"x" * 50, "text/plain")})
    assert response.status_code == 413


def test_unknown_job(client):
    assert client.get("/api/scan/does-not-exist").status_code == 404


def test_schema_v2_and_secrets_masked(client):
    text = "I have asthma. Key AKIAIOSFODNN7EXAMPLE"
    body = wait_for(client, client.post("/api/scan", data={"text": text}).json()["jobId"]).json()
    report = body["report"]
    assert report["schemaVersion"] == 2
    assert "findings" in report
    blob = json.dumps(report)
    assert "AKIAIOSFODNN7EXAMPLE" not in blob
    assert "asthma" not in blob
    kinds = {f["kind"] for f in report["findings"]}
    assert "aws_access_key" in kinds
    assert "health" in kinds


def test_legacy_report_strip(client, monkeypatch):
    monkeypatch.setenv("TMI_LEGACY_REPORT", "1")
    body = wait_for(client, client.post("/api/scan", data={"text": "hello"}).json()["jobId"]).json()
    report = body["report"]
    assert "score" in report and "categories" in report
    for key in ("schemaVersion", "findings", "bands", "domainMatrix", "readouts", "coverage"):
        assert key not in report, key


def test_local_app_serves_the_shared_report_view(client):
    """The v2 report view and its stylesheets exist once, in web/; the local app serves them from there."""
    for path, kind in [
        ("/static/lib/report-view.js", "javascript"),
        ("/static/lib/analysis-prompt.js", "javascript"),
        ("/static/matrix.css", "text/css"),
        ("/static/howto-extras.css", "text/css"),
        ("/static/styles.css", "text/css"),
        ("/static/app.js", "javascript"),
    ]:
        response = client.get(path)
        assert response.status_code == 200, path
        assert kind in response.headers["content-type"], path
