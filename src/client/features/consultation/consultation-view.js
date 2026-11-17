const openingByEntry = {
  self_understanding: '我们可以从一个你反复注意到的模式开始。你不需要先判断自己是什么类型，只要说一个最近让你感觉“我好像总是这样”的具体片段就好。',
  recent_difficulty: '我们先不急着分析人格。你可以从最近这件困难本身讲起：发生了什么、你卡在哪里、它为什么让你在意。',
  free_conversation: '那我们就从轻一点的地方开始。最近有没有一个念头、情绪或小事，反复在你脑子里出现？',
};

/** @param {string} text */
function escapeHtml(text) { return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
/** @param {string} text */
function formatMessage(text) {
  const lines = escapeHtml(text).split('\n'); let html = ''; let list = '';
  const closeList = () => { if (list) html += `</${list}>`; list = ''; };
  for (const raw of lines) {
    const line = raw.trim(); const unordered = line.match(/^[-*] (.+)$/); const ordered = line.match(/^\d+[.、] (.+)$/); const heading = line.match(/^(#{1,2}) (.+)$/);
    if (unordered || ordered) { const matched = /** @type {RegExpMatchArray} */ (unordered || ordered); const next = unordered ? 'ul' : 'ol'; if (list !== next) { closeList(); list = next; html += `<${next}>`; } html += `<li>${matched[1].replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</li>`; continue; }
    closeList(); if (!line) continue;
    if (heading) { const level = heading[1].length; html += `<h${level}>${heading[2]}</h${level}>`; continue; }
    html += line.startsWith('&gt; ') ? `<blockquote>${line.slice(5)}</blockquote>` : `<p>${line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</p>`;
  }
  closeList(); return html || '<p></p>';
}

/** @param {Document} root @param {{ beginConsultation?: () => void, returnToRoom?: () => void, isScene?: (state: string) => boolean, setSceneState?: (state: string) => void }} [room] */
export function createConsultationView(root, room = {}) {
  const layer = /** @type {HTMLElement} */ (root.querySelector('#consultationUiLayer'));
  const chat = /** @type {HTMLElement} */ (root.querySelector('#chat'));
  const chatWrap = /** @type {HTMLElement} */ (root.querySelector('#chatWrap'));
  const input = /** @type {HTMLTextAreaElement} */ (root.querySelector('#input'));
  const send = /** @type {HTMLButtonElement} */ (root.querySelector('#send'));
  const toastNode = /** @type {HTMLElement} */ (root.querySelector('#toast'));
  const endButton = /** @type {HTMLButtonElement} */ (root.querySelector('#consultationEndButton'));
  const end = /** @type {HTMLElement} */ (root.querySelector('#consultationEndModal'));
  const endClose = /** @type {HTMLButtonElement} */ (root.querySelector('#consultationEndModalCloseButton'));
  const endContinue = /** @type {HTMLButtonElement} */ (root.querySelector('#consultationEndContinueButton'));
  const endReport = /** @type {HTMLButtonElement} */ (root.querySelector('#consultationEndReportButton'));
  const exit = /** @type {HTMLElement} */ (root.querySelector('#consultationExitModal'));
  const exitDiscard = /** @type {HTMLButtonElement} */ (root.querySelector('#consultationExitDiscardButton'));
  const exitSave = /** @type {HTMLButtonElement} */ (root.querySelector('#consultationExitSaveButton'));
  const closeButton = /** @type {HTMLButtonElement} */ (root.querySelector('#consultationUiCloseButton'));
  const startButton = /** @type {HTMLButtonElement} */ (root.querySelector('#startConsultationBtn'));
  const sectionButtons = [...root.querySelectorAll('[data-consultation-section]')];
  const panels = [...root.querySelectorAll('[data-consultation-panel]')];
  /** @type {ReturnType<typeof setTimeout> | null} */ let transitionTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */ let toastTimer = null;
  let transitioning = false; let busy = false;
  /** @type {HTMLElement | null} */ let streamingMessage = null;
  /** @type {any} */ let actions = {};

  function reducedMotion() { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; }
  /** @param {string} section */ function visibleSection(section) { return section === 'start' ? 'explore' : section; }
  /** @param {string} section */ function selectSection(section) {
    const activeSection = visibleSection(section); layer.dataset.activeSection = activeSection;
    for (const button of sectionButtons) button.setAttribute('aria-selected', String(button.getAttribute('data-consultation-section') === activeSection));
    for (const panel of panels) { const active = panel.getAttribute('data-consultation-panel') === activeSection; panel.classList.toggle('is-active', active); panel.setAttribute('aria-hidden', String(!active)); }
  }
  /** @param {'end' | 'exit'} dialog @param {boolean} visible */ function setDialog(dialog, visible) { const node = dialog === 'end' ? end : exit; node.dataset.modalState = visible ? 'open' : 'closed'; node.setAttribute('aria-hidden', String(!visible)); }
  function closeAllDialogs() { setDialog('end', false); setDialog('exit', false); }
  function resizeComposer() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 180)}px`; }
  function scrollChat() { window.requestAnimationFrame(() => { chatWrap.scrollTop = chatWrap.scrollHeight; }); }
  /** @param {'user' | 'assistant'} role @param {string} content */ function appendMessage(role, content) {
    const isUser = role === 'user'; const message = root.createElement('div'); message.className = `message ${isUser ? 'user' : 'assistant'}`;
    message.innerHTML = `<div class="avatar ${isUser ? 'user-avatar' : 'assistant-avatar'}">${isUser ? '你' : '林'}</div><div class="bubble-wrap"><div class="speaker">${isUser ? '你' : '林澈 · 咨询伙伴'}</div><div class="bubble">${formatMessage(content)}</div>${isUser ? '' : '<button class="copy" type="button">复制回复</button>'}</div>`;
    if (!isUser) message.querySelector('.copy')?.addEventListener('click', () => { void navigator.clipboard.writeText(content).then(() => toast('已复制')).catch(() => toast('复制失败')); });
    chat.append(message); scrollChat(); return message;
  }
  /** @param {string} text */ function updateStreaming(text) {
    if (!streamingMessage) {
      streamingMessage = appendMessage('assistant', ''); streamingMessage.dataset.streaming = 'true';
      const copy = /** @type {HTMLButtonElement | null} */ (streamingMessage.querySelector('.copy'));
      if (copy) copy.hidden = true;
    }
    const bubble = streamingMessage.querySelector('.bubble');
    if (bubble) bubble.innerHTML = formatMessage(text);
    scrollChat();
  }
  function removeStreaming() { streamingMessage?.remove(); streamingMessage = null; }
  function focusComposer() { input.focus({ preventScroll: true }); }
  /** @param {string} section */ function open(section) {
    if (transitioning || (room.isScene && !room.isScene('room'))) return;
    transitioning = true; room.beginConsultation?.(); selectSection(section); if (transitionTimer) clearTimeout(transitionTimer);
    transitionTimer = setTimeout(() => { room.setSceneState?.('darkening'); transitionTimer = setTimeout(() => { room.setSceneState?.('consultation-ui'); layer.setAttribute('aria-hidden', 'false'); transitionTimer = setTimeout(() => { transitioning = false; transitionTimer = null; focusComposer(); }, reducedMotion() ? 20 : 420); }, reducedMotion() ? 10 : 380); }, reducedMotion() ? 1 : 160);
  }
  function close() {
    if (transitioning || (room.isScene && !room.isScene('consultation-ui'))) return;
    transitioning = true; closeAllDialogs(); layer.setAttribute('aria-hidden', 'true'); room.setSceneState?.('consultation-closing'); if (transitionTimer) clearTimeout(transitionTimer);
    transitionTimer = setTimeout(() => { room.setSceneState?.('room'); room.returnToRoom?.(); transitioning = false; transitionTimer = null; }, reducedMotion() ? 1 : 280);
  }
  /** Restore an already-open consultation after visiting the report/history screens. @param {string} section */
  function resume(section) {
    if (transitionTimer) clearTimeout(transitionTimer);
    transitionTimer = null; transitioning = false;
    closeAllDialogs(); room.beginConsultation?.(); selectSection(section);
    room.setSceneState?.('consultation-ui'); layer.setAttribute('aria-hidden', 'false'); focusComposer();
  }
  /** @param {'end' | 'exit'} dialog */ function openDialog(dialog) { if (transitioning || layer.getAttribute('aria-hidden') === 'true') return; setDialog(dialog, true); (dialog === 'end' ? endContinue : exitSave).focus({ preventScroll: true }); }
  /** @param {'end' | 'exit'} dialog */ function closeDialog(dialog) { setDialog(dialog, false); (dialog === 'end' ? endButton : closeButton).focus({ preventScroll: true }); }
  /** @param {any} session */ function renderDraft(session) { chat.innerHTML = ''; if (!session) return; const entryType = /** @type {keyof typeof openingByEntry} */ (session.entryType); appendMessage('assistant', openingByEntry[entryType] || openingByEntry.free_conversation); for (const message of session.messages || []) appendMessage(message.role, message.content); }
  /** @param {boolean} value */ function setBusy(value) { busy = value; send.classList.toggle('stop', value); send.textContent = value ? '停止' : '➤'; send.setAttribute('aria-label', value ? '停止生成' : '发送'); }
  /** @param {string} text */ function toast(text) { toastNode.textContent = text; toastNode.classList.add('show'); if (toastTimer) clearTimeout(toastTimer); toastTimer = setTimeout(() => toastNode.classList.remove('show'), 1800); }
  /** @param {any} callbacks */ function bind(callbacks) {
    actions = callbacks;
    for (const button of sectionButtons) button.addEventListener('click', () => actions.onSectionSelect?.(button.getAttribute('data-consultation-section') || 'start'));
    endButton.addEventListener('click', () => actions.onRequestEnd?.()); endClose.addEventListener('click', () => actions.onContinue?.()); endContinue.addEventListener('click', () => actions.onContinue?.()); endReport.addEventListener('click', () => actions.onSaveAndStartReport?.()); closeButton.addEventListener('click', () => actions.onRequestExit?.()); exitDiscard.addEventListener('click', () => actions.onDiscardAndExit?.()); exitSave.addEventListener('click', () => actions.onSaveAndExit?.()); startButton.addEventListener('click', () => actions.onOpenAtStart?.());
    send.addEventListener('click', () => { if (busy) actions.onAbortRequest?.(); else actions.onSendMessage?.(input.value.trim()); });
    input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); actions.onSendMessage?.(input.value.trim()); } }); input.addEventListener('input', resizeComposer);
    root.addEventListener('keydown', event => { if (event.key !== 'Escape' || /** @type {HTMLElement | null} */ (root.querySelector('#roomScreen'))?.hidden) return; if (end.dataset.modalState === 'open') actions.onContinue?.(); else if (exit.dataset.modalState === 'open') actions.onCancelExit?.(); else if (layer.getAttribute('aria-hidden') === 'false') actions.onRequestExit?.(); });
  }
  return { bind, open, close, resume, selectSection, openDialog, closeDialog, renderDraft, renderMessage: appendMessage, updateStreaming, removeStreaming, setBusy, clearComposer: () => { input.value = ''; resizeComposer(); }, toast };
}
