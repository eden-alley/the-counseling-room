import assert from 'node:assert/strict';
import test from 'node:test';
import { createSession } from '../../shared/contracts/session.js';
import { createLocalSessionRepository } from '../../src/client/infrastructure/local-session-repository.js';

function createStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function session(id, updatedAt = '2026-08-27T00:00:00.000Z') {
  return createSession({
    id,
    now: updatedAt,
    entryType: 'free_conversation',
    entryLabel: '开始探索',
    promptContext: 'context',
  });
}

test('repository saves and loads the current session and upserts history', () => {
  const repository = createLocalSessionRepository(createStorage());
  const current = session('session-fixed');

  repository.saveCurrentSession(current);
  assert.equal(repository.loadCurrentSession().id, 'session-fixed');

  repository.upsertHistory({ ...current, updatedAt: '2026-08-27T00:01:00.000Z' });
  assert.equal(repository.listHistory()[0].id, 'session-fixed');

  repository.removeCurrentSession();
  assert.equal(repository.loadCurrentSession(), null);
  repository.deleteHistorySession('session-fixed');
  assert.deepEqual(repository.listHistory(), []);
});

test('repository handles invalid stored JSON without exposing malformed data', () => {
  const storage = createStorage();
  storage.setItem('ape-v2-current-session', '{not-json');
  storage.setItem('ape-v2-session-history', '{not-json');

  const repository = createLocalSessionRepository(storage);
  assert.equal(repository.loadCurrentSession(), null);
  assert.deepEqual(repository.listHistory(), []);
});

test('repository keeps the newest 30 unique history sessions', () => {
  const repository = createLocalSessionRepository(createStorage());
  for (let index = 0; index < 31; index += 1) {
    repository.upsertHistory(session(
      `session-${index}`,
      `2026-08-27T00:${String(index).padStart(2, '0')}:00.000Z`,
    ));
  }

  const history = repository.listHistory();
  assert.equal(history.length, 30);
  assert.equal(history[0].id, 'session-30');
  assert.equal(history.at(-1).id, 'session-1');

  repository.upsertHistory({ ...history.at(-1), updatedAt: '2026-08-27T01:00:00.000Z' });
  assert.equal(repository.listHistory().length, 30);
  assert.equal(repository.listHistory()[0].id, 'session-1');
});
