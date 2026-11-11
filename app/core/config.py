from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings, loaded from environment variables / .env file."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "Humograph Voice Agent"
    debug: bool = False
    cors_origins: list[str] = []

    # --- Groq ---
    groq_api_key: str = ""
    groq_base_url: str = "https://api.groq.com/openai/v1"
    groq_timeout_seconds: float = 120.0
    groq_max_retries: int = 3

    # --- Speech-to-text (Groq Whisper) ---
    # whisper-large-v3 is the most accurate model Groq hosts (turbo trades accuracy for speed).
    stt_model: str = "whisper-large-v3"
    stt_allowed_models: list[str] = ["whisper-large-v3", "whisper-large-v3-turbo"]
    stt_default_language: str | None = None
    max_upload_mb: int = 25

    # Whisper's own decoding thresholds, used to detect hallucinated / silent segments.
    no_speech_threshold: float = 0.6
    logprob_threshold: float = -1.0
    compression_ratio_threshold: float = 2.4

    # --- Text-to-speech ---
    tts_max_chars: int = 20_000
    # Neural voice (Groq Orpheus). Requires accepting the model terms once in the Groq console.
    tts_model: str = "canopylabs/orpheus-v1-english"
    tts_voices: list[str] = ["troy", "austin", "daniel", "autumn", "diana", "hannah"]
    tts_default_voice: str = "troy"
    # Orpheus accepts at most 200 characters per request, so text is synthesized in chunks.
    tts_neural_chunk_chars: int = 200
    # Browsers (notably Chrome) cut off long utterances, so browser speech is chunked too.
    tts_browser_chunk_chars: int = 220

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024


@lru_cache
def get_settings() -> Settings:
    return Settings()
