import http from 'node:http';

import { handleCorsPreflight } from './http/cors.js';
import { createRateLimiter } from './http/rate-limit.js';
import { json } from './http/response.js';
import { serveStatic } from './http/static-files.js';
import { handleChat } from './routes/chat-route.js';
import { handleHealth } from './routes/health-route.js';
import { handleReportAudit, handleReportGenerate } from './routes/report-route.js';
import { createChatService } from './services/chat-service.js';
import { createReportService } from './services/report-service.js';

/** @param {{ config: any, modelClient: any, staticRoot?: string | null }} options */
export function createServer({ config, modelClient, staticRoot = null }) {
  const allowedByRateLimit = createRateLimiter(config.limits);
  const chatService = createChatService({ config, modelClient });
  const reportService = createReportService({ config, modelClient });

  return http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://localhost');
    if (handleCorsPreflight(request, response, url.pathname)) return;
    if (url.pathname === '/api/health') return handleHealth(response, modelClient);
    if (url.pathname === '/api/chat') {
      if (request.method !== 'POST') return json(response, { error: '只支持 POST 请求。' }, 405);
      return handleChat({ request, response, config, chatService, modelClient, allowedByRateLimit });
    }
    if (url.pathname === '/api/report/audit') {
      if (request.method !== 'POST') return json(response, { error: '只支持 POST 请求。' }, 405);
      return handleReportAudit({ request, response, config, reportService, modelClient, allowedByRateLimit });
    }
    if (url.pathname === '/api/report/generate') {
      if (request.method !== 'POST') return json(response, { error: '只支持 POST 请求。' }, 405);
      return handleReportGenerate({ request, response, config, reportService, modelClient, allowedByRateLimit });
    }
    if (staticRoot) return serveStatic({ requestPath: url.pathname, response, staticRoot });
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
  });
}
