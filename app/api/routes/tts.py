from fastapi import APIRouter, Depends, Response

from app.api.deps import get_tts_service
from app.core.config import Settings, get_settings
from app.schemas.tts import SpeechPrepareRequest, SpeechPrepareResponse, SynthesizeRequest, VoicesResponse
from app.services.tts_service import TextToSpeechService

router = APIRouter(prefix="/tts", tags=["text-to-speech"])


@router.get("/voices", response_model=VoicesResponse)
async def list_voices(settings: Settings = Depends(get_settings)) -> VoicesResponse:
    return VoicesResponse(model=settings.tts_model, default_voice=settings.tts_default_voice, voices=settings.tts_voices)


@router.post("/prepare", response_model=SpeechPrepareResponse)
async def prepare_speech(
    body: SpeechPrepareRequest,
    service: TextToSpeechService = Depends(get_tts_service),
) -> SpeechPrepareResponse:
    """Normalize text and split it into chunks sized for the chosen engine."""
    return service.prepare(body.text, body.language, body.engine)


@router.post(
    "/synthesize",
    response_class=Response,
    responses={200: {"content": {"audio/wav": {}}, "description": "WAV audio for one chunk"}},
)
async def synthesize_speech(
    body: SynthesizeRequest,
    service: TextToSpeechService = Depends(get_tts_service),
) -> Response:
    """Synthesize one chunk (≤200 chars) with the neural voice."""
    audio = await service.synthesize(body.text, body.voice)
    return Response(content=audio, media_type="audio/wav")
