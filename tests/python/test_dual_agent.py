"""真实 LangGraph + 确定响应；验证工程行为，不给咨询质量打分。"""
import asyncio
import copy
import importlib
import json
from dataclasses import replace

import httpx
import pytest

from backend.config import load_settings
from backend.model_client import ModelError


MESSAGES = [{'id': 'u1', 'role': 'user', 'content': '最近工作很累，我还想再说说。'}]


def analysis(**updates):
    return {'goal': None, 'statements': [], 'hypotheses': [], 'boundaries': [],
            'unknowns': [], 'exploration': None, **updates}


def dialogue(**updates):
    return {'reply': '我在听，你可以慢慢说。', 'action': 'acknowledge', 'questions': [],
            'analysis_response': 'deferred', 'feedback': '用户还在表达，暂缓探索。',
            'evidence': [], **updates}


def choice(value, *, calls=None):
    return ({'message': {'content': json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value,
                         'tool_calls': calls},
             'finish_reason': 'tool_calls' if calls else 'stop'},
            {'prompt_tokens': 10, 'completion_tokens': 5})


class ScriptedClient:
    configured = True
    provider = 'fixture'
    model = 'fixture-model'

    def __init__(self, *answers):
        self.answers = list(answers)
        self.requests = []

    async def complete_once(self, messages, tools, max_completion_tokens, allow_tools, *, budget):
        self.requests.append(copy.deepcopy({'messages': messages, 'tools': tools,
                                           'tokens': max_completion_tokens, 'allow_tools': allow_tools}))
        result = self.answers.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


def counselor(first, second, **kwargs):
    cls = importlib.import_module('backend.agent.graph').DualCounselor
    return cls(load_settings({}), role_clients={'analysis': first, 'dialogue': second}, **kwargs)


async def test_both_roles_receive_original_history_and_dialogue_can_defer_without_questions():
    first, second = ScriptedClient(choice(analysis())), ScriptedClient(choice(dialogue()))
    previous = {'version': 1, 'last_dialogue': dialogue(feedback='上一轮理解需要校准。')}
    result = await counselor(first, second).run_turn(MESSAGES, previous_state=previous, entry_context='自由聊聊')
    a = json.loads(first.requests[0]['messages'][-1]['content'])
    b = json.loads(second.requests[0]['messages'][-1]['content'])
    assert a['history'] == b['history'] == MESSAGES
    assert a['previous_state']['last_dialogue']['feedback'] == '上一轮理解需要校准。'
    assert a['entry_context'] == b['entry_context'] == '自由聊聊'
    assert b['analysis']['hypotheses'] == []
    assert result['dialogue']['questions'] == []
    assert result['session_state']['version'] == 2
    assert result['session_state']['last_dialogue']['analysis_response'] == 'deferred'
    assert result['usage']['model_requests'] == 2
    assert first.requests[0]['tokens'] == 2400 and second.requests[0]['tokens'] == 1200
    assert MESSAGES == [{'id': 'u1', 'role': 'user', 'content': '最近工作很累，我还想再说说。'}]


async def test_bad_analysis_stops_before_dialogue_without_json_repair():
    first, second = ScriptedClient(choice('不是 JSON')), ScriptedClient(choice(dialogue()))
    with pytest.raises(ModelError):
        await counselor(first, second).run_turn(MESSAGES)
    assert len(first.requests) == 1 and second.requests == []


async def test_internal_or_invalid_reply_is_rejected_before_result_is_returned():
    first = ScriptedClient(choice(analysis()))
    second = ScriptedClient(choice(dialogue(reply='{"analysis_update": "private"}')))
    with pytest.raises(ModelError):
        await counselor(first, second).run_turn(MESSAGES)
    assert len(second.requests) == 1


def test_withdrawn_fact_invalidates_dependents_and_requires_new_user_evidence_to_reactivate():
    module = importlib.import_module('backend.agent.state')
    messages = [{'id': 'u1', 'role': 'user', 'content': '我总是拖延。'}]
    fact = {'id': 'f1', 'text': '用户说自己总是拖延', 'kind': 'report',
            'status': 'active', 'evidence': [{'message_id': 'u1', 'quote': '总是拖延'}]}
    hypothesis = {'id': 'h1', 'text': '可能有重复回避', 'support': fact['evidence'],
                  'against': [], 'alternative': '可能是现实任务限制', 'status': 'tentative', 'depends_on': ['f1']}
    previous = module.merge_analysis(module.AnalysisBrief.model_validate(
        analysis(statements=[fact], hypotheses=[hypothesis])), None, messages)
    messages.append({'id': 'u2', 'role': 'user', 'content': '那件事其实没有发生。'})
    withdrawn = {**fact, 'status': 'withdrawn', 'evidence': [{'message_id': 'u2', 'quote': '没有发生'}],
                 'revision_reason': '用户纠正原先陈述。'}
    current = module.merge_analysis(module.AnalysisBrief.model_validate(analysis(statements=[withdrawn])), previous, messages)
    assert current['hypotheses'][0]['status'] == 'needs_review'
    assert current['statements'][0]['status'] == 'withdrawn'
    with pytest.raises(ValueError, match='新用户证据'):
        module.merge_analysis(module.AnalysisBrief.model_validate(analysis(statements=[fact])), current, messages)
    messages.append({'id': 'u3', 'role': 'user', 'content': '不过我昨天也拖延了。'})
    fresh = {**fact, 'evidence': [{'message_id': 'u3', 'quote': '昨天也拖延'}], 'revision_reason': '新的具体经历。'}
    revised = module.merge_analysis(module.AnalysisBrief.model_validate(analysis(statements=[fresh])), current, messages)
    assert revised['statements'][0]['status'] == 'active'
    assert revised['hypotheses'][0]['status'] == 'needs_review'


@pytest.mark.parametrize('reference', [
    {'message_id': 'a1', 'quote': '你可能很焦虑'},
    {'message_id': 'u1', 'quote': '从未说过这句话'},
])
def test_references_require_existing_user_words(reference):
    module = importlib.import_module('backend.agent.state')
    messages = MESSAGES + [{'id': 'a1', 'role': 'assistant', 'content': '你可能很焦虑'}]
    brief = module.AnalysisBrief.model_validate(analysis(statements=[{
        'id': 'f1', 'text': '某种解释', 'kind': 'interpretation', 'status': 'active', 'evidence': [reference]}]))
    with pytest.raises(ValueError, match='用户原文'):
        module.merge_analysis(brief, None, messages)


async def test_invalid_tool_and_unconfigured_dialogue_scope_are_bounded():
    bad_call = [{'id': 't1', 'type': 'function', 'function': {
        'name': 'search_analysis_material', 'arguments': '{"query": 123}'}}]
    missing_call = [{'id': 't2', 'type': 'function', 'function': {
        'name': 'search_dialogue_material', 'arguments': '{"query": "承接表达"}'}}]
    first = ScriptedClient(choice(None, calls=bad_call), choice(analysis()))
    second = ScriptedClient(choice(None, calls=missing_call), choice(dialogue()))
    result = await counselor(first, second).run_turn(MESSAGES)
    assert result['usage']['model_requests'] == 4
    assert result['usage']['retrieval_attempts'] == 2
    assert first.requests[1]['allow_tools'] is False
    assert second.requests[1]['allow_tools'] is False
    assert json.loads(first.requests[1]['messages'][-1]['content'])['status'] == 'error'
    assert json.loads(second.requests[1]['messages'][-1]['content'])['status'] == 'unavailable'


@pytest.mark.parametrize('mode', ['qwen', 'deepseek'])
async def test_real_http_adapter_runs_both_roles_with_provider_parameters(mode):
    from backend.deepseek_client import DeepSeekClient
    requests = []

    def handler(request):
        payload = json.loads(request.content)
        requests.append(payload)
        role = json.loads(payload['messages'][1]['content'])['role']
        expected_tokens = 2400 if role == 'analysis' else 1200
        assert payload['max_tokens'] == expected_tokens
        if mode == 'qwen':
            assert payload['enable_thinking'] is False and 'thinking' not in payload
        else:
            assert payload['thinking'] == {'type': 'disabled'} and 'enable_thinking' not in payload
        value = analysis() if role == 'analysis' else dialogue()
        return httpx.Response(200, json={'choices': [choice(value)[0]], 'usage': {'total_tokens': 15}})

    settings = replace(load_settings({}), mode=mode, api_key='offline-fixture', model='role-model',
                       url='https://provider.invalid/chat/completions')
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = DeepSeekClient(settings, http_client=http)
        result = await counselor(client, client).run_turn(MESSAGES)
    assert result['reply'] == '我在听，你可以慢慢说。'
    assert len(requests) == 2


async def test_cancellation_propagates_and_does_not_start_dialogue():
    started = asyncio.Event()

    class WaitingClient(ScriptedClient):
        async def complete_once(self, *args, **kwargs):
            started.set()
            await asyncio.Event().wait()

    second = ScriptedClient(choice(dialogue()))
    task = asyncio.create_task(counselor(WaitingClient(), second).run_turn(MESSAGES))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert second.requests == []


async def test_dialogue_receives_dependency_invalidations_not_stale_model_status():
    from backend.agent.state import AnalysisBrief, merge_analysis
    messages = [{'id': 'u1', 'role': 'user', 'content': '那件事发生过。'}]
    fact = {'id': 'f1', 'text': '用户报告某件事', 'kind': 'report', 'status': 'active',
            'evidence': [{'message_id': 'u1', 'quote': '发生过'}]}
    hypothesis = {'id': 'h1', 'text': '暂时解释', 'support': fact['evidence'], 'against': [],
                  'alternative': None, 'status': 'tentative', 'depends_on': ['f1']}
    previous = merge_analysis(AnalysisBrief.model_validate(analysis(statements=[fact], hypotheses=[hypothesis])), None, messages)
    messages.append({'id': 'u2', 'role': 'user', 'content': '我说错了，没发生。'})
    first = ScriptedClient(choice(analysis(statements=[{**fact, 'status': 'withdrawn',
        'evidence': [{'message_id': 'u2', 'quote': '没发生'}], 'revision_reason': '纠正'}], hypotheses=[hypothesis])))
    second = ScriptedClient(choice(dialogue()))
    await counselor(first, second).run_turn(messages, previous_state=previous)
    payload = json.loads(second.requests[0]['messages'][1]['content'])
    assert payload['analysis']['hypotheses'][0]['status'] == 'needs_review'


async def test_shared_deadline_cancels_active_role_without_retry(monkeypatch):
    from backend.agent import budget as budget_module
    real_budget = budget_module.TurnBudget
    monkeypatch.setattr(budget_module, 'TurnBudget', lambda **kw: real_budget(timeout=1, **kw))
    cancelled = asyncio.Event()

    class Slow(ScriptedClient):
        async def complete_once(self, *args, **kwargs):
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

    second = ScriptedClient(choice(dialogue()))
    with pytest.raises(ModelError) as caught:
        await counselor(Slow(), second).run_turn(MESSAGES)
    assert caught.value.status == 504 and cancelled.is_set()
    assert second.requests == []


async def test_final_role_request_cannot_start_another_retrieval():
    call = [{'id': 'tool1', 'type': 'function', 'function': {
        'name': 'search_analysis_material', 'arguments': '{"query":"测试"}'}}]
    first, second = ScriptedClient(choice(None, calls=call), choice(None, calls=call)), ScriptedClient(choice(dialogue()))
    with pytest.raises(ModelError):
        await counselor(first, second).run_turn(MESSAGES)
    assert len(first.requests) == 2 and second.requests == []


async def test_actual_supplier_utf8_bytes_rejected_before_http():
    from backend.deepseek_client import DeepSeekClient
    calls = []
    settings = replace(load_settings({}), mode='qwen', api_key='fixture')
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: calls.append(request))) as http:
        client = DeepSeekClient(settings, http_client=http)
        messages = [{'id': f'u{i}', 'role': 'user', 'content': '测试内容' * 500} for i in range(30)]
        with pytest.raises(ModelError) as caught:
            await counselor(client, client).run_turn(messages)
    assert caught.value.status == 413 and calls == []


def test_role_models_inherit_only_explicit_provider_and_keep_keys_private():
    from backend.config import role_settings
    default = load_settings({'DEEPSEEK_API_KEY': 'unused'})
    assert all(role_settings(default, role).mode == 'mock' for role in ('analysis', 'dialogue'))
    configured = load_settings({'MODEL_MODE': 'qwen', 'DASHSCOPE_API_KEY': 'q-fixture',
        'DEEPSEEK_API_KEY': 'd-fixture', 'ANALYSIS_PROVIDER': 'deepseek',
        'ANALYSIS_MODEL': 'analysis-model', 'DIALOGUE_MODEL': 'dialogue-model'})
    assert (role_settings(configured, 'analysis').mode, role_settings(configured, 'analysis').model) == ('deepseek', 'analysis-model')
    assert role_settings(configured, 'analysis').api_key == 'd-fixture'
    assert (role_settings(configured, 'dialogue').mode, role_settings(configured, 'dialogue').model) == ('qwen', 'dialogue-model')
    assert 'fixture' not in repr(configured)
    prompted = replace(configured, api_key='later-process-key')
    assert role_settings(prompted, 'dialogue').api_key == 'later-process-key'


async def test_model_readiness_is_independent_of_missing_corpus(tmp_path):
    from backend.deepseek_client import DeepSeekClient
    settings = replace(load_settings({}), mode='deepseek', api_key='fixture', embedding_key='fixture',
                       rag_index_dir=tmp_path / 'missing', rag_chunks_path=tmp_path / 'missing.jsonl')
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: None)) as http:
        client = DeepSeekClient(settings, http_client=http)
        assert client.configured and client.retriever is None


def test_model_marked_needs_review_can_be_revised_with_later_user_words():
    from backend.agent.state import AnalysisBrief, merge_analysis
    messages = [{'id': 'u1', 'role': 'user', 'content': '我暂时不确定。'}]
    hypothesis = {'id': 'h1', 'text': '需要校准', 'support': [], 'against': [],
                  'alternative': None, 'status': 'needs_review', 'depends_on': []}
    previous = merge_analysis(AnalysisBrief.model_validate(analysis(hypotheses=[hypothesis])), None, messages)
    messages.append({'id': 'u2', 'role': 'user', 'content': '刚确认了新的经历。'})
    revised = {**hypothesis, 'status': 'revised', 'revision_reason': '得到新信息',
               'support': [{'message_id': 'u2', 'quote': '确认了新的经历'}]}
    result = merge_analysis(AnalysisBrief.model_validate(analysis(hypotheses=[revised])), previous, messages)
    assert result['hypotheses'][0]['status'] == 'revised'
