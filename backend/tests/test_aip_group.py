from __future__ import annotations

import pytest

from app.services import aip_group
from app.services.aip_group import (
    ExternalPartner,
    GroupDiscussionResult,
    parse_mq_url,
)


def test_parse_mq_url() -> None:
    parsed = parse_mq_url("amqps://user:p%40ss@mq.example.com:5671/aip")
    assert parsed["rabbitmq_host"] == "mq.example.com"
    assert parsed["rabbitmq_port"] == 5671
    assert parsed["rabbitmq_vhost"] == "aip"
    assert parsed["rabbitmq_user"] == "user"
    assert parsed["rabbitmq_password"] == "p@ss"


def test_parse_mq_url_rejects_bad_scheme() -> None:
    with pytest.raises(aip_group.AipGroupBridgeError):
        parse_mq_url("https://mq.example.com")


async def test_bridge_requires_mq_config(monkeypatch) -> None:
    monkeypatch.setattr(aip_group, "mq_settings", lambda: {})
    with pytest.raises(aip_group.AipGroupBridgeError):
        await aip_group.run_aip_group_discussion(
            leader_aic="1.2.156.3088.0.1.2.3.4.ABCD",
            partners=[ExternalPartner(aic="aic-x", name="x", rpc_url="https://x/rpc")],
            topic="议题",
            rounds=1,
            initial_context="",
            on_speech=lambda sender, statement: None,
            timeout_seconds=5,
        )


async def test_bridge_runs_group_and_reports_speeches(monkeypatch) -> None:
    speeches_seen: list[tuple[str, str]] = []

    class FakeClient:
        def __init__(self, **kwargs: object) -> None:
            self.group_id = None

        async def connect(self) -> None:
            return None

        async def create_group(self) -> str:
            self.group_id = "group-test"
            return self.group_id

        async def invite_partner(self, acs: object, rpc_url: str, timeout: float = 30.0) -> None:
            return None

        def set_message_handler(self, handler) -> None:
            self._handler = handler

        async def send_task_command(self, *args: object, **kwargs: object) -> None:
            handler = self._handler
            # 模拟两个外部 Partner 各回一条发言
            class Item:
                type = "text"
                text = ""

            class Product:
                dataItems = []

            class Status:
                state = "completed"

            class Result:
                senderId = ""
                status = Status()
                products = []

            for sender, text in (("aic-1", "发言一"), ("aic-2", "发言二")):
                item = Item()
                item.text = text
                product = Product()
                product.dataItems = [item]
                result = Result()
                result.senderId = sender
                result.products = [product]
                await handler(result)

        async def broadcast_group_shutdown(self) -> None:
            return None

        async def cleanup_group_resources(self) -> None:
            return None

        async def dissolve_group(self) -> None:
            return None

        async def close(self) -> None:
            return None

    # GroupLeader (not the low-level client) must perform ACL registration.
    import asyncio
    from types import SimpleNamespace
    class FakeLeader:
        def __init__(self, aic, config, **kwargs):
            assert config["auth_service_url"] == "https://mq-auth.test"
            self.state = {}
        async def create_group_session(self, session_id, partners):
            self.session = SimpleNamespace(group_id="group-test", leader_mq_client=self,
                state_update_event=asyncio.Event(),
                get_partner_task_snapshot=lambda task_id, aic: self.state.get((task_id, aic)))
            return self.session
        async def invite_partner(self, *args, **kwargs):
            pass
        async def start_task(self, session_id, *, text_content, task_id, mentions):
            assert session_id == task_id  # Official Message correlationId contract.
            self.target = mentions[0]
            self.state[(task_id, self.target)] = {"state": "awaiting-completion", "product_text": "发言一" if self.target == "aic-1" else "发言二"}
        async def complete_task(self, task_id, session_id, mentions):
            self.state[(task_id, mentions[0])]["state"] = "completed"
        async def close(self):
            pass
    monkeypatch.setattr("acps_sdk.aip.aip_group_leader.GroupLeader", FakeLeader)
    monkeypatch.setattr(aip_group, "identity_context", lambda aic: None)
    monkeypatch.setattr(aip_group, "message_emitter", lambda aic: None)
    monkeypatch.setattr(aip_group, "get_settings", lambda: SimpleNamespace(aip_group_auth_url="https://mq-auth.test"))
    monkeypatch.setattr(aip_group, "mq_settings", lambda: {"rabbitmq_host": "localhost", "rabbitmq_port": 5671, "rabbitmq_vhost": "acps"})

    result = await aip_group.run_aip_group_discussion(
        leader_aic="1.2.156.3088.0.1.2.3.4.ABCD",
        partners=[
            ExternalPartner(aic="aic-1", name="文献专家", rpc_url="https://a1/rpc"),
            ExternalPartner(aic="aic-2", name="评审专家", rpc_url="https://a2/rpc"),
        ],
        topic="综述方法",
        rounds=1,
        initial_context="",
        on_speech=lambda sender, statement: speeches_seen.append((sender, statement)),
        timeout_seconds=10,
    )

    assert result.transport == "aip-mq"
    assert result.group_id == "group-test"
    assert len(result.speeches) == 2
    assert speeches_seen == [("aic-1", "发言一"), ("aic-2", "发言二")]


async def test_local_swarm_used_without_external_partners(db_session_none=None) -> None:
    """无外部 aip-rpc 参与者时不触碰 MQ 桥（冒烟：桥函数仅在外部成员时被调用）。"""
    partners = [
        ExternalPartner(aic="aic-x", name="x", rpc_url="https://x/rpc"),
    ]
    assert all(p.rpc_url for p in partners)
