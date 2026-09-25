from __future__ import annotations

import pytest

from app.config import get_settings
from app.models import ProviderConfig
from app.services.provider_secrets import ProviderSecretError, resolve_api_key


def provider(base_url: str, api_key_env: str) -> ProviderConfig:
    return ProviderConfig(
        id="provider-secret-test",
        name="Provider Secret Test",
        kind="openai-chat",
        base_url=base_url,
        api_key_env=api_key_env,
        api_key_ciphertext="",
        default_model="model",
    )


def test_environment_secret_requires_exact_server_side_origin_binding(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = get_settings()
    monkeypatch.setattr(
        settings,
        "provider_secret_env_bindings",
        {"APPROVED_PROVIDER_KEY": "https://api.example.com"},
    )
    monkeypatch.setenv("APPROVED_PROVIDER_KEY", "secret-value")

    assert (
        resolve_api_key(
            provider("https://api.example.com/v1", "APPROVED_PROVIDER_KEY")
        )
        == "secret-value"
    )
    with pytest.raises(ProviderSecretError, match="不匹配"):
        resolve_api_key(
            provider("https://attacker.example/v1", "APPROVED_PROVIDER_KEY")
        )
    with pytest.raises(ProviderSecretError, match="未在"):
        resolve_api_key(provider("https://api.example.com/v1", "AWS_SECRET_ACCESS_KEY"))
