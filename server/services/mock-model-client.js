import { waitForRetry } from './model-runtime.js';

/** Deterministic local transport fixture, not a counseling-quality model. @param {{delayMs?:number}} [options] */
export function createMockModelClient({ delayMs = 40 } = {}) {
  const reply = '【模拟响应，仅用于流程测试】这是本地假模型逐段返回的文字，用来检查流式显示、停止生成以及完成后保存。这些内容不是对你的经历作出的分析，也不代表真实模型的咨询效果；后续需要获准调用真实模型后再评测。';
  return {
    configured: true,
    /** @param {Array<{role:string,content:string}>} messages */
    async complete(messages) {
      const task = messages.at(-1)?.content || '';
      if (task.startsWith('任务：审查以下咨询记录')) return { reply: JSON.stringify({ questions: [] }) };
      if (task.startsWith('任务：生成面向用户的最终咨询报告')) return { reply: '# 模拟咨询报告\n\n仅用于本地流程测试，未进行真实咨询分析。' };
      return { reply };
    },
    /** @param {unknown} messages @param {any} schema @param {{signal?:AbortSignal}} [options] */
    async completeStructured(messages, schema, { signal } = {}) {
      signal?.throwIfAborted();
      return { data: schema.parse({ goal: null, statements: [], hypotheses: [], strategy: 'reflect' }) };
    },
    /** @param {unknown} messages @param {{signal?:AbortSignal}} [options] */
    async *stream(messages, { signal } = {}) {
      for (let i = 0; i < reply.length; i += 6) {
        signal?.throwIfAborted(); await waitForRetry(delayMs, signal); yield reply.slice(i, i + 6);
      }
    }
  };
}
