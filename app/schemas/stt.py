from pydantic import BaseModel, Field


class TranscriptionOptions(BaseModel):
    """Options that influence transcription accuracy."""

    model: str
    # ISO-639-1 code (e.g. "en", "ur"). Setting it avoids language mis-detection.
    language: str | None = None
    # Context / vocabulary hint: names, jargon, spelling style. Max ~224 tokens.
    prompt: str | None = Field(default=None, max_length=1000)


class Segment(BaseModel):
    start: float
    end: float
    text: str
    confidence: float = Field(description="0-1, derived from the segment's average log-probability")
    no_speech_prob: float
    flagged: bool = Field(description="True if the segment looks unreliable (low confidence or repetitive)")


class TranscriptionResponse(BaseModel):
    text: str
    language: str | None
    duration: float | None
    model: str
    confidence: float | None = Field(description="Duration-weighted confidence over kept segments")
    segments: list[Segment]
    warnings: list[str] = []
