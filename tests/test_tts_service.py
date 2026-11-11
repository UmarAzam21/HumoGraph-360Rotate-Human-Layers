import asyncio
import json

import httpx
import pytest

from app.core.exceptions import ConfigurationError, InvalidInputError
from app.services.groq_client import GroqClient
from app.services.tts_service import TextToSpeechService


def make_service(settings, handler):
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return TextToSpeechService(settings, GroqClient(client, settings))


def test_synthesize_sends_orpheus_request(settings):
    captured = {}

    def handler(request):
        captured.update(path=request.url.path, body=json.loads(request.content))
        return httpx.Response(200, content=b"RIFFfakewav", headers={"content-type": "audio/wav"})

    audio = asyncio.run(make_service(settings, handler).synthesize("Hello there.", "diana"))
    assert audio == b"RIFFfakewav"
    assert captured["path"].endswith("/audio/speech")
    assert captured["body"] == {
        "model": "canopylabs/orpheus-v1-english",
        "voice": "diana",
        "input": "Hello there.",
        "response_format": "wav",
    }


def test_synthesize_validates_voice_and_length(settings):
    service = make_service(settings, lambda r: httpx.Response(200))
    with pytest.raises(InvalidInputError, match="voice"):
        asyncio.run(service.synthesize("hi", "nobody"))
    with pytest.raises(InvalidInputError, match="200"):
        asyncio.run(service.synthesize("x" * 201, None))


def test_synthesize_terms_not_accepted(settings):
    error = {"error": {"message": "accept the terms", "code": "model_terms_required"}}
    service = make_service(settings, lambda r: httpx.Response(400, json=error))
    with pytest.raises(ConfigurationError, match="accept the terms"):
        asyncio.run(service.synthesize("hi", None))


def test_prepare_chunk_size_depends_on_engine(settings):
    text = "word " * 100
    service = TextToSpeechService(settings)
    assert max(map(len, service.prepare(text, "en", "neural").chunks)) <= settings.tts_neural_chunk_chars
    assert max(map(len, service.prepare(text, "en", "browser").chunks)) <= settings.tts_browser_chunk_chars


def test_normalize_english_symbols_and_markdown():
    text = "**Note:** e.g. 20°C   is   fine, see https://example.com"
    assert TextToSpeechService.normalize(text, "en-US") == "Note: for example 20 degrees Celsius is fine, see link"


def test_normalize_skips_english_rules_for_other_languages():
    assert TextToSpeechService.normalize("50% & more", "ur-PK") == "50% & more"


def test_chunks_respect_limit_and_sentence_boundaries():
    text = "First sentence. Second sentence! " + ("word " * 100) + "end."
    chunks = TextToSpeechService.chunk(TextToSpeechService.normalize(text, "en"), 60)
    assert all(len(c) <= 60 for c in chunks)
    assert chunks[0] == "First sentence. Second sentence!"
    assert " ".join(chunks).split() == text.split()


def test_prepare_rejects_too_long(settings):
    settings.tts_max_chars = 10
    with pytest.raises(InvalidInputError):
        TextToSpeechService(settings).prepare("x" * 11, "en")


def test_prepare_rejects_unspeakable(settings):
    with pytest.raises(InvalidInputError):
        TextToSpeechService(settings).prepare("*** ###", "en")
