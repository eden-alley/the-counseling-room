"""千问切换：使用HTTP替身，不调用外部模型。"""
import json

import httpx
import pytest

from backend.config import load_settings
from backend.deepseek_client import DeepSeekClient
from backend.api import create_app
from backend import __main__ as cli
from test_deepseek_runtime import Retrieval, response, call
from test_model_cli import setup_cli


def settings():
    return load_settings({'MODEL_MODE': 'qwen', 'DASHSCOPE_API_KEY': 'qwen-fixture',
                          'DEEPSEEK_API_KEY': 'must-not-use'})


def test_qwen_configuration_uses_bailian_only():
    configured = settings()
    assert configured.model == 'qwen3.8-max'
    assert configured.url == 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
    assert configured.api_key == configured.embedding_key == 'qwen-fixture'
    assert 'qwen-fixture' not in repr(configured)


async def test_qwen_http_chat_runs_dual_roles_with_scoped_tool_and_qwen_parameters():
    from test_dual_agent import analysis, dialogue
    requests = []

    async def handler(request):
        payload = json.loads(request.content)
        requests.append(payload)
        assert request.url.host == 'dashscope.aliyuncs.com'
        assert request.headers['authorization'] == 'Bearer qwen-fixture'
        assert payload['model'] == 'qwen3.8-max'
        assert payload['enable_thinking'] is False
        assert 'thinking' not in payload
        role = json.loads(payload['messages'][1]['content'])['role']
        if len(requests) == 1:
            assert role == 'analysis'
            return httpx.Response(200, json=response(None, [call(name='search_analysis_material')]))
        if role == 'analysis':
            assert payload['messages'][-1]['role'] == 'tool'
            assert 'CR-TEST-001' in payload['messages'][-1]['content']
            assert payload['tool_choice'] == 'none'
            value = analysis()
        else:
            assert role == 'dialogue' and len(requests) == 3
            value = dialogue(reply='已核对资料。[CR-TEST-001]')
        return httpx.Response(200, json=response(json.dumps(value, ensure_ascii=False)))

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        model = DeepSeekClient(settings(), http_client=http, retriever=Retrieval())
        app = create_app(settings=settings(), model_client=model)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://test') as client:
            result = await client.post('/api/chat', json={'messages': [{'role': 'user', 'content': '请查原文'}]})
    assert result.status_code == 200
    assert result.json() == {'reply': '已核对资料。[CR-TEST-001]'}
    assert len(requests) == 3


def test_qwen_cli_uses_existing_bailian_key_and_snapshot(monkeypatch):
    seen = setup_cli(monkeypatch, ['--qwen'])
    cli.main()
    assert seen['settings'].mode == 'qwen'
    assert seen['settings'].api_key == 'process-embedding-key'
    assert seen['snapshot'][1].name == 'chunks.jsonl'
    assert seen['server']['host'] == '127.0.0.1'


def test_qwen_missing_key_stops_before_start(monkeypatch):
    seen = setup_cli(monkeypatch, ['--qwen'])
    monkeypatch.delenv('DASHSCOPE_API_KEY')
    with pytest.raises(SystemExit):
        cli.main()
    assert 'server' not in seen
