from typing import Literal

from pydantic import BaseModel, Field

SpeechEngine = Literal["neural", "browser"]


class SpeechPrepareRequest(BaseModel):
    text: str = Field(min_length=1)
    # BCP-47 tag (e.g. "en-US"); used for language-aware text normalization.
    language: str = "en-US"
    # Chunk sizes differ: the neural voice has a per-request limit, browsers have their own.
    engine: SpeechEngine = "neural"


class SpeechPrepareResponse(BaseModel):
    language: str
    normalized_text: str
    chunks: list[str]


class SynthesizeRequest(BaseModel):
    # One chunk from /tts/prepare.
    text: str = Field(min_length=1)
    voice: str | None = None


class VoicesResponse(BaseModel):
    model: str
    default_voice: str
    voices: list[str]
