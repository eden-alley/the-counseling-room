import assert from 'node:assert/strict';
import test from 'node:test';
import { createConsultationState } from '../../src/client/features/consultation/consultation-state.js';

test('consultation state opens at start and keeps end and exit mutually exclusive', () => {
  const state = createConsultationState();

  state.openAtStart();
  assert.deepEqual(state.get(), { visibility: 'open', section: 'start', dialog: 'none', requestStatus: 'idle' });
  state.openEndDialog();
  assert.equal(state.get().dialog, 'end');
  state.openExitDialog();
  assert.equal(state.get().dialog, 'exit');
  state.closeDialog();
  assert.equal(state.get().dialog, 'none');
});

test('consultation state rejects invalid values and invalid transitions', () => {
  const state = createConsultationState();

  assert.throws(() => state.openConversation('explore'), /open consultation/);
  assert.throws(() => state.openEndDialog(), /open consultation/);
  assert.throws(() => state.openExitDialog(), /open consultation/);
  state.openAtStart();
  assert.throws(() => state.openConversation('not-a-section'), /Invalid consultation section/);
  assert.throws(() => state.setRequestStatus('not-a-status'), /Invalid request status/);

  assert.throws(() => state.setRequestStatus('aborting'), /sending request/);
  state.setRequestStatus('sending');
  state.setRequestStatus('aborting');
  state.setRequestStatus('idle');
  state.close();
  assert.throws(() => state.setRequestStatus('sending'), /open consultation/);
});
