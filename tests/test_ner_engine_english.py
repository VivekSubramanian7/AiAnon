"""English-only NER: one shared spaCy model, Presidio types mapped to ours, no crashes."""

import re
import typing

import pytest

from lib.pipeline import ner_engine as ne
from lib.pipeline.index import run_pipeline
from lib.types import PipelineInput, TokenType

ALLOWED_TYPES = set(typing.get_args(TokenType))
PLACEHOLDER_RE = re.compile(r"\[[A-Z]+_\d+\]")

# Records from the Gretel PII test set that crashed the pipeline before the fix:
# Presidio read part of an IP address as PHONE_NUMBER, a type RedactionToken did not allow.
PRESIDIO_PHONE_CASES = [
    "Customer acknowledges that data processing will occur on instances located in the region "
    "specified by IP address 141.78.93.120. Customer's medical record number is G9710320, and "
    "credit card number 3727-4303-5247-738 will be used for billing.",
    "The system architecture diagram, created on 1963-09-07, connects components with IPs "
    "145.181.112.93 and 167.94.10.100. Employee IDs P9779023 and J-175274-E are associated "
    "with these components.",
]


def test_models_loaded():
    assert ne.MODELS_LOADED


def test_one_english_model_is_shared_with_presidio():
    assert ne.nlp_en is ne.analyzer.nlp_engine.nlp["en"]
    assert f"{ne.nlp_en.meta['lang']}_{ne.nlp_en.meta['name']}" == ne.SPACY_MODEL == "en_core_web_md"
    assert not hasattr(ne, "nlp_de")
    assert ne.analyzer.supported_languages == ["en"]


def test_presidio_results_use_our_token_types():
    entities = ne.ner_engine.run_presidio(
        "Ana Lopez emailed ana.lopez@example.org from Madrid and called +1 415 555 0134."
    )
    assert entities
    assert {e["type"] for e in entities} <= ALLOWED_TYPES


@pytest.mark.parametrize("text", PRESIDIO_PHONE_CASES)
def test_presidio_only_phone_does_not_crash(text):
    result = run_pipeline(PipelineInput(rawText=text, blocklist="", sessionId="t"))
    assert {t.type for t in result.tokens} <= ALLOWED_TYPES


@pytest.mark.parametrize("text", PRESIDIO_PHONE_CASES)
def test_placeholders_stay_unique_across_stages(text):
    result = run_pipeline(PipelineInput(rawText=text, blocklist="", sessionId="t"))
    values = [t.value for t in result.tokens if PLACEHOLDER_RE.fullmatch(t.value)]
    assert len(values) == len(set(values)), values


def test_ner_numbering_continues_after_existing_placeholders():
    engine = ne.NEREngine()
    engine.seed_counters_from_text("Call [PHONE_01] or [PHONE_02], mail [EMAIL_01]. I'm [AGE_30s].")
    assert engine.get_next_token("PHONE") == "[PHONE_03]"
    assert engine.get_next_token("EMAIL") == "[EMAIL_02]"
    assert engine.get_next_token("PERSON") == "[PERSON_01]"
