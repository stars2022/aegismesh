from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

import httpx

from ..config import get_settings


class RegistrationError(RuntimeError):
    pass


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
            raise RegistrationError("注册服务登录超时") from exc
        except httpx.HTTPStatusError as exc:
            raise RegistrationError(f"注册服务登录失败：HTTP {exc.response.status_code}") from exc
        except httpx.HTTPError as exc:
            raise RegistrationError(f"注册服务不可达：{exc}") from exc
        payload = response.json()
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
            raise RegistrationError("注册服务请求超时") from exc
        except httpx.HTTPStatusError as exc:
            detail = ""
            try:
                body = exc.response.json()
                detail = str(body.get("detail") or body)
            except ValueError:
                detail = exc.response.text[:200]
            raise RegistrationError(f"注册服务返回 {exc.response.status_code}：{detail}") from exc
        except httpx.HTTPError as exc:
            raise RegistrationError(f"注册服务不可达：{exc}") from exc
        if not response.content:
            return None
        return response.json()

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
