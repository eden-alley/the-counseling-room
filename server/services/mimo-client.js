import { unsafeModelOutput } from './output-guard.js';
import { abortable, readSse } from '../../shared/contracts/sse.js';
import { ModelError, modelFailure, attemptSignal, waitForRetry } from './model-runtime.js';

/** @param {{ url: string, apiKey: string, model: string, fetchImpl: typeof fetch, timeoutMs?: number, retryDelayMs?: number }} options */
export function createMiMoClient({ url, apiKey, model, fetchImpl, timeoutMs = 30000, retryDelayMs = 500 }) {
  /** @param {Array<{role:string,content:string}>} messages @param {boolean} stream @param {number} tokens @param {AbortSignal} signal */
  async function request(messages, stream, tokens, signal) {
    signal.throwIfAborted();
    const response = await abortable(fetchImpl(url, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, stream, max_completion_tokens: tokens, temperature: 1, top_p: 0.95, thinking: { type: 'disabled' } })
    }), signal);
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new ModelError(response.status === 429 ? '模型服务繁忙或额度不足，请稍后重试。' : '模型服务返回错误。', response.status === 429 ? 429 : response.status >= 500 ? 502 : 400, response.status === 429 || response.status >= 500);
    }
    return response;
  }
  /** @param {Array<{role:string,content:string}>} messages @param {any} schema @param {{maxCompletionTokens?:number, signal?:AbortSignal}} options */
  async function complete(messages, schema, { maxCompletionTokens = 1200, signal } = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const scope = attemptSignal(timeoutMs, signal);
      try {
        const response = await request(messages, false, maxCompletionTokens, scope.signal);
        let data;
        try { data = await abortable(response.json(), scope.signal); }
        catch (error) { scope.signal.throwIfAborted(); throw new ModelError('模型服务返回了无法读取的内容。'); }
        const message = data.choices?.[0]?.message;
        const reply = message?.content;
        if (typeof reply !== 'string' || !reply.trim() || message.tool_calls || message.function_call) throw new ModelError('模型没有返回有效回复。');
        if (schema) {
          try { return { data: schema.parse(JSON.parse(reply)) }; }
          catch { throw new ModelError('模型服务返回了无法读取的内容。'); }
        }
        if (unsafeModelOutput(reply)) throw new ModelError('本次回复生成异常，已为你拦截。请重新发送。');
        return { reply: reply.trim(), usage: data.usage };
      } catch (error) {
        const failure = modelFailure(error, signal);
        if (!failure.retryable || attempt === 2) return { error: failure.message, status: failure.status };
      } finally { scope.dispose(); }
      await waitForRetry(retryDelayMs * (attempt + 1), signal);
    }
    throw Error('Unreachable');
  }
  return {
    configured: Boolean(apiKey),
    /** @param {Array<{role:string,content:string}>} messages @param {{maxCompletionTokens?:number, signal?:AbortSignal}} [options] */
    complete(messages, options) { return complete(messages, null, options || {}); },
    /** @param {Array<{role:string,content:string}>} messages @param {any} schema @param {{maxCompletionTokens?:number, signal?:AbortSignal}} [options] */
    completeStructured(messages, schema, options) { return complete(messages, schema, options || {}); },
    /** @param {Array<{role:string,content:string}>} messages @param {{maxCompletionTokens?:number, signal?:AbortSignal}} [options] */
    async *stream(messages, { maxCompletionTokens = 1200, signal } = {}) {
      let emitted = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const scope = attemptSignal(timeoutMs, signal);
        try {
          const response = await request(messages, true, maxCompletionTokens, scope.signal);
          if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new ModelError('模型服务返回了无法读取的内容。');
          let stopped = false;
          for await (const frame of readSse(response.body, scope.signal)) {
            if (frame.data === '[DONE]') {
              if (!stopped || !emitted) throw new ModelError('模型没有返回有效回复。');
              return;
            }
            let data;
            try { data = JSON.parse(frame.data); } catch { throw new ModelError('模型服务返回了无法读取的内容。'); }
            const choice = data.choices?.[0];
            if (!choice) continue;
            if (stopped || choice.delta?.tool_calls || choice.delta?.function_call) throw new ModelError('本次回复生成异常，已为你拦截。请重新发送。');
            if (choice.finish_reason && choice.finish_reason !== 'stop') throw new ModelError('模型回复未完整生成，请重试。');
            const text = choice.delta?.content;
            if (text != null && typeof text !== 'string') throw new ModelError('模型没有返回有效回复。');
            if (text) { emitted = true; yield text; }
            if (choice.finish_reason === 'stop') stopped = true;
          }
          throw new ModelError('模型回复中断，请重试。', 502, true);
        } catch (error) {
          const failure = modelFailure(error, signal);
          if (emitted || !failure.retryable || attempt === 2) throw failure;
        } finally { scope.dispose(); }
        await waitForRetry(retryDelayMs * (attempt + 1), signal);
      }
    }
  };
}
