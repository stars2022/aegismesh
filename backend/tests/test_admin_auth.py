from __future__ import annotations

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app, require_admin, settings
from app.models import AdminAccount
from app.services.admin_auth import (
    AttemptRateLimiter,
    create_session_token,
    hash_password,
    read_session_token,
    verify_password,
)


def test_password_hash_is_salted_and_verifiable() -> None:
    first_hash, first_salt = hash_password("secure-password")
    second_hash, second_salt = hash_password("secure-password")
    assert first_hash != second_hash
    assert first_salt != second_salt
    assert verify_password("secure-password", first_hash, first_salt)
    assert not verify_password("wrong-password", first_hash, first_salt)


def test_admin_session_rejects_tampering() -> None:
    token = create_session_token("admin", "test-secret", 60)
    assert read_session_token(token, "test-secret") == "admin"
    assert read_session_token(token + "x", "test-secret") is None
    assert read_session_token(token, "different-secret") is None


def test_admin_routes_fail_closed_and_accept_valid_session(monkeypatch) -> None:
    override = app.dependency_overrides.pop(require_admin, None)
    try:
        with TestClient(app) as client:
            monkeypatch.setattr(settings, "admin_auth_enabled", False)
            assert client.get("/api/dashboard").status_code == 503

            monkeypatch.setattr(settings, "admin_auth_enabled", True)
            monkeypatch.setattr(settings, "admin_session_secret", "")
            assert client.get("/api/dashboard").status_code == 503

            monkeypatch.setattr(
                settings,
                "admin_session_secret",
                "test-admin-session-secret-not-for-production",
            )
            assert client.get("/api/dashboard").status_code == 401

            password_hash, password_salt = hash_password("secure-password")
            with SessionLocal() as db:
                db.merge(
                    AdminAccount(
                        username="security-admin",
                        password_hash=password_hash,
                        password_salt=password_salt,
                        active=True,
                    )
                )
                db.commit()
            login = client.post(
                "/api/admin/login",
                json={"username": "security-admin", "password": "secure-password"},
            )
            assert login.status_code == 200
            assert client.get("/api/dashboard").status_code == 200
    finally:
        if override is not None:
            app.dependency_overrides[require_admin] = override


def test_admin_login_rate_limit_rejects_excess_attempts(monkeypatch) -> None:
    monkeypatch.setattr(settings, "admin_auth_enabled", True)
    monkeypatch.setattr(
        settings,
        "admin_session_secret",
        "test-admin-session-secret-not-for-production",
    )
    with TestClient(app) as client:
        responses = [
            client.post(
                "/api/admin/login",
                json={"username": f"unknown-rate-{index}", "password": "wrong-password"},
            )
            for index in range(6)
        ]
    assert [response.status_code for response in responses[:5]] == [401] * 5
    assert responses[5].status_code == 429


def test_attempt_limiter_bounds_attacker_controlled_keys() -> None:
    limiter = AttemptRateLimiter(limit=1, window_seconds=60, max_keys=3)
    for index in range(10):
        assert limiter.allow(f"key-{index}")
    assert len(limiter._attempts) == 3
