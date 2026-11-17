import { escapeHtml, formatDuration } from '../../shared/format.js';

/** @param {Document} root */
export function createHistoryView(root) {
  const list = /** @type {HTMLElement} */ (root.querySelector('#historyList'));
  /** @type {any} */ let actions = {};
  /** @param {any[]} sessions */ function render(sessions) {
    list.innerHTML = '';
    if (!sessions.length) { list.innerHTML = '<div class="empty">当前设备还没有保存的咨询记录。</div>'; return; }
    for (const item of sessions) { const element = root.createElement('article'); const date = new Date(item.startedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); element.className = 'history-item'; element.innerHTML = `<div><h3>${escapeHtml(item.title || item.entryLabel || '一次人格探索会谈')}</h3><p>${date} · ${escapeHtml(item.entryLabel || '未选择入口')} · ${formatDuration(item.durationSeconds)} · ${item.messageCount || 0} 轮对话</p></div><div class="history-actions"><button class="secondary" data-action="continue" type="button">继续</button><button class="ghost" data-action="summary" type="button">总结</button><button class="ghost" data-action="export" type="button">导出</button><button class="ghost" data-action="delete" type="button">删除</button></div>`; element.querySelector('[data-action="continue"]')?.addEventListener('click', () => actions.onResume?.(item.id)); element.querySelector('[data-action="summary"]')?.addEventListener('click', () => actions.onViewSummary?.(item.id)); element.querySelector('[data-action="export"]')?.addEventListener('click', () => actions.onExport?.(item.id)); element.querySelector('[data-action="delete"]')?.addEventListener('click', () => actions.onDelete?.(item.id)); list.append(element); }
  }
  /** @param {any} callbacks */ function bind(callbacks) { actions = callbacks; root.querySelector('#historyBtn')?.addEventListener('click', () => actions.onOpen?.()); root.querySelector('#historyHomeBtn')?.addEventListener('click', () => actions.onBack?.()); root.querySelector('#historyNewBtn')?.addEventListener('click', () => actions.onNew?.()); }
  /** @param {string} filename @param {string} content */ function download(filename, content) { const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' }); const anchor = root.createElement('a'); anchor.href = URL.createObjectURL(blob); anchor.download = filename; anchor.click(); URL.revokeObjectURL(anchor.href); }
  return { bind, render, download, toast: () => {} };
}
