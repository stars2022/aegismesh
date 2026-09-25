from __future__ import annotations

import httpx
from acps_sdk.adp import (
    ADPError,
    DiscoveryContext,
    DiscoveryRequest,
    DiscoveryResponse,
    validate_discovery_request,
)

from ..config import get_settings


class DiscoveryError(RuntimeError):
    pass


class AdpDiscoveryClient:
    """Small ADP client using the official SDK's models and validators."""

    async def discover(
        self,
        query: str,
        limit: int,
        session_id: str | None = None,
        recent_turns: list[str] | None = None,
    ) -> dict:
        settings = get_settings()
        base_url = settings.adp_discovery_url.rstrip("/")
        if not base_url:
            raise DiscoveryError("请先配置 ADP_DISCOVERY_URL")

        context = None
        if session_id or recent_turns:
            context = DiscoveryContext(
                conversationId=session_id,
                recentTurns=(recent_turns or [])[-8:],
            )
        request = DiscoveryRequest(
            type="explicit",
            query=query,
            limit=limit,
            context=context,
        )
        try:
            validate_discovery_request(request)
        except ADPError as exc:
            raise DiscoveryError(f"ADP 请求校验失败：{exc.message}") from exc

        candidate_paths = [
            f"{base_url}/acps-adp-v2/discover",
            f"{base_url}/discover",
        ]
        response = None
        last_error = None
        try:
            async with httpx.AsyncClient(timeout=settings.adp_timeout_seconds) as client:
                for target_url in candidate_paths:
                    try:
                        resp = await client.post(target_url, json=request.to_dict())
                        if resp.status_code == 404:
                            continue
                        resp.raise_for_status()
                        response = resp
                        break
                    except httpx.HTTPStatusError as exc:
                        last_error = exc
                        if exc.response.status_code == 404:
                            continue
                        raise
                if response is None:
                    if last_error:
                        raise DiscoveryError(f"ADP 发现服务返回 {last_error.response.status_code}") from last_error
                    raise DiscoveryError("未找到可用的发现服务接口端点 (404)")
            parsed = DiscoveryResponse.from_dict(response.json())
        except httpx.TimeoutException as exc:
            raise DiscoveryError("ADP 发现请求超时") from exc
        except httpx.HTTPStatusError as exc:
            raise DiscoveryError(f"ADP 发现服务返回 {exc.response.status_code}") from exc
        except (ValueError, TypeError) as exc:
            raise DiscoveryError("ADP 发现响应不符合协议") from exc

        if parsed.is_error():
            message = parsed.error.message if parsed.error else "未知协议错误"
            raise DiscoveryError(f"ADP 发现服务错误：{message}")
        raw_dict = parsed.to_dict()
        result_node = raw_dict.get("result", {})
        acs_map = result_node.get("acsMap", {})
        return {
            "result": result_node,
            "acsMap": acs_map,
            "aliveMap": result_node.get("aliveMap") or {},
            "raw": raw_dict,
        }


def health_from_alive_map(alive_map: dict | None, aic: str) -> str:
    """Map an ADP aliveMap entry onto the router health vocabulary.

    Missing entries stay unknown so an older discovery server does not look offline.
    """
    view = (alive_map or {}).get(aic)
    if not isinstance(view, dict) or "alive" not in view:
        return "unknown"
    return "online" if view.get("alive") else "offline"
