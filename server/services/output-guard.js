/** @param {string} text */
export function unsafeModelOutput(text) {
  return [
    /<tool_call\b/i,
    /<function=/i,
    /<parameter=/i,
    /code_interpreter/i,
    /conversation_analysis/i,
    /analysis_update/i,
    /current_stage/i,
    /当前(?:咨询)?阶段\s*[:：]/
  ].some(pattern => pattern.test(text));
}
