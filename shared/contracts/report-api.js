/** @typedef {{ question: string, answer: string }} ReportAnswer */
/** @typedef {{ questions: string[] }} AuditResponse */
/** @typedef {{ report: string }} ReportResponse */

/** @param {unknown} value @returns {value is ReportAnswer[]} */
export function isValidReportAnswers(value) {
  return Array.isArray(value)
    && value.length <= 3
    && value.every(item => {
      if (!item || typeof item !== 'object') return false;
      const answer = /** @type {Record<string, unknown>} */ (item);
      return typeof answer.question === 'string'
        && answer.question.length <= 1_000
        && typeof answer.answer === 'string'
        && answer.answer.length <= 4_000;
    });
}

/** @param {unknown} value @returns {value is AuditResponse} */
export function isAuditResponse(value) {
  if (!value || typeof value !== 'object') return false;
  const response = /** @type {Record<string, unknown>} */ (value);
  return Array.isArray(response.questions)
    && response.questions.length <= 3
    && response.questions.every(question => typeof question === 'string' && question.trim().length > 0 && question.length <= 1_000);
}

/** @param {unknown} value @returns {value is ReportResponse} */
export function isReportResponse(value) {
  if (!value || typeof value !== 'object') return false;
  const response = /** @type {Record<string, unknown>} */ (value);
  return typeof response.report === 'string' && response.report.trim().length > 0;
}
