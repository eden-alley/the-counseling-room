import { isChatResponse } from '../../../shared/contracts/chat-api.js';
import { isAuditResponse, isReportResponse } from '../../../shared/contracts/report-api.js';
import { ApiError } from '../shared/errors.js';
import { abortable, readSse } from '../../../shared/contracts/sse.js';

/** @param {number} status @param {unknown} payload */
function errorMessage(status, payload) {
  const error = payload && typeof payload === 'object' && typeof /** @type {Record<string, unknown>} */ (payload).error === 'string'
    ? /** @type {Record<string, unknown>} */ (payload).error
    : '';
  if (status === 429) return error || '发送太频繁，请稍后再试。';
  if (status === 413) return '本次对话过长，请先导出后开始新对话。';
  return error || '连接没有成功，请稍后重试。';
}

/** Legacy chat/report contracts accept only public role/content, without session message IDs. @param {unknown} messages */
function publicMessages(messages) {
  return Array.isArray(messages)
    ? messages.map(message => ({role:message?.role,content:message?.content}))
    : messages;
}

/** @param {{ baseUrl: string, fetchImpl?: typeof fetch }} options */
export function createApiClient({ baseUrl, fetchImpl = fetch }) {
  const root = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;

  /** @param {string} path @param {unknown} payload @param {AbortSignal | undefined} signal */
  async function request(path, payload, signal, method = 'POST') {
    signal?.throwIfAborted();
    const response = await abortable(fetchImpl(`${root}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal,
    }), signal);
    /** @type {unknown} */
    let data;
    try {
      data = await abortable(response.json(), signal);
    } catch (reason) {
      if (signal?.aborted) throw signal.reason;
      throw new ApiError(errorMessage(response.status, null), response.status);
    }
    if (!response.ok) throw new ApiError(errorMessage(response.status, data), response.status);
    return data;
  }

  /** @param {unknown} messages @param {AbortSignal | undefined} [signal] */
  async function sendChat(messages, signal) {
    const data = await request('/api/chat', { messages:publicMessages(messages) }, signal);
    if (!isChatResponse(data)) throw new ApiError(errorMessage(200, null), 200);
    return data.reply;
  }

  /** @param {unknown} messages @param {(text:string)=>void} onDelta @param {AbortSignal} [signal] */
  async function streamChat(messages, onDelta, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    // The current backend permits 180 seconds; allow 30 seconds for transport/cleanup.
    const timer = setTimeout(() => controller.abort(new DOMException('回复超时，请重试。', 'TimeoutError')), 210000);
    let text = '';
    try {
      controller.signal.throwIfAborted();
      const response = await abortable(fetchImpl(`${root}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages:publicMessages(messages), stream: true }), signal: controller.signal }), controller.signal);
      if (!response.ok) {
        const payload = await abortable(response.json().catch(() => null), controller.signal);
        throw new ApiError(errorMessage(response.status, payload), response.status);
      }
      if (!response.headers.get('content-type')?.includes('text/event-stream')) {
        void response.body?.cancel().catch(() => {});
        throw new ApiError('回复格式不正确，请重试。', 502);
      }
      for await (const frame of readSse(response.body, controller.signal)) {
        controller.signal.throwIfAborted();
        const event = JSON.parse(frame.data);
        if (!event || event.type !== frame.event) throw new ApiError('回复格式不正确，请重试。', 502);
        if (event.type === 'error') throw new ApiError(typeof event.error === 'string' ? event.error : '回复生成失败。', typeof event.status === 'number' ? event.status : 502);
        if (event.type === 'delta' && typeof event.text === 'string' && event.text.length && Array.from(text + event.text).length <= 8000) { text += event.text; onDelta(event.text); }
        else if (event.type === 'done' && isChatResponse(event) && event.reply === text) return text;
        else throw new ApiError('回复格式不正确，请重试。', 502);
      }
      throw new ApiError('回复中断，未保存未完成内容。请重试。', 502);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }

  /** @param {unknown} messages @param {AbortSignal} [signal] */
  async function auditReport(messages, signal) {
    const data = await request('/api/report/audit', { messages:publicMessages(messages) }, signal);
    if (!isAuditResponse(data)) throw new ApiError(errorMessage(200, null), 200);
    return data.questions;
  }

  /** @param {unknown} messages @param {unknown} answers @param {AbortSignal} [signal] */
  async function generateReport(messages, answers, signal) {
    const data = await request('/api/report/generate', { messages:publicMessages(messages), answers }, signal);
    if (!isReportResponse(data)) throw new ApiError(errorMessage(200, null), 200);
    return data.report;
  }

  /** @param {string} id */ const pathFor = id => `/api/sessions/${encodeURIComponent(id)}`;
  /** @param {string} path @param {any} [payload] @param {string} [method] */
  async function sessionRequest(path, payload, method) {
    const data = /** @type {any} */ (await request(path, payload, undefined, method));
    if (!data?.session || typeof data.session.id !== 'string') throw new ApiError('会话响应格式不正确。', 502);
    return data.session;
  }
  /** @param {string} id @param {any} payload @param {(event:any)=>void} onEvent @param {AbortSignal} [signal] */
  async function streamTurn(id, payload, onEvent, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new DOMException('回复超时，请检查已保存的请求状态。', 'TimeoutError')), 210000);
    let text = '';
    try {
      const response = await abortable(fetchImpl(`${root}${pathFor(id)}/turns`, {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({...payload,stream:true}),signal:controller.signal}), controller.signal);
      if (!response.ok) throw Object.assign(new ApiError(errorMessage(response.status, await abortable(response.json().catch(() => null), controller.signal)), response.status),{requestRejected:true});
      if (!response.headers.get('content-type')?.includes('text/event-stream')) { void response.body?.cancel().catch(() => {}); throw new ApiError('回复格式不正确，请检查请求状态。', 502); }
      for await (const frame of readSse(response.body, controller.signal)) {
        const event = JSON.parse(frame.data);
        if (!event || event.type !== frame.event) throw new ApiError('回复格式不正确。',502);
        if (event.type === 'delta' && typeof event.text === 'string' && event.text.length && Array.from(text + event.text).length <= 8000) { text += event.text; onEvent(event); }
        else if ((event.type === 'accepted' || event.type === 'done') && event.request_id === payload.request_id && event.session?.storage === 'server' && typeof event.revision === 'number') {
          if (event.type === 'done' && (!isChatResponse(event) || (text && text !== event.reply))) throw new ApiError('回复格式不正确。',502);
          onEvent(event); if (event.type === 'done') return event;
        } else if (event.type === 'error') { onEvent(event); throw new ApiError(errorMessage(event.status || 502,event),event.status || 502); }
        else throw new ApiError('回复格式不正确。',502);
      }
      throw new ApiError('回复连接中断，正在读取已保存的请求结果。',502);
    } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  return {
    sendChat, streamChat, auditReport, generateReport, streamTurn,
    health: () => request('/api/health',undefined,undefined,'GET'),
    createSession: (/** @type {any} */ session) => sessionRequest('/api/sessions',{session}),
    importSession: (/** @type {any} */ session) => sessionRequest('/api/sessions/import',{session}),
    listSessions: async () => { const data = /** @type {any} */ (await request('/api/sessions',undefined,undefined,'GET')); if (!Array.isArray(data?.sessions)) throw new ApiError('会话列表格式不正确。',502); return data.sessions; },
    getSession: (/** @type {string} */ id) => sessionRequest(pathFor(id),undefined,'GET'),
    getTurn: (/** @type {string} */ id, /** @type {string} */ rid) => request(`${pathFor(id)}/turns/${encodeURIComponent(rid)}`,undefined,undefined,'GET'),
    cancelTurn: (/** @type {string} */ id, /** @type {string} */ rid) => request(`${pathFor(id)}/turns/${encodeURIComponent(rid)}/cancel`,undefined,undefined),
    saveSession: (/** @type {string} */ id, /** @type {number} */ revision, /** @type {any} */ metadata) => sessionRequest(`${pathFor(id)}/save`,{expected_revision:revision,metadata}),
    updateSessionMetadata: (/** @type {string} */ id, /** @type {number} */ revision, /** @type {any} */ metadata) => sessionRequest(`${pathFor(id)}/metadata`,{expected_revision:revision,metadata}),
    discardSession: (/** @type {string} */ id, /** @type {number} */ revision) => sessionRequest(`${pathFor(id)}/discard`,{expected_revision:revision}),
    deleteSession: (/** @type {string} */ id, /** @type {number} */ revision) => sessionRequest(pathFor(id),{expected_revision:revision},'DELETE'),
  };
}
