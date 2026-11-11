import re
import unicodedata

from app.core.config import Settings
from app.core.exceptions import InvalidInputError
from app.schemas.tts import SpeechEngine, SpeechPrepareResponse
from app.services.groq_client import GroqClient

# Split after sentence-ending punctuation (Latin, CJK, Urdu/Arabic, Devanagari).
_SENTENCE_END = re.compile(r"(?<=[.!?。！？۔؟।])\s+")
_CLAUSE_END = re.compile(r"(?<=[,;:،])\s+")
_WHITESPACE = re.compile(r"\s+")
_URL = re.compile(r"https?://\S+")

# English-only symbol expansions so the browser voice pronounces them correctly.
_EN_SYMBOLS = [
    (re.compile(r"(\d)\s*%"), r"\1 percent"),
    (re.compile(r"\s&\s"), " and "),
    (re.compile(r"(\d)\s*°C\b"), r"\1 degrees Celsius"),
    (re.compile(r"(\d)\s*°F\b"), r"\1 degrees Fahrenheit"),
    (re.compile(r"\be\.g\.", re.IGNORECASE), "for example"),
    (re.compile(r"\bi\.e\.", re.IGNORECASE), "that is"),
    (re.compile(r"\betc\.", re.IGNORECASE), "et cetera"),
    (re.compile(r"\bvs\.?\s", re.IGNORECASE), "versus "),
]


class TextToSpeechService:
    """Prepares text for speech and synthesizes it with Groq's neural voice.

    Text is normalized (so symbols/abbreviations are pronounced properly) and split
    into sentence-aligned chunks: the neural model has a per-request character limit,
    and browsers truncate or stall on long utterances. The client then requests audio
    chunk by chunk (neural) or speaks each chunk with speechSynthesis (browser).
    """

    def __init__(self, settings: Settings, groq: GroqClient | None = None):
        self._settings = settings
        self._groq = groq

    def prepare(self, text: str, language: str, engine: SpeechEngine = "neural") -> SpeechPrepareResponse:
        if len(text) > self._settings.tts_max_chars:
            raise InvalidInputError(f"Text exceeds {self._settings.tts_max_chars} characters.")

        normalized = self.normalize(text, language)
        if not normalized:
            raise InvalidInputError("Text contains nothing speakable.")

        max_chars = (
            self._settings.tts_neural_chunk_chars if engine == "neural" else self._settings.tts_browser_chunk_chars
        )
        return SpeechPrepareResponse(
            language=language,
            normalized_text=normalized,
            chunks=self.chunk(normalized, max_chars),
        )

    async def synthesize(self, text: str, voice: str | None) -> bytes:
        """Return WAV audio for a single chunk of text."""
        s = self._settings
        voice = voice or s.tts_default_voice
        if voice not in s.tts_voices:
            raise InvalidInputError(f"Unknown voice {voice!r}. Choose one of: {s.tts_voices}.")
        text = text.strip()
        if not text:
            raise InvalidInputError("Text is empty.")
        if len(text) > s.tts_neural_chunk_chars:
            raise InvalidInputError(
                f"Text exceeds {s.tts_neural_chunk_chars} characters; split it with /tts/prepare first."
            )

        response = await self._groq.post(
            "/audio/speech",
            json={"model": s.tts_model, "voice": voice, "input": text, "response_format": "wav"},
        )
        return response.content

    @staticmethod
    def normalize(text: str, language: str) -> str:
        text = unicodedata.normalize("NFKC", text)
        text = _URL.sub(" link ", text)
        # Markdown emphasis / headings / code markers are read aloud literally otherwise.
        text = re.sub(r"[*_`#>]+", " ", text)
        if language.lower().startswith("en"):
            for pattern, replacement in _EN_SYMBOLS:
                text = pattern.sub(replacement, text)
        return _WHITESPACE.sub(" ", text).strip()

    @staticmethod
    def chunk(text: str, max_chars: int) -> list[str]:
        chunks: list[str] = []
        current = ""

        def push(piece: str) -> None:
            nonlocal current
            candidate = f"{current} {piece}".strip()
            if len(candidate) <= max_chars:
                current = candidate
                return
            if current:
                chunks.append(current)
            current = piece

        for sentence in _SENTENCE_END.split(text):
            if len(sentence) <= max_chars:
                push(sentence)
                continue
            # Sentence too long: start it in a fresh chunk (keeps pauses natural),
            # then break at clause boundaries, then at word boundaries.
            if current:
                chunks.append(current)
                current = ""
            for clause in _CLAUSE_END.split(sentence):
                if len(clause) <= max_chars:
                    push(clause)
                    continue
                for word in clause.split(" "):
                    push(word)

        if current:
            chunks.append(current)
        return chunks
