"""SDK 外部边界替身；咨询/报告/API 调用链本身真实执行，不联网。"""
import importlib
import json
from dataclasses import replace
from types import SimpleNamespace

import httpx
import pytest
from openai_codex.generated.v2_all import TurnStatus

from backend.config import load_settings
from backend.api import create_app


def runtime():
    try:
        return importlib.import_module('backend.codex_client')
    except ImportError:
        pytest.fail('尚未实现 Codex SDK 运行适配器')


def test_codex_settings_explicit_and_secret_not_in_repr():
    settings = load_settings({'MODEL_MODE': 'codex', 'DASHSCOPE_API_KEY': 'test-secret',
                              'RAG_INDEX_DIR': '/index', 'RAG_CHUNKS_PATH': '/chunks'})
    assert settings.mode == 'codex'
    assert settings.embedding_key == 'test-secret'
    assert 'test-secret' not in repr(settings)
    assert load_settings({}).mode == 'mock'


class FakeCodex:
    configs = []
    starts = []
    inputs = []
    response = '可以先看一个具体场景。[CR-BB01-001]'
    status = TurnStatus.completed
    auth = 'chatgpt'
    fail = False

    def __init__(self, config):
        self.configs.append(config)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def account(self):
        return SimpleNamespace(model_dump=lambda **kw: {'account': {'type': self.auth}})

    async def thread_start(self, **kwargs):
        self.starts.append(kwargs)
        return self

    async def turn(self, text, **kwargs):
        self.inputs.append(text)
        return self

    async def run(self):
        if self.fail:
            raise RuntimeError('sensitive upstream response')
        return SimpleNamespace(final_response=self.response, status=self.status)

    async def interrupt(self):
        pass


@pytest.fixture
def client(monkeypatch, tmp_path):
    module = runtime()
    monkeypatch.setattr(module, 'AsyncCodex', FakeCodex)
    monkeypatch.setenv('OPENAI_API_KEY', 'must-not-propagate')
    monkeypatch.setenv('CODEX_HOME', str(tmp_path))
    FakeCodex.configs.clear()
    FakeCodex.starts.clear()
    FakeCodex.inputs.clear()
    FakeCodex.auth, FakeCodex.fail = 'chatgpt', False
    FakeCodex.status = TurnStatus.completed
    FakeCodex.response = '可以先看一个具体场景。[CR-BB01-001]'
    settings = replace(load_settings({}), mode='codex', embedding_key='embedding-test',
                       rag_index_dir=tmp_path, rag_chunks_path=tmp_path / 'chunks.jsonl')
    return module.CodexModelClient(settings), settings


@pytest.mark.asyncio
async def test_chat_and_reports_use_codex_without_assessment_round(client):
    model, settings = client
    app = create_app(settings=settings, model_client=model)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as http:
        payload = {'messages': [{'role': 'user', 'content': '解释投射与我的经历区别'}]}
        result = await http.post('/api/chat', json=payload)
        assert result.status_code == 200
        assert result.json()['reply'].endswith('[CR-BB01-001]')
        assert len(FakeCodex.inputs) == 1
        result = await http.post('/api/chat', json={**payload, 'stream': True})
        assert 'event: delta' in result.text and 'event: done' in result.text
        FakeCodex.response = '{"questions": ["具体发生了什么？"]}'
        result = await http.post('/api/report/audit', json=payload)
        assert result.json() == {'questions': ['具体发生了什么？']}
        FakeCodex.response = '这是咨询报告'
        result = await http.post('/api/report/generate', json=payload)
        assert result.json() == {'report': '这是咨询报告'}
    assert FakeCodex.configs[0].env['OPENAI_API_KEY'] == ''
    assert FakeCodex.starts[0]['ephemeral'] is True
    assert 'search_personality_knowledge' in FakeCodex.starts[0]['base_instructions']


@pytest.mark.asyncio
async def test_non_subscription_auth_rejected(client):
    model, _ = client
    FakeCodex.auth = 'apiKey'
    with pytest.raises(Exception, match='ChatGPT'):
        await model.complete([{'role': 'user', 'content': '你好'}])
    assert not FakeCodex.inputs


@pytest.mark.asyncio
async def test_upstream_failure_sanitized(client):
    model, _ = client
    FakeCodex.fail = True
    with pytest.raises(Exception) as caught:
        await model.complete([{'role': 'user', 'content': '你好'}])
    assert 'sensitive' not in str(caught.value)


@pytest.mark.asyncio
async def test_incomplete_turn_and_empty_response_are_rejected(client):
    model, _ = client
    FakeCodex.status = TurnStatus.failed
    with pytest.raises(Exception, match='未返回完整回复'):
        await model.complete([{'role': 'user', 'content': '你好'}])

    FakeCodex.status = TurnStatus.completed
    FakeCodex.response = '  '
    with pytest.raises(Exception, match='未返回完整回复'):
        await model.complete([{'role': 'user', 'content': '你好'}])


@pytest.mark.asyncio
async def test_mcp_tool_budget_and_unknown_tool():
    try:
        module = importlib.import_module('backend.rag_mcp')
    except ImportError:
        pytest.fail('尚未实现 RAG MCP 工具入口')
    class Retrieval:
        async def search(self, query, top_k=4):
            return {'results': [{'chunk_id': 'A', 'text': query}]}
    server = module.RagToolServer(Retrieval())
    listing = await server.handle({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'})
    assert [x['name'] for x in listing['result']['tools']] == ['search_personality_knowledge']
    request = {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {
        'name': 'search_personality_knowledge', 'arguments': {'query': '投射'}}}
    for _ in range(2):
        response = await server.handle(request)
        assert json.loads(response['result']['content'][0]['text'])['results'][0]['chunk_id'] == 'A'
    response = await server.handle(request)
    assert response['result']['isError'] is True
    request['params']['name'] = 'shell'
    assert (await server.handle(request))['result']['isError'] is True
