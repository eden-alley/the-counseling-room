import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiClient } from '../../src/client/infrastructure/api-client.js';
import { ApiError } from '../../src/client/shared/errors.js';
import { isChatResponse } from '../../shared/contracts/chat-api.js';
import {
  isAuditResponse,
  isReportResponse,
  isValidReportAnswers,
} from '../../shared/contracts/report-api.js';

const messages = [{ role: 'user', content: '最近很焦虑。' }];
const answers = [{ question: '什么场景最明显？', answer: '做选择时。' }];

function streamResponse(events) {
  const bytes = new TextEncoder().encode(events.map(([event, data]) => `event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`).join(''));
  return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 2) c.enqueue(bytes.slice(i, i + 2)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
}

test('streaming client decodes split UTF-8 and requires a matching final reply', async () => {
  const events = [['delta', { type: 'delta', text: '你好' }], ['delta', { type: 'delta', text: '。' }], ['done', { type: 'done', reply: '你好。' }]];
  const client = createApiClient({ baseUrl: '', fetchImpl: async (_url, options) => { assert.equal(JSON.parse(options.body).stream, true); return streamResponse(events); } });
  assert.equal(typeof client.streamChat, 'function');
  const seen = [];
  assert.equal(await client.streamChat(messages, delta => seen.push(delta)), '你好。');
  assert.deepEqual(seen, ['你好', '。']);
  for (const broken of [events.slice(0, 2), [...events.slice(0, 2), ['done', { type: 'done', reply: 'different' }]], [['error', { type: 'error', error: '失败', status: 502 }]]]) {
    const c = createApiClient({ baseUrl: '', fetchImpl: async () => streamResponse(broken) });
    await assert.rejects(c.streamChat(messages, () => {}));
  }
});

test('stream cancellation interrupts a hung reader and cancels its source', async () => {
  let cancelled = false; const controller = new AbortController();
  const client = createApiClient({ baseUrl: '', fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } }) });
  assert.equal(typeof client.streamChat, 'function');
  const pending = client.streamChat(messages, () => {}, controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true);
});

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('api client sends the three domain requests through injected fetch', async () => {
  const calls = [];
  const responses = [
    jsonResponse({ reply: '我在听。' }),
    jsonResponse({ questions: ['最近一次是什么时候？'] }),
    jsonResponse({ report: '# 本次咨询报告' }),
  ];
  const signal = new AbortController().signal;
  const client = createApiClient({
    baseUrl: 'https://example.test/',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return responses.shift();
    },
  });

  assert.equal(await client.sendChat(messages, signal), '我在听。');
  assert.deepEqual(await client.auditReport(messages), ['最近一次是什么时候？']);
  assert.equal(await client.generateReport(messages, answers), '# 本次咨询报告');

  assert.deepEqual(calls.map(call => call.url), [
    'https://example.test/api/chat',
    'https://example.test/api/report/audit',
    'https://example.test/api/report/generate',
  ]);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['content-type'], 'application/json');
  assert.equal(calls[0].options.signal, signal);
  assert.deepEqual(JSON.parse(calls[0].options.body), { messages });
  assert.deepEqual(JSON.parse(calls[1].options.body), { messages });
  assert.deepEqual(JSON.parse(calls[2].options.body), { messages, answers });
});

test('response contracts accept only usable chat and report payloads', () => {
  assert.equal(isChatResponse({ reply: '有效回复' }), true);
  assert.equal(isChatResponse({ reply: '   ' }), false);
  assert.equal(isAuditResponse({ questions: ['补充什么信息？'] }), true);
  assert.equal(isAuditResponse({ questions: ['x'.repeat(1_001)] }), false);
  assert.equal(isReportResponse({ report: '# 报告' }), true);
  assert.equal(isReportResponse({ report: '' }), false);
  assert.equal(isValidReportAnswers(answers), true);
  assert.equal(isValidReportAnswers(Array.from({ length: 4 }, () => answers[0])), false);
});

test('api client maps bad responses to ApiError and preserves aborts', async () => {
  const rateLimited = createApiClient({
    baseUrl: 'https://example.test',
    fetchImpl: async () => jsonResponse({ error: '发送太频繁，请稍后再试。' }, 429),
  });
  await assert.rejects(
    rateLimited.sendChat(messages),
    error => error instanceof ApiError && error.status === 429 && error.message === '发送太频繁，请稍后再试。',
  );

  const invalidJson = createApiClient({
    baseUrl: 'https://example.test',
    fetchImpl: async () => new Response('not json', { status: 200 }),
  });
  await assert.rejects(
    invalidJson.auditReport(messages),
    error => error instanceof ApiError && error.status === 200,
  );

  const abort = new DOMException('The operation was aborted.', 'AbortError');
  const aborted = createApiClient({
    baseUrl: 'https://example.test',
    fetchImpl: async () => { throw abort; },
  });
  await assert.rejects(aborted.sendChat(messages), error => error === abort);
});

test('report requests forward cancellation and do not wait for a hung fetch', async () => {
  for (const kind of ['audit', 'generate']) {
    const controller = new AbortController(); let received;
    const client = createApiClient({ baseUrl: '', fetchImpl: async (_url, options) => { received = options.signal; return new Promise(() => {}); } });
    const pending = kind === 'audit' ? client.auditReport(messages, controller.signal) : client.generateReport(messages, answers, controller.signal);
    controller.abort();
    assert.ok(received, 'request must receive a cancellation signal');
    assert.equal(received.aborted, true);
    await assert.rejects(pending, { name: 'AbortError' });
  }
});

test('chat does not time out before the backend 180-second completion window', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let source;
  const client = createApiClient({ baseUrl: '', fetchImpl: async () => new Response(new ReadableStream({ start(c) { source = c; } }), { headers: { 'content-type': 'text/event-stream' } }) });
  const pending = client.streamChat(messages, () => {}); pending.catch(() => {});
  t.mock.timers.tick(180000);
  source.enqueue(new TextEncoder().encode('event: delta\ndata: {"type":"delta","text":"ok"}\n\nevent: done\ndata: {"type":"done","reply":"ok"}\n\n')); source.close();
  assert.equal(await pending, 'ok');
});

test('a silent chat stream eventually times out after the backend deadline and grace period', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = createApiClient({ baseUrl: '', fetchImpl: async () => new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } }) });
  const pending = client.streamChat(messages, () => {}); const rejection = assert.rejects(pending, { name: 'TimeoutError' });
  t.mock.timers.tick(210001); await rejection;
});

test('session API uses explicit methods and versioned payloads without legacy chat envelopes',async()=>{
  const calls=[];const session={id:'s1',storage:'server',revision:2,messages:[]};
  const client=createApiClient({baseUrl:'',fetchImpl:async(url,options)=>{calls.push([url,options.method,options.body&&JSON.parse(options.body)]);return jsonResponse(url.endsWith('/health')?{ready:true,capabilities:{sessions_v1:true}}:{session});}});
  assert.equal((await client.health()).capabilities.sessions_v1,true);assert.deepEqual(await client.getSession('s1'),session);
  await client.saveSession('s1',2,{title:'saved'});await client.deleteSession('s1',2);
  assert.deepEqual(calls,[['/api/health','GET',undefined],['/api/sessions/s1','GET',undefined],['/api/sessions/s1/save','POST',{expected_revision:2,metadata:{title:'saved'}}],['/api/sessions/s1','DELETE',{expected_revision:2}]]);
});
test('session stream delivers accepted and authoritative done before returning',async()=>{
  const session={id:'s1',storage:'server',revision:2,messages:[{id:'u1',role:'user',content:'hello'},{id:'a1',role:'assistant',content:'reply'}]};
  const events=[['accepted',{type:'accepted',request_id:'r1',revision:1,session:{...session,revision:1,messages:session.messages.slice(0,1)}}],['delta',{type:'delta',text:'reply'}],['done',{type:'done',request_id:'r1',revision:2,reply:'reply',session}]];
  const client=createApiClient({baseUrl:'',fetchImpl:async()=>streamResponse(events)});const seen=[];await client.streamTurn('s1',{request_id:'r1',expected_revision:0,message:'hello'},e=>seen.push(e));assert.deepEqual(seen.map(e=>e.type),['accepted','delta','done']);assert.deepEqual(seen.at(-1).session,session);
});

test('session SSE accepts an authoritative history larger than a legacy reply frame',async()=>{
  const session={id:'s1',storage:'server',revision:2,messages:Array.from({length:30},(_,i)=>({id:`m${i}`,role:i%2?'assistant':'user',content:'x'.repeat(5000)}))};
  const events=[['accepted',{type:'accepted',request_id:'r1',revision:1,session}],['done',{type:'done',request_id:'r1',revision:2,reply:'last',session}]];
  const client=createApiClient({baseUrl:'',fetchImpl:async()=>new Response(events.map(([event,data])=>`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}})});await client.streamTurn('s1',{request_id:'r1'},()=>{});
});

test('bounded session SSE accepts legal histories above one MiB even when multiple frames share a transport chunk',async()=>{
  const session={id:'s1',storage:'server',revision:2,summaryMarkdown:'s'.repeat(100000),messages:Array.from({length:60},(_,i)=>({id:`m${i}`,role:i%2?'assistant':'user',content:'\u0001'.repeat(8000)}))};
  const events=[['accepted',{type:'accepted',request_id:'r1',revision:1,session}],['done',{type:'done',request_id:'r1',revision:2,reply:'reply',session}]];
  const encoded=events.map(([event,data])=>`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');assert.ok(encoded.length>2*1024*1024);
  const client=createApiClient({baseUrl:'',fetchImpl:async()=>new Response(encoded,{headers:{'content-type':'text/event-stream'}})});await client.streamTurn('s1',{request_id:'r1'},()=>{});
});

test('streamed replies respect the backend 8000 codepoint bound for supplementary Unicode',async()=>{
  const reply='😀'.repeat(8000);assert.equal(isChatResponse({reply}),true);const client=createApiClient({baseUrl:'',fetchImpl:async()=>new Response(`event: delta\ndata: ${JSON.stringify({type:'delta',text:reply})}\n\nevent: done\ndata: ${JSON.stringify({type:'done',reply})}\n\n`,{headers:{'content-type':'text/event-stream'}})});assert.equal(await client.streamChat(messages,()=>{}),reply);
});

test('session transport distinguishes explicit HTTP rejection from an unknown stream interruption',async()=>{
  const rejected=createApiClient({baseUrl:'',fetchImpl:async()=>jsonResponse({error:'not configured'},503)});
  await assert.rejects(rejected.streamTurn('s1',{request_id:'r1'},()=>{}),error=>error.status===503&&error.requestRejected===true);
});

test('legacy chat and report transport projects role/content while retaining stable session message ids',async()=>{
  const original=[{id:'u-stable',role:'user',content:'original'}];const bodies=[];
  const client=createApiClient({baseUrl:'',fetchImpl:async(url,options)=>{
    const body=JSON.parse(options.body);bodies.push([url,body]);
    if(url.endsWith('/audit'))return jsonResponse({questions:[]});
    if(url.endsWith('/generate'))return jsonResponse({report:'# report'});
    if(body.stream)return streamResponse([['delta',{type:'delta',text:'reply'}],['done',{type:'done',reply:'reply'}]]);
    return jsonResponse({reply:'reply'});
  }});
  await client.sendChat(original);await client.streamChat(original,()=>{});await client.auditReport(original);await client.generateReport(original,[]);
  assert.deepEqual(bodies,[['/api/chat',{messages:[{role:'user',content:'original'}]}],['/api/chat',{messages:[{role:'user',content:'original'}],stream:true}],['/api/report/audit',{messages:[{role:'user',content:'original'}]}],['/api/report/generate',{messages:[{role:'user',content:'original'}],answers:[]}]]);
  assert.equal(original[0].id,'u-stable');assert.deepEqual(original,[{id:'u-stable',role:'user',content:'original'}]);
});
