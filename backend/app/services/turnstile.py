"""Single-use Cloudflare verification; no challenge tokens in logs or storage."""
import httpx
from fastapi import HTTPException

from ..config import get_settings


def public_config() -> dict:
    cfg = get_settings()
    return {"enabled": cfg.turnstile_enabled,
            "site_key": cfg.turnstile_site_key if cfg.turnstile_enabled else "",
            "ready": bool(cfg.turnstile_site_key and cfg.turnstile_secret and cfg.turnstile_hostnames.strip())}


def verify(token: str, action: str) -> None:
    cfg = get_settings()
    if not cfg.turnstile_enabled:
        return
    hostnames = {host.strip() for host in cfg.turnstile_hostnames.split(",") if host.strip()}
    if not cfg.turnstile_secret or not cfg.turnstile_site_key or not hostnames:
        raise HTTPException(503, "人机验证尚未配置完成，请稍后重试")
    if not token or len(token) > 2048:
        raise HTTPException(403, "请先完成人机验证")
    try:
        response = httpx.post("https://challenges.cloudflare.com/turnstile/v0/siteverify",
                              data={"secret": cfg.turnstile_secret, "response": token},
                              timeout=10, follow_redirects=False)
        result = response.json() if response.is_success else None
    except (httpx.HTTPError, ValueError):
        result = None
    if (not isinstance(result, dict) or result.get("success") is not True
            or result.get("action") != action or result.get("hostname") not in hostnames):
        raise HTTPException(403, "人机验证未通过或已过期，请重新验证")
