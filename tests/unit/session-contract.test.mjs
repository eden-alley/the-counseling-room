import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CURRENT_SESSION_KEY,
  HISTORY_KEY,
  createSession,
  finalizeSession,
  isMessage,
  isValidMessages,
  normalizeSession,
} from '../../shared/contracts/session.js';

test('createSession creates the stable consultation session shape', () => {
  assert.equal(CURRENT_SESSION_KEY, 'ape-v2-current-session');
  assert.equal(HISTORY_KEY, 'ape-v2-session-history');
  const session = createSession({
    id: 'session-fixed',
    now: '2026-08-27T00:00:00.000Z',
    entryType: 'free_conversation',
    entryLabel: '开始探索',
    promptContext: 'context',
  });

  assert.deepEqual(session, {
    id: 'session-fixed',
    startedAt: '2026-08-27T00:00:00.000Z',
    endedAt: null,
    updatedAt: '2026-08-27T00:00:00.000Z',
    entryType: 'free_conversation',
    entryLabel: '开始探索',
    title: '开始探索',
    durationSeconds: 0,
    messageCount: 0,
    messages: [],
    promptContext: 'context',
    summaryMarkdown: '',
  });
});

test('finalizeSession records completion metadata without changing session content', () => {
  const session = {
    id: 'session-finalize',
    startedAt: '2026-08-27T10:00:00.000Z',
    updatedAt: '2026-08-27T10:00:00.000Z',
    endedAt: null,
    entryType: 'free_conversation',
    entryLabel: '开始探索',
    title: '保留的标题',
    durationSeconds: 0,
    messageCount: 0,
    summaryMarkdown: '# 保留的总结',
    messages: [
      { role: 'user', content: '第一条' },
      { role: 'assistant', content: '回应' },
      { role: 'user', content: '第二条' }
    ],
    promptContext: ''
  };
  const originalMessages = session.messages;

  const result = finalizeSession(session, '2026-08-27T10:01:45.900Z');

  assert.equal(result, session);
  assert.equal(session.endedAt, '2026-08-27T10:01:45.900Z');
  assert.equal(session.updatedAt, '2026-08-27T10:01:45.900Z');
  assert.equal(session.durationSeconds, 105);
  assert.equal(session.messageCount, 2);
  assert.equal(session.title, '保留的标题');
  assert.equal(session.summaryMarkdown, '# 保留的总结');
  assert.equal(session.messages, originalMessages);
});

test('message validators enforce the shared request bounds', () => {
  assert.equal(isMessage({ role: 'user', content: '一次真实表达' }), true);
  assert.equal(isMessage({ role: 'system', content: 'not allowed' }), false);
  assert.equal(isMessage({ role: 'assistant', content: '   ' }), false);
  assert.equal(isMessage({ role: 'user', content: 'x'.repeat(8_001) }), false);
  assert.equal(isValidMessages([{ role: 'user', content: '你好' }]), true);
  assert.equal(isValidMessages([]), false);
  assert.equal(isValidMessages(Array.from({ length: 61 }, () => ({ role: 'user', content: '你好' }))), false);
});

test('normalizeSession rejects missing ids and retains only valid messages', () => {
  assert.equal(normalizeSession({ messages: [] }), null);

  const normalized = normalizeSession({
    id: 'session-normalized',
    startedAt: '2026-08-27T00:00:00.000Z',
    messages: [
      { role: 'user', content: '保留这条消息' },
      { role: 'system', content: '丢弃这条消息' },
    ],
  });

  assert.deepEqual(normalized.messages, [{ role: 'user', content: '保留这条消息' }]);
  assert.equal(normalized.entryLabel, '开始探索');
  assert.equal(normalized.messageCount, 1);
  assert.equal(normalized.summaryMarkdown, '');
});

test('8000 Unicode codepoints are retained as original text rather than filtered by UTF-16 length',()=>{
  const content='😀'.repeat(8000);assert.equal(isMessage({role:'user',content}),true);assert.equal(normalizeSession({id:'unicode',messages:[{role:'user',content}]}).messages[0]?.content,content);assert.equal(isMessage({role:'user',content:content+'a'}),false);
});
