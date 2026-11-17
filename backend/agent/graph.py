"""从这里读起：整理理解 → 生成回复 → 检查。每次请求都有独立状态。"""
import re
import asyncio
from contextlib import aclosing
import anyio
from langgraph.runtime import Runtime

from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph
from langsmith import tracing_context

from .prompts import assessment_messages, response_messages
from .state import Assessment, ChatRequest, ConsultationState, validate_assessment
from ..config import Settings
from ..model_client import ModelError


def unsafe_reply(text: str) -> bool:
    """仅检查已知格式泄漏；不能证明语义安全或咨询质量。"""
    patterns = [
        r"<tool_call\b", r"<function=", r"<parameter=", r"code_interpreter",
        r"conversation_analysis", r"analysis_update", r"current_stage",
        r"当前(?:咨询)?阶段\s*[:：]", r"^\s*(?:[\[{]|```)",
        r'"(?:assessment|hypotheses|statements|strategy)"\s*:',
    ]
    return any(re.search(pattern, text, re.IGNORECASE) for pattern in patterns)


class Counselor:
    # 阅读定位：这是自定义 LangGraph 工作流，不是 LangChain create_agent。
    # 正常路径固定为 understand → respond → check → END，没有 model ↔ tools 回路。
    # Harness（给模型准备上下文、约束行为的外围机制）分布在 prompts/state/本文件；
    # model_client/api 另外提供网络重试、超时、HTTP 和取消等运行支撑。
    def __init__(self, settings: Settings, model_client):
        self.settings = settings
        self.model = model_client
        # State 是节点共享的数据袋；节点返回局部 dict，只更新相应字段。
        # 本项目未配置 reducer，因此字段更新是覆盖，不会自动追加消息。
        builder = StateGraph(ConsultationState)
        builder.add_node("understand", self.understand)
        builder.add_node("respond", self.respond)
        builder.add_node("check", self.check)
        # edge 决定下一步；这里只在失败时提前结束，没有失败后重新推理的边。
        builder.add_edge(START, "understand")
        builder.add_conditional_edges("understand", lambda state: END if state["failure"] else "respond")
        builder.add_conditional_edges("respond", lambda state: END if state["failure"] else "check")
        builder.add_edge("check", END)
        self.graph = builder.compile()  # 不启用检查点或数据库。

    @staticmethod
    def fail(error: Exception) -> dict:
        failure = {"error": str(error), "status": error.status} if isinstance(error, ModelError) else {
            "error": "本次回复生成异常，已为你拦截。请重新发送。", "status": 502,
        }
        get_stream_writer()({"type": "error", **failure})
        return {"failure": failure}

    async def understand(self, state: ConsultationState) -> dict:
        # 第一次模型调用：生成结构化理解，再验证引用是否来自用户消息。
        # assessment.strategy 只影响下一步回复的提示词，不负责选择图节点。
        try:
            result = await self.model.complete_structured(
                assessment_messages(self.settings, state["messages"]), Assessment,
                max_completion_tokens=2400,
            )
            return {"assessment": validate_assessment(result, state["messages"]).model_dump()}
        except Exception as error:
            # asyncio.CancelledError不是Exception，取消会继续向上游传播。
            return self.fail(error)

    async def respond(self, state: ConsultationState) -> dict:
        # 第二次模型调用：历史消息 + 内部理解 → 面向用户的自然语言。
        # writer 发 custom 事件；它不是工具调用，也不是将完整 State 发给前端。
        writer = get_stream_writer()
        reply, sent = "", 0
        try:
            source = self.model.stream(response_messages(self.settings, state["messages"], state["assessment"]))
            async with aclosing(source):
                async for chunk in source:
                    if not isinstance(chunk, str):
                        raise ValueError("无效文本片段")
                    reply += chunk
                    if len(reply) > 8000 or unsafe_reply(reply):
                        raise ValueError("输出格式不合格")
                    # 保留末尾64字符，拦截分块出现的内部标记。
                    until = max(0, len(reply) - 64)
                    if until > sent:
                        writer({"type": "delta", "text": reply[sent:until]})
                        sent = until
            if not reply.strip():
                raise ValueError("空回复")
            if sent < len(reply):
                writer({"type": "delta", "text": reply[sent:]})
            return {"reply": reply}
        except Exception as error:
            return self.fail(error)

    def check(self, state: ConsultationState) -> dict:
        # 纯 Python 格式检查，不再调用模型，不评判咨询语义，也不触发重写。
        # delta 已可能发出；done 表示本轮完成，前端据此决定保存。
        reply = state["reply"]
        if not reply.strip() or len(reply) > 8000 or unsafe_reply(reply):
            return self.fail(ValueError("输出格式不合格"))
        get_stream_writer()({"type": "done", "reply": reply})
        return {}

    @staticmethod
    def initial(messages: list[dict]) -> ConsultationState:
        # 每次请求重新建状态；历史由调用方传入，不从 checkpointer 恢复。
        validated = ChatRequest.model_validate({"messages": messages})
        return {"messages": [message.model_dump() for message in validated.messages], "assessment": None, "reply": "", "failure": None}

    async def reply(self, messages: list[dict]) -> dict:
        # 非流式入口：ainvoke 跑完整张图，返回最终状态。
        with tracing_context(enabled=False):  # 不向外部追踪服务上传会话。
            result = await self.graph.ainvoke(self.initial(messages))
        return result["failure"] or {"reply": result["reply"]}

    async def stream(self, messages: list[dict]):
        # 流式入口：astream 仍执行同一张图，只是途中交付 custom 事件。
        # ASGI断开会反复取消所在的AnyIO作用域。独立任务只接收一次取消，
        # 才能等LangGraph和上游HTTP完整清理，而不是遗留后台生成。
        queue = asyncio.Queue(maxsize=32)

        async def produce():
            try:
                with tracing_context(enabled=False):
                    source = self.graph.astream(self.initial(messages), stream_mode="custom", version="v2")
                    async with aclosing(source):
                        async for part in source:
                            await queue.put(part["data"])
            except asyncio.CancelledError:
                raise
            except Exception as error:
                await queue.put(error)
            await queue.put(None)

        producer = asyncio.create_task(produce())
        try:
            # 这是传输队列的消费循环，不是 Agent 的“决策 → 工具 → 再决策”。
            while True:
                event = await queue.get()
                if event is None:
                    break
                if isinstance(event, Exception):
                    raise event
                yield event  # 不对外传完整图状态。
        finally:
            producer.cancel()
            with anyio.CancelScope(shield=True):
                await asyncio.gather(producer, return_exceptions=True)


class DualCounselor:
    """一张固定图；只在所有结构校验成功后返回可落盘的完整轮次。"""
    def __init__(self, settings, *, role_clients, retrievers=None):
        from .runtime import RunContext
        from .state import DualState
        self.settings = settings
        self.clients = role_clients
        self.retrievers = retrievers if retrievers is not None else {
            role: getattr(client, 'retriever', None) for role, client in role_clients.items()}
        builder = StateGraph(DualState, context_schema=RunContext)
        builder.add_node('analysis', self.analyze)
        builder.add_node('dialogue', self.respond)
        builder.add_node('check', self.check)
        builder.add_edge(START, 'analysis')
        builder.add_edge('analysis', 'dialogue')
        builder.add_edge('dialogue', 'check')
        builder.add_edge('check', END)
        self.graph = builder.compile()

    @property
    def configured(self):
        return all(self.clients[role].configured for role in ('analysis', 'dialogue'))

    async def analyze(self, state, runtime: Runtime):
        from .prompts import role_messages
        from .runtime import run_role
        from .state import AnalysisBrief, merge_analysis
        brief = await run_role(role='analysis', client=self.clients['analysis'],
            messages=role_messages(self.settings, 'analysis', AnalysisBrief, history=state['messages'],
                previous_state=state['previous_state'], entry_context=state['entry_context']),
            schema=AnalysisBrief, retriever=self.retrievers.get('analysis'), context=runtime.context)
        merged = merge_analysis(brief, state['previous_state'], state['messages'])
        checked_brief = {**brief.model_dump(), 'statements': merged['statements'], 'hypotheses': merged['hypotheses']}
        return {'analysis': checked_brief, 'session_state': merged}

    async def respond(self, state, runtime: Runtime):
        from .prompts import role_messages
        from .runtime import run_role
        from .state import DialogueTurn
        turn = await run_role(role='dialogue', client=self.clients['dialogue'],
            messages=role_messages(self.settings, 'dialogue', DialogueTurn, history=state['messages'],
                previous_state=state['session_state'], entry_context=state['entry_context'], analysis=state['analysis']),
            schema=DialogueTurn, retriever=self.retrievers.get('dialogue'), context=runtime.context)
        return {'dialogue': turn.model_dump()}

    def check(self, state, runtime: Runtime):
        from .prompts import PROMPT_VERSION
        from .state import DialogueTurn, SessionState, validate_quotes
        turn = DialogueTurn.model_validate(state['dialogue'])
        validate_quotes(turn.evidence, state['messages'])
        if unsafe_reply(turn.reply):
            raise ValueError('内部格式不能作为公开回复')
        merged = {**state['session_state'], 'last_dialogue': turn.model_dump(),
                  'materials': [*state['session_state']['materials'], *runtime.context.materials]}
        merged = SessionState.model_validate(merged).model_dump()
        result = {'reply': turn.reply, 'analysis': state['analysis'], 'dialogue': turn.model_dump(),
                  'session_state': merged, 'usage': {**runtime.context.budget.summary(), 'provider_usage': runtime.context.usage},
                  'models': {role: {'provider': client.provider, 'model': client.model} for role, client in self.clients.items()},
                  'prompt_version': PROMPT_VERSION}
        return {'session_state': merged, 'result': result}

    async def run_turn(self, messages, previous_state=None, entry_context=''):
        from .budget import TurnBudget
        from .runtime import RunContext
        from .state import SessionState
        try:
            if not isinstance(entry_context, str) or len(entry_context) > 8000:
                raise ValueError('入口上下文无效')
            validated = ChatRequest.model_validate({'messages': [
                {'role': item['role'], 'content': item['content']} for item in messages]})
            if len(validated.messages) + bool(entry_context) + 1 > 60:
                raise ModelError('对话内容过长，请保存并结束本次咨询。', 413)
            # 带 ID 的持久化原文不能 trim；兼容入口仅补充本轮临时编号。
            raw = [{**item, 'id': item.get('id', f'legacy-{index}')} for index, item in enumerate(messages)]
            ids = [item['id'] for item in raw]
            if any(not isinstance(mid, str) or not mid or len(mid) > 200 for mid in ids) or len(set(ids)) != len(ids):
                raise ValueError('消息 ID 无效')
            previous = SessionState.model_validate(previous_state or {}).model_dump()
            context = RunContext(TurnBudget(max_body_bytes=self.settings.max_body_bytes))
            initial = {'messages': raw, 'previous_state': previous, 'entry_context': entry_context}
            with tracing_context(enabled=False):
                async with asyncio.timeout(context.budget.remaining()):
                    final = await self.graph.ainvoke(initial, context=context)
            return final['result']
        except ModelError:
            raise
        except TimeoutError:
            raise ModelError('本轮回复超时，已停止。', 504) from None
        except Exception:
            raise ModelError('本轮结构或引用校验未通过，未保存助手回复。', 502) from None

    async def reply(self, messages):
        try:
            result = await self.run_turn(messages)
            return {'reply': result['reply']}
        except ModelError as error:
            return {'error': str(error), 'status': error.status}

    async def stream(self, messages):
        result = await self.reply(messages)
        if 'error' in result:
            yield {'type': 'error', **result}
        else:
            yield {'type': 'delta', 'text': result['reply']}
            yield {'type': 'done', **result}
