from fastapi import Depends, Request

from app.core.config import Settings, get_settings
from app.services.groq_client import GroqClient
from app.services.stt_service import GroqWhisperService
from app.services.tts_service import TextToSpeechService


def get_groq_client(request: Request, settings: Settings = Depends(get_settings)) -> GroqClient:
    # The shared HTTP client is created once in the app lifespan (connection pooling).
    return GroqClient(request.app.state.http_client, settings)


def get_stt_service(
    groq: GroqClient = Depends(get_groq_client), settings: Settings = Depends(get_settings)
) -> GroqWhisperService:
    return GroqWhisperService(groq, settings)


def get_tts_service(
    groq: GroqClient = Depends(get_groq_client), settings: Settings = Depends(get_settings)
) -> TextToSpeechService:
    return TextToSpeechService(settings, groq)
