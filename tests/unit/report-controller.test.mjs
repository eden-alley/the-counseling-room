import assert from 'node:assert/strict';
import test from 'node:test';
import { createReportController } from '../../src/client/features/report/report-controller.js';

function session(summaryMarkdown = '') { return { id: 's1', startedAt: '2026-01-01T00:00:00.000Z', endedAt: null, updatedAt: '2026-01-01T00:00:00.000Z', entryLabel: '开始探索', messages: [{ role: 'user', content: 'hello' }], summaryMarkdown, title: '开始探索', durationSeconds: 0, messageCount: 0 }; }
function setup({ questions = [], report = '# 新标题\n内容', failure, apiOverrides = {}, repositoryOverrides = {}, buildMessages = value => value.messages } = {}) {
  let current = session('旧总结'); const events = [];
  const view = { open: () => events.push('open'), loading: stage => events.push(`loading:${stage}`), question: (q, i, total) => events.push(`question:${q}:${i}/${total}`), render: value => events.push(`render:${value}`), restore: value => events.push(`restore:${value}`), error: value => events.push(`error:${value}`), download: (name, body) => events.push(`download:${name}:${body}`), toast: value => events.push(`toast:${value}`) };
  const api = { auditReport: async () => questions, generateReport: async () => { if (failure) throw new Error(failure); return report; }, ...apiOverrides };
  const repository = { upsertHistory: saved => events.push(`history:${saved.summaryMarkdown}`), saveCurrentSession: saved => events.push(`save:${saved.summaryMarkdown}`), ...repositoryOverrides };
  const controller = createReportController({ api, repository, view, getSession: () => current, setSession: next => { current = next; }, buildMessages, now: () => '2026-02-03T04:05:06.000Z' });
  return { controller, events, get: () => current, set: next => { current = next; } };
}

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('zero audit questions generate a report immediately', async () => { const { controller, events } = setup(); controller.openSummary(); await controller.startReport(); assert.deepEqual(events, ['open', 'loading:audit', 'loading:generate', 'history:# 新标题\n内容', 'save:# 新标题\n内容', 'render:# 新标题\n内容', 'toast:总结已保存到历史']); });
test('one to three audit questions are presented sequentially', async () => { const { controller, events } = setup({ questions: ['q1', 'q2', 'q3'] }); await controller.startReport(); await controller.answerCurrentQuestion('a1'); await controller.answerCurrentQuestion('a2'); assert.deepEqual(events.filter(event => event.startsWith('question:')), ['question:q1:1/3', 'question:q2:2/3', 'question:q3:3/3']); });
test('skipping an audit question stores an empty answer before generation', async () => { const { controller, events } = setup({ questions: ['q1'] }); await controller.startReport(); await controller.skipCurrentQuestion(); assert.deepEqual(events.slice(-5), ['loading:generate', 'history:# 新标题\n内容', 'save:# 新标题\n内容', 'render:# 新标题\n内容', 'toast:总结已保存到历史']); });
test('successful generation updates metadata and saves history before rendering', async () => { const { controller, events, get } = setup(); await controller.startReport(); assert.equal(get().summaryMarkdown, '# 新标题\n内容'); assert.equal(get().endedAt, '2026-02-03T04:05:06.000Z'); assert.equal(get().title, '新标题'); assert.equal(get().messageCount, 1); assert.ok(events.indexOf('history:# 新标题\n内容') < events.indexOf('render:# 新标题\n内容')); });
test('generation failure preserves the prior summary', async () => { const { controller, events, get } = setup({ failure: 'offline' }); await controller.startReport(); assert.equal(get().summaryMarkdown, '旧总结'); assert.deepEqual(events.slice(-3), ['loading:generate', 'restore:旧总结', 'error:offline']); });

test('repeated starts during audit and follow-up questions make one audit request', async () => {
  const gate = deferred(); let audits = 0;
  const { controller } = setup({ apiOverrides: { auditReport: () => { audits++; return gate.promise; } } });
  const first = controller.startReport(); const second = controller.startReport();
  gate.resolve(['q1']); await Promise.all([first, second]); await controller.startReport();
  assert.equal(audits, 1); assert.deepEqual(controller.getState().questions, ['q1']);
});

for (const stage of ['audit', 'generate']) for (const failure of [false, true]) {
  test(`a stale ${stage} ${failure ? 'failure' : 'success'} cannot change a replacement session or its view`, async () => {
    const gate = deferred();
    const { controller, events, set, get } = setup({ apiOverrides: stage === 'audit' ? { auditReport: () => gate.promise } : { generateReport: () => gate.promise } });
    const original = get(); const pending = controller.startReport(); await Promise.resolve();
    const replacement = { ...session('B总结'), id: 's2' }; set(replacement);
    const before = [...events];
    if (failure) gate.reject(new Error('旧请求失败')); else gate.resolve(stage === 'audit' ? ['旧问题'] : '# 旧结果');
    await pending;
    assert.equal(get(), replacement); assert.equal(original.summaryMarkdown, '旧总结'); assert.deepEqual(events, before);
  });
}

test('replacing the session object with the same ID also invalidates pending generation', async () => {
  const gate = deferred(); const { controller, get, set, events } = setup({ apiOverrides: { generateReport: () => gate.promise } });
  const pending = controller.startReport(); await Promise.resolve();
  const replacement = { ...get(), summaryMarkdown: '重新载入的总结' }; set(replacement); const before = [...events];
  gate.resolve('# 过期结果'); await pending;
  assert.equal(get(), replacement); assert.deepEqual(events, before);
});

test('generation uses the frozen audit message snapshot and answers belonging to that run', async () => {
  let generated;
  const { controller, get } = setup({ questions: ['q1'], apiOverrides: { generateReport: async (messages, answers) => { generated = { messages, answers }; return '# 完成'; } } });
  await controller.startReport(); get().messages[0].content = 'changed'; get().messages.push({ role: 'assistant', content: 'later' });
  await controller.answerCurrentQuestion('a1');
  assert.deepEqual(generated, { messages: [{ role: 'user', content: 'hello' }], answers: [{ question: 'q1', answer: 'a1' }] });
});

test('switching sessions replaces follow-up state without leaking old answers', async () => {
  const payloads = []; let audit = 0;
  const { controller, set } = setup({ apiOverrides: { auditReport: async () => ++audit === 1 ? ['A1', 'A2'] : ['B1'], generateReport: async (messages, answers) => { payloads.push(answers); return '# B'; } } });
  await controller.startReport(); await controller.answerCurrentQuestion('A回答'); set({ ...session(), id: 'B' });
  await controller.startReport(); await controller.answerCurrentQuestion('B回答');
  assert.deepEqual(payloads, [[{ question: 'B1', answer: 'B回答' }]]);
});

test('answer over 4000 characters is rejected without advancing or clearing the question', async () => {
  const { controller, events } = setup({ questions: ['q1', 'q2'] }); await controller.startReport();
  await controller.answerCurrentQuestion('字'.repeat(4001));
  assert.equal(controller.getState().index, 0); assert.deepEqual(controller.getState().answers, []);
  assert.equal(events.filter(value => value.startsWith('question:')).length, 1);
  assert.match(events.at(-1), /4000/);
  await controller.answerCurrentQuestion('字'.repeat(4000)); assert.equal(controller.getState().index, 1);
});

test('messages including entry context over 60 are rejected without trimming session content', async () => {
  const { controller, get, events } = setup({ buildMessages: value => [{ role: 'user', content: '入口上下文' }, ...value.messages] });
  get().messages = Array.from({ length: 60 }, () => ({ role: 'user', content: '正文' }));
  await controller.startReport();
  assert.equal(get().messages.length, 60); assert.ok(events.some(value => value.includes('60')));
  assert.ok(!events.some(value => value.startsWith('loading:') || value.startsWith('history:')));
});

test('a message over 8000 characters is rejected without discarding its content', async () => {
  const { controller, get, events } = setup(); get().messages[0].content = '字'.repeat(8001);
  await controller.startReport();
  assert.equal(get().messages[0].content.length, 8001); assert.ok(events.some(value => value.includes('8000')));
  assert.ok(!events.some(value => value.startsWith('loading:') || value.startsWith('history:')));
});

test('60 messages of 8000 characters are accepted at the request boundary', async () => {
  const { controller, get, events } = setup(); get().messages = Array.from({ length: 60 }, () => ({ role: 'user', content: '字'.repeat(8000) }));
  await controller.startReport(); assert.ok(events.some(value => value.startsWith('render:')));
});

test('repeated final-answer and generate actions cannot start parallel generation', async () => {
  const gate = deferred(); let generated = 0;
  const { controller } = setup({ questions: ['q1'], apiOverrides: { generateReport: () => { generated++; return gate.promise; } } });
  await controller.startReport(); const pending = controller.answerCurrentQuestion('a1');
  const duplicates = [controller.answerCurrentQuestion('again'), controller.skipCurrentQuestion(), controller.generateReport(), controller.startReport()];
  gate.resolve('# 完成'); await Promise.all([pending, ...duplicates]); assert.equal(generated, 1);
});

test('cancelPending aborts the request, restores idle, and suppresses its late response', async () => {
  const gate = deferred(); let signal;
  const { controller, events, get } = setup({ apiOverrides: { auditReport: (messages, receivedSignal) => { signal = receivedSignal; return gate.promise; } } });
  const pending = controller.startReport(); controller.cancelPending(); const before = [...events];
  assert.equal(signal.aborted, true); assert.equal(controller.getState().status, 'idle');
  gate.resolve([]); await pending;
  assert.deepEqual(events, before); assert.equal(get().summaryMarkdown, '旧总结');
});

for (const failure of [false, true]) {
  test(`an invalidated token cannot disturb a newer run on the same session after late ${failure ? 'failure' : 'success'}`, async () => {
    const old = deferred(); let calls = 0;
    const { controller, events } = setup({ apiOverrides: { auditReport: () => ++calls === 1 ? old.promise : Promise.resolve(['新问题']) } });
    const previous = controller.startReport(); controller.cancelPending(); await controller.startReport(); const before = [...events];
    if (failure) old.reject(new Error('旧错误')); else old.resolve(['旧问题']);
    await previous;
    assert.deepEqual(controller.getState().questions, ['新问题']); assert.equal(controller.getState().status, 'questioning'); assert.deepEqual(events, before);
  });
}

test('audit and generation share the request signal, and persistence sees the old current report until both writes succeed', async () => {
  const signals = []; let fixture;
  fixture = setup({ apiOverrides: { auditReport: async (messages, signal) => { signals.push(signal); return []; }, generateReport: async (messages, answers, signal) => { signals.push(signal); return '# 新总结'; } }, repositoryOverrides: { upsertHistory: () => assert.equal(fixture.get().summaryMarkdown, '旧总结'), saveCurrentSession: () => assert.equal(fixture.get().summaryMarkdown, '旧总结') } });
  await fixture.controller.startReport();
  assert.ok(signals[0] instanceof AbortSignal); assert.equal(signals[0], signals[1]); assert.equal(fixture.get().summaryMarkdown, '# 新总结');
});

for (const method of ['upsertHistory', 'saveCurrentSession']) {
  test(`${method} failure retains all previous in-memory report metadata and shows no saved claim`, async () => {
    const { controller, get, events } = setup({ repositoryOverrides: { [method]: () => { throw new Error('存储空间不足'); } } });
    const original = get(); const before = structuredClone(original); await controller.startReport();
    assert.equal(get(), original); assert.deepEqual(get(), before);
    assert.match(events.at(-1), /存储空间不足/); assert.ok(!events.includes('toast:总结已保存到历史'));
  });
}

test('report does not publish its new summary before asynchronous storage succeeds',async()=>{
  const gate=deferred();const h=setup({repositoryOverrides:{upsertHistory:()=>gate.promise}});const running=h.controller.startReport();await Promise.resolve();await Promise.resolve();
  assert.equal(h.get().summaryMarkdown,'旧总结');assert.equal(h.events.some(e=>e.startsWith('render:')),false);
  gate.resolve();await running;assert.match(h.get().summaryMarkdown,/新标题/);
});

test('successful durable report keeps the active session object used by continued chat',async()=>{
  const h=setup();const active=h.get();await h.controller.startReport();assert.equal(h.get(),active);
});
