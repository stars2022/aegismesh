from __future__ import annotations

import json
import logging
import time
from urllib.parse import parse_qs, urlparse

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from app.config import get_settings
from app.services import account_providers as providers


@pytest.fixture(scope="module")
def signing_key():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
    return key, {"keys": [{**public, "kid": "fixture", "use": "sig"}]}


def id_token(key, **overrides):
    claims = {"iss": "https://accounts.google.com", "aud": "client", "sub": "official-subject",
              "nonce": "nonce", "iat": int(time.time()), "exp": int(time.time()) + 300}
    claims.update(overrides)
    return jwt.encode(claims, key, algorithm="RS256", headers={"kid": "fixture"})


def test_identity_token_signature_and_claims(signing_key):
    key, keys = signing_key
    def verify(token, jwks=keys):
        return providers.verify_id_token(token, jwks, issuer="https://accounts.google.com", audience="client", nonce="nonce")
    assert verify(id_token(key))["sub"] == "official-subject"
    for claims in [{"iss": "https://evil.example"}, {"aud": "other"}, {"nonce": "wrong"}, {"exp": 1},
                   {"iat": int(time.time()) + 3600}, {"aud": ["client", "other"]}, {"azp": "other"}]:
        with pytest.raises((ValueError, jwt.PyJWTError)):
            verify(id_token(key, **claims))
    assert verify(id_token(key, aud=["client", "other"], azp="client"))["sub"] == "official-subject"
    for missing in ["iss", "aud", "sub", "exp", "iat", "nonce"]:
        claims = jwt.decode(id_token(key), options={"verify_signature": False})
        claims.pop(missing)
        with pytest.raises(jwt.PyJWTError):
            verify(jwt.encode(claims, key, algorithm="RS256", headers={"kid": "fixture"}))
    with pytest.raises(ValueError):
        verify(id_token(key), {"keys": []})
    with pytest.raises(ValueError):
        verify(jwt.encode({"sub": "forged"}, "not-a-key" * 8, algorithm="HS256", headers={"kid": "fixture"}))
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    with pytest.raises(jwt.InvalidSignatureError):
        verify(id_token(other))


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["google", "apple", "huawei", "wechat", "qq"])
async def test_provider_contracts_without_external_requests(name, monkeypatch, signing_key):
    key, keys = signing_key
    cfg = get_settings()
    options = {"enabled": True, "client_id": "client", "client_secret": "server-only-secret"}
    if name == "huawei":
        options.update(issuer="https://accounts.huawei.com", jwks_uri="https://oauth-login.cloud.huawei.com/fixture-keys")
    monkeypatch.setattr(cfg, "accounts_enabled", True)
    monkeypatch.setattr(cfg, "account_public_origin", "https://demo.example")
    monkeypatch.setattr(cfg, "account_oauth", {name: options})
    spec = providers.PROVIDERS[name]
    seen = []
    def transport(request):
        seen.append(request)
        assert request.url.scheme == "https"
        if str(request.url).split("?")[0] == spec.token:
            form = dict(request.url.params) if name in {"wechat", "qq"} else {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            assert form["code"] == "auth-code" and form["grant_type"] == "authorization_code"
            assert form["secret" if name == "wechat" else "client_secret"] == "server-only-secret"
            assert request.method == ("GET" if name in {"wechat", "qq"} else "POST")
            if name == "google":
                assert form["code_verifier"] == "verifier"
            if name in {"wechat", "qq"}:
                return httpx.Response(200, json={"access_token": "private-access", "openid": "official-subject"})
            return httpx.Response(200, json={"id_token": id_token(key, iss=options.get("issuer") or spec.issuer)})
        if request.url.path.endswith("userinfo"):
            assert request.url.params["access_token"] == "private-access"
            return httpx.Response(200, json={"openid": "official-subject", "nickname": "昵称"})
        if request.url.path.endswith("/me"):
            assert request.url.params["fmt"] == "json"
            return httpx.Response(200, json={"client_id": "client", "openid": "official-subject"})
        return httpx.Response(200, json=keys)
    original = httpx.AsyncClient
    monkeypatch.setattr(providers.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(transport), **kwargs))
    result = await providers.exchange_identity(name, "auth-code", "nonce", "verifier")
    assert result["subject"] == "official-subject" and result["namespace"] == "client"
    assert len(seen) == 2 and "private-access" not in json.dumps(result)
    auth = providers.authorization_url(name, "state", "nonce", "verifier")
    params = parse_qs(urlparse(auth).query)
    assert params["state"] == ["state"] and "secret" not in auth
    assert params["redirect_uri"] == [f"https://demo.example/api/account/oauth/{name}/callback"]


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["qq", "wechat"])
async def test_provider_rejects_mismatched_identity(name, monkeypatch):
    cfg = get_settings()
    monkeypatch.setattr(cfg, "accounts_enabled", True)
    monkeypatch.setattr(cfg, "account_public_origin", "https://demo.example")
    monkeypatch.setattr(cfg, "account_oauth", {name: {"enabled": True, "client_id": "client", "client_secret": "secret"}})
    def transport(request):
        if request.url.path.endswith("token"):
            return httpx.Response(200, json={"access_token": "token", "openid": "first"})
        return httpx.Response(200, json={"openid": "another", "client_id": "wrong-app"})
    original = httpx.AsyncClient
    monkeypatch.setattr(providers.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(transport), **kwargs))
    with pytest.raises(ValueError):
        await providers.exchange_identity(name, "code", "nonce", "verifier")


def test_provider_configuration_and_logs_do_not_expose_credentials(monkeypatch):
    cfg = get_settings()
    monkeypatch.setattr(cfg, "accounts_enabled", True)
    monkeypatch.setattr(cfg, "account_public_origin", "https://demo.example")
    monkeypatch.setattr(cfg, "account_oauth", {"huawei": {"enabled": True, "client_id": "client", "client_secret": "secret",
                                                          "issuer": "https://accounts.huawei.com", "jwks_uri": "https://evil.example/keys"}})
    with pytest.raises(providers.ProviderUnavailable):
        providers.provider_config("huawei")
    assert not any(p["available"] for p in providers.provider_statuses())
    assert "secret" not in json.dumps(providers.provider_statuses())
    monkeypatch.setattr(cfg, "account_oauth", {"google": {"enabled": "false", "client_id": "client", "client_secret": "secret"}})
    with pytest.raises(providers.ProviderUnavailable):
        providers.provider_config("google")
    for message, args in [("GET https://api.weixin.qq.com/sns/oauth2/access_token?secret=SUPERSECRET&code=CODE", ()),
                          ('%s - "GET %s HTTP/1.1" 303', ("127.0.0.1", "/api/account/oauth/google/callback?state=STATE&code=CODE"))]:
        record = logging.LogRecord("httpx", logging.INFO, "", 1, message, args, None)
        providers.AuthLogRedactor().filter(record)
        assert all(secret not in record.getMessage() for secret in ["SUPERSECRET", "STATE", "CODE"])


def test_access_log_redaction_preserves_uvicorn_formatter_arguments():
    from uvicorn.logging import AccessFormatter
    record = logging.LogRecord(
        "uvicorn.access", logging.INFO, "", 1, '%s - "%s %s HTTP/%s" %d',
        ("127.0.0.1:1234", "GET", "/api/account/oauth/google/callback?code=SUPERSECRET&state=STATE", "1.1", 303), None,
    )
    assert providers.AuthLogRedactor().filter(record)
    assert len(record.args) == 5 and record.args[-1] == 303
    output = AccessFormatter("%(client_addr)s %(request_line)s %(status_code)s").format(record)
    assert "303" in output and "GET /api/account/oauth/google/callback" in output
    assert "SUPERSECRET" not in output and "STATE" not in output


def test_ordinary_access_log_is_not_flattened():
    from uvicorn.logging import AccessFormatter
    args = ("127.0.0.1:1234", "GET", "/api/health", "1.1", 200)
    record = logging.LogRecord("uvicorn.access", logging.INFO, "", 1, '%s - "%s %s HTTP/%s" %d', args, None)
    providers.AuthLogRedactor().filter(record)
    assert record.args == args
    assert "200" in AccessFormatter("%(request_line)s %(status_code)s").format(record)
