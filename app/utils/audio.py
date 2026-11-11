from pathlib import PurePath

from app.core.exceptions import InvalidInputError, PayloadTooLargeError, UnsupportedMediaError

# Formats accepted by Groq's transcription endpoint.
SUPPORTED_EXTENSIONS = {"flac", "mp3", "mp4", "mpeg", "mpga", "m4a", "ogg", "opus", "wav", "webm"}

_CONTENT_TYPE_TO_EXT = {
    "audio/flac": "flac",
    "audio/x-flac": "flac",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/ogg": "ogg",
    "audio/opus": "opus",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/webm": "webm",
    "video/webm": "webm",
    "video/mp4": "mp4",
}

# Anything smaller than this cannot contain meaningful speech; Whisper tends to hallucinate on it.
MIN_AUDIO_BYTES = 1024


def resolve_audio_filename(filename: str | None, content_type: str | None) -> str:
    """Return a filename with a supported extension, or raise UnsupportedMediaError.

    Groq infers the container format from the extension, so a correct one matters.
    Browsers often send blobs named "blob" with the type only in the content-type header.
    """
    ext = PurePath(filename or "").suffix.lower().lstrip(".")
    if ext in SUPPORTED_EXTENSIONS:
        return PurePath(filename).name

    base_type = (content_type or "").split(";")[0].strip().lower()
    ext = _CONTENT_TYPE_TO_EXT.get(base_type)
    if ext:
        return f"audio.{ext}"

    raise UnsupportedMediaError(
        f"Unsupported audio format (filename={filename!r}, content_type={content_type!r}). "
        f"Supported: {', '.join(sorted(SUPPORTED_EXTENSIONS))}."
    )


def validate_audio_size(size: int, max_bytes: int) -> None:
    if size < MIN_AUDIO_BYTES:
        raise InvalidInputError("Audio is empty or too short to transcribe.")
    if size > max_bytes:
        raise PayloadTooLargeError(f"Audio exceeds the {max_bytes // (1024 * 1024)} MB limit.")
