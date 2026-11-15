"""DeepSeek TTS & ASR integration for the Digital Human console."""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
from typing import Any
from urllib.parse import urlsplit

import httpx

from ..models import ProviderConfig
from .provider_secrets import decrypt_api_key, resolve_api_key

ORIGIN = "https://api.deepseek.com"
MAX_TTS_TEXT_CHARS = 10000
MAX_TTS_AUDIO_BYTES = 16 * 1024 * 1024
MAX_ASR_AUDIO_BYTES = 8 * 1024 * 1024


def normalize_speech_base_url(base_url: str | None) -> str:
    raw = (base_url or "").strip() or ORIGIN
    try:
        parts = urlsplit(raw)
    except ValueError as exc:
        raise RuntimeError("语音服务地址格式无效") from exc
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
        raise RuntimeError("语音服务地址必须使用安全的 https:// 域名")
    host = parts.netloc
    path = parts.path.rstrip("/")
    if path.endswith("/v1"):
        path = path[:-3]
    return f"https://{host}{path}"


def resolve_speech_credentials(
    provider: ProviderConfig | None,
    *,
    base_url: str = "",
    api_key_ciphertext: str = "",
    raw_api_key: str = "",
) -> tuple[str, str]:
    """Return (base_url, api_key) preferring independent key, falling back to ProviderConfig."""
    if raw_api_key and raw_api_key.strip():
        return normalize_speech_base_url(base_url), raw_api_key.strip()
    if api_key_ciphertext:
        key = decrypt_api_key(api_key_ciphertext)
        if key:
            return normalize_speech_base_url(base_url), key
    if not is_official_deepseek_provider(provider):
        raise RuntimeError("请填写独立的 DeepSeek 语音 API Key，或选择启用的 api.deepseek.com 官方供应商")
    return ORIGIN, resolve_api_key(provider)


def is_official_deepseek_provider(provider: ProviderConfig | None) -> bool:
    if not provider or not provider.active:
        return False
    try:
        parts = urlsplit(provider.base_url)
        return (
            parts.scheme == "https"
            and parts.hostname == "api.deepseek.com"
            and parts.port in (None, 443)
            and not parts.username
            and not parts.password
        )
    except ValueError:
        return False


def _speech_http_error(kind: str, status: int) -> RuntimeError:
    label = "语音合成" if kind == "tts" else "语音识别"
    return RuntimeError({
        400: f"DeepSeek {label}参数或音频格式无效",
        401: f"DeepSeek {label}密钥无效，请在后台更新",
        402: f"DeepSeek {label}账户余额不足",
        403: f"DeepSeek {label}请求被拒绝",
        404: f"DeepSeek {label}接口不可用，请检查服务状态",
        413: f"DeepSeek {label}内容超出大小限制",
        429: f"DeepSeek {label}触发限速，请稍后再试",
    }.get(status, f"DeepSeek {label}返回 HTTP {status}"))


async def synthesize_tts(
    provider: ProviderConfig | None,
    *,
    text: str,
    voice_id: str = "stella",
    filter_markdown: bool = True,
    timeout_seconds: float = 30.0,
    base_url: str = "",
    api_key_ciphertext: str = "",
    raw_api_key: str = "",
) -> bytes:
    """Synthesize speech WAV audio via DeepSeek TTS (`POST /v1/tools/tts`)."""
    cleaned = text.strip()
    if not cleaned:
        raise ValueError("播报文本不能为空")
    if len(cleaned) > MAX_TTS_TEXT_CHARS:
        cleaned = cleaned[:MAX_TTS_TEXT_CHARS]
    endpoint_origin, key = resolve_speech_credentials(
        provider,
        base_url=base_url,
        api_key_ciphertext=api_key_ciphertext,
        raw_api_key=raw_api_key,
    )
    body: dict[str, Any] = {
        "text": cleaned,
        "voice_id": voice_id if voice_id in {"stella", "tide"} else "stella",
        "format": "wav",
        "filter_markdown": bool(filter_markdown),
    }
    try:
        async with asyncio.timeout(timeout_seconds):
            async with httpx.AsyncClient(
                timeout=timeout_seconds, follow_redirects=False, trust_env=False
            ) as client:
                async with client.stream(
                    "POST",
                    f"{endpoint_origin}/v1/tools/tts",
                    headers={
                        "Authorization": f"Bearer {key}",
                        "Content-Type": "application/json",
                    },
                    json=body,
                ) as response:
                    if response.status_code != 200:
                        raise _speech_http_error("tts", response.status_code)
                    audio = bytearray()
                    async for chunk in response.aiter_bytes():
                        if len(chunk) > MAX_TTS_AUDIO_BYTES - len(audio):
                            raise RuntimeError("DeepSeek 语音合成音频过大")
                        audio.extend(chunk)
        if not audio:
            raise RuntimeError("DeepSeek 语音合成未返回音频数据")
        return bytes(audio)
    except (httpx.HTTPError, TimeoutError) as exc:
        raise RuntimeError("DeepSeek 语音合成连接失败或超时") from exc


async def stream_tts(
    provider: ProviderConfig | None,
    *,
    text: str,
    voice_id: str = "stella",
    filter_markdown: bool = True,
    timeout_seconds: float = 30.0,
    base_url: str = "",
    api_key_ciphertext: str = "",
    raw_api_key: str = "",
    on_complete: Callable[[int], None] | None = None,
    audio_format: str = "wav",
) -> AsyncIterator[bytes]:
    """Stream WAV or raw 24 kHz mono PCM directly from DeepSeek TTS."""
    cleaned = text.strip()
    if not cleaned:
        raise ValueError("播报文本不能为空")
    if len(cleaned) > MAX_TTS_TEXT_CHARS:
        cleaned = cleaned[:MAX_TTS_TEXT_CHARS]
    endpoint_origin, key = resolve_speech_credentials(
        provider,
        base_url=base_url,
        api_key_ciphertext=api_key_ciphertext,
        raw_api_key=raw_api_key,
    )
    body: dict[str, Any] = {
        "text": cleaned,
        "voice_id": voice_id if voice_id in {"stella", "tide"} else "stella",
        "format": "pcm" if audio_format == "pcm" else "wav",
        "filter_markdown": bool(filter_markdown),
    }
    total_bytes = 0
    try:
        async with asyncio.timeout(timeout_seconds):
            async with httpx.AsyncClient(
                timeout=timeout_seconds, follow_redirects=False, trust_env=False
            ) as client:
                async with client.stream(
                    "POST",
                    f"{endpoint_origin}/v1/tools/tts",
                    headers={
                        "Authorization": f"Bearer {key}",
                        "Content-Type": "application/json",
                    },
                    json=body,
                ) as response:
                    if response.status_code != 200:
                        raise _speech_http_error("tts", response.status_code)
                    async for chunk in response.aiter_bytes():
                        if not chunk:
                            continue
                        if len(chunk) > MAX_TTS_AUDIO_BYTES - total_bytes:
                            raise RuntimeError("DeepSeek 语音合成音频过大")
                        total_bytes += len(chunk)
                        yield chunk
    except (httpx.HTTPError, TimeoutError) as exc:
        raise RuntimeError("DeepSeek 语音合成连接失败或超时") from exc
    finally:
        if on_complete is not None:
            on_complete(total_bytes)


async def transcribe_asr(
    provider: ProviderConfig | None,
    *,
    audio_bytes: bytes,
    filename: str = "speech.wav",
    content_type: str = "audio/wav",
    timeout_seconds: float = 30.0,
    base_url: str = "",
    api_key_ciphertext: str = "",
    raw_api_key: str = "",
) -> dict[str, Any]:
    """Transcribe WAV or Ogg Opus audio via DeepSeek ASR (`POST /v1/tools/asr`)."""
    if not audio_bytes:
        raise ValueError("音频文件不能为空")
    if len(audio_bytes) > MAX_ASR_AUDIO_BYTES:
        raise ValueError("音频文件不能超过 8 MiB")
    endpoint_origin, key = resolve_speech_credentials(
        provider,
        base_url=base_url,
        api_key_ciphertext=api_key_ciphertext,
        raw_api_key=raw_api_key,
    )
    safe_name = filename.strip() or "speech.wav"
    safe_type = content_type.strip() or "audio/wav"
    try:
        async with asyncio.timeout(timeout_seconds):
            async with httpx.AsyncClient(
                timeout=timeout_seconds, follow_redirects=False, trust_env=False
            ) as client:
                response = await client.post(
                    f"{endpoint_origin}/v1/tools/asr",
                    headers={"Authorization": f"Bearer {key}"},
                    files={"file": (safe_name, audio_bytes, safe_type)},
                )
        if response.status_code != 200:
            raise _speech_http_error("asr", response.status_code)
        payload = response.json()
        if not isinstance(payload, dict) or not isinstance(payload.get("text"), str):
            raise RuntimeError("DeepSeek 语音识别返回格式无效")
        return {
            "request_id": str(payload.get("request_id") or ""),
            "text": payload["text"],
            "duration_ms": int(payload.get("duration_ms") or 0),
        }
    except (httpx.HTTPError, TimeoutError, ValueError) as exc:
        if isinstance(exc, RuntimeError):
            raise
        raise RuntimeError("DeepSeek 语音识别连接失败或响应无效") from exc
