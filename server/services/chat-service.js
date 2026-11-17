import { createCounselorGraph } from '../agent/graph.js';

/** @param {{ config: any, modelClient: any }} dependencies */
export function createChatService({ config, modelClient }) {
  const graph = createCounselorGraph({ config, modelClient });
  return {
    /** @param {Array<{ role: 'user'|'assistant', content: string }>} messages @param {{signal?:AbortSignal}} [options] */
    async reply(messages, { signal } = {}) {
      const result = await graph.invoke({ messages }, { signal });
      return result.failure || { reply: result.reply };
    },
    /** @param {Array<{ role: 'user'|'assistant', content: string }>} messages @param {{signal?:AbortSignal}} [options] */
    async *stream(messages, { signal } = {}) {
      const stream = await graph.stream({ messages }, { streamMode: 'custom', signal });
      for await (const event of stream) yield event;
    }
  };
}
