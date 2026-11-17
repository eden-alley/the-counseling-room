import test from 'node:test';
import assert from 'node:assert/strict';
import { createConsultationView } from '../../src/client/features/consultation/consultation-view.js';

function setup() {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      dataset: {}, attributes: new Map(), listeners: new Map(), style: {}, value: '', hidden: false,
      classList: { toggle() {}, add() {}, remove() {} },
      addEventListener(name, handler) { this.listeners.set(name, handler); },
      getAttribute(name) { return this.attributes.get(name); },
      setAttribute(name, value) { this.attributes.set(name, value); },
      focus() { this.focused = true; },
    });
    return nodes.get(id);
  }
  const root = { querySelector: node, querySelectorAll: () => [], addEventListener: (...args) => node('document').addEventListener(...args) };
  const scenes = []; let begins = 0;
  const view = createConsultationView(root, { beginConsultation: () => begins++, setSceneState: scene => scenes.push(scene) });
  return { view, node, scenes, getBegins: () => begins };
}

test('IME confirmation Enter is not treated as sending a message', () => {
  const h = setup(); const sent = []; h.view.bind({ onSendMessage: text => sent.push(text) });
  h.node('#input').value = '中文候选';
  const keydown = h.node('#input').listeners.get('keydown'); let prevented = 0;
  keydown({ key: 'Enter', isComposing: true, preventDefault: () => prevented++ });
  keydown({ key: 'Enter', keyCode: 229, preventDefault: () => prevented++ });
  assert.deepEqual(sent, []); assert.equal(prevented, 0);
  keydown({ key: 'Enter', isComposing: false, preventDefault: () => prevented++ });
  assert.deepEqual(sent, ['中文候选']); assert.equal(prevented, 1);
});

test('Escape cancels the exit dialog without discarding the consultation', () => {
  const h = setup(); const events = [];
  h.view.bind({ onCancelExit: () => events.push('cancel'), onDiscardAndExit: () => events.push('discard') });
  h.node('#consultationExitModal').dataset.modalState = 'open';
  h.node('document').listeners.get('keydown')({ key: 'Escape' });
  assert.deepEqual(events, ['cancel']);
});

test('Escape outside the consultation screen does not open an invisible exit dialog', () => {
  const h = setup(); let exits = 0; h.view.bind({ onRequestExit: () => exits++ });
  h.node('#roomScreen').hidden = true; h.node('#consultationUiLayer').setAttribute('aria-hidden', 'false');
  h.node('document').listeners.get('keydown')({ key: 'Escape' });
  assert.equal(exits, 0);
});

test('returning from a report restores the visible consultation scene and selected panel', () => {
  const h = setup(); h.view.resume('explore');
  assert.equal(h.scenes.at(-1), 'consultation-ui');
  assert.equal(h.node('#consultationUiLayer').getAttribute('aria-hidden'), 'false');
  assert.equal(h.node('#consultationUiLayer').dataset.activeSection, 'explore');
  assert.equal(h.getBegins(), 1);
  assert.equal(h.node('#input').focused, true);
});

test('closing the exit dialog restores focus to its trigger', () => {
  const h = setup(); h.view.closeDialog('exit');
  assert.equal(h.node('#consultationExitModal').getAttribute('aria-hidden'), 'true');
  assert.equal(h.node('#consultationUiCloseButton').focused, true);
});
