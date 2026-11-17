import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createSession } from '../../shared/contracts/session.js';

// Exercise the real entry factory without bootstrapping the unrelated DOM/media.
const source = readFileSync(new URL('../../src/client/main.js', import.meta.url), 'utf8');
const factorySource = source.match(/function createSessionForEntry\([\s\S]*?(?=\n  function ensureExplorationSession)/)?.[0];

test('first-session storage failure keeps an in-memory draft and visibly warns instead of breaking entry', () => {
  let current; const notices = [];
  const factory = new Function('createSession', 'repository', 'setCurrentSession', 'entryPrompts', 'showToast', `return (${factorySource});`)(
    createSession, { saveCurrentSession() { throw new Error('QuotaExceededError'); } }, s => { current = s; }, { free_conversation: 'context' }, message => notices.push(message),
  );
  const session = factory('free_conversation', '开始探索');
  assert.equal(current, session); assert.deepEqual(session.messages, []);
  assert.match(notices[0] || '', /保存/);
});

test('draft restoration populates only an empty existing composer',()=>{
  const restoreSource=source.match(/function restoreComposer\([\s\S]*?(?=\n  const navigation)/)?.[0];
  const input={value:'',dispatchEvent(){}};const restore=new Function('root','required',`return (${restoreSource});`)({},()=>input);
  restore('#consultationInput','retained original');assert.equal(input.value,'retained original');input.value='new typing';restore('#consultationInput','old');assert.equal(input.value,'new typing');
});

test('stored history navigation ignores an old cancellation completion after selection changes',async()=>{
  let finish;const gate=new Promise(resolve=>finish=resolve);const events=[];const navSource=source.match(/async function openStoredHistory\([\s\S]*?(?=\n  historyView.bind)/)?.[0];
  const factory=new Function('consultation','legacyChat','showScreen','showToast','initial',`let currentSession=initial;let navigationOperation=0;return {open:(${navSource}),set:session=>{currentSession=session;navigationOperation+=1;}};`);
  const h=factory({prepareToLeave:()=>gate},{cancelPending:async()=>events.push('legacy-cancel')},screen=>events.push(screen),()=>{}, {id:'A'});const opening=h.open();h.set({id:'B'});finish();await opening;assert.deepEqual(events,[]);
});
