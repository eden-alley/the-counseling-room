"""迁移契约测试：假模型运行真图和真HTTP应用，不发外部请求。"""
import asyncio
import importlib
import json
from dataclasses import replace

import httpx
import pytest


def module(name):
    try:
        return importlib.import_module(name)
    except ModuleNotFoundError:
        pytest.fail(f"Python实现尚未提供：{name}")


class FakeModel:
    configured = True

    def __init__(self, parts=None, evidence=None):
        self.parts = parts or ["时间", "是实际限制。"]
        self.evidence = [0] if evidence is None else evidence
        self.calls = []

    async def complete_structured(self, messages, schema, **options):
        self.calls.append(("understand", messages))
        return schema.model_validate({
            "goal": None,
            "statements": [{"text": "时间不足", "kind": "report", "evidence": self.evidence}],
            "hypotheses": [], "strategy": "reflect",
        })

    async def stream(self, messages, **options):
        self.calls.append(("reply", messages))
        for part in self.parts:
            yield part

    async def complete(self, messages, **options):
        task = messages[-1]["content"]
        return {"reply": '{"questions":["具体情况？"]}' if "审查以下" in task else "# 模拟报告"}


def settings():
    return module("backend.config").load_settings({})


async def test_python_graph_and_private_state():
    model = FakeModel()
    counselor = module("backend.agent.graph").Counselor(settings(), model)
    events = [event async for event in counselor.stream([{"role": "user", "content": "不是害怕，是时间不够"}])]
    assert [event["type"] for event in events] == ["delta", "done"]
    assert events[-1] == {"type": "done", "reply": "时间是实际限制。"}
    assert len(model.calls) == 2
    assert "hypotheses" not in json.dumps(events)
    assert json.loads(model.calls[1][1][-1]["content"])["assessment"]["statements"][0]["text"] == "时间不足"


@pytest.mark.parametrize("evidence", [[1], [99], [True], [-1]])
async def test_invalid_source_stops_before_response(evidence):
    model = FakeModel(evidence=evidence)
    counselor = module("backend.agent.graph").Counselor(settings(), model)
    result = await counselor.reply([{"role": "user", "content": "事实"}, {"role": "assistant", "content": "猜测"}])
    assert result["status"] == 502
    assert len(model.calls) == 1


@pytest.mark.parametrize("parts", [["<tool_", "call>secret"], ['{"assessment":', '"secret"}'], ["```json\n", '{}\n```'], [" "], ["x" * 8001]])
async def test_unsafe_reply_never_finishes(parts):
    counselor = module("backend.agent.graph").Counselor(settings(), FakeModel(parts=parts))
    events = [event async for event in counselor.stream([{"role": "user", "content": "你好"}])]
    assert events[-1]["type"] == "error"
    assert not any(event["type"] == "done" for event in events)


async def test_http_json_stream_reports_validation_and_cors():
    # This fixture exercises the retained MiMo transport; dual-role/session HTTP
    # behavior has its own complete_once clients in test_session_api.py.
    app = module("backend.api").create_app(settings=replace(settings(), mode='mimo'), model_client=FakeModel())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.get('/api/health')).json() == {"ready": True, "capabilities": {"sessions_v1": False}}
        body = {"messages": [{"role": "user", "content": "你好"}]}
        assert (await client.post('/api/chat', json=body)).json() == {"reply": "时间是实际限制。"}
        stream = await client.post('/api/chat', json={**body, "stream": True})
        assert "text/event-stream" in stream.headers['content-type']
        assert "event: delta" in stream.text and "event: done" in stream.text
        assert "hypotheses" not in stream.text
        assert (await asyncio.wait_for(client.post('/api/report/audit', json=body), 1)).json() == {"questions": ["具体情况？"]}
        assert (await client.post('/api/report/generate', json=body)).json() == {"report": "# 模拟报告"}
        assert (await client.post('/api/report/generate', json={**body, "answers": [{}]})).status_code == 400
        for bad in [None, {}, {"messages": []}, {"messages": [{"role": "system", "content": "evil"}]}]:
            assert (await client.post('/api/chat', json=bad)).status_code == 400
        preflight = await client.options('/api/chat', headers={"origin": "http://localhost:4173", "access-control-request-method": "POST"})
        assert preflight.headers['access-control-allow-origin'] == '*'


async def test_body_limit_rate_limit_and_configuration():
    config = settings()
    assert config.mode == "mock"
    with pytest.raises(ValueError):
        module("backend.config").load_settings({"MODEL_MODE": "typo"})
    app = module("backend.api").create_app(settings=replace(config, mode='mimo'), model_client=FakeModel())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.post('/api/chat', content=b'x' * 160001)).status_code == 413
        results = [await client.post('/api/report/audit', json={"messages": [{"role": "user", "content": "test"}]}) for _ in range(11)]
        assert results[-1].status_code == 429


async def test_concurrent_graphs_keep_their_own_history():
    class Echo(FakeModel):
        async def stream(self, messages, **options):
            yield json.loads(messages[-1]['content'])['messages'][0]['content']
    counselor = module("backend.agent.graph").Counselor(settings(), Echo())
    results = await asyncio.gather(*(counselor.reply([{"role": "user", "content": text}]) for text in ['A会话', 'B会话']))
    assert results == [{"reply": "A会话"}, {"reply": "B会话"}]
