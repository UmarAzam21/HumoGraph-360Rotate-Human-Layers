from app.api.deps import get_stt_service
from app.schemas.stt import TranscriptionResponse


class FakeSTT:
    def __init__(self):
        self.calls = []

    async def transcribe(self, audio, filename, content_type, options):
        self.calls.append((filename, options))
        return TranscriptionResponse(
            text="hi", language="english", duration=1.0, model=options.model, confidence=0.9, segments=[]
        )


def test_health(client):
    r = client.get("/api/v1/health")
    assert r.status_code == 200
    assert r.json()["groq_configured"] is True


def test_index_served(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "Voice Agent" in r.text


def test_transcribe_uses_content_type_for_blob_filename(client):
    fake = FakeSTT()
    client.app.dependency_overrides[get_stt_service] = lambda: fake
    r = client.post(
        "/api/v1/stt/transcribe",
        files={"file": ("blob", b"x" * 4096, "audio/webm;codecs=opus")},
        data={"language": "en", "prompt": "  Groq  "},
    )
    assert r.status_code == 200, r.text
    filename, options = fake.calls[0]
    assert filename == "audio.webm"
    assert options.model == "whisper-large-v3"
    assert options.language == "en"
    assert options.prompt == "Groq"


def test_transcribe_rejects_unsupported_format(client):
    client.app.dependency_overrides[get_stt_service] = FakeSTT
    r = client.post("/api/v1/stt/transcribe", files={"file": ("notes.txt", b"x" * 4096, "text/plain")})
    assert r.status_code == 415
    assert r.json()["error"]["code"] == "unsupported_media"


def test_transcribe_rejects_tiny_audio(client):
    client.app.dependency_overrides[get_stt_service] = FakeSTT
    r = client.post("/api/v1/stt/transcribe", files={"file": ("a.wav", b"x" * 10, "audio/wav")})
    assert r.status_code == 400


def test_transcribe_rejects_oversized_audio(client, settings):
    settings.max_upload_mb = 1
    client.app.dependency_overrides[get_stt_service] = FakeSTT
    r = client.post("/api/v1/stt/transcribe", files={"file": ("a.wav", b"x" * (1024 * 1024 + 1), "audio/wav")})
    assert r.status_code == 413


def test_tts_prepare(client):
    r = client.post("/api/v1/tts/prepare", json={"text": "Growth was 50% & rising.", "language": "en-US"})
    assert r.status_code == 200
    assert r.json()["normalized_text"] == "Growth was 50 percent and rising."
