export class ModelError extends Error {
  /** @param {string} message @param {number} [status] @param {boolean} [retryable] */
  constructor(message, status = 502, retryable = false) {
    super(message); this.status = status; this.retryable = retryable;
  }
}

/** @param {unknown} error @param {AbortSignal} [signal] */
export function modelFailure(error, signal) {
  signal?.throwIfAborted();
  if (error instanceof ModelError) return error;
  if (error instanceof Error && error.name === 'TimeoutError') return new ModelError('模型响应超时，请稍后重试。', 504, true);
  return new ModelError('暂时无法连接模型服务，请稍后重试。', 502, true);
}

/** @param {number} timeoutMs @param {AbortSignal} [parent] */
export function attemptSignal(timeoutMs, parent) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), timeoutMs);
  return { signal: controller.signal, dispose() { clearTimeout(timer); parent?.removeEventListener('abort', abort); } };
}

/** @param {number} ms @param {AbortSignal} [signal] */
export function waitForRetry(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(undefined); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
