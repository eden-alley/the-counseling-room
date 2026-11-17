import { readValidBody, validReportAnswers } from '../http/body.js';
import { clientIp } from '../http/rate-limit.js';
import { json } from '../http/response.js';

/** @param {import('node:http').ServerResponse} response */
function unavailable(response) {
  return json(response, { error: '服务尚未完成配置。' }, 503);
}

/** @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response @param {(key: string) => boolean} allowedByRateLimit */
function rateLimited(request, response, allowedByRateLimit) {
  if (allowedByRateLimit(`report:${clientIp(request)}`)) return false;
  json(response, { error: '报告请求太频繁，请一分钟后再试。' }, 429);
  return true;
}

/** @param {{ request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, config: any, reportService: any, modelClient: any, allowedByRateLimit: (key: string) => boolean }} dependencies */
export async function handleReportAudit({ request, response, config, reportService, modelClient, allowedByRateLimit }) {
  if (rateLimited(request, response, allowedByRateLimit)) return;
  if (modelClient.configured === false) return unavailable(response);
  const body = await readValidBody(request, response, config.limits);
  if (!body) return;
  const result = await reportService.audit(body.messages);
  if (result.error) return json(response, { error: result.error }, result.status);
  return json(response, { questions: result.questions });
}

/** @param {{ request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, config: any, reportService: any, modelClient: any, allowedByRateLimit: (key: string) => boolean }} dependencies */
export async function handleReportGenerate({ request, response, config, reportService, modelClient, allowedByRateLimit }) {
  if (rateLimited(request, response, allowedByRateLimit)) return;
  if (modelClient.configured === false) return unavailable(response);
  const body = await readValidBody(request, response, config.limits);
  if (!body) return;
  if (!validReportAnswers(body.answers || [], config.limits.maxReportQuestions)) {
    return json(response, { error: '报告补充信息格式不正确。' }, 400);
  }
  const result = await reportService.generate(body.messages, body.answers || []);
  if (result.error) return json(response, { error: result.error }, result.status);
  return json(response, { report: result.reply });
}
