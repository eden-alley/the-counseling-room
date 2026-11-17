const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type'
};

/** @param {import('node:http').ServerResponse} response @param {any} data @param {number} [status] @param {import('node:http').OutgoingHttpHeaders} [extraHeaders] */
export function json(response, data, status = 200, extraHeaders = {}) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...CORS_HEADERS,
    ...extraHeaders
  });
  response.end(JSON.stringify(data));
}

/** @param {import('node:http').ServerResponse} response @param {string} body @param {number} status */
export function text(response, body, status) {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(body);
}
