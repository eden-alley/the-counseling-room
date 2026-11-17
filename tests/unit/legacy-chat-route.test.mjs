import assert from 'node:assert/strict';
import test from 'node:test';
import { createLegacyChatRoute } from '../../src/client/features/legacy-chat/legacy-chat-route.js';

test('legacy route resumes a historical session by clearing its end state and navigating to chat', async () => { const events = []; const source = { id: 's1', endedAt: '2026-01-01T01:00:00.000Z', updatedAt: 'old', messages: [{ role: 'user', content: 'hello' }] }; let saved; const route = createLegacyChatRoute({ repository: { listHistory: () => [source], saveCurrentSession: value => { saved = value; events.push('save'); } }, setSession: value => events.push(`set:${value.id}`), navigation: { show: screen => events.push(`show:${screen}`) }, now: () => '2026-02-03T04:05:06.000Z' }); await route.resumeHistoricalSession('s1'); assert.equal(saved.endedAt, null); assert.equal(saved.updatedAt, '2026-02-03T04:05:06.000Z'); assert.notEqual(saved, source); assert.deepEqual(events, ['save', 'set:s1', 'show:chatScreen']); });

test('resumed legacy chat renders its history and can persist a newly sent reply', async () => {
  let session = null;
  const saved = [];
  const rendered = [];
  const source = { id: 'legacy-1', endedAt: '2026-01-01T01:00:00.000Z', updatedAt: 'old', entryType: 'free_conversation', entryLabel: '开始探索', messages: [{ role: 'user', content: '已有内容' }] };
  const route = createLegacyChatRoute({
    repository: { listHistory: () => [source], saveCurrentSession: value => saved.push({ ...value, messages: [...value.messages] }) },
    setSession: value => { session = value; }, navigation: { show: () => {} }, now: () => '2026-02-03T04:05:06.000Z',
    api: { sendChat: async () => '新的回复' }, buildMessages: value => value.messages,
    view: { render: value => rendered.push(value.messages.map(message => message.content)), renderMessage: () => {}, setBusy: () => {}, clearComposer: () => {}, bind: () => {} },
  });
  await route.resumeHistoricalSession('legacy-1');
  await route.sendMessage('继续聊');
  assert.deepEqual(rendered, [['已有内容']]);
  assert.deepEqual(session.messages.map(message => message.content), ['已有内容', '继续聊', '新的回复']);
  assert.deepEqual(saved.at(-1).messages.map(message => message.content), ['已有内容', '继续聊', '新的回复']);
});

test('legacy resume awaits authoritative selection before navigation and uses repository turn recovery',async()=>{
  const events=[];let resolve;const gate=new Promise(r=>resolve=r);const session={id:'server-1',storage:'server',revision:1,messages:[{id:'u1',role:'user',content:'old'}]};
  const route=createLegacyChatRoute({repository:{resumeSession:async()=>{await gate;return session},saveCurrentSession:async()=>{},updateMetadata:async()=>{},submitMessage:async(s,text,{onAccepted})=>{s.messages.push({id:'u2',role:'user',content:text});onAccepted();s.messages.push({id:'a2',role:'assistant',content:'stored reply'});}},setSession:()=>events.push('set'),navigation:{show:()=>events.push('show')},api:{},view:{render:s=>events.push(s.messages.map(m=>m.content)),setBusy(){},clearComposer(){}}});
  const resume=route.resumeHistoricalSession('server-1');assert.deepEqual(events,[]);resolve();await resume;await route.sendMessage('new');assert.deepEqual(events.at(-1),['old','new','stored reply']);
});

test('legacy can open a pending server session without attempting forbidden metadata changes',async()=>{
  const session={id:'s1',storage:'server',revision:1,pendingRequestId:'p1',messages:[{role:'user',content:'waiting'}]};let rendered;let writes=0;
  const route=createLegacyChatRoute({repository:{resumeSession:async()=>session,saveCurrentSession:()=>{},updateMetadata:async()=>{writes++;throw Error('pending')}},setSession:()=>{},navigation:{show:()=>{}},view:{render:s=>rendered=s,renderMessage:()=>{},setBusy:()=>{}}});
  await route.resumeHistoricalSession('s1');assert.equal(writes,0);assert.equal(rendered.pendingRequestId,'p1');
});

test('a slow historical A selection cannot overwrite a newer completed B selection or its cache',async()=>{
  let finish;const gate=new Promise(resolve=>finish=resolve);const events=[];let cached;
  const route=createLegacyChatRoute({repository:{resumeSession:async id=>{if(id==='A')await gate;return {id,messages:[]}},saveCurrentSession:value=>{cached=value.id;events.push(`cache:${value.id}`)}},setSession:value=>events.push(`set:${value.id}`),navigation:{show:()=>events.push('show')},view:{render:value=>events.push(`render:${value.id}`)}});
  const older=route.resumeHistoricalSession('A');await Promise.resolve();await route.resumeHistoricalSession('B');finish();await older;assert.equal(cached,'B');assert.deepEqual(events,['cache:B','set:B','show','render:B']);
});
