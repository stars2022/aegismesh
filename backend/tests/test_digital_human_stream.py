import asyncio
from types import SimpleNamespace

import pytest

from app.services.digital_human_stream import stream_realtime_result


@pytest.mark.asyncio
async def test_spoken_reply_arrives_before_ui_json_finishes():
    finish = asyncio.Event()

    class Transport:
        async def execute(self, agent, prompt, on_text, **kwargs):
            for piece in ['{"action":"chat","reply":', '"AIC标识身份，', 'ACS声明能力。"']:
                await on_text(piece)
            await finish.wait()
            return SimpleNamespace(text='{"reply":"AIC标识身份，ACS声明能力。","ui_blocks":[]}')

    stream = stream_realtime_result(Transport(), None, '', timeout_seconds=1)
    assert await anext(stream) == ('speech', 'AIC标识身份，ACS声明能力。')
    finish.set()
    kind, result = await anext(stream)
    assert kind == 'result'
    assert 'ui_blocks' in result.text
    await stream.aclose()


@pytest.mark.asyncio
async def test_partial_json_escapes_never_leak_into_speech():
    class Transport:
        async def execute(self, agent, prompt, on_text, **kwargs):
            for piece in ['```json\n{"action":"chat","reply": "他说\\', '"你好\\"。"', '}']:
                await on_text(piece)
            return 'complete'

    events = [event async for event in stream_realtime_result(Transport(), None, '')]
    assert events == [('speech', '他说"你好"。'), ('result', 'complete')]


@pytest.mark.asyncio
async def test_cancellation_stops_the_model_request():
    cancelled = asyncio.Event()

    class Transport:
        async def execute(self, agent, prompt, on_text, **kwargs):
            try:
                await on_text('{"action":"chat","reply":"第一句话。"')
                await asyncio.Event().wait()
            finally:
                cancelled.set()

    stream = stream_realtime_result(Transport(), None, '')
    assert (await anext(stream))[0] == 'speech'
    await stream.aclose()
    assert cancelled.is_set()


@pytest.mark.asyncio
async def test_timeout_is_a_failure_not_a_successful_completion():
    class Transport:
        async def execute(self, *args, **kwargs):
            await asyncio.Event().wait()

    with pytest.raises(TimeoutError):
        _ = [event async for event in stream_realtime_result(Transport(), None, '', timeout_seconds=.01)]


@pytest.mark.asyncio
async def test_task_handoff_waits_for_validated_routing_instead_of_announcing_an_unstarted_task():
    class Transport:
        async def execute(self, agent, prompt, on_text, **kwargs):
            await on_text('{"action":"dispatch_task","reply":"已经安排任务。"')
            return 'complete'

    assert [event async for event in stream_realtime_result(Transport(), None, '')] == [('result', 'complete')]
