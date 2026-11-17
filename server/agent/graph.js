import { StateSchema, StateGraph, START, END } from '@langchain/langgraph';
import { z } from 'zod';
import { messagesSchema, assessmentSchema, validateAssessment } from './state.js';
import { assessmentMessages, responseMessages } from './prompts.js';
import { unsafeModelOutput } from '../services/output-guard.js';
import { ModelError } from '../services/model-runtime.js';

const state = new StateSchema({ messages: messagesSchema, assessment: assessmentSchema.nullable().default(null), reply: z.string().default(''), failure: z.object({ error: z.string(), status: z.number() }).nullable().default(null) });
const invalid = () => new ModelError('本次回复生成异常，已为你拦截。请重新发送。');
/** Public consultation text only; report audit still permits its separate JSON contract. @param {string} text */
const unsafeReply = text => unsafeModelOutput(text) || /^\s*(?:[\[{]|```)/.test(text) || /"(?:assessment|hypotheses|statements|strategy)"\s*:/.test(text);

/** @param {{config:any,modelClient:any}} dependencies */
export function createCounselorGraph({ config, modelClient }) {
  /** @param {unknown} error @param {any} runtime */
  function failure(error, runtime) {
    runtime.signal?.throwIfAborted();
    const result = error instanceof ModelError ? { error: error.message, status: error.status } : { error: '本次回复生成异常，已为你拦截。请重新发送。', status: 502 };
    runtime.writer?.({ type: 'error', ...result });
    return { failure: result };
  }
  return new StateGraph(state)
    .addNode('understand', async (s, runtime) => {
      try {
        messagesSchema.parse(s.messages);
        const result = await modelClient.completeStructured(assessmentMessages(config, s.messages), assessmentSchema, { maxCompletionTokens: 2400, signal: runtime.signal });
        if (result.error) throw new ModelError(result.error, result.status);
        return { assessment: validateAssessment(result.data, s.messages) };
      } catch (error) { return failure(error, runtime); }
    })
    .addNode('respond', async (s, runtime) => {
      let reply = ''; let sent = 0;
      try {
        for await (const chunk of modelClient.stream(responseMessages(config, s.messages, s.assessment), { signal: runtime.signal })) {
          runtime.signal?.throwIfAborted();
          if (typeof chunk !== 'string') throw invalid();
          reply += chunk;
          if (reply.length > 8000 || unsafeReply(reply)) throw invalid();
          // Keep a short suffix to catch internal markers split across provider chunks.
          const until = Math.max(0, reply.length - 64);
          if (until > sent) { runtime.writer?.({ type: 'delta', text: reply.slice(sent, until) }); sent = until; }
        }
        if (!reply.trim()) throw invalid();
        if (sent < reply.length) runtime.writer?.({ type: 'delta', text: reply.slice(sent) });
        return { reply };
      } catch (error) { return failure(error, runtime); }
    })
    .addNode('check', (s, runtime) => {
      if (!s.reply.trim() || s.reply.length > 8000 || unsafeReply(s.reply)) return failure(invalid(), runtime);
      runtime.writer?.({ type: 'done', reply: s.reply });
      return {};
    })
    .addEdge(START, 'understand')
    .addConditionalEdges('understand', s => s.failure ? END : 'respond')
    .addConditionalEdges('respond', s => s.failure ? END : 'check')
    .addEdge('check', END).compile();
}
