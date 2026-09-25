from __future__ import annotations

import os
from urllib.parse import urlsplit

from cryptography.fernet import Fernet, InvalidToken

from ..config import get_settings
from ..models import ProviderConfig


class ProviderSecretError(RuntimeError):
    pass


def _fernet() -> Fernet:
    key = get_settings().provider_encryption_key.strip()
    if not key:
        secret = get_settings().admin_session_secret.strip()
        if secret:
            import base64
            import hashlib
            derived = base64.urlsafe_b64encode(hashlib.sha256(secret.encode()).digest())
            return Fernet(derived)
        raise ProviderSecretError("请先配置 PROVIDER_ENCRYPTION_KEY")
    try:
        return Fernet(key.encode())
    except ValueError as exc:
        raise ProviderSecretError("PROVIDER_ENCRYPTION_KEY 格式无效") from exc


def encrypt_api_key(value: str) -> str:
    return _fernet().encrypt(value.encode()).decode()


def _origin(value: str) -> str:
    parts = urlsplit(value.strip())
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
        raise ProviderSecretError("供应商密钥只能绑定到有效的 HTTPS 服务地址")
    port = parts.port
    authority = parts.hostname.lower()
    if port and port != 443:
        authority = f"{authority}:{port}"
    return f"https://{authority}"


def validate_secret_reference(api_key_env: str, base_url: str) -> None:
    if not api_key_env:
        return
    binding = get_settings().provider_secret_env_bindings.get(api_key_env, "").strip()
    if not binding:
        raise ProviderSecretError("环境密钥引用未在 PROVIDER_SECRET_ENV_BINDINGS 中获准")
    if _origin(binding) != _origin(base_url):
        raise ProviderSecretError("环境密钥引用与供应商服务地址不匹配")


def resolve_api_key(provider: ProviderConfig) -> str:
    if provider.api_key_env:
        validate_secret_reference(provider.api_key_env, provider.base_url)
        value = os.getenv(provider.api_key_env, "").strip()
        if value:
            return value
    if not provider.api_key_ciphertext:
        raise ProviderSecretError("供应商密钥尚未配置")
    try:
        return _fernet().decrypt(provider.api_key_ciphertext.encode()).decode()
    except InvalidToken as exc:
        raise ProviderSecretError("供应商密钥无法解密") from exc
