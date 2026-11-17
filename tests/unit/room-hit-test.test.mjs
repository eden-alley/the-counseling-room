import assert from 'node:assert/strict';
import test from 'node:test';
import { roomObjectAtPoint } from '../../src/client/features/room/room-hit-test.js';

test('roomObjectAtPoint preserves mailbox, book, wall-art, and miss hit areas', () => {
  assert.equal(roomObjectAtPoint({ x: .42, y: .30 }), 'mailbox');
  assert.equal(roomObjectAtPoint({ x: .42, y: .63 }), 'book');
  assert.equal(roomObjectAtPoint({ x: .05, y: .20 }), 'wallArt');
  assert.equal(roomObjectAtPoint({ x: .10, y: .80 }), null);
});
