import assert from 'node:assert/strict';
import test from 'node:test';
import { createConsultationController } from '../../src/client/features/consultation/consultation-controller.js';

function createSession(messages = []) {
  return { id: 'session-1', entryType: 'free_conversation', entryLabel: '开始探索', messages: [...messages] };
}

function setup({ messages = [], reply = 'reply', sendChat } = {}) {
  let session = createSession(messages);
  const events = [];
  const view = {
    open: section => events.push(['open', section]), close: () => events.push(['close']), selectSection: section => events.push(['section', section]),
    renderDraft: draft => events.push(['draft', draft.messages.map(message => message.content)]), renderMessage: (role, content) => events.push(['message', role, content]),
    setBusy: busy => events.push(['busy', busy]), openDialog: dialog => events.push(['openDialog', dialog]), closeDialog: dialog => events.push(['closeDialog', dialog]),
    clearComposer: () => events.push(['clearComposer']), toast: text => events.push(['toast', text]),
  };
  const repository = {
    saveCurrentSession: saved => events.push(['save', saved.messages.map(message => message.content)]), upsertHistory: saved => events.push(['history', saved.messages.map(message => message.content)]), removeCurrentSession: () => events.push(['remove']),
  };
  const api = { sendChat: sendChat || (async (apiMessages, signal) => { events.push(['api', apiMessages.map(message => message.content), Boolean(signal)]); return reply; }) };
  const controller = createConsultationController({
    repository, api, view, getSession: () => session, setSession: next => { session = next; events.push(['setSession', next]); },
    buildMessages: current => [{ role: 'assistant', content: 'entry context' }, ...current.messages],
    prepareForHistory: saved => events.push(['prepare', saved.id]),
    onStartReport: current => events.push(['report', current.id]), onReturnToRoom: () => events.push(['room']),
  });
  return { controller, events, repository, getSession: () => session, setSession: next => { session = next; } };
}

test('opening at start renders the saved draft in the start section', () => {
  const { controller, events } = setup({ messages: [{ role: 'user', content: 'existing' }] });
  controller.openAtStart();
  assert.deepEqual(controller.state.get(), { visibility: 'open', section: 'start', dialog: 'none', requestStatus: 'idle' });
  assert.deepEqual(events, [['open', 'start'], ['draft', ['existing']]]);
});

test('sending saves the user turn, calls the API, then saves and renders the assistant turn', async () => {
  const { controller, events } = setup();
  controller.openAtStart();
  await controller.sendMessage('hello');
  assert.deepEqual(events.slice(2), [
    ['save', ['hello']], ['clearComposer'], ['message', 'user', 'hello'], ['busy', true], ['api', ['entry context', 'hello'], true],
    ['save', ['hello', 'reply']], ['message', 'assistant', 'reply'], ['busy', false],
  ]);
  assert.equal(events.some(event => event[0] === 'history'), false);
});

test('an aborted request does not render a failure bubble', async () => {
  const { controller, events } = setup({ sendChat: async () => { const error = new Error('cancelled'); error.name = 'AbortError'; throw error; } });
  controller.openAtStart();
  await controller.sendMessage('hello');
  assert.deepEqual(events.filter(event => event[0] === 'message'), [['message', 'user', 'hello']]);
  assert.equal(controller.state.get().requestStatus, 'idle');
});

test('end then continue closes only the end dialog', () => {
  const { controller, events } = setup();
  controller.openAtStart(); controller.requestEnd(); controller.continueConsultation();
  assert.equal(controller.state.get().dialog, 'none');
  assert.deepEqual(events.slice(-2), [['openDialog', 'end'], ['closeDialog', 'end']]);
  assert.equal(events.some(event => event[0] === 'close'), false);
});

test('ending for a report without a user turn shows a toast and does not save history or report', async () => {
  const { controller, events } = setup({ messages: [{ role: 'assistant', content: 'opening' }] });
  controller.openAtStart(); controller.requestEnd(); await controller.saveAndStartReport();
  assert.deepEqual(events.filter(event => ['toast', 'history', 'report'].includes(event[0])), [['toast', '请先完成一些对话']]);
  assert.equal(controller.state.get().dialog, 'end');
});

test('ending for a report writes history before starting report and never returns to room', async () => {
  const { controller, events } = setup({ messages: [{ role: 'user', content: 'meaningful turn' }] });
  controller.openAtStart(); controller.requestEnd(); await controller.saveAndStartReport();
  const prepareIndex = events.findIndex(event => event[0] === 'prepare'); const historyIndex = events.findIndex(event => event[0] === 'history'); const reportIndex = events.findIndex(event => event[0] === 'report');
  assert.ok(prepareIndex >= 0 && prepareIndex < historyIndex && historyIndex < reportIndex);
  assert.equal(events.some(event => event[0] === 'room'), false); assert.equal(events.some(event => event[0] === 'remove'), false);
});

test('exit discard removes the current session and returns to room without reporting', async () => {
  const { controller, events, getSession } = setup({ messages: [{ role: 'user', content: 'draft' }] });
  controller.openAtStart(); controller.requestExit(); await controller.discardAndExit();
  assert.equal(getSession(), null); assert.deepEqual(events.slice(-4), [['remove'], ['setSession', null], ['close'], ['room']]);
  assert.equal(events.some(event => event[0] === 'report'), false);
});

test('exit save writes history before removing the current session and returning to room', async () => {
  const { controller, events, getSession } = setup({ messages: [{ role: 'user', content: 'draft' }] });
  controller.openAtStart(); controller.requestExit(); await controller.saveAndExit();
  const prepareIndex = events.findIndex(event => event[0] === 'prepare'); const historyIndex = events.findIndex(event => event[0] === 'history'); const removeIndex = events.findIndex(event => event[0] === 'remove'); const roomIndex = events.findIndex(event => event[0] === 'room');
  assert.ok(prepareIndex >= 0 && prepareIndex < historyIndex && historyIndex < removeIndex && removeIndex < roomIndex);
  assert.equal(getSession(), null); assert.equal(events.some(event => event[0] === 'report'), false);
});

function deferred() {
  /** @type {(value: string) => void} */ let resolve;
  const promise = new Promise(next => { resolve = next; });
  return { promise, resolve };
}

test('stream previews stay out of storage and abort ignores late deltas and completion', async () => {
  const session = createSession(); const saved = []; const preview = []; const response = deferred();
  let delta;
  const controller = createConsultationController({
    repository: { saveCurrentSession: s => saved.push(s.messages.map(m => m.content)) },
    api: { streamChat: (_messages, callback) => { delta = callback; return response.promise; } },
    view: { open() {}, renderDraft() {}, renderMessage() {}, setBusy() {}, updateStreaming: text => preview.push(text), removeStreaming: () => preview.push('removed') },
    getSession: () => session, setSession() {}, onStartReport() {}, onReturnToRoom() {},
  });
  controller.openAtStart(); const pending = controller.sendMessage('user');
  await Promise.resolve(); assert.equal(typeof delta, 'function'); delta('半句');
  assert.deepEqual(saved, [['user']]); assert.equal(preview.at(-1), '半句');
  controller.abortRequest(); delta('迟到片段'); response.resolve('完整但迟到'); await pending;
  assert.deepEqual(saved, [['user']]); assert.equal(preview.at(-1), 'removed');
  assert.equal(controller.state.get().requestStatus, 'idle');
});

function setupDeferredExit() {
  let session = createSession([{ role: 'user', content: 'draft' }]);
  let current = session;
  const history = [];
  const busy = [];
  const response = deferred();
  /** @type {AbortSignal | null} */ let signal = null;
  const view = { open: () => {}, close: () => {}, selectSection: () => {}, renderDraft: () => {}, renderMessage: () => {}, setBusy: value => busy.push(value), openDialog: () => {}, closeDialog: () => {}, clearComposer: () => {}, toast: () => {} };
  const controller = createConsultationController({
    repository: { saveCurrentSession: value => { current = value; }, upsertHistory: value => history.push({ ...value, messages: [...value.messages] }), removeCurrentSession: () => { current = null; } },
    api: { sendChat: (_messages, nextSignal) => { signal = nextSignal; return response.promise; } }, view, getSession: () => session, setSession: value => { session = value; },
    buildMessages: value => value.messages, prepareForHistory: () => {}, onStartReport: () => {}, onReturnToRoom: () => {},
  });
  return { controller, response, getCurrent: () => current, getSignal: () => signal, history, busy };
}

test('discarding during a chat request keeps the current-session pointer cleared after a late reply', async () => {
  const { controller, response, getCurrent, getSignal, busy } = setupDeferredExit();
  controller.openAtStart();
  const sending = controller.sendMessage('waiting'); await Promise.resolve();
  controller.requestExit();
  await controller.discardAndExit();
  assert.equal(getSignal()?.aborted, true);
  response.resolve('late reply');
  await sending;
  assert.equal(getCurrent(), null);
  assert.equal(busy.at(-1), false);
  assert.equal(controller.state.get().visibility, 'closed');
});

test('saving exit during a chat request preserves the saved snapshot and keeps current cleared after a late reply', async () => {
  const { controller, response, getCurrent, getSignal, history, busy } = setupDeferredExit();
  controller.openAtStart();
  const sending = controller.sendMessage('waiting'); await Promise.resolve();
  controller.requestExit();
  await controller.saveAndExit();
  assert.equal(getSignal()?.aborted, true);
  response.resolve('late reply');
  await sending;
  assert.equal(getCurrent(), null);
  assert.deepEqual(history.at(-1).messages.map(message => message.content), ['draft', 'waiting']);
  assert.equal(busy.at(-1), false);
  assert.equal(controller.state.get().visibility, 'closed');
});

test('starting a report cancels pending generation and rejects its late completion', async () => {
  const { controller, response, getCurrent, getSignal, history } = setupDeferredExit();
  controller.openAtStart(); const sending = controller.sendMessage('waiting'); await Promise.resolve();
  await controller.saveAndStartReport();
  assert.equal(getSignal().aborted, true);
  response.resolve('late'); await sending;
  assert.deepEqual(getCurrent().messages.map(m => m.content), ['draft', 'waiting']);
  assert.deepEqual(history.at(-1).messages.map(m => m.content), ['draft', 'waiting']);
});

test('storage failure preserves the composer and rolls back the unsent user message', async () => {
  const h = setup(); h.controller.openAtStart();
  h.repository.saveCurrentSession = () => { throw new Error('QuotaExceededError'); };
  await h.controller.sendMessage('must not disappear');
  assert.deepEqual(h.getSession().messages, []);
  assert.equal(h.events.some(e => e[0] === 'clearComposer' || e[0] === 'api'), false);
  assert.match(h.events.find(e => e[0] === 'toast')?.[1] || '', /保存/);
  assert.equal(h.controller.state.get().requestStatus, 'idle');
});

test('oversized input is rejected without clearing or saving it', async () => {
  const h = setup(); h.controller.openAtStart();
  await h.controller.sendMessage('中'.repeat(8001));
  assert.deepEqual(h.getSession().messages, []);
  assert.equal(h.events.some(e => ['api', 'save', 'clearComposer'].includes(e[0])), false);
  assert.match(h.events.find(e => e[0] === 'toast')?.[1] || '', /8000/);
});

test('chat reserves room for the assistant and report entry context at the 60-message limit', async () => {
  const h = setup({ messages: Array.from({ length: 56 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'turn' })) });
  h.controller.openAtStart();
  await h.controller.sendMessage('last safe turn');
  assert.equal(h.getSession().messages.length, 58);
  h.events.length = 0;
  await h.controller.sendMessage('one too many');
  assert.equal(h.getSession().messages.length, 58);
  assert.equal(h.events.some(e => ['api', 'save', 'clearComposer'].includes(e[0])), false);
  assert.match(h.events.find(e => e[0] === 'toast')?.[1] || '', /上限/);
});

test('reply storage failure keeps the visible reply and reports an unsaved state', async () => {
  const h = setup(); h.controller.openAtStart(); let saves = 0;
  h.repository.saveCurrentSession = () => { if (++saves === 2) throw new Error('quota'); };
  await h.controller.sendMessage('hello');
  assert.deepEqual(h.getSession().messages.map(m => m.content), ['hello', 'reply']);
  assert.deepEqual(h.events.filter(e => e[0] === 'message'), [['message', 'user', 'hello'], ['message', 'assistant', 'reply']]);
  assert.match(h.events.find(e => e[0] === 'toast')?.[1] || '', /保存/);
});

for (const operation of ['saveAndStartReport', 'saveAndExit', 'discardAndExit']) {
  test(`${operation} keeps the session and dialog open on storage failure`, async () => {
    const h = setup({ messages: [{ role: 'user', content: 'keep me' }] });
    h.controller.openAtStart();
    if (operation === 'saveAndStartReport') h.controller.requestEnd(); else h.controller.requestExit();
    h.repository.upsertHistory = h.repository.removeCurrentSession = () => { throw new Error('storage unavailable'); };
    await h.controller[operation]();
    assert.equal(h.getSession().messages[0].content, 'keep me');
    assert.equal(h.controller.state.get().visibility, 'open');
    assert.notEqual(h.controller.state.get().dialog, 'none');
    assert.equal(h.events.some(e => e[0] === 'report' || e[0] === 'room'), false);
  });
}

test('cancelling the exit dialog preserves the session and never removes storage', () => {
  const h = setup({ messages: [{ role: 'user', content: 'keep me' }] });
  h.controller.openAtStart(); h.controller.requestExit(); h.controller.closeExitDialog();
  assert.equal(h.controller.state.get().dialog, 'none');
  assert.equal(h.controller.state.get().visibility, 'open');
  assert.equal(h.getSession().messages[0].content, 'keep me');
  assert.equal(h.events.some(e => e[0] === 'remove'), false);
});

test('late chat completion after switching sessions cannot write to the new session', async () => {
  const response = deferred(); const h = setup({ sendChat: () => response.promise });
  h.controller.openAtStart(); const pending = h.controller.sendMessage('A'); await Promise.resolve();
  h.setSession({ ...createSession(), id: 'B' }); h.controller.openAtStart(); h.events.length = 0;
  response.resolve('late A'); await pending;
  assert.equal(h.events.some(e => e[0] === 'save' || e[0] === 'message'), false);
  assert.equal(h.getSession().id, 'B');
  assert.equal(h.controller.state.get().requestStatus, 'idle');
});

test('save exit waits for asynchronous history durability before removing draft or navigating', async () => {
  const h=setup({messages:[{role:'user',content:'keep me'}]});const gate=deferred();h.repository.upsertHistory=()=>gate.promise;
  h.controller.openAtStart();h.controller.requestExit();const exit=h.controller.saveAndExit();
  assert.notEqual(h.getSession(),null);assert.equal(h.events.some(e=>e[0]==='room'||e[0]==='remove'),false);
  gate.resolve();await exit;assert.equal(h.getSession(),null);assert.equal(h.events.at(-1)[0],'room');
});
test('report transition waits for asynchronous durable storage', async () => {
  const h=setup({messages:[{role:'user',content:'keep me'}]});const gate=deferred();h.repository.upsertHistory=()=>gate.promise;
  h.controller.openAtStart();h.controller.requestEnd();const transition=h.controller.saveAndStartReport();
  assert.equal(h.events.some(e=>e[0]==='report'),false);gate.resolve();await transition;assert.equal(h.events.some(e=>e[0]==='report'),true);
});

test('server exit waits for explicit cancellation and request settlement before discard',async()=>{
  const h=setup({messages:[{role:'user',content:'keep me'}]});const gate=deferred();const order=[];
  h.repository.cancelPending=async()=>{order.push('cancel');await gate.promise;order.push('terminal');};
  h.repository.discardCurrentSession=async()=>{order.push('discard');};
  h.controller.openAtStart();h.controller.requestExit();const exit=h.controller.discardAndExit();await Promise.resolve();
  assert.deepEqual(order,['cancel']);assert.notEqual(h.getSession(),null);gate.resolve();await exit;assert.deepEqual(order,['cancel','terminal','discard']);assert.equal(h.getSession(),null);
});
test('failed asynchronous save preserves current session and prevents navigation',async()=>{
  const h=setup({messages:[{role:'user',content:'keep me'}]});h.repository.upsertHistory=async()=>{throw Error('offline');};
  h.controller.openAtStart();h.controller.requestExit();await h.controller.saveAndExit();assert.notEqual(h.getSession(),null);assert.equal(h.events.some(e=>e[0]==='room'),false);
});

test('restored unknown request draft is offered to the existing composer without automatic send',async()=>{
  const session={id:'s1',storage:'server',revision:1,messages:[]};const restored=[];let calls=0;
  const controller=createConsultationController({repository:{recoverSession:async()=>session,getUnsentDraft:()=> 'original draft',submitMessage:async()=>{calls++;}},api:{},view:{open(){},renderDraft(){},setBusy(){},restoreComposer:text=>restored.push(text),toast(){}},getSession:()=>session,setSession(){},onStartReport(){},onReturnToRoom(){}});
  controller.openAtStart();await Promise.resolve();await Promise.resolve();assert.deepEqual(restored,['original draft']);assert.equal(calls,0);
});

test('existing history section opens the shared history route only after current request cancellation',async()=>{
  const session=createSession([{role:'user',content:'saved'}]);const events=[];const gate=deferred();
  const controller=createConsultationController({repository:{cancelPending:async()=>{events.push('cancel');await gate.promise;}},api:{},view:{open(){},renderDraft(){},setBusy(){},selectSection:s=>events.push(s),toast:t=>events.push(t)},getSession:()=>session,setSession(){},onStartReport(){},onReturnToRoom(){},onOpenHistory:()=>events.push('historyScreen')});
  controller.openAtStart();const opening=controller.selectSection('consultation-history');await Promise.resolve();assert.deepEqual(events,['cancel']);gate.resolve();await opening;assert.deepEqual(events,['cancel','historyScreen']);assert.equal(controller.state.get().section,'start');
});

for(const operation of ['discardAndExit','saveAndExit','saveAndStartReport','abortRequest','history']){
  test(`late ${operation} for A cannot mutate, discard, navigate or reset the selected B`,async()=>{
    const a=createSession([{role:'user',content:'A'}]);a.id='A';const b=createSession([{role:'user',content:'B'}]);b.id='B';let selected=a;const gate=deferred();const writes=[];const cancellations=[];const navigation=[];const busy=[];
    const controller=createConsultationController({repository:{cancelPending:async target=>{cancellations.push(target?.id);await gate.promise},discardCurrentSession:async target=>writes.push(['discard',target.id]),upsertHistory:async target=>writes.push(['save',target.id]),saveCurrentSession:async target=>writes.push(['cache',target.id]),removeCurrentSession:()=>writes.push(['remove'])},api:{},view:{open(){},renderDraft(){},setBusy:value=>busy.push(value),removeStreaming(){},toast(){},close(){},closeDialog(){},selectSection(){}},getSession:()=>selected,setSession:value=>{selected=value},onStartReport:()=>navigation.push('report'),onReturnToRoom:()=>navigation.push('room'),onOpenHistory:()=>navigation.push('history')});
    controller.openAtStart();if(operation==='abortRequest')controller.state.setRequestStatus('sending');const result=operation==='history'?controller.selectSection('consultation-history'):controller[operation]();await Promise.resolve();selected=b;controller.openAtStart();controller.state.setRequestStatus('sending');busy.length=0;gate.resolve();await result;
    assert.equal(selected,b);assert.deepEqual(cancellations,['A']);assert.deepEqual(writes,[]);assert.deepEqual(navigation,[]);assert.deepEqual(busy,[]);assert.equal(controller.state.get().requestStatus,'sending');
  });
}

for(const operation of ['saveAndExit','saveAndStartReport']){
  test(`late ${operation} persistence for A cannot remove B cache or navigate`,async()=>{
    const h=setup({messages:[{role:'user',content:'A'}]});const gate=deferred();h.repository.upsertHistory=()=>gate.promise;
    h.controller.openAtStart();const result=h.controller[operation]();await Promise.resolve();await Promise.resolve();h.setSession({...createSession([{role:'user',content:'B'}]),id:'B'});h.controller.openAtStart();h.events.length=0;gate.resolve();await result;
    assert.equal(h.getSession().id,'B');assert.equal(h.events.some(event=>['save','remove','report','room','setSession','busy'].includes(event[0])),false);
  });
}
test('late recovery for A cannot reset B request status or composer',async()=>{
  const gate=deferred();let selected={id:'A',storage:'server',revision:1,messages:[]};const changes=[];
  const controller=createConsultationController({repository:{recoverSession:()=>gate.promise,getUnsentDraft:()=> 'A draft'},api:{},view:{open(){},renderDraft(){},setBusy:busy=>changes.push(['busy',busy]),restoreComposer:text=>changes.push(['composer',text]),toast(){}},getSession:()=>selected,setSession(){},onStartReport(){},onReturnToRoom(){}});
  controller.openAtStart();selected={id:'B',messages:[]};controller.openAtStart();controller.state.setRequestStatus('sending');changes.length=0;gate.resolve();await Promise.resolve();await Promise.resolve();await Promise.resolve();
  assert.equal(controller.state.get().requestStatus,'sending');assert.deepEqual(changes,[]);
});

test('cancellation waiting for the old transport settles only A and never cancels the new B',async()=>{
  let selected=createSession([{role:'user',content:'A'}]);selected.id='A';const b={...createSession(),id:'B'};const gate=deferred();const cancelled=[];const discarded=[];
  const controller=createConsultationController({repository:{submitMessage:()=>gate.promise,cancelPending:async session=>cancelled.push(session.id),discardCurrentSession:async session=>discarded.push(session.id)},api:{},view:{open(){},renderDraft(){},setBusy(){},removeStreaming(){},toast(){},close(){}},getSession:()=>selected,setSession:s=>selected=s,onStartReport(){},onReturnToRoom(){}});
  controller.openAtStart();const sending=controller.sendMessage('waiting');const exiting=controller.discardAndExit();selected=b;controller.openAtStart();gate.resolve();await sending;await exiting;assert.deepEqual(cancelled,['A']);assert.deepEqual(discarded,[]);assert.equal(selected,b);
});
test('a newer exit choice on the same session invalidates the earlier pending save operation',async()=>{
  const h=setup({messages:[{role:'user',content:'A'}]});const gate=deferred();h.repository.cancelPending=()=>gate.promise;h.repository.discardCurrentSession=()=>{};h.controller.openAtStart();const saving=h.controller.saveAndExit();const discarding=h.controller.discardAndExit();gate.resolve();await Promise.all([saving,discarding]);assert.equal(h.events.some(event=>event[0]==='history'),false);assert.equal(h.events.filter(event=>event[0]==='room').length,1);
});
