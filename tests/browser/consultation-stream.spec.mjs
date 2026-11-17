import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';

test('real client, controller and view save only after the in-memory stream completes', async ({ page }) => {
  await page.route('**/api/**', route => route.abort());
  const modules = ['src/client/infrastructure/api-client.js', 'src/client/shared/errors.js', 'shared/contracts/session.js', 'shared/contracts/chat-api.js', 'shared/contracts/report-api.js', 'shared/contracts/sse.js', 'src/client/features/consultation/consultation-controller.js', 'src/client/features/consultation/consultation-state.js', 'src/client/features/consultation/consultation-view.js'];
  for (const name of modules) {
    const body = await fs.readFile(new URL(`../../${name}`, import.meta.url), 'utf8');
    await page.route(`**/__test/${name}`, route => route.fulfill({ contentType: 'text/javascript', body }));
  }
  await page.goto('/');
  await page.evaluate(async () => {
    const { createApiClient } = await import('/__test/src/client/infrastructure/api-client.js');
    const { createConsultationController } = await import('/__test/src/client/features/consultation/consultation-controller.js');
    const { createConsultationView } = await import('/__test/src/client/features/consultation/consultation-view.js');
    const session = { messages: [] }; const saves = [];
    let source, started;
    const ready = new Promise(resolve => { started = resolve; });
    const api = createApiClient({ baseUrl: '', fetchImpl: async () => new Response(new ReadableStream({ start(c) { source = c; started(); } }), { headers: { 'content-type': 'text/event-stream' } }) });
    const view = createConsultationView(document);
    const controller = createConsultationController({ api, view, repository: { saveCurrentSession: s => saves.push(JSON.stringify(s.messages)) }, getSession: () => session, setSession() {}, onStartReport() {}, onReturnToRoom() {} });
    controller.openAtStart();
    window.streamTest = { saves, session, controller, pending: controller.sendMessage('你好'), emit(event, payload) { source.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...payload })}\n\n`)); }, close() { source.close(); } };
    await ready;
    window.streamTest.emit('delta', { text: '正在生成' });
  });
  await expect(page.locator('#chat [data-streaming] .bubble')).toHaveText('正在生成');
  expect(await page.evaluate(() => window.streamTest.session.messages.map(m => m.role))).toEqual(['user']);
  await page.evaluate(async () => { window.streamTest.emit('done', { reply: '正在生成' }); window.streamTest.close(); await window.streamTest.pending; });
  await expect(page.locator('#chat [data-streaming]')).toHaveCount(0);
  expect(await page.evaluate(() => window.streamTest.session.messages.map(m => m.content))).toEqual(['你好', '正在生成']);
});

test('stream preview is escaped, removable, and final message is rendered once', async ({ page }) => {
  await page.route('**/api/**', route => route.abort());
  await page.goto('/');
  const source = await fs.readFile(new URL('../../src/client/features/consultation/consultation-view.js', import.meta.url), 'utf8');
  const result = await page.evaluate(async source => {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const { createConsultationView } = await import(url); URL.revokeObjectURL(url);
    const view = createConsultationView(document);
    if (!view.updateStreaming) return { missing: true };
    view.renderDraft({ messages: [] });
    const count = document.querySelectorAll('#chat .message').length;
    view.updateStreaming('半句 <img src=x onerror="window.bad=true">');
    view.updateStreaming('完整 <img src=x onerror="window.bad=true">');
    const streaming = document.querySelector('#chat [data-streaming]');
    const safe = !streaming.querySelector('img') && streaming.textContent.includes('<img');
    const copyHidden = streaming.querySelector('.copy').hidden;
    view.removeStreaming();
    const cleared = document.querySelectorAll('#chat .message').length === count;
    view.renderMessage('assistant', '最终回复');
    return { safe, copyHidden, cleared, finalCount: document.querySelectorAll('#chat .message').length - count };
  }, source);
  expect(result).toEqual({ safe: true, copyHidden: true, cleared: true, finalCount: 1 });
});
