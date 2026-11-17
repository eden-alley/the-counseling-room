"""统一角色工具回路；供应商适配器每次只发一个 HTTP 请求。"""
import json
from dataclasses import dataclass, field

from pydantic import Field

from .budget import TurnBudget
from .state import StrictModel
from ..model_client import ModelError


class SearchArguments(StrictModel):
    query: str = Field(min_length=1, max_length=1000)
    top_k: int = Field(default=4, ge=1, le=5)


@dataclass
class RunContext:
    budget: TurnBudget
    usage: list[dict] = field(default_factory=list)
    materials: list[dict] = field(default_factory=list)


def role_tool(role):
    return {'type': 'function', 'function': {
        'name': f'search_{role}_material',
        'description': '检索待审分析资料。' if role == 'analysis' else '检索沟通过程案例；未配置时返回 unavailable。',
        'parameters': SearchArguments.model_json_schema(),
    }}


async def _retrieve(call, *, role, retriever, context):
    # 无效调用也先消耗本角色额度，不能靠坏参数重新获得调用机会。
    context.budget.use_tool(role)
    try:
        function = call.get('function', {})
        raw_args = function.get('arguments')
        if function.get('name') != f'search_{role}_material' or not isinstance(raw_args, str) or len(raw_args) > 8192:
            raise ValueError('Invalid tool')
        args = SearchArguments.model_validate_json(raw_args)
        if not args.query.strip():
            raise ValueError('Empty query')
        if retriever is None:
            return {'status': 'unavailable', 'results': [], 'reason': '本角色资料未配置。'}
        result = await retriever.search(args.query, top_k=args.top_k, scope=role)
        # 仅存来源定位和版本，不把工具全部正文重复塞进会话状态。
        context.materials.extend({'scope': role, **{key: row[key] for key in (
            'chunk_id', 'source_refs', 'parent_path', 'heading_path', 'parent_review_status',
            'rights_status', 'original_locator_status', 'embedding_text_sha256') if key in row}}
            for row in result.get('results', []))
        return result
    except Exception:
        # CancelledError 不属于 Exception；取消继续传播，不变成可重试工具错误。
        return {'status': 'error', 'results': [], 'reason': '检索未完成，不得编造出处。'}


async def run_role(*, role, client, messages, schema, retriever, context):
    if not client.configured:
        raise ModelError('当前角色模型尚未配置。', 503)
    history = [dict(message) for message in messages]
    tools = [role_tool(role)]
    for attempt in range(2):
        context.budget.use_model(role)
        choice, usage = await client.complete_once(history, tools,
            max_completion_tokens=2400 if role == 'analysis' else 1200,
            allow_tools=attempt == 0, budget=context.budget)
        context.usage.append({'role': role, 'tokens': usage})
        message = choice.get('message', {})
        calls = message.get('tool_calls')
        if not calls:
            if choice.get('finish_reason') != 'stop' or not isinstance(message.get('content'), str):
                raise ModelError('模型未返回完整结构化结果。')
            # 不修补、不从围栏或混合文本中猜测 JSON；失败即终止本轮。
            return schema.model_validate_json(message['content'])
        if attempt or choice.get('finish_reason') != 'tool_calls' or not isinstance(calls, list) or len(calls) != 1:
            raise ModelError('本轮工具调用格式或次数异常。')
        call = calls[0]
        if not isinstance(call, dict) or call.get('type') != 'function' or not isinstance(call.get('id'), str) or not call['id']:
            context.budget.use_tool(role)
            raise ModelError('本轮工具调用格式异常。')
        result = await _retrieve(call, role=role, retriever=retriever, context=context)
        history.append({'role': 'assistant', 'content': None, 'tool_calls': calls})
        history.append({'role': 'tool', 'tool_call_id': call['id'], 'content': json.dumps(result, ensure_ascii=False)})
    raise ModelError('本轮模型调用次数已达上限。')


class MockRoleClient:
    configured = True
    provider = 'mock'
    model = 'offline-dual-fixture'
    retriever = None

    def __init__(self, role):
        self.role = role

    async def complete_once(self, messages, tools, max_completion_tokens, allow_tools, *, budget):
        budget.encode_payload({'model': self.model, 'messages': messages, 'tools': tools})
        if self.role == 'analysis':
            result = {'goal': None, 'statements': [], 'hypotheses': [], 'boundaries': [],
                      'unknowns': ['本地模拟不评估用户情况。'], 'exploration': None}
        else:
            result = {'reply': '【本地模拟】我在听，你可以继续说说。', 'action': 'acknowledge',
                      'questions': [], 'analysis_response': 'deferred',
                      'feedback': '离线模拟只验证流程，未评估咨询质量。', 'evidence': []}
        return {'message': {'content': json.dumps(result, ensure_ascii=False)}, 'finish_reason': 'stop'}, None

    async def aclose(self):
        pass


def make_role_clients(settings):
    from ..config import role_settings
    from ..deepseek_client import DeepSeekClient
    return {role: (MockRoleClient(role) if role_settings(settings, role).mode == 'mock'
                   else DeepSeekClient(role_settings(settings, role))) for role in ('analysis', 'dialogue')}
