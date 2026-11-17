import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../server/config.js';
import { createServer } from '../../server/create-server.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function rawRequest(port, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: requestPath }, response => {
      response.resume();
      response.on('end', () => resolve(response));
    });
    request.on('error', reject);
  });
}

test('API routes use the injected model client and static files stay inside dist/web', async () => {
  delete process.env.MIMO_API_KEY;
  const calls = [];
  const modelClient = {
    async completeStructured(messages, schema, options) {
      calls.push({ messages, options });
      return { data: schema.parse({ goal: null, statements: [], hypotheses: [], strategy: 'reflect' }) };
    },
    async *stream(messages, options) {
      calls.push({ messages, options });
      yield '这是由 fake modelClient 返回的回复。';
    },
    async complete(messages, options) {
      calls.push({ messages, options });
      const task = messages.at(-1).content;
      if (task.includes('审查以下咨询记录')) {
        return { reply: JSON.stringify({ questions: ['这个模式还出现在哪些场景？'] }) };
      }
      if (task.includes('生成面向用户的最终咨询报告')) {
        return { reply: '# 本次咨询报告\n\n已整理你的线索。' };
      }
      return { reply: '这是由 fake modelClient 返回的回复。' };
    }
  };
  const config = loadConfig({}, projectRoot);
  const server = createServer({
    config,
    modelClient,
    staticRoot: path.join(projectRoot, 'dist', 'web')
  });
  await listen(server);
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const health = await fetch(`${base}/api/health`);
    assert.deepEqual(await health.json(), { ready: true });

    const chat = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '最近很焦虑。' }] })
    });
    assert.deepEqual(await chat.json(), { reply: '这是由 fake modelClient 返回的回复。' });

    const messages = [
      { role: 'user', content: '我总是在最后确认前拖延。' },
      { role: 'assistant', content: '最近一次是什么情况？' }
    ];
    const audit = await fetch(`${base}/api/report/audit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages })
    });
    assert.deepEqual(await audit.json(), { questions: ['这个模式还出现在哪些场景？'] });

    const report = await fetch(`${base}/api/report/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages, answers: [{ question: '这个模式还出现在哪些场景？', answer: '做作业时也会。' }] })
    });
    assert.match((await report.json()).report, /本次咨询报告/);
    assert.equal(calls.length, 4);
    assert.match(calls[0].messages[0].content, /自然收尾/);
    assert.equal(calls[0].options.maxCompletionTokens, 2400);
    assert.equal(calls[2].options.maxCompletionTokens, 900);
    assert.equal(calls[3].options.maxCompletionTokens, 2200);

    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await index.text(), /今天想从哪里开始/);

    const missing = await fetch(`${base}/not-found.txt`);
    assert.equal(missing.status, 404);

    const traversal = await rawRequest(server.address().port, '/%2e%2e%2fapp.js');
    assert.equal(traversal.statusCode, 400);
  } finally {
    await close(server);
  }
});
