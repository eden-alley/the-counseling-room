import assert from 'node:assert/strict';
import test from 'node:test';
import { createMiMoClient } from '../../server/services/mimo-client.js';

const input = [{ role: 'user', content: 'hello' }];
const schema = { parse(value) { if (value?.goal !== 'clear') throw Error('invalid'); return value; } };
function payload(content) { return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { 'content-type': 'application/json' } }); }
function sse(parts) { return new Response(new ReadableStream({ start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } }); }
const frame = text => `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`;
const finished = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
const client = (fetchImpl, extra = {}) => createMiMoClient({ url: 'https://model.invalid', apiKey: 'test-only', model: 'fake', fetchImpl, retryDelayMs: 0, ...extra });

test('structured call validates JSON separately without disabling public output filtering', async () => {
  const c = client(async () => payload('{"goal":"clear"}'));
  assert.equal(typeof c.completeStructured, 'function');
  assert.deepEqual((await c.completeStructured(input, schema)).data, { goal: 'clear' });
  const unsafe = client(async () => payload('conversation_analysis: private'));
  assert.equal((await unsafe.complete(input)).status, 502);
});

test('structured format and authentication failures are not retried', async () => {
  for (const response of [() => payload('not-json'), () => payload('{"goal":"wrong"}'), () => new Response('', { status: 401 })]) {
    let calls = 0;
    const c = client(async () => { calls++; return response(); });
    assert.equal(typeof c.completeStructured, 'function');
    const result = await c.completeStructured(input, schema);
    assert.ok(result.error); assert.equal(calls, 1);
  }
});

test('transient failures retry up to three attempts and success stops retries', async () => {
  let calls = 0;
  const c = client(async () => { calls++; return calls < 3 ? new Response('', { status: 503 }) : payload('{"goal":"clear"}'); });
  assert.equal(typeof c.completeStructured, 'function');
  assert.deepEqual((await c.completeStructured(input, schema)).data, { goal: 'clear' });
  assert.equal(calls, 3);
  calls = 0;
  const exhausted = client(async () => { calls++; return new Response('', { status: 429 }); });
  assert.equal((await exhausted.completeStructured(input, schema)).status, 429); assert.equal(calls, 3);
});

test('stream retries before text only, joins partial SSE lines, and requires a stop marker', async () => {
  let calls = 0;
  const content = frame('你好') + frame('。') + finished;
  const c = client(async (_url, options) => { calls++; assert.equal(JSON.parse(options.body).stream, true); return calls === 1 ? new Response('', { status: 500 }) : sse([content.slice(0, 13), content.slice(13)]); });
  assert.equal(typeof c.stream, 'function');
  const chunks = []; for await (const text of c.stream(input)) chunks.push(text);
  assert.deepEqual(chunks, ['你好', '。']); assert.equal(calls, 2);
  calls = 0;
  const broken = client(async () => { calls++; return sse([frame('半句')]); });
  const seen = [];
  await assert.rejects(async () => { for await (const t of broken.stream(input)) seen.push(t); });
  assert.deepEqual(seen, ['半句']); assert.equal(calls, 1);
});

test('stream ignores hidden reasoning, blocks tool calls, and does not accept length truncation', async () => {
  for (const body of [
    'data: {"choices":[{"delta":{"tool_calls":[{}]},"finish_reason":null}]}\n\n',
    frame('unfinished') + 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n',
  ]) {
    const c = client(async () => sse([body])); assert.equal(typeof c.stream, 'function');
    await assert.rejects(async () => { for await (const _ of c.stream(input)) {} });
  }
  const c = client(async () => sse(['data: {"choices":[{"delta":{"reasoning_content":"secret"},"finish_reason":null}]}\n\n', frame('visible'), finished]));
  let text = ''; for await (const t of c.stream(input)) text += t;
  assert.equal(text, 'visible');
});

test('abort cancels an outstanding structured request without retries', async () => {
  let calls = 0; const controller = new AbortController();
  const c = client(async () => { calls++; controller.abort(); throw new DOMException('aborted', 'AbortError'); });
  assert.equal(typeof c.completeStructured, 'function');
  await assert.rejects(c.completeStructured(input, schema, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('upstream timeout is bounded and retried, pre-aborted input never calls fetch', async () => {
  let calls = 0;
  const c = client(async () => { calls++; return new Promise(() => {}); }, { timeoutMs: 10 });
  assert.equal(typeof c.completeStructured, 'function');
  assert.equal((await c.completeStructured(input, schema)).status, 504); assert.equal(calls, 3);
  const controller = new AbortController(); controller.abort(); calls = 0;
  await assert.rejects(c.completeStructured(input, schema, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
});
