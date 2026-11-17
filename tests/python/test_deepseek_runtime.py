"""DeepSeek协议与RAG回路：真实本地逻辑，HTTP替身，禁止付费调用。"""
import asyncio
import importlib
import json
from dataclasses import replace

import httpx
import pytest

from backend.api import create_app
from backend.config import load_settings
from backend.model_client import ModelError


def runtime():
    return importlib.import_module('backend.deepseek_client')


def settings():
    return replace(load_settings({}), mode='deepseek', model='deepseek-flash',
                   url='https://api.deepseek.com/chat/completions', api_key='chat-test-secret',
                   embedding_key='embedding-test-secret')


class Retrieval:
    configured = True

    def __init__(self):
        self.calls = []
        self.fail = False

    async def search(self, query, top_k=4, *, scope='analysis'):
        self.calls.append((query, top_k))
        if self.fail:
            raise RuntimeError('private-provider-body')
        return {'status': 'draft_only', 'query': query, 'results': [{
            'chunk_id': 'CR-TEST-001', 'text': '完整正文与限定：25%，不是66%。',
            'source_refs': ['source-test'], 'parent_review_status': 'draft',
            'rights_status': 'pending', 'original_locator_status': 'parent_scope_only'}]}


def call(number=1, arguments=None, name='search_personality_knowledge'):
    return {'id': f'call_{number}', 'type': 'function', 'function': {
        'name': name, 'arguments': json.dumps(arguments or {'query': '原文数字'}, ensure_ascii=False)}}


def response(content='完整回复', calls=None, finish=None):
    return {'choices': [{'finish_reason': finish or ('tool_calls' if calls else 'stop'),
                         'message': {'role': 'assistant', 'content': content, 'tool_calls': calls}}],
            'usage': {'prompt_tokens': 10, 'completion_tokens': 2, 'total_tokens': 12}}


def test_deepseek_configuration_uses_only_its_key():
    configured = load_settings({'MODEL_MODE': 'deepseek', 'DEEPSEEK_API_KEY': 'deepseek-private',
                                'DASHSCOPE_API_KEY': 'bailian-private', 'MIMO_API_KEY': 'wrong-provider'})
    assert configured.model == 'deepseek-flash'
    assert configured.url == 'https://api.deepseek.com/chat/completions'
    assert configured.api_key == 'deepseek-private'
    assert configured.embedding_key == 'bailian-private'
    assert 'private' not in repr(configured) and 'wrong-provider' not in repr(configured)
    assert load_settings({'DEEPSEEK_API_KEY': 'unused'}).mode == 'mock'
    assert load_settings({'DEEPSEEK_API_KEY': 'unused'}).api_key == ''


async def test_actual_tool_text_and_metadata_reach_followup_request():
    requests = []
    retriever = Retrieval()

    async def handler(request):
        payload = json.loads(request.content)
        requests.append(payload)
        assert request.headers['authorization'] == 'Bearer chat-test-secret'
        assert payload['thinking'] == {'type': 'disabled'}
        assert payload['max_tokens'] == 2200 and 'max_completion_tokens' not in payload
        assert payload['stream'] is False
        assert '当前没有任何可调用工具' not in json.dumps(payload, ensure_ascii=False)
        if len(requests) == 1:
            assert payload['tools'][0]['function']['name'] == 'search_personality_knowledge'
            return httpx.Response(200, json=response(None, [call()]))
        assert payload['messages'][-2]['tool_calls'][0]['id'] == 'call_1'
        tool = payload['messages'][-1]
        assert tool['role'] == 'tool' and tool['tool_call_id'] == 'call_1'
        result = json.loads(tool['content'])
        assert result['results'][0] == {
            'chunk_id': 'CR-TEST-001', 'text': '完整正文与限定：25%，不是66%。',
            'source_refs': ['source-test'], 'parent_review_status': 'draft',
            'rights_status': 'pending', 'original_locator_status': 'parent_scope_only'}
        return httpx.Response(200, json=response('全同25%。[CR-TEST-001]'))

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        model = runtime().DeepSeekClient(settings(), http_client=http, retriever=retriever)
        result = await runtime().DeepSeekCounselor(settings(), model).reply([{'role': 'user', 'content': '66%全同吗？'}])
    assert result == {'reply': '全同25%。[CR-TEST-001]'}
    assert retriever.calls == [('原文数字', 4)] and len(requests) == 2


async def test_budget_resets_per_request_and_final_turn_disables_tools():
    retriever = Retrieval()
    requests = []

    async def handler(request):
        payload = json.loads(request.content)
        requests.append(payload)
        if len(requests) % 2:
            return httpx.Response(200, json=response(None, [call(1), call(2), call(3)]))
        tool_messages = [m for m in payload['messages'] if m['role'] == 'tool']
        assert len(tool_messages) == 3
        assert '上限' in tool_messages[-1]['content']
        assert payload.get('tool_choice') == 'none'
        return httpx.Response(200, json=response('仅根据已取到的资料回答。'))

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        model = runtime().DeepSeekClient(settings(), http_client=http, retriever=retriever)
        for _ in range(2):
            assert (await model.complete([{'role': 'user', 'content': '理论'}]))['reply']
    assert len(retriever.calls) == 4 and len(requests) == 4


async def test_two_sequential_searches_have_at_most_three_model_requests():
    seen = []
    retriever = Retrieval()

    async def handler(request):
        data = json.loads(request.content)
        seen.append(data)
        if len(seen) < 3:
            return httpx.Response(200, json=response(None, [call(len(seen))]))
        assert data['tool_choice'] == 'none'
        return httpx.Response(200, json=response('最终答案'))

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = runtime().DeepSeekClient(settings(), http_client=http, retriever=retriever)
        assert (await client.complete([{'role': 'user', 'content': '原文'}]))['reply'] == '最终答案'
    assert len(seen) == 3 and len(retriever.calls) == 2


@pytest.mark.parametrize('bad_call', [call(arguments={'query': 'test', 'shell': 'no'}), call(name='shell')])
async def test_unknown_or_invalid_tool_cannot_execute(bad_call):
    retriever = Retrieval()
    count = 0

    async def handler(request):
        nonlocal count
        count += 1
        if count == 1:
            return httpx.Response(200, json=response(None, [bad_call]))
        assert '未完成' in json.loads(request.content)['messages'][-1]['content']
        return httpx.Response(200, json=response('资料暂不可用。'))

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = runtime().DeepSeekClient(settings(), http_client=http, retriever=retriever)
        await client.complete([{'role': 'user', 'content': 'test'}])
    assert not retriever.calls


async def test_retrieval_failure_is_fed_back_without_private_error():
    retriever = Retrieval()
    retriever.fail = True
    count = 0

    async def handler(request):
        nonlocal count
        count += 1
        if count == 1:
            return httpx.Response(200, json=response(None, [call()]))
        content = json.loads(request.content)['messages'][-1]['content']
        assert '未完成' in content and 'private-provider-body' not in content
        return httpx.Response(200, json=response('资料不足，不能编造出处。'))

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = runtime().DeepSeekClient(settings(), http_client=http, retriever=retriever)
        await client.complete([{'role': 'user', 'content': '原文'}])


@pytest.mark.parametrize('body', [response('被截断', finish='length'), response(''),
                                 response(None, [dict(call(), id='')]), {'choices': []}])
async def test_incomplete_or_invalid_responses_rejected(body):
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=body))) as http:
        client = runtime().DeepSeekClient(settings(), http_client=http, retriever=Retrieval())
        with pytest.raises(ModelError):
            await client.complete([{'role': 'user', 'content': '你好'}])


async def test_http_error_sanitized_without_paid_automatic_retry():
    requests = []

    async def handler(request):
        requests.append(request)
        return httpx.Response(401, text='chat-test-secret private upstream body')

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = runtime().DeepSeekClient(settings(), http_client=http, retriever=Retrieval())
        with pytest.raises(ModelError) as caught:
            await client.complete([{'role': 'user', 'content': '你好'}])
    assert caught.value.status == 401
    assert 'secret' not in str(caught.value) and 'private' not in str(caught.value)
    assert len(requests) == 1


async def test_cancellation_reaches_active_http_call():
    started, cancelled = asyncio.Event(), asyncio.Event()

    async def handler(request):
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = runtime().DeepSeekClient(settings(), http_client=http, retriever=Retrieval())
        task = asyncio.create_task(client.complete([{'role': 'user', 'content': '你好'}]))
        await asyncio.wait_for(started.wait(), 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert cancelled.is_set()


async def test_chat_sse_and_reports_keep_public_contract():
    from test_dual_agent import analysis, dialogue
    reply = '这是最终回答'
    roles = []

    def handler(request):
        payload = json.loads(request.content)
        try:
            role = json.loads(payload['messages'][1]['content']).get('role')
        except ValueError:
            role = None  # 报告仍使用独立的旧协议。
        if role:
            roles.append(role)
            value = analysis() if role == 'analysis' else dialogue(reply=reply)
            return httpx.Response(200, json=response(json.dumps(value, ensure_ascii=False)))
        return httpx.Response(200, json=response(reply))

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as upstream:
        model = runtime().DeepSeekClient(settings(), http_client=upstream, retriever=Retrieval())
        app = create_app(settings=settings(), model_client=model)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as http:
            body = {'messages': [{'role': 'user', 'content': '你好'}]}
            assert (await http.post('/api/chat', json=body)).json() == {'reply': reply}
            stream = await http.post('/api/chat', json={**body, 'stream': True})
            assert 'event: delta' in stream.text and 'event: done' in stream.text
            assert 'reasoning_content' not in stream.text and 'tool_calls' not in stream.text
            reply = '{"questions": ["最近一次是什么时候？"]}'
            assert (await http.post('/api/report/audit', json=body)).json() == {'questions': ['最近一次是什么时候？']}
            reply = '最终咨询报告'
            assert (await http.post('/api/report/generate', json=body)).json() == {'report': reply}
    assert roles == ['analysis', 'dialogue', 'analysis', 'dialogue']


async def test_report_generation_cannot_bypass_internal_marker_filter():
    leak = '<tool_call><function=search_personality_knowledge>private execution text'
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=response(leak)))) as upstream:
        model = runtime().DeepSeekClient(settings(), http_client=upstream, retriever=Retrieval())
        app = create_app(settings=settings(), model_client=model)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as http:
            result = await http.post('/api/report/generate', json={'messages': [{'role': 'user', 'content': '生成报告'}]})
            assert result.status_code == 502
            assert 'private execution text' not in result.text and '<tool_call>' not in result.text
