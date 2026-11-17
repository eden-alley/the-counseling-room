"""MiMo 模型 HTTP 客户端与确定性本地假模型。"""

from __future__ import annotations

import asyncio
import codecs
import json
import re
from collections.abc import AsyncIterator, Sequence
from typing import Any, TypeVar

import httpx
from pydantic import BaseModel, ValidationError


Schema = TypeVar("Schema", bound=BaseModel)
_MAX_SSE_BUFFER = 128 * 1024
_UNSAFE_OUTPUT = re.compile(
    r"<tool_call\b|<function=|<parameter=|code_interpreter|"
    r"conversation_analysis|analysis_update|current_stage|当前(?:咨询)?阶段\s*[:：]",
    re.IGNORECASE,
)
_INVALID_REPLY = "模型服务返回了无法读取的内容。"
_INVALID_STREAM = "本次回复生成异常，已为你拦截。请重新发送。"


class ModelError(Exception):
    """安全、可展示的模型调用错误，不包含密钥或上游响应原文。"""

    def __init__(self, message: str, status: int = 502, retryable: bool = False):
        super().__init__(message)
        self.status = status
        self.retryable = retryable


def _safe_failure(error: BaseException) -> ModelError:
    if isinstance(error, ModelError):
        return error
    if isinstance(error, (TimeoutError, httpx.TimeoutException)):
        return ModelError("模型响应超时，请稍后重试。", 504, True)
    if isinstance(error, httpx.RequestError):
        return ModelError("暂时无法连接模型服务，请稍后重试。", 502, True)
    return ModelError("模型服务返回了无法读取的内容。", 502, False)


def _validate_reply(reply: Any, *, check_public_markers: bool = True) -> str:
    if not isinstance(reply, str) or not reply.strip():
        raise ModelError("模型没有返回有效回复。", 502, False)
    if check_public_markers and _UNSAFE_OUTPUT.search(reply):
        raise ModelError(_INVALID_STREAM, 502, False)
    return reply.strip()


async def _sse_events(response: httpx.Response) -> AsyncIterator[str]:
    """严格解码 UTF-8，并以空行分隔 SSE 帧；单帧缓冲最多 128 KiB。"""
    decoder = codecs.getincrementaldecoder("utf-8")("strict")
    buffer = ""
    data_lines: list[str] = []

    async def line_ready(line: str) -> str | None:
        nonlocal data_lines
        if line == "":
            if not data_lines:
                return None
            event_data = "\n".join(data_lines)
            data_lines = []
            return event_data
        if line.startswith(":"):
            return None
        field, separator, value = line.partition(":")
        if field == "data":
            data_lines.append(value[1:] if value.startswith(" ") else value)
        return None

    def check_line_size(line: str) -> None:
        buffered = len(line.encode("utf-8")) + sum(len(part.encode("utf-8")) for part in data_lines)
        if buffered > _MAX_SSE_BUFFER:
            raise ModelError(_INVALID_REPLY, 502, False)

    try:
        # HTTPX先解压Content-Encoding，再由增量解码器处理UTF-8/SSE。
        async for chunk in response.aiter_bytes():
            buffer += decoder.decode(chunk, final=False)
            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                if line.endswith("\r"):
                    line = line[:-1]
                check_line_size(line)
                event_data = await line_ready(line)
                if event_data is not None:
                    yield event_data
                if len(buffer.encode("utf-8")) + sum(len(part.encode("utf-8")) for part in data_lines) > _MAX_SSE_BUFFER:
                    raise ModelError(_INVALID_REPLY, 502, False)
            if len(buffer.encode("utf-8")) + sum(len(part.encode("utf-8")) for part in data_lines) > _MAX_SSE_BUFFER:
                raise ModelError(_INVALID_REPLY, 502, False)
        buffer += decoder.decode(b"", final=True)
    except UnicodeDecodeError as error:
        raise ModelError(_INVALID_REPLY, 502, False) from error

    # SSE 只派发由空行终止的事件；连接结束时的半帧必须丢弃。


class MiMoClient:
    """OpenAI-compatible MiMo HTTP client with bounded retry and SSE support."""

    def __init__(
        self,
        *,
        url: str,
        api_key: str,
        model: str,
        http_client: httpx.AsyncClient | None = None,
        timeout: float = 30.0,
        retry_delay: float = 0.5,
    ) -> None:
        self.url = url
        self.api_key = api_key
        self.model = model
        self.timeout = timeout
        self.retry_delay = retry_delay
        self.configured = bool(api_key)
        self._owns_client = http_client is None
        self._http = http_client or httpx.AsyncClient()

    async def aclose(self) -> None:
        if self._owns_client:
            await self._http.aclose()

    def _request_json(self, messages: Sequence[dict[str, Any]], *, stream: bool, tokens: int) -> dict[str, Any]:
        return {
            "model": self.model,
            "messages": list(messages),
            "stream": stream,
            "max_completion_tokens": tokens,
            "temperature": 1,
            "top_p": 0.95,
            "thinking": {"type": "disabled"},
        }

    def _headers(self) -> dict[str, str]:
        return {
            "content-type": "application/json",
            "authorization": f"Bearer {self.api_key}",
        }

    @staticmethod
    def _check_status(response: httpx.Response) -> None:
        if response.is_success:
            return
        status = response.status_code
        if status == 429:
            raise ModelError("模型服务繁忙或额度不足，请稍后重试。", 429, True)
        if status >= 500:
            raise ModelError("模型服务返回错误。", 502, True)
        raise ModelError("模型服务返回错误。", status, False)

    async def _complete_once(
        self,
        messages: Sequence[dict[str, Any]],
        tokens: int,
        *,
        public_output: bool = True,
    ) -> dict[str, Any]:
        async with self._http.stream(
            "POST",
            self.url,
            headers=self._headers(),
            json=self._request_json(messages, stream=False, tokens=tokens),
            timeout=None,  # 统一由外层30秒attempt期限控制。
        ) as response:
            self._check_status(response)
            try:
                payload = json.loads(await response.aread())
            except (json.JSONDecodeError, UnicodeDecodeError) as error:
                raise ModelError(_INVALID_REPLY, 502, False) from error
        if not isinstance(payload, dict):
            raise ModelError(_INVALID_REPLY, 502, False)
        choices = payload.get("choices")
        message = choices[0].get("message") if isinstance(choices, list) and choices and isinstance(choices[0], dict) else None
        if not isinstance(message, dict) or message.get("tool_calls") or message.get("function_call"):
            raise ModelError("模型没有返回有效回复。", 502, False)
        reply = _validate_reply(message.get("content"), check_public_markers=public_output)
        return {"reply": reply, "usage": payload.get("usage")}

    async def _complete_with_retries(
        self,
        messages: Sequence[dict[str, Any]],
        max_completion_tokens: int,
        *,
        public_output: bool,
    ) -> dict[str, Any]:
        for attempt in range(3):
            try:
                async with asyncio.timeout(self.timeout):
                    return await self._complete_once(
                        messages,
                        max_completion_tokens,
                        public_output=public_output,
                    )
            except asyncio.CancelledError:
                raise
            except Exception as error:
                failure = _safe_failure(error)
                if not failure.retryable or attempt == 2:
                    raise failure from error
            await asyncio.sleep(self.retry_delay * (attempt + 1))
        raise RuntimeError("Unreachable")

    async def complete(
        self,
        messages: Sequence[dict[str, Any]],
        *,
        max_completion_tokens: int = 1200,
    ) -> dict[str, Any]:
        return await self._complete_with_retries(
            messages,
            max_completion_tokens,
            public_output=True,
        )

    async def complete_structured(
        self,
        messages: Sequence[dict[str, Any]],
        schema: type[Schema],
        *,
        max_completion_tokens: int = 2400,
    ) -> Schema:
        result = await self._complete_with_retries(
            messages,
            max_completion_tokens,
            public_output=False,
        )
        try:
            value = json.loads(result["reply"])
            return schema.model_validate(value)
        except (json.JSONDecodeError, ValidationError, TypeError, ValueError) as error:
            raise ModelError(_INVALID_REPLY, 502, False) from error

    async def _stream_once(self, messages: Sequence[dict[str, Any]], tokens: int) -> AsyncIterator[str]:
        async with self._http.stream(
            "POST",
            self.url,
            headers=self._headers(),
            json=self._request_json(messages, stream=True, tokens=tokens),
            timeout=None,
        ) as response:
            self._check_status(response)
            if "text/event-stream" not in response.headers.get("content-type", "").lower():
                raise ModelError(_INVALID_REPLY, 502, False)
            stopped = False
            emitted = False
            events = _sse_events(response)
            try:
                async for raw_event in events:
                    if raw_event == "[DONE]":
                        if not stopped or not emitted:
                            raise ModelError("模型没有返回有效回复。", 502, False)
                        return
                    try:
                        data = json.loads(raw_event)
                    except (json.JSONDecodeError, TypeError) as error:
                        raise ModelError(_INVALID_REPLY, 502, False) from error
                    choices = data.get("choices") if isinstance(data, dict) else None
                    choice = choices[0] if isinstance(choices, list) and choices and isinstance(choices[0], dict) else None
                    if choice is None:
                        continue
                    delta = choice.get("delta") or {}
                    finish = choice.get("finish_reason")
                    if not isinstance(delta, dict):
                        raise ModelError(_INVALID_STREAM, 502, False)
                    if stopped or delta.get("tool_calls") or delta.get("function_call"):
                        raise ModelError(_INVALID_STREAM, 502, False)
                    if finish is not None and finish != "stop":
                        raise ModelError("模型回复未完整生成，请重试。", 502, False)
                    text = delta.get("content")
                    if text is not None and not isinstance(text, str):
                        raise ModelError("模型没有返回有效回复。", 502, False)
                    if text:
                        emitted = True
                        yield text
                    if finish == "stop":
                        stopped = True
                raise ModelError("模型回复中断，请重试。", 502, True)
            finally:
                await events.aclose()
                await response.aclose()

    async def stream(
        self,
        messages: Sequence[dict[str, Any]],
        *,
        max_completion_tokens: int = 1200,
    ) -> AsyncIterator[str]:
        emitted = False
        for attempt in range(3):
            try:
                async with asyncio.timeout(self.timeout):
                    source = self._stream_once(messages, max_completion_tokens)
                    try:
                        async for text in source:
                            emitted = True
                            yield text
                    finally:
                        await source.aclose()
                    return
            except asyncio.CancelledError:
                raise
            except Exception as error:
                failure = _safe_failure(error)
                if emitted or not failure.retryable or attempt == 2:
                    raise failure from error
            await asyncio.sleep(self.retry_delay * (attempt + 1))


class MockModelClient:
    """Deterministic local fixture; its text is not genuine model analysis."""

    _reply = (
        "【模拟响应，仅用于流程测试】这是本地假模型逐段返回的文字，用来检查流式显示、停止生成以及完成后保存。"
        "这些内容不是对你的经历作出的分析，也不代表真实模型的咨询效果；后续需要获准调用真实模型后再评测。"
    )

    def __init__(self, delay: float = 0.04) -> None:
        self.delay = delay
        self.configured = True

    async def aclose(self) -> None:
        return None

    async def complete(
        self,
        messages: Sequence[dict[str, Any]],
        *,
        max_completion_tokens: int = 1200,
    ) -> dict[str, Any]:
        task = messages[-1].get("content", "") if messages else ""
        if task.startswith("任务：审查以下咨询记录"):
            return {"reply": json.dumps({"questions": []}, ensure_ascii=False), "usage": None}
        if task.startswith("任务：生成面向用户的最终咨询报告"):
            return {"reply": "# 模拟咨询报告\n\n仅用于本地流程测试，未进行真实咨询分析。", "usage": None}
        return {"reply": self._reply, "usage": None}

    async def complete_structured(
        self,
        messages: Sequence[dict[str, Any]],
        schema: type[Schema],
        *,
        max_completion_tokens: int = 2400,
    ) -> Schema:
        value = {"goal": None, "statements": [], "hypotheses": [], "strategy": "reflect"}
        return schema.model_validate(value)

    async def stream(
        self,
        messages: Sequence[dict[str, Any]],
        *,
        max_completion_tokens: int = 1200,
    ) -> AsyncIterator[str]:
        for index in range(0, len(self._reply), 6):
            await asyncio.sleep(self.delay)
            yield self._reply[index : index + 6]
