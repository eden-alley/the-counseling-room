import { formatMarkdown, formatDuration } from '../../shared/format.js';

const openingByEntry = {
  self_understanding: '我们可以从一个你反复注意到的模式开始。你不需要先判断自己是什么类型，只要说一个最近让你感觉“我好像总是这样”的具体片段就好。',
  recent_difficulty: '我们先不急着分析人格。你可以从最近这件困难本身讲起：发生了什么、你卡在哪里、它为什么让你在意。',
  free_conversation: '那我们就从轻一点的地方开始。最近有没有一个念头、情绪或小事，反复在你脑子里出现？',
};

/** @param {Document} root */
export function createLegacyChatView(root) {
  const chat = /** @type {HTMLElement} */ (root.querySelector('#legacyChat'));
  const input = /** @type {HTMLTextAreaElement} */ (root.querySelector('#legacyInput'));
  const send = /** @type {HTMLButtonElement} */ (root.querySelector('#legacySend'));
  const entryMeta = /** @type {HTMLElement} */ (root.querySelector('#entryMeta'));
  const durationMeta = /** @type {HTMLElement} */ (root.querySelector('#durationMeta'));
  const countMeta = /** @type {HTMLElement} */ (root.querySelector('#countMeta'));
  /** @type {any} */ let actions = {};
  /** @param {'user' | 'assistant'} role @param {string} content */ function appendMessage(role, content) {
    const message = root.createElement('div');
    const isUser = role === 'user';
    message.className = `message ${isUser ? 'user' : 'assistant'}`;
    message.innerHTML = `<div class="avatar ${isUser ? 'user-avatar' : 'assistant-avatar'}">${isUser ? '你' : '林'}</div><div class="bubble-wrap"><div class="speaker">${isUser ? '你' : '林澈 · 咨询伙伴'}</div><div class="bubble">${formatMarkdown(content)}</div></div>`;
    chat.append(message);
    chat.parentElement?.scrollTo({ top: chat.parentElement.scrollHeight });
  }
  /** @param {any} session */ function updateMeta(session) {
    entryMeta.textContent = `入口：${session.entryLabel || '未选择'}`;
    const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(session.startedAt)) / 1000));
    durationMeta.textContent = formatDuration(seconds);
    countMeta.textContent = `${session.messages.filter(/** @param {any} message */ message => message.role === 'user').length} 轮对话`;
  }
  /** @param {any} session */ function render(session) {
    chat.innerHTML = '';
    const entryType = /** @type {keyof typeof openingByEntry} */ (session.entryType);
    appendMessage('assistant', openingByEntry[entryType] || openingByEntry.free_conversation);
    for (const message of session.messages) appendMessage(message.role, message.content);
    updateMeta(session);
  }
  /** @param {'user' | 'assistant'} role @param {string} content @param {any} session */ function renderMessage(role, content, session) { appendMessage(role, content); updateMeta(session); }
  /** @param {boolean} busy */ function setBusy(busy) { send.disabled = busy; send.textContent = busy ? '…' : '↑'; }
  /** @param {any} callbacks */ function bind(callbacks) {
    actions = callbacks;
    send.addEventListener('click', () => { void actions.onSendMessage?.(input.value); });
    input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void actions.onSendMessage?.(input.value); } });
  }
  return { bind, render, renderMessage, setBusy, clearComposer: () => { input.value = ''; } };
}
