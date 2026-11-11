import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)


class AppError(Exception):
    """Base error. Subclasses set an HTTP status and a stable machine-readable code."""

    status_code: int = 500
    code: str = "internal_error"

    def __init__(self, message: str, *, status_code: int | None = None, code: str | None = None):
        super().__init__(message)
        self.message = message
        if status_code is not None:
            self.status_code = status_code
        if code is not None:
            self.code = code


class InvalidInputError(AppError):
    status_code = 400
    code = "invalid_input"


class UnsupportedMediaError(AppError):
    status_code = 415
    code = "unsupported_media"


class PayloadTooLargeError(AppError):
    status_code = 413
    code = "payload_too_large"


class ConfigurationError(AppError):
    status_code = 500
    code = "configuration_error"


class UpstreamServiceError(AppError):
    status_code = 502
    code = "upstream_error"


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def handle_app_error(_: Request, exc: AppError) -> JSONResponse:
        if exc.status_code >= 500:
            logger.error("%s: %s", exc.code, exc.message)
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": exc.code, "message": exc.message}},
        )
