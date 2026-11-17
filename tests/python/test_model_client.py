import asyncio
import json
import gzip

import httpx
import pytest
from pydantic import BaseModel, ValidationError

from backend.model_client import MiMoClient, MockModelClient, ModelError


MESSAGES = [{"role": "user", "content": "你好"}]


async def test_attempt_deadline_is_not_shortened_by_httpx_default_timeout():
    timeouts = []

    class SSE(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield event(content="ok") + event(finish="stop") + b"data: [DONE]\n\n"

    async def handler(request):
        timeouts.append(request.extensions['timeout'])
        if json.loads(request.content)['stream']:
            return httpx.Response(200, headers={'content-type': 'text/event-stream'}, stream=SSE())
        return httpx.Response(200, json=response_body('ok'))

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as transport:
        client = MiMoClient(url='https://model.invalid', api_key='test', model='fake', http_client=transport)
        assert (await client.complete(MESSAGES))['reply'] == 'ok'
        assert ''.join([part async for part in client.stream(MESSAGES)]) == 'ok'
    assert timeouts == [{'connect': None, 'read': None, 'write': None, 'pool': None}] * 2


async def test_compressed_http_stream_is_decoded_before_sse_parsing():
    class Compressed(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield gzip.compress(event(content='正常') + event(finish='stop') + b'data: [DONE]\n\n')

    async def handler(request):
        return httpx.Response(200, headers={'content-type': 'text/event-stream', 'content-encoding': 'gzip'}, stream=Compressed())

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as transport:
        client = MiMoClient(url='https://model.invalid', api_key='test', model='fake', http_client=transport)
        assert ''.join([part async for part in client.stream(MESSAGES)]) == '正常'


def response_body(reply: str, *, usage: dict | None = None) -> dict:
    return {
        "choices": [{"message": {"role": "assistant", "content": reply}}],
        "usage": usage or {"total_tokens": 4},
    }


def event(*, content: str = "", finish: str | None = None, delta: dict | None = None) -> bytes:
    choice = {"delta": delta or {"content": content}, "finish_reason": finish}
    return f"data: {json.dumps({'choices': [choice]}, ensure_ascii=False)}\n\n".encode()


class Reflection(BaseModel):
    goal: str | None
    statements: list[str]
    hypotheses: list[str]
    strategy: str


def make_client(handler, **kwargs) -> MiMoClient:
    transport = httpx.MockTransport(handler)
    client = httpx.AsyncClient(transport=transport)
    return MiMoClient(url="https://model.invalid/v1", api_key="test-only", model="mimo", http_client=client, **kwargs)


@pytest.mark.asyncio
async def test_complete_returns_trimmed_reply_and_usage_without_blocking_report_json():
    async def handler(request):
        return httpx.Response(200, json=response_body('  {"questions": []}  '))

    client = make_client(handler)
    try:
        result = await client.complete(MESSAGES)
        assert result == {"reply": '{"questions": []}', "usage": {"total_tokens": 4}}
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_complete_retries_transient_statuses_three_times(monkeypatch):
    attempts = 0
    delays = []

    async def handler(request):
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            return httpx.Response(503)
        return httpx.Response(200, json=response_body("ok"))

    async def no_wait(delay):
        delays.append(delay)

    monkeypatch.setattr("backend.model_client.asyncio.sleep", no_wait)
    client = make_client(handler)
    try:
        assert (await client.complete(MESSAGES))["reply"] == "ok"
        assert attempts == 3
        assert delays == [0.5, 1.0]
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_complete_retries_rate_limit_status(monkeypatch):
    attempts = 0
    delays = []

    async def handler(request):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(429)
        return httpx.Response(200, json=response_body("ok"))

    async def no_wait(delay):
        delays.append(delay)

    monkeypatch.setattr("backend.model_client.asyncio.sleep", no_wait)
    client = make_client(handler)
    try:
        assert (await client.complete(MESSAGES))["reply"] == "ok"
        assert attempts == 2
        assert delays == [0.5]
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_complete_does_not_retry_client_errors(monkeypatch):
    attempts = 0

    async def handler(request):
        nonlocal attempts
        attempts += 1
        return httpx.Response(400) if attempts == 1 else httpx.Response(200, content=b"not-json")

    async def no_wait(delay):
        pytest.fail("4xx and invalid response JSON must not be retried")

    monkeypatch.setattr("backend.model_client.asyncio.sleep", no_wait)
    client = make_client(handler)
    try:
        with pytest.raises(ModelError) as error:
            await client.complete(MESSAGES)
        assert error.value.status == 400
        assert error.value.retryable is False
        assert attempts == 1
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_complete_does_not_retry_malformed_json(monkeypatch):
    attempts = 0

    async def handler(request):
        nonlocal attempts
        attempts += 1
        return httpx.Response(200, content=b"not-json")

    async def no_wait(delay):
        pytest.fail("invalid response JSON must not be retried")

    monkeypatch.setattr("backend.model_client.asyncio.sleep", no_wait)
    client = make_client(handler)
    try:
        with pytest.raises(ModelError) as error:
            await client.complete(MESSAGES)
        assert error.value.retryable is False
        assert attempts == 1
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_complete_structured_validates_schema_and_does_not_retry_validation_failure(monkeypatch):
    attempts = 0

    async def handler(request):
        nonlocal attempts
        attempts += 1
        return httpx.Response(200, json=response_body('{"goal": null, "statements": []}'))

    async def no_wait(delay):
        pytest.fail("schema failures must not be retried")

    monkeypatch.setattr("backend.model_client.asyncio.sleep", no_wait)
    client = make_client(handler)
    try:
        with pytest.raises(ModelError) as error:
            await client.complete_structured(MESSAGES, Reflection)
        assert error.value.retryable is False
        assert attempts == 1
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_complete_structured_returns_validated_model():
    async def handler(request):
        return httpx.Response(200, json=response_body('{"goal": null, "statements": [], "hypotheses": [], "strategy": "reflect"}'))

    client = make_client(handler)
    try:
        result = await client.complete_structured(MESSAGES, Reflection)
        assert result == Reflection(goal=None, statements=[], hypotheses=[], strategy="reflect")
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_structured_json_text_may_contain_public_output_markers():
    phrase = "conversation_analysis"
    payload = json.dumps(
        {"goal": None, "statements": [phrase], "hypotheses": [], "strategy": "reflect"}
    )
    calls = 0

    async def handler(request):
        nonlocal calls
        calls += 1
        return httpx.Response(200, json=response_body(payload))

    client = make_client(handler)
    try:
        result = await client.complete_structured(MESSAGES, Reflection)
        assert result.statements == [phrase]
        with pytest.raises(ModelError):
            await client.complete(MESSAGES)
        assert calls == 2
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_complete_propagates_cancellation_without_retry():
    attempts = 0

    async def handler(request):
        nonlocal attempts
        attempts += 1
        raise asyncio.CancelledError()

    client = make_client(handler)
    try:
        with pytest.raises(asyncio.CancelledError):
            await client.complete(MESSAGES)
        assert attempts == 1
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_complete_times_out_entire_attempt_then_retries(monkeypatch):
    attempts = 0

    async def handler(request):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            await asyncio.Event().wait()
        return httpx.Response(200, json=response_body("after timeout"))

    async def no_wait(delay):
        return None

    monkeypatch.setattr("backend.model_client.asyncio.sleep", no_wait)
    client = make_client(handler, timeout=0.02)
    try:
        assert (await client.complete(MESSAGES))["reply"] == "after timeout"
        assert attempts == 2
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_stream_requires_stop_and_done_and_decodes_split_utf8_and_crlf():
    payload = (
        b'data: {"choices":[{"delta":{"reasoning_content":"secret"},"finish_reason":null}]}\r\n\r\n'
        + 'data: {"choices":[{"delta":{"content":"你"},"finish_reason":null}]}\r\n\r\n'.encode()
        + b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\n'
        + b"data: [DONE]\r\n\r\n"
    )
    split = payload.index("你".encode()) + 1

    class SplitStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield payload[:split]
            yield payload[split:]

    async def handler(request):
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=SplitStream())

    client = make_client(handler)
    try:
        assert [piece async for piece in client.stream(MESSAGES)] == ["你"]
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_stream_retries_before_first_text_but_never_after_emitting(monkeypatch):
    attempts = 0
    delays = []

    async def handler(request):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            class InterruptedStream(httpx.AsyncByteStream):
                async def __aiter__(self):
                    yield b'data: {"choices":[{"delta":{"reasoning_content":"hidden"},"finish_reason":null}]}\n\n'
                    raise httpx.ReadError("connection interrupted")

            return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=InterruptedStream())

        class CompleteStream(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield event(content="hello") + event(finish="stop") + b"data: [DONE]\n\n"

        return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=CompleteStream())

    async def no_wait(delay):
        delays.append(delay)

    monkeypatch.setattr("backend.model_client.asyncio.sleep", no_wait)
    client = make_client(handler)
    try:
        assert [piece async for piece in client.stream(MESSAGES)] == ["hello"]
        assert attempts == 2
        assert delays == [0.5]
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_stream_rejects_length_tool_calls_and_missing_done_without_retry(monkeypatch):
    for frame, end in [
        (event(content="x", finish="length"), b"data: [DONE]\n\n"),
        (event(delta={"tool_calls": [{"id": "x"}]}), event(finish="stop") + b"data: [DONE]\n\n"),
        (event(content="x", finish="stop"), b""),
    ]:
        attempts = 0

        async def handler(request):
            nonlocal attempts
            attempts += 1
            class ScenarioStream(httpx.AsyncByteStream):
                async def __aiter__(self):
                    yield frame + end

            return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=ScenarioStream())

        async def no_wait(delay):
            pytest.fail("invalid stream must not be retried after text or terminal validation")

        monkeypatch.setattr("backend.model_client.asyncio.sleep", no_wait)
        client = make_client(handler)
        try:
            with pytest.raises(ModelError):
                _ = [piece async for piece in client.stream(MESSAGES)]
            assert attempts == 1
        finally:
            await client.aclose()


@pytest.mark.asyncio
async def test_stream_does_not_accept_done_frame_without_empty_line_terminator():
    attempts = 0

    class TruncatedDone(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield event(content="partial") + event(finish="stop") + b"data: [DONE]"

    async def handler(request):
        nonlocal attempts
        attempts += 1
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=TruncatedDone())

    client = make_client(handler)
    try:
        with pytest.raises(ModelError):
            _ = [piece async for piece in client.stream(MESSAGES)]
        assert attempts == 1
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_stream_does_not_retry_connection_failure_after_emitting_text(monkeypatch):
    attempts = 0

    class InterruptedAfterText(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield event(content="visible")
            raise httpx.ReadError("connection interrupted")

    async def handler(request):
        nonlocal attempts
        attempts += 1
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=InterruptedAfterText())

    async def no_wait(delay):
        pytest.fail("a partial reply must not be repeated")

    monkeypatch.setattr("backend.model_client.asyncio.sleep", no_wait)
    client = make_client(handler)
    try:
        generator = client.stream(MESSAGES)
        assert await anext(generator) == "visible"
        with pytest.raises(ModelError) as error:
            await anext(generator)
        assert error.value.retryable is True
        assert attempts == 1
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_stream_rejects_invalid_utf8_without_retry(monkeypatch):
    attempts = 0

    class InvalidUtf8(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b"data: \xff\n\n"

    async def handler(request):
        nonlocal attempts
        attempts += 1
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=InvalidUtf8())

    async def no_wait(delay):
        pytest.fail("invalid UTF-8 must not be retried")

    monkeypatch.setattr("backend.model_client.asyncio.sleep", no_wait)
    client = make_client(handler)
    try:
        with pytest.raises(ModelError) as error:
            _ = [piece async for piece in client.stream(MESSAGES)]
        assert error.value.retryable is False
        assert attempts == 1
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_stream_rejects_oversized_sse_frame_without_retry(monkeypatch):
    attempts = 0

    class OversizedFrame(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b"data: " + (b"x" * (128 * 1024 + 1)) + b"\n\n"

    async def handler(request):
        nonlocal attempts
        attempts += 1
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=OversizedFrame())

    async def no_wait(delay):
        pytest.fail("an oversized SSE frame must not be retried")

    monkeypatch.setattr("backend.model_client.asyncio.sleep", no_wait)
    client = make_client(handler)
    try:
        with pytest.raises(ModelError) as error:
            _ = [piece async for piece in client.stream(MESSAGES)]
        assert error.value.retryable is False
        assert attempts == 1
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_stream_closes_upstream_when_consumer_cancels():
    closed = False

    class LongStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield event(content="first")
            await asyncio.Event().wait()

        async def aclose(self):
            nonlocal closed
            closed = True

    async def handler(request):
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=LongStream())

    client = make_client(handler)
    try:
        generator = client.stream(MESSAGES)
        assert await anext(generator) == "first"
        await generator.aclose()
        assert closed
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_only_owned_http_client_is_closed():
    external = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200)))
    client = MiMoClient(url="https://model.invalid", api_key="", model="m", http_client=external)
    assert client.configured is False
    await client.aclose()
    assert not external.is_closed
    await external.aclose()


@pytest.mark.asyncio
async def test_mock_client_returns_explicit_simulation_and_report_contracts():
    mock = MockModelClient(delay=0)
    assert mock.configured is True
    assert (await mock.complete([{"role": "user", "content": "任务：审查以下咨询记录"}]))["reply"] == '{"questions": []}'
    report = await mock.complete([{"role": "user", "content": "任务：生成面向用户的最终咨询报告"}])
    assert "模拟咨询报告" in report["reply"]
    structured = await mock.complete_structured(MESSAGES, Reflection)
    assert structured == Reflection(goal=None, statements=[], hypotheses=[], strategy="reflect")
    pieces = [piece async for piece in mock.stream(MESSAGES)]
    assert "模拟响应" in "".join(pieces)
    await mock.aclose()
