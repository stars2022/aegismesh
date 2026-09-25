from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import secrets
import threading
import time
from collections import OrderedDict, deque


COOKIE_NAME = "aegismesh_admin"
DEMO_COOKIE_NAME = "aegismesh_demo"


class PasswordVerificationBusy(RuntimeError):
    pass


class AttemptRateLimiter:
    def __init__(
        self,
        limit: int = 5,
        window_seconds: int = 60,
        max_keys: int = 10_000,
    ) -> None:
        self.limit = limit
        self.window_seconds = window_seconds
        self.max_keys = max_keys
        self._attempts: OrderedDict[str, deque[float]] = OrderedDict()
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        with self._lock:
            attempts = self._attempts.get(key)
            if attempts is None:
                if len(self._attempts) >= self.max_keys:
                    self._attempts.popitem(last=False)
                attempts = deque()
                self._attempts[key] = attempts
            else:
                self._attempts.move_to_end(key)
            while attempts and now - attempts[0] >= self.window_seconds:
                attempts.popleft()
            if len(attempts) >= self.limit:
                return False
            attempts.append(now)
            return True

    def reset(self, key: str) -> None:
        with self._lock:
            self._attempts.pop(key, None)


_PASSWORD_VERIFY_SLOTS = threading.BoundedSemaphore(value=2)


def hash_password(password: str, salt_hex: str | None = None) -> tuple[str, str]:
    if len(password) < 8:
        raise ValueError("管理员密码至少需要 8 个字符")
    salt = bytes.fromhex(salt_hex) if salt_hex else secrets.token_bytes(16)
    derived = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1)
    return derived.hex(), salt.hex()


_DUMMY_PASSWORD_HASH, _DUMMY_PASSWORD_SALT = hash_password(
    "aegismesh-dummy-password-verification-only"
)


def verify_password(password: str, expected_hash: str, salt_hex: str) -> bool:
    if not _PASSWORD_VERIFY_SLOTS.acquire(blocking=False):
        raise PasswordVerificationBusy("密码校验服务繁忙")
    try:
        actual, _ = hash_password(password, salt_hex)
        return hmac.compare_digest(actual, expected_hash)
    finally:
        _PASSWORD_VERIFY_SLOTS.release()


def verify_password_or_dummy(
    password: str,
    expected_hash: str | None,
    salt_hex: str | None,
) -> bool:
    return verify_password(
        password,
        expected_hash or _DUMMY_PASSWORD_HASH,
        salt_hex or _DUMMY_PASSWORD_SALT,
    )


def create_session_token(username: str, secret: str, lifetime_seconds: int) -> str:
    if not secret:
        raise RuntimeError("ADMIN_SESSION_SECRET 未配置")
    payload = json.dumps(
        {"username": username, "expires": int(time.time()) + lifetime_seconds},
        separators=(",", ":"),
    ).encode("utf-8")
    encoded = base64.urlsafe_b64encode(payload).rstrip(b"=")
    signature = hmac.new(secret.encode("utf-8"), encoded, hashlib.sha256).hexdigest().encode()
    return f"{encoded.decode()}.{signature.decode()}"


def read_session_token(token: str, secret: str) -> str | None:
    if not token or not secret or "." not in token:
        return None
    encoded, signature = token.rsplit(".", 1)
    expected = hmac.new(secret.encode("utf-8"), encoded.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        return None
    try:
        padding = "=" * (-len(encoded) % 4)
        payload = json.loads(base64.urlsafe_b64decode(encoded + padding))
        if int(payload["expires"]) < int(time.time()):
            return None
        username = payload["username"]
        return username if isinstance(username, str) else None
    except (ValueError, KeyError, TypeError, json.JSONDecodeError, binascii.Error):
        return None
