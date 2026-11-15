from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.database import get_db
from app.main import app, require_admin, require_demo
from app.models import DigitalHumanConfig, ProviderConfig
from app.services import digital_human_speech
from app.services.provider_secrets import encrypt_api_key


def make_provider(provider_id="ds", base_url="https://api.deepseek.com", **changes):
    return ProviderConfig(
        id=provider_id,
        name="DeepSeek",
        kind="openai-chat",
        base_url=base_url,
        api_key_ciphertext=encrypt_api_key("sk-test-secret-key"),
        default_model="deepseek-chat",
        active=True,
        **changes,
    )


@pytest.mark.asyncio
async def test_streaming_tts_requests_pcm_and_settles_when_closed(monkeypatch):
    seen, settled = {}, []
    client_cls = httpx.AsyncClient

    def respond(request):
        seen.update(json.loads(request.content))
        return httpx.Response(200, content=b"\x00\x00\xff\x7f")

    monkeypatch.setattr(digital_human_speech.httpx, "AsyncClient", lambda **_: client_cls(transport=httpx.MockTransport(respond)))
    stream = digital_human_speech.stream_tts(make_provider(), text="您好", audio_format="pcm", on_complete=settled.append)
    assert await anext(stream) == b"\x00\x00\xff\x7f"
    await stream.aclose()
    assert seen["format"] == "pcm"
    assert settled == [4]


@pytest.mark.asyncio
async def test_realtime_disconnect_releases_foreground_quota(db, monkeypatch):
    from starlette.requests import Request
    from app.schemas import DigitalHumanRealtimeChatRequest
    from app.services import quotas
    import app.main as main

    provider = make_provider()
    db.add(provider); db.commit()
    from app.account_models import AccountPolicy
    db.add(AccountPolicy(id=1, values={"quota_mode": "enforce"}))
    db.commit()
    request = Request({"type": "http", "headers": [], "state": {"owner_id": "guest_realtime_disconnect"}})
    response = await main.demo_digital_human_realtime_chat_stream(
        DigitalHumanRealtimeChatRequest(message="您好", history=[], tasks=[]), request, db,
    )
    stage = await anext(response.body_iterator)
    try:
        assert "event: stage" in stage
        assert quotas.snapshot(db, "guest_realtime_disconnect")["concurrency"]["reserved"] == 1
    finally:
        await response.body_iterator.aclose()
    assert quotas.snapshot(db, "guest_realtime_disconnect")["concurrency"]["reserved"] == 0


@pytest.mark.asyncio
async def test_realtime_failure_is_not_reported_as_successful_speech(db, monkeypatch):
    from starlette.requests import Request
    from app.schemas import DigitalHumanRealtimeChatRequest
    from app.services import quotas
    import app.main as main

    db.add(make_provider()); db.commit()
    from app.account_models import AccountPolicy
    db.add(AccountPolicy(id=1, values={"quota_mode": "enforce"})); db.commit()

    class Unavailable:
        async def execute(self, *args, **kwargs):
            raise RuntimeError("upstream unavailable")

    monkeypatch.setattr(main.TransportRegistry, "get", lambda *args: Unavailable())
    request = Request({"type": "http", "headers": [], "state": {"owner_id": "guest_realtime_failure"}})
    response = await main.demo_digital_human_realtime_chat_stream(
        DigitalHumanRealtimeChatRequest(message="您好", history=[], tasks=[]), request, db,
    )
    events = ''.join([part async for part in response.body_iterator])
    assert "event: error" in events
    assert "event: done" not in events
    assert "event: speech" not in events
    assert quotas.snapshot(db, "guest_realtime_failure")["concurrency"]["reserved"] == 0


@pytest.mark.parametrize(
    "base_url",
    [
        "http://api.deepseek.com",
        "https://api.deepseek.com.evil.test",
        "https://api.deepseek.com:444",
        "https://user@api.deepseek.com",
    ],
)
def test_rejects_untrusted_deepseek_origin(base_url):
    assert not digital_human_speech.is_official_deepseek_provider(make_provider(base_url=base_url))


@pytest.mark.asyncio
async def test_synthesize_tts_posts_official_endpoint(monkeypatch):
    seen = {}

    def respond(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, content=b"RIFF\x00\x00\x00\x00WAVEfmt ")

    client_cls = httpx.AsyncClient
    monkeypatch.setattr(
        digital_human_speech.httpx,
        "AsyncClient",
        lambda **_: client_cls(transport=httpx.MockTransport(respond)),
    )

    audio = await digital_human_speech.synthesize_tts(
        make_provider(),
        text="你好，我是麦溪。",
        voice_id="tide",
        filter_markdown=True,
    )
    assert audio.startswith(b"RIFF")
    assert seen["url"] == "https://api.deepseek.com/v1/tools/tts"
    assert seen["auth"] == "Bearer sk-test-secret-key"
    assert seen["body"] == {
        "text": "你好，我是麦溪。",
        "voice_id": "tide",
        "format": "wav",
        "filter_markdown": True,
    }


@pytest.mark.asyncio
async def test_transcribe_asr_posts_multipart_wav(monkeypatch):
    seen = {}

    def respond(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        seen["content_type"] = request.headers.get("content-type", "")
        return httpx.Response(200, json={"request_id": "req-1", "text": "今天天气怎么样", "duration_ms": 1800})

    client_cls = httpx.AsyncClient
    monkeypatch.setattr(
        digital_human_speech.httpx,
        "AsyncClient",
        lambda **_: client_cls(transport=httpx.MockTransport(respond)),
    )

    result = await digital_human_speech.transcribe_asr(
        make_provider(),
        audio_bytes=b"RIFF\x00\x00\x00\x00WAVEfmt ",
        filename="speech.wav",
        content_type="audio/wav",
    )
    assert result == {"request_id": "req-1", "text": "今天天气怎么样", "duration_ms": 1800}
    assert seen["url"] == "https://api.deepseek.com/v1/tools/asr"
    assert seen["auth"] == "Bearer sk-test-secret-key"
    assert "multipart/form-data" in seen["content_type"]


def test_admin_and_demo_digital_human_endpoints(db, monkeypatch):
    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[require_admin] = lambda: None
    app.dependency_overrides[require_demo] = lambda: None
    try:
        db.add(make_provider())
        db.commit()

        with TestClient(app) as client:

            # Default config
            res = client.get("/api/admin/digital-human")
            assert res.status_code == 200
            assert res.json()["tts_backend"] == "browser"
            assert res.json()["asr_backend"] == "browser"

            # Update to DeepSeek TTS & ASR using independent API keys (no ProviderConfig required)
            payload = {
                "enabled": True,
                "display_name": "麦溪 Pro",
                "greeting": "您好，我是麦溪 Pro。",
                "tts_backend": "deepseek",
                "tts_provider_id": "",
                "tts_base_url": "https://api.deepseek.com",
                "tts_api_key": "sk-independent-tts",
                "tts_voice_id": "stella",
                "tts_filter_markdown": True,
                "tts_timeout_seconds": 30,
                "asr_backend": "deepseek",
                "asr_provider_id": "",
                "asr_base_url": "https://api.deepseek.com",
                "asr_api_key": "sk-independent-asr",
                "asr_timeout_seconds": 30,
            }
            put_res = client.put("/api/admin/digital-human", json=payload)
            assert put_res.status_code == 200
            assert put_res.json()["tts_backend"] == "deepseek"
            assert put_res.json()["tts_key_configured"] is True
            assert put_res.json()["asr_key_configured"] is True
            assert put_res.json()["display_name"] == "麦溪 Pro"

            # Now test binding to ProviderConfig: referenced provider cannot be deleted
            put_ref = client.put("/api/admin/digital-human", json={
                **payload,
                "tts_api_key": None,
                "clear_tts_api_key": True,
                "tts_provider_id": "ds",
                "asr_api_key": None,
                "clear_asr_api_key": True,
                "asr_provider_id": "ds",
            })
            assert put_ref.status_code == 200
            assert put_ref.json()["tts_key_configured"] is False

            # Provider referenced by DigitalHumanConfig cannot be deleted
            del_res = client.delete("/api/providers/ds")
            assert del_res.status_code == 409

            # Public config exposes availability without provider_id or secret
            pub_res = client.get("/api/demo/digital-human/config")
            assert pub_res.status_code == 200
            pub = pub_res.json()
            assert pub["tts_available"] is True
            assert pub["asr_available"] is True
            assert "tts_provider_id" not in pub
            assert "asr_provider_id" not in pub

            # Demo TTS & ASR proxy
            def respond_speech(request: httpx.Request) -> httpx.Response:
                if str(request.url).endswith("/tts"):
                    if json.loads(request.content).get("format") == "pcm":
                        return httpx.Response(200, content=b"\x00\x00\xff\x7f")
                    return httpx.Response(200, content=b"RIFF\x24\x00\x00\x00WAVE")
                return httpx.Response(200, json={"request_id": "r2", "text": "测试语音识别", "duration_ms": 900})

            client_cls = httpx.AsyncClient
            monkeypatch.setattr(
                digital_human_speech.httpx,
                "AsyncClient",
                lambda **_: client_cls(transport=httpx.MockTransport(respond_speech)),
            )

            tts_res = client.post("/api/demo/digital-human/tts", json={"text": "你好"})
            assert tts_res.status_code == 200
            assert tts_res.headers["content-type"].startswith("audio/wav")
            assert tts_res.content.startswith(b"RIFF")
            pcm_res = client.post("/api/demo/digital-human/tts", json={"text": "你好", "format": "pcm"})
            assert pcm_res.status_code == 200
            assert pcm_res.headers["content-type"].startswith("audio/pcm")
            assert pcm_res.headers["x-audio-sample-rate"] == "24000"
            assert pcm_res.content == b"\x00\x00\xff\x7f"
            assert client.post("/api/demo/digital-human/tts", json={"text": "你好", "format": "mp3"}).status_code == 422

            asr_res = client.post(
                "/api/demo/digital-human/asr",
                files={"file": ("speech.wav", b"RIFF\x24\x00\x00\x00WAVE", "audio/wav")},
            )
            assert asr_res.status_code == 200
            assert asr_res.json() == {"text": "测试语音识别", "duration_ms": 900}

            # Realtime chat separation: fast chat vs quick_search vs dispatch_task
            from app.services.transport import TransportRegistry
            from app.services.transport import PartnerResult
            import app.main as main_mod

            async def fake_search_handler(args):
                return {"results": [{"title": "今日天气晴", "snippet": "北京今日晴，气温 18-26°C", "url": "https://example.com/weather"}]}

            monkeypatch.setattr(main_mod, "configured_search", lambda *a, **kw: fake_search_handler)

            class FakeTransport:
                async def execute(self, agent, prompt, **kwargs):
                    if "任务标题" in prompt:
                        return PartnerResult(text=json.dumps({
                            "ui_title": "小米公司财报分析",
                            "summary_speech": "小米集团最新财报显示营收与汽车业务增长亮眼，详细对比已呈现在界面中。",
                            "ui_blocks": [
                                {"type": "kpi_grid", "title": "核心指标", "items": [{"label": "营收", "value": "3659亿", "delta": "+35%"}]},
                                {"type": "actions", "items": [{"label": "深入对比汽车业务", "prompt": "深入对比小米汽车业务"}]},
                            ],
                        }, ensure_ascii=False), data={})
                    if "检索结果" in prompt:
                        return PartnerResult(text=json.dumps({
                            "reply": "北京今天晴朗，气温在 18 到 26 度之间。",
                            "ui_title": "北京今日天气",
                            "ui_blocks": [
                                {"type": "cards", "items": [{"title": "北京天气", "body": "晴，18-26°C", "tag": "实时检索"}]},
                            ],
                        }, ensure_ascii=False), data={})
                    if "今天北京天气" in prompt:
                        return PartnerResult(text=json.dumps({
                            "reply": "",
                            "action": "quick_search",
                            "search_query": "北京今天天气",
                            "task_prompt": "",
                            "task_title": "",
                        }, ensure_ascii=False), data={})
                    if "帮我调研" in prompt:
                        return PartnerResult(text=json.dumps({
                            "reply": "好的，我已经安排后台团队开始调研，您可以继续和我聊天。",
                            "action": "dispatch_task",
                            "task_prompt": "调研最新 AI 进展",
                            "task_title": "AI 进展调研",
                        }, ensure_ascii=False), data={})
                    return PartnerResult(text=json.dumps({
                        "reply": "目前后台任务正在顺利进行中，我们随时可以聊别的。",
                        "action": "chat",
                        "task_prompt": "",
                        "task_title": "",
                    }, ensure_ascii=False), data={})

            monkeypatch.setattr(TransportRegistry, "get", lambda self, kind: FakeTransport())

            rt_dispatch = client.post(
                "/api/demo/digital-human/realtime-chat",
                json={"message": "帮我调研一下最新AI进展", "history": [], "tasks": []},
            )
            assert rt_dispatch.status_code == 200
            assert rt_dispatch.json()["action"] == "dispatch_task"
            assert rt_dispatch.json()["task_title"] == "AI 进展调研"

            rt_search = client.post(
                "/api/demo/digital-human/realtime-chat",
                json={"message": "今天北京天气怎么样", "history": [], "tasks": []},
            )
            assert rt_search.status_code == 200
            assert rt_search.json()["action"] == "quick_search"
            assert "18" in rt_search.json()["reply"]
            assert len(rt_search.json()["ui_blocks"]) == 1
            assert rt_search.json()["ui_blocks"][0]["type"] == "cards"

            rt_chat = client.post(
                "/api/demo/digital-human/realtime-chat",
                json={
                    "message": "任务怎么样了",
                    "history": [],
                    "tasks": [{"id": "t1", "title": "AI 进展调研", "status": "running", "stage": "正在检索"}],
                },
            )
            assert rt_chat.status_code == 200
            assert rt_chat.json()["action"] == "chat"
            assert "顺利进行" in rt_chat.json()["reply"]

            ui_res = client.post(
                "/api/demo/digital-human/synthesize-ui",
                json={"title": "小米公司财报", "content": "2025年营收创新高，智能汽车交付量持续提升。"},
            )
            assert ui_res.status_code == 200
            assert ui_res.json()["ui_title"] == "小米公司财报分析"
            assert len(ui_res.json()["ui_blocks"]) == 2
            assert ui_res.json()["ui_blocks"][0]["type"] == "kpi_grid"

            # Verify quota enforcement: guest_turns=3 -> 4th realtime-chat turn returns 429
            from app.account_models import AccountPolicy
            policy_row = db.get(AccountPolicy, 1)
            if policy_row is None:
                policy_row = AccountPolicy(id=1, values={"accounts_enabled": True, "quota_mode": "enforce", "guest_turns": 3}, lock_version=0)
                db.add(policy_row)
            else:
                policy_row.values = {**(policy_row.values or {}), "accounts_enabled": True, "quota_mode": "enforce", "guest_turns": 3}
            db.commit()

            for _ in range(3):
                ok_res = client.post(
                    "/api/demo/digital-human/realtime-chat",
                    json={"message": "你好", "history": [], "tasks": []},
                )
                assert ok_res.status_code == 200
            blocked_res = client.post(
                "/api/demo/digital-human/realtime-chat",
                json={"message": "第四次提问", "history": [], "tasks": []},
            )
            assert blocked_res.status_code == 429
    finally:
        app.dependency_overrides.clear()
