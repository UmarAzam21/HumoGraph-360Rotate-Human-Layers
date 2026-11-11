from fastapi import APIRouter, Depends, File, Form, UploadFile

from app.api.deps import get_stt_service
from app.core.config import Settings, get_settings
from app.core.exceptions import PayloadTooLargeError
from app.schemas.stt import TranscriptionOptions, TranscriptionResponse
from app.services.stt_service import GroqWhisperService
from app.utils.audio import resolve_audio_filename, validate_audio_size

router = APIRouter(prefix="/stt", tags=["speech-to-text"])

_READ_CHUNK = 1024 * 1024


@router.post("/transcribe", response_model=TranscriptionResponse)
async def transcribe(
    file: UploadFile = File(..., description="Audio file (webm, wav, mp3, m4a, ogg, flac, ...)"),
    language: str | None = Form(None, description="ISO-639-1 code, e.g. 'en'. Improves accuracy."),
    prompt: str | None = Form(None, description="Vocabulary / context hint (names, jargon)."),
    model: str | None = Form(None, description="Override the Whisper model."),
    settings: Settings = Depends(get_settings),
    service: GroqWhisperService = Depends(get_stt_service),
) -> TranscriptionResponse:
    filename = resolve_audio_filename(file.filename, file.content_type)
    audio = await _read_limited(file, settings.max_upload_bytes)
    validate_audio_size(len(audio), settings.max_upload_bytes)

    options = TranscriptionOptions(
        model=model or settings.stt_model,
        language=(language or settings.stt_default_language or None),
        prompt=(prompt or "").strip() or None,
    )
    return await service.transcribe(audio, filename, file.content_type, options)


async def _read_limited(file: UploadFile, max_bytes: int) -> bytes:
    """Read the upload without ever holding more than max_bytes (+1 chunk) in memory."""
    buffer = bytearray()
    while chunk := await file.read(_READ_CHUNK):
        buffer.extend(chunk)
        if len(buffer) > max_bytes:
            raise PayloadTooLargeError(f"Audio exceeds the {max_bytes // (1024 * 1024)} MB limit.")
    return bytes(buffer)
