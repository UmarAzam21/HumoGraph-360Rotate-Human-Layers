import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings, get_settings
from app.main import create_app


@pytest.fixture
def settings() -> Settings:
    return Settings(_env_file=None, groq_api_key="test-key", groq_max_retries=1)


@pytest.fixture
def client(settings: Settings):
    app = create_app()
    app.dependency_overrides[get_settings] = lambda: settings
    with TestClient(app) as c:
        yield c
