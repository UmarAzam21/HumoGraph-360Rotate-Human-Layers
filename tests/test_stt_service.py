import asyncio

import httpx
import pytest

from app.core.exceptions import ConfigurationError, InvalidInputError, UpstreamServiceError
from app.schemas.stt import TranscriptionOptions
from app.services.groq_client import GroqClient
from app.services.stt_service import GroqWhisperService

GROQ_PAYLOAD = {
    "text": " Hello world. Thank you for watching.",
    "language": "english",
    "duration": 6.0,
    "segments": [
        {"start": 0.0, "end": 3.0, "text": " Hello world.", "avg_logprob": -0.1, "no_speech_prob": 0.01, "compression_ratio": 1.1},
        # Classic Whisper hallucination on trailing silence: high no-speech, low confidence.
        {"start": 3.0, "end": 6.0, "text": " Thank you for watching.", "avg_logprob": -1.5, "no_speech_prob": 0.9, "compression_ratio": 1.0},
    ],
}


def run(coro):
    return asyncio.run(coro)


def make_service(settings, handler):
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return GroqWhisperService(GroqClient(client, settings), settings)


def options(**kw):
    return TranscriptionOptions(model="whisper-large-v3", **kw)


def test_sends_accuracy_params_and_filters_hallucinations(settings):
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = request.content.decode(errors="ignore")
        captured["auth"] = request.headers["authorization"]
        return httpx.Response(200, json=GROQ_PAYLOAD)

    service = make_service(settings, handler)
    result = run(service.transcribe(b"x" * 2048, "a.webm", "audio/webm", options(language="en", prompt="Humograph")))

    body = captured["body"]
    for expected in ("whisper-large-v3", "verbose_json", 'name="temperature"\r\n\r\n0', "Humograph", 'name="language"\r\n\r\nen'):
        assert expected in body
    assert captured["auth"] == "Bearer test-key"

    assert result.text == "Hello world."
    assert len(result.segments) == 1
    assert result.confidence == pytest.approx(0.9048, abs=1e-3)
    assert any("silence" in w for w in result.warnings)


def test_flags_low_confidence_segment(settings):
    payload = {"text": "maybe", "segments": [{"start": 0, "end": 1, "text": "maybe", "avg_logprob": -1.2, "no_speech_prob": 0.1}]}
    service = make_service(settings, lambda r: httpx.Response(200, json=payload))
    result = run(service.transcribe(b"x" * 2048, "a.wav", "audio/wav", options()))
    assert result.segments[0].flagged
    assert any("low confidence" in w for w in result.warnings)


def test_retries_on_rate_limit(settings):
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, headers={"retry-after": "0"}, json={"error": {"message": "slow down"}})
        return httpx.Response(200, json=GROQ_PAYLOAD)

    result = run(make_service(settings, handler).transcribe(b"x" * 2048, "a.wav", None, options()))
    assert calls["n"] == 2
    assert result.text == "Hello world."


def test_client_error_maps_to_invalid_input(settings):
    service = make_service(settings, lambda r: httpx.Response(400, json={"error": {"message": "bad audio"}}))
    with pytest.raises(InvalidInputError, match="bad audio"):
        run(service.transcribe(b"x" * 2048, "a.wav", None, options()))


def test_server_error_after_retries(settings):
    service = make_service(settings, lambda r: httpx.Response(503, json={"error": {"message": "down"}}))
    with pytest.raises(UpstreamServiceError):
        run(service.transcribe(b"x" * 2048, "a.wav", None, options()))


def test_missing_api_key(settings):
    settings.groq_api_key = ""
    service = make_service(settings, lambda r: httpx.Response(200, json=GROQ_PAYLOAD))
    with pytest.raises(ConfigurationError):
        run(service.transcribe(b"x" * 2048, "a.wav", None, options()))


def test_rejects_unknown_model(settings):
    service = make_service(settings, lambda r: httpx.Response(200, json=GROQ_PAYLOAD))
    with pytest.raises(InvalidInputError):
        run(service.transcribe(b"x" * 2048, "a.wav", None, TranscriptionOptions(model="nope")))
