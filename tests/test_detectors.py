import re

import pytest

from lib.scanner.detectors import detect, fence_slices
from lib.scanner.scan import CODE_BLOCK_RE


def kinds(text, **kw):
    return [h.kind for h in detect(text, **kw)]


def test_secrets_hits():
    assert "private_key" in kinds("-----BEGIN RSA PRIVATE KEY-----")
    assert "aws_access_key" in kinds("key: AKIAIOSFODNN7EXAMPLE here")
    assert "api_token" in kinds("ghp_abcdefghijklmnopqrst")
    assert "tokenized_url" in kinds("https://s3.amazonaws.com/x?X-Amz-Signature=abc123def456ghi789jkl012mno345")


def test_secrets_misses():
    assert "password_cue" not in kinds("my password is stored in 1Password")
    assert "api_token" not in kinds("sk-example123456789012345")
    assert "password_cue" not in kinds("password: secret")
    assert "payment_card" not in kinds("pin 4242")


def test_jwt_medium():
    jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
    hits = detect(jwt)
    assert hits and hits[0].kind == "jwt" and hits[0].confidence == "medium"


def test_fence_pem_only_in_fence_pass():
    fenced = "```\n-----BEGIN OPENSSH PRIVATE KEY-----\n```"
    slices = fence_slices(fenced)
    assert slices and "private_key" in kinds(slices[0], in_code_block=True)
    blanked = CODE_BLOCK_RE.sub(" ", fenced)
    assert "private_key" not in kinds(blanked, in_code_block=False)


def test_asthma_not_in_fence_for_health():
    fenced = "```\nI have asthma\n```"
    assert "health" not in kinds(fenced, in_code_block=True)


def test_payment_card_and_ssn():
    assert "payment_card" in kinds("card: 4242 4242 4242 4242")
    assert "payment_card" not in kinds("03.05.2026")
    assert "payment_card" not in kinds("4111111111111112")
    assert "national_id" in kinds("SSN 123-45-6789")
    assert "national_id" not in kinds("123-45-6789")


def test_health_and_location():
    hits = detect("I have asthma")
    assert hits and hits[0].kind == "health" and hits[0].confidence == "medium"
    assert "health" in kinds("asthma") and detect("asthma")[0].confidence == "low"
    assert "religion" not in kinds("Christian")
    assert "religion" in kinds("I'm Christian")
    assert "children" in kinds("my daughter Zoë")
    assert "street_address" in kinds("flat 4B at 18 Elm Grove")
    assert "street_address" not in kinds("Austin")
    assert "gps" in kinds("37.77490, -122.41940")
    assert "gps" not in kinds("0.00000, 0.00000")


def test_employer_and_compensation():
    hits = detect("I work at Acme")
    kinds_found = [h.kind for h in hits]
    assert "employer" in kinds_found
    emp = next(h for h in hits if h.kind == "employer")
    assert emp.harm == "H5" and emp.confidence == "medium"
    assert "Acme" in emp.value
    assert "employer" not in kinds("Please join the standup at noon")

    pay = detect("salary is $120,000")
    assert any(h.kind == "compensation" and h.harm == "H5" for h in pay)
    amount = next(h for h in pay if h.kind == "compensation")
    assert "120,000" in amount.value or "120000" in amount.value.replace(",", "")
    assert "compensation" not in kinds("The laptop costs $120,000")


def test_profile_and_os_paths():
    assert "profile_url" in kinds("https://www.linkedin.com/in/priya-n")
    assert "profile_url" not in kinds("linkedin.com/company/acme")
    assert "profile_url" in kinds("https://github.com/octocat")
    assert "profile_url" not in kinds("https://github.com/features")
    assert "profile_url" not in kinds("https://github.com/octocat/repo")
    assert "os_username" not in kinds("/Users/Public/Documents")