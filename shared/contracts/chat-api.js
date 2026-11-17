/** @typedef {{ reply: string }} ChatResponse */

/** @param {unknown} value @returns {value is ChatResponse} */
export function isChatResponse(value) {
  if (!value || typeof value !== 'object') return false;
  const response = /** @type {Record<string, unknown>} */ (value);
  return typeof response.reply === 'string'
    && response.reply.trim().length > 0
    && Array.from(response.reply).length <= 8_000;
}
