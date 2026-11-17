import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../server/config.js';
import { createServer } from '../../server/create-server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const assessment = { goal: null, statements: [], hypotheses: [], strategy: 'reflect' };

test('chat stream sends only public SSE events and preserves JSON mode', async () => {
  const server = createServer({ config: loadConfig({}, root), modelClient: {
    async completeStructured() { return { data: assessment }; },
    async *stream() { yield '这是模拟文本'.repeat(20); },
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/chat`;
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }], stream: true }) });
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const body = await response.text();
    assert.match(body, /event: delta/); assert.match(body, /event: done/); assert.doesNotMatch(body, /hypotheses|assessment/);
    const json = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }) });
    assert.deepEqual(await json.json(), { reply: '这是模拟文本'.repeat(20) });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('default mode is mock, unknown modes fail closed', () => {
  assert.equal(loadConfig({}, root).mode, 'mock');
  assert.equal(loadConfig({ MODEL_MODE: 'mimo' }, root).mode, 'mimo');
  assert.throws(() => loadConfig({ MODEL_MODE: 'typo' }, root));
});

test('disconnect propagates cancellation into an active model stream', async () => {
  let cancelled; const cancellation = new Promise(resolve => { cancelled = resolve; });
  const server = createServer({ config: loadConfig({}, root), modelClient: {
    async completeStructured() { return { data: assessment }; },
    async *stream(_messages, { signal }) {
      yield 'a'.repeat(100);
      await new Promise(resolve => { const stop = () => { cancelled(true); resolve(); }; signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop(); });
      signal.throwIfAborted();
    },
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/chat`, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'test' }] }) });
    const reader = response.body.getReader(); await reader.read(); controller.abort();
    let timer;
    try { assert.equal(await Promise.race([cancellation, new Promise(resolve => { timer = setTimeout(() => resolve(false), 1000); })]), true); }
    finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
