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


def found(text, kind):
    return [(h.value, h.confidence) for h in detect(text) if h.kind == kind]


def test_children_as_memories_put_it():
    assert found("my kids start school in May", "children")
    assert found("I have two kids", "children")
    assert found("lazy-eye treatment for my then three-year-old.", "children") == [("my then three-year-old", "medium")]
    assert found("my 6-month-old is teething", "children")
    assert found("my three year old's nursery", "children")
    assert found("Daughter is Mia, who loves drawing.", "children") == [("Daughter", "medium")]
    assert found("my daughter is Mia", "children") == [("my daughter", "medium")]  # one hit, not two
    assert not found("selling my 10-year-old car", "children")
    assert not found("my 30-year-old flat", "children")
    assert not found("Jess's son is Leo", "children")
    assert not found("the son is unwell", "children")


def test_health_words_and_cues():
    assert found("I've asked about my own anxiety", "health") == [("anxiety", "medium")]
    assert found("I was diagnosed with a deep vein thrombosis", "health") == [("thrombosis", "medium")]
    for text in ("feeling depressed", "a febrile seizure", "epilepsy", "treatment for a lazy eye", "lazy-eye drops"):
        assert found(text, "health"), text
    for text in ("cabin fever", "two glasses of wine"):  # left out on purpose: idioms and tableware
        assert not found(text, "health"), text


def test_immigration_terms():
    assert found("my Niederlassungserlaubnis came through", "immigration") == [("Niederlassungserlaubnis", "medium")]
    for text in ("a settlement permit", "permanent residence", "a permanent resident", "my green card",
                 "indefinite leave to remain", "my student visa", "the visa application", "visa sponsorship",
                 "proof of my right to work in the UK"):
        assert found(text, "immigration"), text
    # The card brand, and the right to work from home, are not immigration.
    for text in ("paid with my Visa card", "my Visa ending 4242", "a Visa Business card", "my Visa expires in May",
                 "the right to work from home", "a right to work remotely"):
        assert not found(text, "immigration"), text


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


def test_current_key_shapes_and_password_phrasing():
    assert "api_token" in kinds("my key is sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7cDe0fGh3iJk6")
    assert "api_token" in kinds("token sk-ant-api03-Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7cDe0fGh3iJk6-xyz")
    assert "api_token" not in kinds("see the sk-learn-model-selection-guide-pages")
    found = [h for h in detect("My password is Hunter2-Summer!") if h.kind == "password_cue"]
    assert found and found[0].value == "Hunter2-Summer!"
    assert "password_cue" not in kinds("my password is incorrect.")
    assert "password_cue" not in kinds("Topspin: forehand drills today")


def test_signed_urls_need_a_signing_parameter():
    assert "tokenized_url" not in kinds("Try https://lightroom.adobe.com/presets/cinematic-film-look-collection")
    assert "tokenized_url" not in kinds(
        "See https://support.google.com/accounts/answer/41078?topic=reset_password_and_recovery")
    assert "tokenized_url" in kinds("https://accounts.example.net/reset?token=AbC123dEf456GhI789jKl012")


def test_streets_and_employers_need_proper_names():
    assert "street_address" not in kinds("We drove 5 hours down the coast road")
    assert "street_address" not in kinds("Looking for a 2 bedroom flat")
    assert "street_address" in kinds("I live at 221B Baker Street, London NW1 6XE")
    assert "employer" not in kinds("I joined a gym last week")
    assert "employer" not in kinds("I work at home on Fridays")
    assert "employer" in kinds("I joined Contoso Health in May")


def test_unclosed_fence_is_still_scanned_for_secrets():
    slices = fence_slices("Here is my config:\n```\nOPENAI=sk-Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z\n")
    assert slices and "api_token" in kinds(slices[0], in_code_block=True)


def test_profile_and_os_paths():
    assert "profile_url" in kinds("https://www.linkedin.com/in/priya-n")
    assert "profile_url" not in kinds("linkedin.com/company/acme")
    assert "profile_url" in kinds("https://github.com/octocat")
    assert "profile_url" not in kinds("https://github.com/features")
    assert "profile_url" not in kinds("https://github.com/octocat/repo")
    assert "os_username" not in kinds("/Users/Public/Documents")