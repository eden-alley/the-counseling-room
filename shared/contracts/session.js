export const CURRENT_SESSION_KEY = 'ape-v2-current-session';
export const HISTORY_KEY = 'ape-v2-session-history';

/** @typedef {{ id?: string, role: 'user' | 'assistant', content: string }} Message */
/** @typedef {{ id: string, startedAt: string, endedAt: string | null, updatedAt: string, entryType: string, entryLabel: string, title: string, durationSeconds: number, messageCount: number, messages: Message[], promptContext: string, summaryMarkdown: string, revision?: number, storage?: 'server', saved?: boolean, hasSavedSnapshot?: boolean, pendingRequestId?: string | null, lastTurn?: any }} Session */

/**
 * @param {{ id: string, now: string, entryType: string, entryLabel: string, promptContext: string }} input
 * @returns {Session}
 */
export function createSession({ id, now, entryType, entryLabel, promptContext }) {
  return {
    id,
    startedAt: now,
    endedAt: null,
    updatedAt: now,
    entryType,
    entryLabel,
    title: entryLabel,
    durationSeconds: 0,
    messageCount: 0,
    messages: [],
    promptContext,
    summaryMarkdown: '',
  };
}

/**
 * @param {Session} session
 * @param {string} now
 * @returns {Session}
 */
export function finalizeSession(session, now) {
  const elapsedSeconds = Math.floor((Date.parse(now) - Date.parse(session.startedAt)) / 1000);

  session.endedAt = now;
  session.updatedAt = now;
  session.durationSeconds = Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0;
  session.messageCount = session.messages.filter(message => message.role === 'user').length;
  return session;
}

/** @param {unknown} value @returns {value is Message} */
export function isMessage(value) {
  if (!value || typeof value !== 'object') return false;
  const message = /** @type {Record<string, unknown>} */ (value);
  return (message.role === 'user' || message.role === 'assistant')
    && typeof message.content === 'string'
    && message.content.trim().length > 0
    && Array.from(message.content).length <= 8_000;
}

/** @param {unknown} value @returns {value is Message[]} */
export function isValidMessages(value) {
  return Array.isArray(value)
    && value.length >= 1
    && value.length <= 60
    && value.every(isMessage);
}

/** @param {unknown} value @returns {Session | null} */
export function normalizeSession(value) {
  if (!value || typeof value !== 'object') return null;
  const session = /** @type {Record<string, unknown>} */ (value);
  if (typeof session.id !== 'string' || !session.id) return null;

  const messages = Array.isArray(session.messages) ? session.messages.filter(isMessage) : [];
  const startedAt = typeof session.startedAt === 'string' ? session.startedAt : new Date(0).toISOString();
  const entryLabel = typeof session.entryLabel === 'string' ? session.entryLabel : '开始探索';
  return {
    id: session.id,
    startedAt,
    endedAt: typeof session.endedAt === 'string' ? session.endedAt : null,
    updatedAt: typeof session.updatedAt === 'string' ? session.updatedAt : startedAt,
    entryType: typeof session.entryType === 'string' ? session.entryType : 'free_conversation',
    entryLabel,
    title: typeof session.title === 'string' ? session.title : entryLabel || '开始探索',
    durationSeconds: typeof session.durationSeconds === 'number' && Number.isFinite(session.durationSeconds)
      ? Math.max(0, session.durationSeconds)
      : 0,
    messageCount: typeof session.messageCount === 'number' && Number.isFinite(session.messageCount)
      ? Math.max(0, session.messageCount)
      : messages.filter(item => item.role === 'user').length,
    messages,
    promptContext: typeof session.promptContext === 'string' ? session.promptContext : '',
    summaryMarkdown: typeof session.summaryMarkdown === 'string' ? session.summaryMarkdown : '',
    ...(session.storage === 'server' ? {
      storage: /** @type {const} */ ('server'),
      revision: typeof session.revision === 'number' ? session.revision : 0,
      saved: session.saved === true,
      ...(typeof session.hasSavedSnapshot === 'boolean' ? {hasSavedSnapshot:session.hasSavedSnapshot} : {}),
      pendingRequestId: typeof session.pendingRequestId === 'string' ? session.pendingRequestId : null,
      lastTurn: session.lastTurn && typeof session.lastTurn === 'object' ? session.lastTurn : null,
    } : {}),
  };
}
