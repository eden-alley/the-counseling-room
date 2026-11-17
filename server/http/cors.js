/** @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response @param {string} pathname */
export function handleCorsPreflight(request, response, pathname) {
  if (request.method !== 'OPTIONS' || !pathname.startsWith('/api/')) return false;
  response.writeHead(204, {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600'
  });
  response.end();
  return true;
}
