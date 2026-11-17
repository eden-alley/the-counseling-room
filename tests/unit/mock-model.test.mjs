import assert from 'node:assert/strict';
import test from 'node:test';

test('mock model supports graph and reports without using fetch', async () => {
  const module = await import('../../server/services/mock-model-client.js').catch(() => ({}));
  assert.equal(typeof module.createMockModelClient, 'function');
  const client = module.createMockModelClient({ delayMs: 0 });
  const { createChatService } = await import('../../server/services/chat-service.js');
  const service = createChatService({ config: { prompts: { system: '', consultantCorpus: '' } }, modelClient: client });
  const result = await service.reply([{ role: 'user', content: 'hello' }]);
  assert.match(result.reply, /模拟响应/);
  const audit = await client.complete([{ role: 'user', content: '任务：审查以下咨询记录的信息缺口。' }]);
  assert.deepEqual(JSON.parse(audit.reply), { questions: [] });
  const report = await client.complete([{ role: 'user', content: '任务：生成面向用户的最终咨询报告。' }]);
  assert.match(report.reply, /模拟/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(async () => { for await (const _ of client.stream([], { signal: controller.signal })) {} }, { name: 'AbortError' });
});
