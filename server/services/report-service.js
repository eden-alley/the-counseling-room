/** @param {string} text */
function parseJsonObject(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** @param {{ config: any, modelClient: any }} dependencies */
export function createReportService({ config, modelClient }) {
  return {
    /** @param {Array<{ role: string, content: string }>} messages */
    async audit(messages) {
      const task = `任务：审查以下咨询记录的信息缺口。只返回 JSON。\n\n咨询记录：\n${JSON.stringify(messages)}`;
      const result = await modelClient.complete([
        { role: 'system', content: config.prompts.report },
        { role: 'user', content: task }
      ], { maxCompletionTokens: 900 });
      if (result.error) return result;
      const parsed = parseJsonObject(result.reply);
      if (!parsed || !Array.isArray(parsed.questions)) {
        return { error: '报告信息审查格式异常，请稍后重试。', status: 502 };
      }
      return {
        questions: parsed.questions
          .filter(/** @param {any} question */ question => typeof question === 'string' && question.trim())
          .slice(0, config.limits.maxReportQuestions)
          .map(/** @param {string} question */ question => question.trim().slice(0, 500))
      };
    },
    /** @param {Array<{ role: string, content: string }>} messages @param {any[]} answers */
    generate(messages, answers) {
      const task = `任务：生成面向用户的最终咨询报告。\n\n咨询记录：\n${JSON.stringify(messages)}\n\n补充问答：\n${JSON.stringify(answers)}`;
      return modelClient.complete([
        { role: 'system', content: config.prompts.report },
        { role: 'user', content: task }
      ], { maxCompletionTokens: 2200 });
    }
  };
}
