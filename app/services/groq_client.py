import asyncio
import logging
from typing import Any

import httpx

from app.core.config import Settings
from app.core.exceptions import ConfigurationError, InvalidInputError, UpstreamServiceError

logger = logging.getLogger(__name__)

_RETRYABLE_STATUS = {408, 409, 429, 500, 502, 503, 504}


class GroqClient:
    """Thin wrapper over Groq's OpenAI-compatible API: auth, retries with backoff, error mapping."""

    def __init__(self, client: httpx.AsyncClient, settings: Settings):
        self._client = client
        self._settings = settings

    async def post(self, path: str, **kwargs: Any) -> httpx.Response:
        """POST to `path` (e.g. "/audio/speech"); returns the 200 response or raises an AppError."""
        if not self._settings.groq_api_key:
            raise ConfigurationError("GROQ_API_KEY is not configured.")

        url = f"{self._settings.groq_base_url}{path}"
        headers = {"Authorization": f"Bearer {self._settings.groq_api_key}"}
        attempts = self._settings.groq_max_retries + 1

        for attempt in range(1, attempts + 1):
            try:
                response = await self._client.post(
                    url, headers=headers, timeout=self._settings.groq_timeout_seconds, **kwargs
                )
            except httpx.TransportError as exc:
                if attempt == attempts:
                    raise UpstreamServiceError(f"Could not reach Groq: {exc}") from exc
                await self._backoff(attempt, None)
                continue

            if response.status_code == 200:
                return response

            if response.status_code in _RETRYABLE_STATUS and attempt < attempts:
                logger.warning("Groq returned %s (attempt %d/%d), retrying", response.status_code, attempt, attempts)
                await self._backoff(attempt, response.headers.get("retry-after"))
                continue

            raise self._error_from_response(response)

        raise UpstreamServiceError("Groq request failed after retries.")  # pragma: no cover

    @staticmethod
    async def _backoff(attempt: int, retry_after: str | None) -> None:
        try:
            delay = float(retry_after) if retry_after else 0.0
        except ValueError:
            delay = 0.0
        await asyncio.sleep(min(max(delay, 0.5 * 2 ** (attempt - 1)), 10.0))

    @staticmethod
    def _error_from_response(response: httpx.Response) -> Exception:
        try:
            error = response.json().get("error", {})
        except ValueError:
            error = {}
        message = error.get("message") or response.text

        if error.get("code") == "model_terms_required":
            return ConfigurationError(message, code="model_terms_required")
        # Client errors (bad audio, bad params) are the caller's problem; surface them as 400.
        if 400 <= response.status_code < 500 and response.status_code not in (401, 403, 429):
            return InvalidInputError(f"Groq rejected the request: {message}")
        return UpstreamServiceError(f"Groq error {response.status_code}: {message}")
