from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

import httpx

from ..config import get_settings


class RegistrationError(RuntimeError):
    def __init__(self, message: str, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


def validate_registration_acs(acs: dict) -> None:
    """Reject invalid declarations locally, without creating an upstream draft."""
    endpoints = acs.get("endPoints") or []
    schemes = acs.get("securitySchemes") or {}
    rpc_endpoints = [e for e in endpoints if str(e.get("transport", "")).upper() in {"JSONRPC", "HTTP_JSON", "AIP"}]
    if not rpc_endpoints:
        raise RegistrationError("提审缺少公开 AIP RPC 端点", 422)
    for endpoint in rpc_endpoints:
        if not str(endpoint.get("url") or "").startswith("https://"):
            raise RegistrationError("提审 RPC 端点必须使用 HTTPS", 422)
    # The registry requires mutual TLS on AMQP declarations as well as RPC.
    for endpoint in endpoints:
        protected = any(
            isinstance(requirement, dict) and any(
                isinstance(schemes.get(key), dict) and schemes[key].get("type") == "mutualTLS"
                for key in requirement
            ) for requirement in (endpoint.get("security") or [])
        )
        if not protected:
            raise RegistrationError("提审端点必须声明 mutualTLS 双向证书认证，请检查端点安全配置", 422)


# registry-server 的 ApprovalStatus → 平台内注册状态
STATUS_MAP = {
    "DRAFT": "draft",
    "PENDING": "pending",
    "APPROVED": "approved",
    "REJECTED": "rejected",
}


@dataclass(slots=True)
class EabCredential:
    key_id: str
    mac_key: str
    aic: str
    expires_at: str


class RegistryClient:
    """官方 registry-server 用户侧 REST 客户端：登录、Agent 草稿/提交/状态、EAB 凭据。"""

    def __init__(
        self,
        base_url: str | None = None,
        atr_base_url: str | None = None,
        username: str | None = None,
        password: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        settings = get_settings()
        self.base_url = (settings.registry_api_url if base_url is None else base_url).rstrip("/")
        self.atr_base_url = (
            atr_base_url
            or (base_url if base_url is not None else settings.registry_atr_url)
        ).rstrip("/")
        self.username = settings.registry_username if username is None else username
        self.password = settings.registry_password if password is None else password
        self.timeout = settings.registry_timeout_seconds
        self.transport = transport
        self._token: str = ""
        self._token_exp: float = 0.0

    def configured(self) -> bool:
        return bool(self.base_url and self.username and self.password)

    def _require_configured(self) -> None:
        if not self.configured():
            raise RegistrationError("请先配置 REGISTRY_API_URL、REGISTRY_USERNAME 与 REGISTRY_PASSWORD")

    async def login(self) -> str:
        self._require_configured()
        try:
            async with httpx.AsyncClient(timeout=self.timeout, transport=self.transport) as client:
                response = await client.post(
                    f"{self.base_url}/auth/login",
                    data={"username": self.username, "password": self.password},
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                )
                response.raise_for_status()
        except httpx.TimeoutException as exc:
            raise RegistrationError("注册服务登录超时，请稍后重试", 504) from exc
        except httpx.HTTPStatusError as exc:
            raise RegistrationError(f"注册服务登录失败：HTTP {exc.response.status_code}，请检查服务端注册账号配置", 503) from exc
        except httpx.HTTPError as exc:
            raise RegistrationError("注册服务暂时不可达，请稍后重试", 503) from exc
        try:
            payload = response.json()
        except ValueError as exc:
            raise RegistrationError("注册服务登录响应不是有效 JSON") from exc
        if not isinstance(payload, dict):
            raise RegistrationError("注册服务登录响应格式异常")
        token = payload.get("accessToken") or payload.get("access_token")
        if not token:
            raise RegistrationError("注册服务登录响应缺少 accessToken")
        expires_in = int(payload.get("expiresIn") or payload.get("expires_in") or 3600)
        self._token = str(token)
        self._token_exp = time.monotonic() + max(60, expires_in - 60)
        return self._token

    async def _headers(self) -> dict[str, str]:
        if not self._token or time.monotonic() >= self._token_exp:
            await self.login()
        return {"Authorization": f"Bearer {self._token}"}

    async def _request(
        self,
        method: str,
        path: str,
        json_body: dict | None = None,
        *,
        base_url: str | None = None,
    ) -> Any:
        self._require_configured()
        headers = await self._headers()
        try:
            async with httpx.AsyncClient(timeout=self.timeout, transport=self.transport) as client:
                response = await client.request(
                    method, f"{base_url or self.base_url}{path}", json=json_body, headers=headers
                )
                if response.status_code == 401:
                    self._token = ""
                    headers = await self._headers()
                    response = await client.request(
                        method, f"{base_url or self.base_url}{path}", json=json_body, headers=headers
                    )
                response.raise_for_status()
        except httpx.TimeoutException as exc:
            raise RegistrationError("注册服务请求超时，请同步状态后再决定是否重试提交", 504) from exc
        except httpx.HTTPStatusError as exc:
            detail = ""
            try:
                body = exc.response.json()
                detail = str(body.get("detail") or body.get("message") or body) if isinstance(body, dict) else str(body)
            except ValueError:
                detail = "上游返回了非 JSON 错误响应"
            upstream = exc.response.status_code
            status = 422 if upstream in {400, 422} else 409 if upstream == 409 else 503 if upstream in {401, 403, 429} else 502
            if "mutualtls" in detail.lower():
                detail = "端点必须声明 mutualTLS 双向证书认证，请检查端点安全配置"
            raise RegistrationError(f"注册服务返回 {upstream}：{detail[:400]}", status) from exc
        except httpx.HTTPError as exc:
            raise RegistrationError("注册服务暂时不可达，请稍后重试", 503) from exc
        if not response.content:
            return None
        try:
            return response.json()
        except ValueError as exc:
            raise RegistrationError("注册服务响应不是有效 JSON，请同步状态后再决定是否重试提交") from exc

    async def save_agent(self, name: str, version: str, description: str, acs: dict) -> str:
        """创建 Agent 草稿，返回注册服务分配的 agent_id。"""
        payload = {
            "name": name,
            "version": version,
            "description": description or name,
            "acs": acs,
            "is_ontology": False,
        }
        result = await self._request("POST", "/agent/client", payload)
        agent_id = (result or {}).get("id") or (result or {}).get("agentId")
        if not agent_id:
            raise RegistrationError("注册服务创建草稿响应缺少 id")
        return str(agent_id)

    async def update_agent(self, registration_agent_id: str, name: str, version: str, description: str, acs: dict) -> None:
        await self._request(
            "PUT",
            f"/agent/client/{registration_agent_id}",
            {"name": name, "version": version, "description": description or name, "acs": acs},
        )

    async def submit(self, registration_agent_id: str) -> None:
        await self._request("POST", f"/agent/client/{registration_agent_id}/submit", {})

    async def cancel(self, registration_agent_id: str) -> None:
        await self._request("POST", f"/agent/client/{registration_agent_id}/cancel", {})

    async def detail(self, registration_agent_id: str) -> dict:
        result = await self._request("GET", f"/agent/client/{registration_agent_id}")
        if not isinstance(result, dict):
            raise RegistrationError("注册服务详情响应格式异常")
        return result

    async def fetch_eab(self, aic: str) -> EabCredential:
        result = await self._request(
            "POST",
            f"/acps-atr-v2/eab/{aic}",
            {},
            base_url=self.atr_base_url,
        )
        if not isinstance(result, dict) or not result.get("keyId"):
            raise RegistrationError("注册服务 EAB 响应缺少 keyId")
        return EabCredential(
            key_id=str(result["keyId"]),
            mac_key=str(result.get("macKey") or ""),
            aic=str(result.get("aic") or aic),
            expires_at=str(result.get("expiresAt") or ""),
        )

    @staticmethod
    def map_status(remote_status: str | None) -> str:
        return STATUS_MAP.get((remote_status or "").upper(), "local")
