import {
  CURRENT_SESSION_KEY,
  HISTORY_KEY,
  normalizeSession,
} from '../../../shared/contracts/session.js';

/** @typedef {{ getItem(key: string): string | null, setItem(key: string, value: string): void, removeItem(key: string): void }} StorageLike */

/** @param {string | null} raw @returns {unknown} */
function parseJson(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** @param {{ updatedAt: string }} first @param {{ updatedAt: string }} second */
function sortNewestFirst(first, second) {
  const firstTime = Date.parse(first.updatedAt) || 0;
  const secondTime = Date.parse(second.updatedAt) || 0;
  return secondTime - firstTime;
}

/** @param {StorageLike} storage */
export function createLocalSessionRepository(storage) {
  function loadCurrentSession() {
    return normalizeSession(parseJson(storage.getItem(CURRENT_SESSION_KEY)));
  }

  /** @param {unknown} session */
  function saveCurrentSession(session) {
    const normalized = normalizeSession(session);
    if (!normalized) {
      storage.removeItem(CURRENT_SESSION_KEY);
      return;
    }
    storage.setItem(CURRENT_SESSION_KEY, JSON.stringify(normalized));
  }

  function removeCurrentSession() {
    storage.removeItem(CURRENT_SESSION_KEY);
  }

  function listHistory() {
    const value = parseJson(storage.getItem(HISTORY_KEY));
    if (!Array.isArray(value)) return [];
    return value
      .map(normalizeSession)
      .filter(session => session !== null)
      .sort(sortNewestFirst)
      .slice(0, 30);
  }

  /** @param {unknown} session */
  function upsertHistory(session) {
    const normalized = normalizeSession(session);
    if (!normalized) return;
    const next = listHistory().filter(item => item.id !== normalized.id);
    next.push(normalized);
    next.sort(sortNewestFirst);
    storage.setItem(HISTORY_KEY, JSON.stringify(next.slice(0, 30)));
  }

  /** @param {string} id */
  function deleteHistorySession(id) {
    storage.setItem(HISTORY_KEY, JSON.stringify(listHistory().filter(session => session.id !== id)));
  }

  return {
    loadRawCurrentSession: () => parseJson(storage.getItem(CURRENT_SESSION_KEY)),
    listRawHistory: () => { const value = parseJson(storage.getItem(HISTORY_KEY)); return Array.isArray(value) ? value : []; },
    loadCurrentSession,
    saveCurrentSession,
    removeCurrentSession,
    listHistory,
    upsertHistory,
    deleteHistorySession,
  };
}
