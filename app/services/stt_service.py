import math
from typing import Any

from app.core.config import Settings
from app.core.exceptions import InvalidInputError
from app.schemas.stt import Segment, TranscriptionOptions, TranscriptionResponse
from app.services.groq_client import GroqClient


class GroqWhisperService:
    """Speech-to-text via Groq's hosted Whisper.

    Accuracy measures:
      * whisper-large-v3 by default (most accurate model available)
      * temperature 0 -> deterministic, highest-likelihood decoding
      * optional language + vocabulary prompt to steer recognition
      * verbose_json segments are used to drop hallucinated text on silence
        and flag low-confidence / repetitive segments for the user
    """

    def __init__(self, groq: GroqClient, settings: Settings):
        self._groq = groq
        self._settings = settings

    async def transcribe(
        self,
        audio: bytes,
        filename: str,
        content_type: str | None,
        options: TranscriptionOptions,
    ) -> TranscriptionResponse:
        if options.model not in self._settings.stt_allowed_models:
            raise InvalidInputError(
                f"Model {options.model!r} is not allowed. Choose one of: {self._settings.stt_allowed_models}."
            )

        data: dict[str, Any] = {
            "model": options.model,
            "response_format": "verbose_json",
            "temperature": "0",
            "timestamp_granularities[]": "segment",
        }
        if options.language:
            data["language"] = options.language
        if options.prompt:
            data["prompt"] = options.prompt

        files = {"file": (filename, audio, content_type or "application/octet-stream")}
        response = await self._groq.post("/audio/transcriptions", data=data, files=files)
        return self._build_response(response.json(), options.model)

    def _build_response(self, payload: dict[str, Any], model: str) -> TranscriptionResponse:
        s = self._settings
        raw_segments: list[dict[str, Any]] = payload.get("segments") or []
        warnings: list[str] = []

        kept: list[Segment] = []
        dropped = 0
        for raw in raw_segments:
            avg_logprob = float(raw.get("avg_logprob", 0.0))
            no_speech_prob = float(raw.get("no_speech_prob", 0.0))
            compression_ratio = float(raw.get("compression_ratio", 1.0))
            text = (raw.get("text") or "").strip()

            # Same rule Whisper uses internally: likely silence AND low confidence -> hallucination.
            if not text or (no_speech_prob > s.no_speech_threshold and avg_logprob < s.logprob_threshold):
                dropped += 1
                continue

            kept.append(
                Segment(
                    start=float(raw.get("start", 0.0)),
                    end=float(raw.get("end", 0.0)),
                    text=text,
                    confidence=round(math.exp(min(avg_logprob, 0.0)), 4),
                    no_speech_prob=round(no_speech_prob, 4),
                    flagged=avg_logprob < s.logprob_threshold or compression_ratio > s.compression_ratio_threshold,
                )
            )

        if raw_segments:
            text = " ".join(seg.text for seg in kept)
        else:
            text = (payload.get("text") or "").strip()

        if dropped:
            warnings.append(f"Removed {dropped} segment(s) that looked like silence or background noise.")
        flagged = sum(seg.flagged for seg in kept)
        if flagged:
            warnings.append(f"{flagged} segment(s) have low confidence; please review them.")
        if not text:
            warnings.append("No speech was detected.")

        return TranscriptionResponse(
            text=text,
            language=payload.get("language"),
            duration=payload.get("duration"),
            model=model,
            confidence=_weighted_confidence(kept),
            segments=kept,
            warnings=warnings,
        )


def _weighted_confidence(segments: list[Segment]) -> float | None:
    total = sum(max(seg.end - seg.start, 0.0) for seg in segments)
    if not segments:
        return None
    if total <= 0:
        return round(sum(seg.confidence for seg in segments) / len(segments), 4)
    return round(sum(seg.confidence * max(seg.end - seg.start, 0.0) for seg in segments) / total, 4)
