from __future__ import annotations

from sqlalchemy.orm import Session

from app.models import Agent, ProviderConfig
from app.services.database_transfer import export_database, import_database


def test_database_export_and_import_round_trip(db: Session) -> None:
    db.add(Agent(id="exported", aic="aic-exported", name="Exported"))
    db.commit()
    payload = export_database(db)
    db.delete(db.get(Agent, "exported"))
    db.commit()

    counts = import_database(db, payload, "merge")

    assert counts["agents"] == 1
    assert db.get(Agent, "exported").aic == "aic-exported"


def test_provider_import_never_restores_secrets_and_clears_on_origin_change(db: Session) -> None:
    provider = ProviderConfig(
        id="provider-one",
        name="Provider One",
        kind="openai-chat",
        base_url="https://old.example.com/v1",
        api_key_ciphertext="encrypted-secret",
        api_key_env="",
        default_model="model-one",
    )
    db.add(provider)
    db.commit()

    payload = export_database(db)
    exported = payload["tables"]["provider_configs"][0]
    assert "api_key_ciphertext" not in exported
    assert "api_key_env" not in exported

    exported["base_url"] = "https://new.example.com/v1"
    exported["api_key_ciphertext"] = "attacker-supplied"
    exported["api_key_env"] = "AWS_SECRET_ACCESS_KEY"
    import_database(db, payload, "merge")

    updated = db.get(ProviderConfig, "provider-one")
    assert updated is not None
    assert updated.base_url == "https://new.example.com/v1"
    assert updated.api_key_ciphertext == ""
    assert updated.api_key_env == ""
    assert updated.active is False


def test_provider_import_rejects_non_https_origin(db: Session) -> None:
    payload = {
        "format": "aegismesh-database",
        "version": 1,
        "tables": {
            "provider_configs": [
                {
                    "id": "unsafe",
                    "name": "Unsafe",
                    "kind": "openai-chat",
                    "base_url": "http://127.0.0.1:8080/v1",
                    "default_model": "model",
                }
            ]
        },
    }

    import pytest

    with pytest.raises(ValueError, match="HTTPS"):
        import_database(db, payload, "merge")
