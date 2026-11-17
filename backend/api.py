"""FastAPI接口层：保留前端现有URL、JSON和SSE契约。"""
import asyncio
import json
import time
from contextlib import aclosing, asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import ValidationError
from starlette.exceptions import HTTPException

from .agent.graph import Counselor
from .agent.state import ChatRequest, ReportRequest
from .config import Settings, load_settings
from .model_client import MiMoClient, MockModelClient, ModelError
from .session_api import SessionAPI, SessionBoundaryMiddleware


def create_app(*, settings: Settings | None = None, model_client=None, static_root: Path | None = None,
               session_store=None, role_clients=None) -> FastAPI:
    # Web 入口与运行支撑：输入校验、限流、SSE、断开取消都在此接线。
    # 这些不是 LangChain AgentMiddleware；咨询节点的执行顺序看 agent/graph.py。
    settings = settings or load_settings()
    owns_model = model_client is None
    if model_client is None:
        if settings.mode in {"deepseek", "qwen"}:
            from .deepseek_client import DeepSeekClient
            model_client = DeepSeekClient(settings)
        elif settings.mode == "codex":
            from .codex_client import CodexModelClient
            model_client = CodexModelClient(settings)
        else:
            model_client = MockModelClient() if settings.mode == "mock" else MiMoClient(
                url=settings.url, api_key=settings.api_key, model=settings.model,
            )
    owns_roles = False
    if settings.mode in {"mock", "deepseek", "qwen"}:
        from .agent.graph import DualCounselor
        if role_clients is None:
            if not owns_model and callable(getattr(model_client, 'complete_once', None)):
                role_clients = {'analysis': model_client, 'dialogue': model_client}
            else:
                from .agent.runtime import make_role_clients
                role_clients = make_role_clients(settings)
                owns_roles = True
        counselor = DualCounselor(settings, role_clients=role_clients)
        dual_counselor = counselor
    elif settings.mode == "codex":
        from .codex_client import CodexCounselor
        counselor = CodexCounselor(settings, model_client)
    else:
        counselor = Counselor(settings, model_client)
    if settings.mode not in {"mock", "deepseek", "qwen"}:
        dual_counselor = None
    def chat_ready():
        if dual_counselor is not None:
            return all(bool(getattr(role_clients.get(role), 'configured', False)) for role in ('analysis', 'dialogue'))
        return bool(model_client.configured)
    sessions = SessionAPI(settings, dual_counselor, store=session_store, ready=chat_ready)
    buckets: dict[str, tuple[float, int]] = {}
    operations: set[asyncio.Task] = set()

    @asynccontextmanager
    async def lifespan(app):
        try:
            sessions.startup()
            yield
        finally:
            try:
                # Stop work before closing the clients it may still be using.
                active = list(operations)
                for task in active:
                    task.cancel()
                await asyncio.gather(*active, return_exceptions=True)
                await sessions.shutdown()
            finally:
                owned = ([model_client] if owns_model else []) + (list(role_clients.values()) if owns_roles else [])
                unique = {id(client): client for client in owned}
                await asyncio.gather(*(client.aclose() for client in unique.values()), return_exceptions=True)

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["POST", "GET", "DELETE", "OPTIONS"], allow_headers=["content-type"])
    app.add_middleware(SessionBoundaryMiddleware)
    sessions.attach(app)

    @app.exception_handler(HTTPException)
    async def http_error(request, error):
        return JSONResponse({"error": str(error.detail)}, status_code=error.status_code, headers=error.headers)

    @app.exception_handler(ModelError)
    async def model_error(request, error):
        return JSONResponse({"error": str(error)}, status_code=error.status)

    async def read_body(request: Request, schema, group: str):
        now = time.monotonic()
        # 清除过期桶，避免长时间运行时无限增长。不信任客户端自填的代理IP。
        for key in list(buckets):
            if now - buckets[key][0] >= settings.window_seconds:
                del buckets[key]
        key = f"{group}:{request.client.host if request.client else 'unknown'}"
        started, count = buckets.get(key, (now, 0))
        if count >= settings.max_requests:
            raise HTTPException(429, "发送太频繁，请一分钟后再试。", headers={"retry-after": "60"})
        buckets[key] = (started, count + 1)
        if not (chat_ready() if group == 'chat' else model_client.configured):
            raise HTTPException(503, "服务尚未完成配置。")
        raw = bytearray()
        async for chunk in request.stream():
            if len(raw) + len(chunk) > settings.max_body_bytes:
                raise HTTPException(413, "对话内容过长，请导出后开始新对话。")
            raw.extend(chunk)
        try:
            return schema.model_validate(json.loads(raw))
        except (ValueError, TypeError, ValidationError):
            raise HTTPException(400, "请求内容或对话记录无效。") from None

    async def until_disconnect(request: Request, operation):
        """非流式接口也取消断开连接后的生成，避免后台继续消耗模型。"""
        async def disconnected():
            # 请求体已经读完，直接等ASGI断开事件。避免is_disconnected
            # 内部的CancelScope吞掉本任务的取消，导致finally一直等待。
            while True:
                event = await request.receive()
                if event["type"] == "http.disconnect":
                    return
        task = asyncio.create_task(operation)
        operations.add(task)
        watcher = asyncio.create_task(disconnected())
        try:
            finished, _ = await asyncio.wait([task, watcher], return_when=asyncio.FIRST_COMPLETED)
            if task in finished:
                return await task
            raise asyncio.CancelledError()
        finally:
            task.cancel()
            watcher.cancel()
            await asyncio.gather(task, watcher, return_exceptions=True)
            operations.discard(task)

    @app.get('/api/health')
    async def health():
        return {"ready": chat_ready(), "capabilities": {"sessions_v1": dual_counselor is not None}}

    @app.post('/api/chat')
    async def chat(request: Request):
        body = await read_body(request, ChatRequest, "chat")
        messages = [message.model_dump() for message in body.messages]
        if not body.stream:
            result = await until_disconnect(request, counselor.reply(messages))
            if "error" in result:
                return JSONResponse({"error": result['error']}, status_code=result['status'])
            return result

        async def events():
            source = counselor.stream(messages)
            task = asyncio.current_task()
            operations.add(task)
            try:
                async with aclosing(source):
                    async for event in source:
                        yield f"event: {event['type']}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
            except Exception:
                event = {"type": "error", "error": "本次回复生成异常，请稍后重试。", "status": 502}
                yield f"event: error\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
            finally:
                operations.discard(task)
        return StreamingResponse(events(), media_type="text/event-stream", headers={
            "cache-control": "no-cache, no-transform", "x-accel-buffering": "no", "x-content-type-options": "nosniff",
        })

    async def report(request: Request, audit: bool):
        body = await read_body(request, ReportRequest, "report")
        messages = [message.model_dump() for message in body.messages]
        task = "任务：审查以下咨询记录的信息缺口。只返回 JSON。" if audit else "任务：生成面向用户的最终咨询报告。"
        task += "\n\n咨询记录：\n" + json.dumps(messages, ensure_ascii=False)
        if not audit:
            task += "\n\n补充问答：\n" + json.dumps([answer.model_dump() for answer in body.answers], ensure_ascii=False)
        result = await until_disconnect(request, model_client.complete([
            {"role": "system", "content": settings.report_prompt}, {"role": "user", "content": task},
        ], max_completion_tokens=900 if audit else 2200))
        if not audit:
            return {"report": result["reply"]}
        try:
            text = result["reply"]
            start, end = text.find('{'), text.rfind('}')
            data = json.loads(text[start:end + 1])
            if not isinstance(data.get("questions"), list):
                raise ValueError("没有问题列表")
            questions = [question.strip()[:500] for question in data["questions"] if isinstance(question, str) and question.strip()][:3]
            return {"questions": questions}
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(502, "报告信息审查格式异常，请稍后重试。") from None

    @app.post('/api/report/audit')
    async def audit(request: Request):
        return await report(request, True)

    @app.post('/api/report/generate')
    async def generate(request: Request):
        return await report(request, False)

    if static_root is not None:
        root = Path(static_root).resolve()

        @app.get('/{asset_path:path}')
        async def asset(asset_path: str):
            target = (root / (asset_path or 'index.html')).resolve()
            if not target.is_relative_to(root):
                raise HTTPException(400, "Bad asset path")
            if not target.is_file():
                raise HTTPException(404, "Not Found")
            return FileResponse(target, headers={"x-content-type-options": "nosniff", "cache-control": "no-cache"})

    return app
