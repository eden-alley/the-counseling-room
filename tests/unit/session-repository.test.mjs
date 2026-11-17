import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionRepository } from '../../src/client/infrastructure/session-repository.js';
import { createLocalSessionRepository } from '../../src/client/infrastructure/local-session-repository.js';
import { CURRENT_SESSION_KEY, HISTORY_KEY, createSession, normalizeSession } from '../../shared/contracts/session.js';
const draft = () => createSession({id:'s1',now:'2026-10-27T00:00:00Z',entryType:'free_conversation',entryLabel:'开始探索',promptContext:'context'});
function setup(overrides = {}) {
  const values = new Map(); const storage = {getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
  let server = {...draft(),storage:'server',revision:0,saved:false,pendingRequestId:null,lastTurn:null};
  let calls = []; let turn = null;
  const api = {
    health:async()=>({ready:true,capabilities:{sessions_v1:true}}),
    createSession:async s=>{calls.push(['create',s]);return server},
    importSession:async s=>{calls.push(['import',s]);return server={...s,storage:'server',revision:0,saved:true}},
    getSession:async()=>server, listSessions:async()=>[server],
    streamTurn:async(id,payload,emit)=>{calls.push(['turn',payload]);server={...server,revision:1,messages:[{id:'u1',role:'user',content:payload.message}],pendingRequestId:payload.request_id};emit({type:'accepted',session:server});server={...server,revision:2,messages:[...server.messages,{id:'a1',role:'assistant',content:'reply'}],pendingRequestId:null};turn={request_id:payload.request_id,status:'completed',reply:'reply'};throw Error('lost done');},
    getTurn:async(id,rid)=>{calls.push(['get',rid]);return {turn,session:server}},
    deleteSession:async()=>{server={id:'s1',revision:3,deleted:true};return server},
    ...overrides,
  };
  const repository=createSessionRepository({storage,localRepository:createLocalSessionRepository(storage),api,requestId:()=>`r${calls.filter(x=>x[0]==='turn').length+1}`});
  return {repository,storage,calls,api,getServer:()=>server};
}
test('normalization retains stable public server session and message identities',()=>{
  const value={...draft(),storage:'server',revision:4,saved:true,pendingRequestId:'r1',lastTurn:{request_id:'r1',status:'pending'},messages:[{id:'u1',role:'user',content:'hello'}]};
  assert.deepEqual(normalizeSession(value),value);
});
test('lost done recovers the same request and does not append duplicate messages',async()=>{
  const h=setup();const session=draft();await h.repository.submitMessage(session,'hello');
  assert.deepEqual(session.messages.map(m=>m.content),['hello','reply']);assert.equal(session.revision,2);
  assert.equal(h.calls.filter(c=>c[0]==='turn').length,1);assert.deepEqual(h.calls.filter(c=>c[0]==='get'),[['get','r1']]);
  assert.equal(h.calls[0][1].storage,undefined);assert.equal(h.calls[0][1].revision,undefined);
  assert.equal(JSON.parse(h.storage.getItem(CURRENT_SESSION_KEY)).messages,undefined);
});
test('selected legacy history imports once, keeps original, and deleted mapping prevents resurrection',async()=>{
  const h=setup();const original={...draft(),messages:[{role:'user',content:'old'}]};h.storage.setItem(HISTORY_KEY,JSON.stringify([original]));
  await h.repository.resumeSession('s1');await h.repository.resumeSession('s1');
  assert.equal(h.calls.filter(c=>c[0]==='import').length,1);assert.deepEqual(JSON.parse(h.storage.getItem(HISTORY_KEY)),[original]);
  await h.repository.deleteHistorySession('s1');assert.deepEqual(await h.repository.listHistory(),[]);
});
test('invalid legacy messages are retained and rejected before import rather than normalized away',async()=>{
  const h=setup();const original={...draft(),messages:[{role:'user',content:'x'.repeat(8001)}]};h.storage.setItem(HISTORY_KEY,JSON.stringify([original]));
  await assert.rejects(h.repository.resumeSession('s1'),/8000|格式|上限/);
  assert.equal(h.calls.filter(c=>c[0]==='import').length,0);assert.deepEqual(JSON.parse(h.storage.getItem(HISTORY_KEY)),[original]);
});
test('health network failure never falls back to a legacy chat call',async()=>{
  let legacyCalls=0;const h=setup({health:async()=>{throw Error('offline')},sendChat:async()=>{legacyCalls++;return 'legacy'}});
  await assert.rejects(h.repository.submitMessage(draft(),'hello'),/offline/);assert.equal(legacyCalls,0);assert.equal(h.calls.length,0);
});
test('explicit failed-turn retry uses a new request with retry_of and reuses original user row',async()=>{
  let payload;const h=setup({streamTurn:async(id,p,emit)=>{payload=p;emit({type:'done',session:{...draft(),storage:'server',revision:4,messages:[{id:'u1',role:'user',content:'hello'},{id:'a1',role:'assistant',content:'reply'}],lastTurn:{status:'completed',request_id:p.request_id}}});}});
  const session={...draft(),storage:'server',revision:2,messages:[{id:'u1',role:'user',content:'hello'}],lastTurn:{request_id:'failed-1',status:'failed'}};
  await h.repository.submitMessage(session,'hello');assert.equal(payload.retry_of,'failed-1');assert.notEqual(payload.request_id,'failed-1');assert.equal(session.messages.filter(m=>m.role==='user').length,1);
});
test('pending recovery does not generate another request',async()=>{
  const h=setup({getTurn:async()=>({turn:{request_id:'p1',status:'pending'},session:{...draft(),storage:'server',revision:1,pendingRequestId:'p1',messages:[{id:'u1',role:'user',content:'hello'}]}})});
  const session={...draft(),storage:'server',revision:1,pendingRequestId:'p1'};await assert.rejects(h.repository.submitMessage(session,'next'),/等待|进行/);assert.equal(h.calls.filter(c=>c[0]==='turn').length,0);
});

test('unknown acceptance is replayed only by an explicit same-content send with the original request id',async()=>{
  let attempts=0;const payloads=[];const missing=()=>Object.assign(Error('missing'),{status:404});
  const h=setup({getTurn:async()=>{throw missing()},streamTurn:async(id,p,emit)=>{payloads.push({...p});if(++attempts===1)throw Error('connection lost');emit({type:'done',session:{...draft(),storage:'server',revision:2,messages:[{id:'u1',role:'user',content:'hello'},{id:'a1',role:'assistant',content:'reply'}]}});}});
  const session=draft();await assert.rejects(h.repository.submitMessage(session,'hello'),/原请求/);await assert.rejects(h.repository.submitMessage(session,'different'),/相同内容/);
  await h.repository.submitMessage(session,'hello');assert.equal(attempts,2);assert.equal(payloads[0].request_id,payloads[1].request_id);assert.deepEqual(payloads[0],payloads[1]);
});
test('cancel cannot declare an unknown unregistered request terminal or discard its recovery marker',async()=>{
  const missing=()=>Object.assign(Error('missing'),{status:404});const h=setup({streamTurn:async()=>{throw Error('lost')},getTurn:async()=>{throw missing()},cancelTurn:async()=>{throw missing()}});
  const session=draft();await assert.rejects(h.repository.submitMessage(session,'hello'));await assert.rejects(h.repository.cancelPending(session),/确定|确认/);
  assert.match(h.storage.getItem('ape-v2-server-session-state'),/r1/);
});
test('server session cannot silently use legacy chat on an older backend',async()=>{
  let calls=0;const h=setup({health:async()=>({ready:true}),sendChat:async()=>{calls++;return 'bad'}});
  await assert.rejects(h.repository.submitMessage({...draft(),storage:'server',revision:2},'hello'),/不支持/);assert.equal(calls,0);
});
test('a recovered completed turn is adopted before a distinct explicit new message is sent',async()=>{
  let sent;const completed={...draft(),storage:'server',revision:2,pendingRequestId:null,messages:[{id:'u1',role:'user',content:'old'},{id:'a1',role:'assistant',content:'reply'}]};
  const h=setup({getTurn:async()=>({turn:{request_id:'p1',status:'completed'},session:completed}),streamTurn:async(id,p,emit)=>{sent=p;emit({type:'done',session:{...completed,revision:4,messages:[...completed.messages,{id:'u2',role:'user',content:'new'},{id:'a2',role:'assistant',content:'next'}]}})}});
  const session={...draft(),storage:'server',revision:1,pendingRequestId:'p1'};await h.repository.submitMessage(session,'new');assert.equal(sent.message,'new');assert.equal(sent.expected_revision,2);assert.equal(session.messages.at(-1).content,'next');
});

test('history excludes unsaved server drafts and preserves local originals when deleting a migrated current draft',async()=>{
  const h=setup();assert.deepEqual(await h.repository.listHistory(),[]);
  const original={...draft(),messages:[{role:'user',content:'old'}]};h.storage.setItem(HISTORY_KEY,JSON.stringify([original]));h.storage.setItem(CURRENT_SESSION_KEY,JSON.stringify(original));
  await h.repository.submitMessage({...original},'hello');await h.repository.deleteHistorySession('s1');
  assert.equal(h.getServer().deleted,true);assert.deepEqual(JSON.parse(h.storage.getItem(HISTORY_KEY)),[original]);
});

test('a late authoritative reply cannot replace a different selected current-session marker',async()=>{
  let finish;let emit;const gate=new Promise(r=>finish=r);const h=setup({streamTurn:async(id,p,onEvent)=>{emit=onEvent;await gate;onEvent({type:'done',session:{...draft(),storage:'server',revision:2,messages:[{role:'user',content:'hello'},{role:'assistant',content:'reply'}]}});}});
  const sending=h.repository.submitMessage(draft(),'hello');while(!emit)await Promise.resolve();h.repository.saveCurrentSession({...draft(),id:'s2'});finish();await sending;
  assert.equal(JSON.parse(h.storage.getItem(CURRENT_SESSION_KEY)).id,'s2');
});
test('unknown request draft remains readable after reloading repository without automatic replay',async()=>{
  const missing=()=>Object.assign(Error('missing'),{status:404});const h=setup({streamTurn:async()=>{throw Error('lost')},getTurn:async()=>{throw missing()}});const session=draft();await assert.rejects(h.repository.submitMessage(session,'unsent original'));
  const restored=createSessionRepository({storage:h.storage,localRepository:createLocalSessionRepository(h.storage),api:h.api});const marker=restored.loadCurrentSession();await restored.recoverSession(marker);
  assert.equal(restored.getUnsentDraft(marker),'unsent original');assert.equal(h.calls.filter(c=>c[0]==='turn').length,0);
});

test('historical saved snapshot remains listed when current resumed revision is not saved',async()=>{
  const server={...draft(),storage:'server',revision:3,saved:false,hasSavedSnapshot:true,messages:[{role:'user',content:'new draft'}],pendingRequestId:'p1'};
  const h=setup({listSessions:async()=>[server]});const listed=await h.repository.listHistory();assert.equal(listed.length,1);assert.equal(listed[0].saved,false);assert.equal(listed[0].hasSavedSnapshot,true);
});

test('invalid or duplicate original stable message ids are rejected without editing the local original',async()=>{
  for(const messages of [[{id:5,role:'user',content:'original'}],[{id:'same',role:'user',content:'one'},{id:'same',role:'assistant',content:'two'}]]){
    const h=setup();const original={...draft(),messages};h.storage.setItem(HISTORY_KEY,JSON.stringify([original]));await assert.rejects(h.repository.resumeSession('s1'),/标识|格式/);assert.deepEqual(JSON.parse(h.storage.getItem(HISTORY_KEY)),[original]);assert.equal(h.calls.filter(c=>c[0]==='import').length,0);
  }
});

test('a rejected stale revision is refreshed and a later explicit send can use the new revision',async()=>{
  let attempts=0;let finalPayload;const missing=()=>Object.assign(Error('missing'),{status:404});
  const h=setup({getSession:async()=>({...draft(),storage:'server',revision:3,messages:[]}),getTurn:async()=>{throw missing()},streamTurn:async(id,p,emit)=>{if(++attempts===1)throw Object.assign(Error('revision conflict'),{status:409,requestRejected:true});finalPayload=p;emit({type:'done',session:{...draft(),storage:'server',revision:5,messages:[{role:'user',content:'hello'},{role:'assistant',content:'reply'}]}})}});
  const session={...draft(),storage:'server',revision:0};await assert.rejects(h.repository.submitMessage(session,'hello'),/revision conflict/);await h.repository.submitMessage(session,'hello');assert.equal(finalPayload.expected_revision,3);
});

test('explicit HTTP 503 rejection plus missing turn releases pending and retains an unsent draft for recovery',async()=>{
  const missing=()=>Object.assign(Error('missing'),{status:404});let cancellations=0;
  const h=setup({streamTurn:async()=>{throw Object.assign(Error('not configured'),{status:503,requestRejected:true})},getTurn:async()=>{throw missing()},cancelTurn:async()=>{cancellations++;throw missing()}});
  const session=draft();await assert.rejects(h.repository.submitMessage(session,'retained draft'),/not configured/);await h.repository.cancelPending(session);
  assert.equal(cancellations,0);assert.equal(h.repository.getUnsentDraft(session),'retained draft');assert.equal(JSON.parse(h.storage.getItem('ape-v2-server-session-state')).pending.s1,undefined);
});

test('capability downgrade exposes only unmigrated history and never falls back for mapped or deleted originals',async()=>{
  for(const capabilities of [{sessions_v1:false},{}])for(const deleted of [false,true]){
    let legacyCalls=0;const h=setup({health:async()=>({ready:true,capabilities}),sendChat:async()=>{legacyCalls++;return 'unsafe legacy'}});
    const original={...draft(),messages:[{role:'user',content:'preserve original'}]};const plain={...draft(),id:'plain'};const raw=JSON.stringify([original,plain]);h.storage.setItem(HISTORY_KEY,raw);h.storage.setItem(CURRENT_SESSION_KEY,JSON.stringify(original));h.storage.setItem('ape-v2-server-session-state',JSON.stringify({mappings:{s1:{serverId:'server-s1',deleted}},pending:{}}));
    assert.deepEqual((await h.repository.listHistory()).map(s=>s.id),['plain']);
    for(const action of [()=>h.repository.resumeSession('s1'),()=>h.repository.submitMessage(structuredClone(original),'new'),()=>h.repository.upsertHistory(structuredClone(original)),()=>h.repository.deleteHistorySession('s1'),()=>h.repository.discardCurrentSession(structuredClone(original))])await assert.rejects(action,/删除|迁移|不支持|后端/);
    assert.equal(legacyCalls,0);assert.equal(h.storage.getItem(HISTORY_KEY),raw);assert.equal(JSON.parse(h.storage.getItem(CURRENT_SESSION_KEY)).id,'s1');
  }
});
test('late discard of A cannot clear a newly selected B current marker',async()=>{
  let finish;const gate=new Promise(resolve=>finish=resolve);const h=setup({discardSession:async()=>{await gate;return {id:'s1',revision:3,deleted:true}}});const a={...draft(),storage:'server',revision:2};h.repository.saveCurrentSession(a);
  const discarding=h.repository.discardCurrentSession(a);await Promise.resolve();h.repository.saveCurrentSession({...draft(),id:'B'});finish();await discarding;assert.equal(JSON.parse(h.storage.getItem(CURRENT_SESSION_KEY)).id,'B');
});

test('real repository selection remains B when an older server A read finishes late',async()=>{
  let finish;const gate=new Promise(resolve=>finish=resolve);const values=new Map();const storage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
  const publicSession=id=>({...draft(),id,storage:'server',revision:1,saved:true,hasSavedSnapshot:true});
  const repository=createSessionRepository({storage,localRepository:createLocalSessionRepository(storage),api:{health:async()=>({capabilities:{sessions_v1:true}}),getSession:async id=>{if(id==='A')await gate;return publicSession(id)},updateSessionMetadata:async id=>({...publicSession(id),revision:2})}});
  const {createLegacyChatRoute}=await import('../../src/client/features/legacy-chat/legacy-chat-route.js');const selected=[];
  const route=createLegacyChatRoute({repository,setSession:session=>selected.push(session.id),navigation:{show(){}},view:{render(){}}});
  const older=route.resumeHistoricalSession('A');await Promise.resolve();await route.resumeHistoricalSession('B');finish();await older;
  assert.deepEqual(selected,['B']);assert.equal(JSON.parse(storage.getItem(CURRENT_SESSION_KEY)).id,'B');
});

for(const slowSelection of ['summary','resume']){
  test(`real history/legacy/repository modules keep B when older ${slowSelection} A finishes late`,async()=>{
    const {createLegacyChatRoute}=await import('../../src/client/features/legacy-chat/legacy-chat-route.js');const {createHistoryController}=await import('../../src/client/features/history/history-controller.js');
    let finish;const gate=new Promise(resolve=>finish=resolve);const values=new Map();const storage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
    const publicSession=id=>({...draft(),id,storage:'server',revision:1,saved:true,hasSavedSnapshot:true,messages:[{id:`u-${id}`,role:'user',content:id}]});
    const repository=createSessionRepository({storage,localRepository:createLocalSessionRepository(storage),api:{health:async()=>({capabilities:{sessions_v1:true}}),listSessions:async()=>{if(slowSelection==='summary')await gate;return [publicSession('A'),publicSession('B')]},getSession:async id=>{if(slowSelection==='resume'&&id==='A')await gate;return publicSession(id)},updateSessionMetadata:async id=>({...publicSession(id),revision:2})}});
    let current={...draft(),id:'root'};repository.saveCurrentSession(current);const events=[];
    const legacy=createLegacyChatRoute({repository,setSession:session=>{current=session;events.push(`resume:${session.id}`)},navigation:{show(){}},view:{render(){}}});
    const history=createHistoryController({repository,view:{toast:message=>events.push(message)},resumeHistoricalSession:(id,isCurrent=()=>true)=>{const before=current;return legacy.resumeHistoricalSession(id,()=>isCurrent()&&current===before)},viewHistoricalSummary:async(session,isCurrent=()=>true)=>{const before=current;await repository.recoverSession(session,{cache:false});if(!isCurrent()||current!==before)return;await repository.saveCurrentSession(session);if(!isCurrent()||current!==before)return;current=session;events.push(`summary:${session.id}`)}});
    const older=slowSelection==='summary'?history.viewSummary('A'):history.resume('A');await Promise.resolve();await Promise.resolve();if(slowSelection==='summary')await history.resume('B');else await history.viewSummary('B');finish();await older;
    assert.equal(current.id,'B');assert.equal(JSON.parse(storage.getItem(CURRENT_SESSION_KEY)).id,'B');assert.equal(events.some(event=>event==='summary:A'||event==='resume:A'),false);
  });
}
