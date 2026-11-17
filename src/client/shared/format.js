/** @param {string} text */
export function escapeHtml(text) { return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
/** @param {string} text */
export function formatMarkdown(text) {
  const lines = escapeHtml(text).split('\n'); let html = ''; let list = '';
  const close = () => { if (list) html += `</${list}>`; list = ''; };
  for (const raw of lines) { const line = raw.trim(); const unordered = line.match(/^[-*] (.+)$/); const ordered = line.match(/^\d+[.、] (.+)$/); const heading = line.match(/^(#{1,2}) (.+)$/);
    if (unordered || ordered) { const matched = /** @type {RegExpMatchArray} */ (unordered || ordered); const next = unordered ? 'ul' : 'ol'; if (list !== next) { close(); list = next; html += `<${next}>`; } html += `<li>${matched[1].replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</li>`; continue; }
    close(); if (!line) continue; if (heading) { const level = heading[1].length; html += `<h${level}>${heading[2]}</h${level}>`; continue; } html += line.startsWith('&gt; ') ? `<blockquote>${line.slice(5)}</blockquote>` : `<p>${line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</p>`;
  } close(); return html || '<p></p>';
}
/** @param {number} seconds */
export function formatDuration(seconds) { const safe = Math.max(0, Math.floor(seconds || 0)); return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`; }
/** @param {string} markdown @param {string} fallback */
export function deriveTitle(markdown, fallback) { const heading = String(markdown || '').split('\n').find(line => /^#{1,2}\s+/.test(line)); return heading ? heading.replace(/^#{1,2}\s+/, '').slice(0, 42) : fallback || '一次人格探索会谈'; }
/** @param {Date} date */
export function dateSlug(date) { return date.toISOString().slice(0, 10); }
/** @param {any} session */
export function sessionExportText(session) { return ['# AI Personality Explorer 咨询记录', '', `> 开始时间：${new Date(session.startedAt).toLocaleString('zh-CN')}`, `> 入口：${session.entryLabel || '未选择'}`, '> 本记录仅用于自我探索，不构成心理治疗、诊断或医疗建议。', '', ...(session.messages || []).flatMap(/** @param {any} message */ function (message) { return [`## ${message.role === 'user' ? '我' : '林澈 · 咨询伙伴'}`, '', message.content, '']; }), session.summaryMarkdown ? '# 本次总结' : '', session.summaryMarkdown || ''].join('\n'); }
