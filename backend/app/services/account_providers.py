"""Server-side OAuth adapters. No request is sent unless explicitly configured/enabled."""
from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import re
from dataclasses import dataclass
from urllib.parse import urlencode, urlparse

import httpx
import jwt

from ..config import get_settings


class AuthLogRedactor(logging.Filter):
    def filter(self, record):
        # HTTP clients and ASGI access logs can otherwise retain OAuth GET secrets.
        from .observability import safe_url
        message = record.getMessage()
        message = re.sub(r"https?://[^\s\"<>]+", lambda m: safe_url(m.group(0)), message)
        message = re.sub(r"(/api/account/oauth/[^/\s]+/callback)\?[^\s\"]+", r"\1?[redacted]", message)
        record.msg, record.args = message, ()
        return True


for _logger_name in ("httpx", "uvicorn.access"):
    logging.getLogger(_logger_name).addFilter(AuthLogRedactor())


@dataclass(frozen=True)
class Provider:
    label: str
    authorize: str
    token: str
    scope: str
    issuer: str = ""
    jwks: str = ""
    pkce: bool = False


PROVIDERS = {
    "google": Provider("Google", "https://accounts.google.com/o/oauth2/v2/auth",
                       "https://oauth2.googleapis.com/token", "openid email profile",
                       "https://accounts.google.com", "https://www.googleapis.com/oauth2/v3/certs", True),
    "apple": Provider("Apple", "https://appleid.apple.com/auth/authorize",
                      "https://appleid.apple.com/auth/token", "email name",
                      "https://appleid.apple.com", "https://appleid.apple.com/auth/keys"),
    # Huawei's tenant/region issuer and signing-key endpoint must be explicitly configured.
    "huawei": Provider("华为", "https://oauth-login.cloud.huawei.com/oauth2/v3/authorize",
                       "https://oauth-login.cloud.huawei.com/oauth2/v3/token", "openid profile email"),
    "wechat": Provider("微信", "https://open.weixin.qq.com/connect/qrconnect",
                       "https://api.weixin.qq.com/sns/oauth2/access_token", "snsapi_login"),
    "qq": Provider("QQ", "https://graph.qq.com/oauth2.0/authorize",
                   "https://graph.qq.com/oauth2.0/token", "get_user_info"),
}


class ProviderUnavailable(ValueError):
    pass


def provider_config(name: str) -> dict:
    cfg = get_settings()
    options = cfg.account_oauth.get(name, {})
    if name not in PROVIDERS or not cfg.accounts_enabled or options.get("enabled") is not True:
        raise ProviderUnavailable("此登录方式尚未启用")
    if not all(options.get(k) for k in ("client_id", "client_secret")):
        raise ProviderUnavailable("此登录方式尚未配置完成")
    origin = cfg.account_public_origin.rstrip("/")
    parsed = urlparse(origin)
    if parsed.scheme != "https" or not parsed.netloc or parsed.path or parsed.query or parsed.fragment:
        raise ProviderUnavailable("第三方登录需要配置 HTTPS 公开源地址")
    if name == "huawei":
        if not options.get("issuer") or not options.get("jwks_uri"):
            raise ProviderUnavailable("华为登录还需确认 issuer 和 JWKS 配置")
        keys = urlparse(str(options["jwks_uri"]))
        if keys.scheme != "https" or not (keys.hostname or "").endswith(".huawei.com"):
            raise ProviderUnavailable("华为 JWKS 必须使用官方 HTTPS 地址")
    return {**options, "redirect_uri": origin + f"/api/account/oauth/{name}/callback"}


def provider_statuses() -> list[dict]:
    result = []
    for name, spec in PROVIDERS.items():
        try:
            provider_config(name)
            available, reason = True, ""
        except ProviderUnavailable as exc:
            available, reason = False, str(exc)
        result.append({"id": name, "label": spec.label, "available": available, "reason": reason})
    return result


def authorization_url(name: str, state: str, nonce: str, verifier: str) -> str:
    options, spec = provider_config(name), PROVIDERS[name]
    params = {"response_type": "code", "client_id": options["client_id"],
              "redirect_uri": options["redirect_uri"], "scope": spec.scope, "state": state}
    if name == "wechat":
        params["appid"] = params.pop("client_id")
    if name in {"google", "apple", "huawei"}:
        params["nonce"] = nonce
    if name == "apple":
        params["response_mode"] = "form_post"
    if spec.pkce:
        params.update(code_challenge=base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("="),
                      code_challenge_method="S256")
    return spec.authorize + "?" + urlencode(params)


def verify_id_token(token: str, keys: dict, *, issuer: str, audience: str, nonce: str) -> dict:
    header = jwt.get_unverified_header(token)
    if header.get("alg") != "RS256" or not header.get("kid"):
        raise ValueError("不支持的身份令牌签名")
    key = next((k for k in keys.get("keys", []) if k.get("kid") == header["kid"]), None)
    if not key:
        raise ValueError("身份令牌签名密钥不匹配")
    claims = jwt.decode(token, jwt.PyJWK.from_dict(key).key, algorithms=["RS256"],
                        issuer=issuer, audience=audience,
                        options={"require": ["iss", "aud", "sub", "exp", "iat", "nonce"]})
    if not hmac.compare_digest(str(claims["nonce"]), nonce):
        raise ValueError("身份令牌 nonce 不匹配")
    if claims.get("azp", audience) != audience or (isinstance(claims["aud"], list) and len(claims["aud"]) > 1 and claims.get("azp") != audience):
        raise ValueError("身份令牌授权客户端不匹配")
    return claims


async def exchange_identity(name: str, code: str, nonce: str, verifier: str) -> dict:
    options, spec = provider_config(name), PROVIDERS[name]
    async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
        async def call(method, url, **kwargs):
            response = await client.request(method, url, **kwargs)
            response.raise_for_status()
            if len(response.content) > 1_000_000:
                raise ValueError("身份服务响应过大")
            data = response.json()
            if not isinstance(data, dict) or data.get("error") or data.get("errcode") or data.get("ret"):
                raise ValueError("身份服务拒绝授权")
            return data

        form = {"grant_type": "authorization_code", "code": code,
                "client_id": options["client_id"], "client_secret": options["client_secret"],
                "redirect_uri": options["redirect_uri"]}
        if spec.pkce:
            form["code_verifier"] = verifier
        if name == "wechat":
            # This provider specifies GET; never log the response or credential URL.
            tokens = await call("GET", spec.token, params={"appid": options["client_id"],
                                "secret": options["client_secret"], "code": code, "grant_type": "authorization_code"})
            profile = await call("GET", "https://api.weixin.qq.com/sns/userinfo",
                                 params={"access_token": tokens["access_token"], "openid": tokens["openid"]})
            if profile.get("openid") != tokens.get("openid"):
                raise ValueError("微信身份不匹配")
            subject, display = profile["openid"], profile.get("nickname")
        elif name == "qq":
            tokens = await call("GET", spec.token, params={**form, "fmt": "json"})
            profile = await call("GET", "https://graph.qq.com/oauth2.0/me",
                                 params={"access_token": tokens["access_token"], "fmt": "json"})
            if str(profile.get("client_id")) != str(options["client_id"]):
                raise ValueError("QQ 授权客户端不匹配")
            subject, display = profile["openid"], "QQ 用户"
        else:
            tokens = await call("POST", spec.token, data=form)
            keys = await call("GET", str(options.get("jwks_uri") or spec.jwks))
            claims = verify_id_token(tokens["id_token"], keys,
                                     issuer=str(options.get("issuer") or spec.issuer),
                                     audience=str(options["client_id"]), nonce=nonce)
            subject, display = claims["sub"], claims.get("name") or spec.label + " 用户"
        if not isinstance(subject, str) or not subject or len(subject) > 255:
            raise ValueError("身份服务未返回有效用户标识")
        # Neither provider-reported email nor client-supplied profile can link accounts.
        return {"provider": name, "namespace": str(options["client_id"]), "subject": subject,
                "display_name": str(display or spec.label + " 用户")[:80]}
