/** Race even adapters that ignore AbortSignal. @template T @param {Promise<T>} promise @param {AbortSignal} [signal] @returns {Promise<T>} */
export function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

/** Bounded UTF-8 SSE decoder; incomplete events are never accepted. @param {ReadableStream<Uint8Array> | null} body @param {AbortSignal} [signal] */
export async function* readSse(body, signal) {
  if (!body) throw Error('Missing stream');
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal);
      buffer += decoder.decode(value, { stream: !done });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        // A public session can carry 60 original messages and the cached report.
        // Bound each frame independently: one network chunk may contain many frames.
        if (match.index > 4 * 1024 * 1024) throw Error('Oversized stream frame');
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        let event = 'message';
        const data = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (data.length) yield { event, data: data.join('\n') };
      }
      if (buffer.length > 4 * 1024 * 1024) throw Error('Oversized stream frame');
      if (done) {
        if (buffer.trim()) throw Error('Incomplete stream frame');
        return;
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
