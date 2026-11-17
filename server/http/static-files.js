import fs from 'node:fs';
import path from 'node:path';

/** @type {Record<string, string>} */
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.webm': 'video/webm',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

/** @param {import('node:http').ServerResponse} response */
function badPath(response) {
  response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('Bad asset path');
}

/** @param {{ requestPath: string, response: import('node:http').ServerResponse, staticRoot: string }} options */
export function serveStatic({ requestPath, response, staticRoot }) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    badPath(response);
    return;
  }
  const root = path.resolve(staticRoot);
  const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^[/\\]+/, '');
  const filePath = path.resolve(root, relativePath);
  const relative = path.relative(root, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    badPath(response);
    return;
  }
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
    return;
  }
  if (!stats.isFile()) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
    return;
  }
  response.writeHead(200, {
    'content-type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-cache',
    'content-length': stats.size,
    'x-content-type-options': 'nosniff'
  });
  fs.createReadStream(filePath).pipe(response);
}
