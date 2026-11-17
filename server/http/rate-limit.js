/** @param {import('node:http').IncomingMessage} request */
export function clientIp(request) {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return request.headers['x-real-ip'] || request.socket.remoteAddress || 'unknown';
}

/** @param {{ windowMs: number, maxRequestsPerWindow: number }} options */
export function createRateLimiter({ windowMs, maxRequestsPerWindow }) {
  const buckets = new Map();
  return /** @param {string} key */ key => {
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now - bucket.startedAt >= windowMs) {
      buckets.set(key, { startedAt: now, count: 1 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= maxRequestsPerWindow;
  };
}
