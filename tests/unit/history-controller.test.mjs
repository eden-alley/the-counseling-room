import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistoryController } from '../../src/client/features/history/history-controller.js';

function item(id, updatedAt) { return { id, updatedAt, startedAt: '2026-01-01T00:00:00.000Z', entryLabel: '开始探索', title: id, durationSeconds: 65, messageCount: 1, messages: [{ role: 'user', content: 'hello' }], summaryMarkdown: '# 总结' }; }
test('history renders sessions newest first and resumes only through the injected route', async () => { const events = []; const older = item('old', '2026-01-01T00:00:00.000Z'); const newer = item('new', '2026-02-01T00:00:00.000Z'); const controller = createHistoryController({ repository: { listHistory: () => [older, newer], deleteHistorySession: () => {} }, view: { render: sessions => events.push(sessions.map(value => value.id)), download: () => {}, toast: () => {} }, resumeHistoricalSession: id => events.push(`resume:${id}`) }); await controller.open(); await controller.resume('new'); assert.deepEqual(events, [['new', 'old'], 'resume:new']); });
test('history delete delegates to repository and refreshes the list', async () => { const events = []; let entries = [item('one', '2026-01-01T00:00:00.000Z')]; const controller = createHistoryController({ repository: { listHistory: () => entries, deleteHistorySession: id => { events.push(`delete:${id}`); entries = []; } }, view: { render: values => events.push(`render:${values.length}`), download: () => {}, toast: () => {} }, resumeHistoricalSession: () => {} }); await controller.open(); await controller.delete('one'); assert.deepEqual(events, ['render:1', 'delete:one', 'render:0']); });
test('history export includes consultation fields and delegates download side effect to view', async () => { const events = []; const record = item('one', '2026-01-01T00:00:00.000Z'); const controller = createHistoryController({ repository: { listHistory: () => [record], deleteHistorySession: () => {} }, view: { render: () => {}, toast: () => {}, download: (name, body) => events.push([name, body]) }, resumeHistoricalSession: () => {} }); await controller.export('one'); assert.match(events[0][0], /^咨询记录-2026-01-01\.md$/); assert.match(events[0][1], /开始时间：/); assert.match(events[0][1], /入口：开始探索/); assert.match(events[0][1], /## 我/); assert.match(events[0][1], /# 本次总结/); });

test('history summary selects the stored session and delegates display without starting report generation', async () => {
  const record = item('summary', '2026-01-01T00:00:00.000Z');
  const selected = [];
  const controller = createHistoryController({ repository: { listHistory: () => [record], deleteHistorySession: () => {} }, view: { render: () => {}, toast: () => {}, download: () => {} }, resumeHistoricalSession: () => {}, viewHistoricalSummary: value => selected.push(value) });
  await controller.viewSummary('summary');
  assert.deepEqual(selected, [record]);
});

test('history delete does not refresh until durable deletion succeeds and reports failure',async()=>{
  let resolve;const gate=new Promise(r=>resolve=r);const events=[];let fail=false;
  const controller=createHistoryController({repository:{listHistory:async()=>[],deleteHistorySession:async()=>{await gate;if(fail)throw Error('offline');}},view:{render:()=>events.push('render'),toast:t=>events.push(t)},resumeHistoricalSession:()=>{}});
  const removal=controller.delete('s1');assert.deepEqual(events,[]);fail=true;resolve();await removal;assert.equal(events.length,1);assert.match(events[0],/offline/);assert.equal(events.includes('render'),false);
});

import {readFileSync} from 'node:fs';
import {createLegacyChatRoute} from '../../src/client/features/legacy-chat/legacy-chat-route.js';
import {createNavigation} from '../../src/client/app/navigation.js';

const mainSource=readFileSync(new URL('../../src/client/main.js',import.meta.url),'utf8');
const navigationChangeSource=mainSource.match(/onChange: (\(\{ id, previous \}\) => \{[\s\S]*?\n  \}) \}\);/)?.[1];
function selectionGate(){let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};}

for(const mode of ['resume','summary'])for(const leaveEarly of [true,false]){
  test(`${mode} history selection ${leaveEarly?'cannot navigate after returning to the room':'commits normally when its navigation cancels the completed selection'}`,async()=>{
    const gate=selectionGate();const entered=selectionGate();const record=item('A','2026-01-01T00:00:00Z');const initial={id:'current'};let current=initial;let cached=null;let navigation;
    const repository={listHistory:()=>[record],resumeSession:async()=>{entered.resolve();await gate.promise;return record},saveCurrentSession:session=>{cached=session.id}};
    const legacy=createLegacyChatRoute({repository,setSession:session=>{current=session},navigation:{show:screen=>navigation.show(screen)},view:{render(){}}});
    const history=createHistoryController({repository,view:{render(){},toast(){}},resumeHistoricalSession:legacy.resumeHistoricalSession,viewHistoricalSummary:async(session,isCurrent=()=>true)=>{entered.resolve();await gate.promise;if(!isCurrent())return;repository.saveCurrentSession(session);current=session;navigation.show('summaryScreen');}});
    // Exercise the actual main callback with real navigation/history/legacy modules.
    const onChange=new Function('history','report','room','entry','consultation','consultationView','currentSession',`return (${navigationChangeSource});`)(history,{cancelPending(){}},null,null,null,{},initial);
    navigation=createNavigation({screens:[],root:{},onChange});navigation.show('roomScreen');navigation.show('historyScreen');
    const selecting=mode==='resume'?history.resume('A'):history.viewSummary('A');await entered.promise;
    if(leaveEarly)navigation.back();gate.resolve();await selecting;
    if(leaveEarly){assert.equal(navigation.getCurrent(),'roomScreen');assert.equal(current,initial);assert.equal(cached,null);}
    else {assert.equal(navigation.getCurrent(),mode==='resume'?'chatScreen':'summaryScreen');assert.equal(current.id,'A');assert.equal(cached,'A');}
  });
}
