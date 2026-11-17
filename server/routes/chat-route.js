import { readValidBody } from '../http/body.js';
import { clientIp } from '../http/rate-limit.js';
import { json } from '../http/response.js';

/** @param {{ request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, config: any, chatService: any, modelClient: any, allowedByRateLimit: (key: string) => boolean }} dependencies */
export async function handleChat({ request, response, config, chatService, modelClient, allowedByRateLimit }) {
  const ip = clientIp(request);
  if (!allowedByRateLimit(`chat:${ip}`)) {
    return json(response, { error: '发送太频繁，请一分钟后再试。' }, 429, { 'retry-after': '60' });
  }
  if (modelClient.configured === false) return json(response, { error: '服务尚未完成配置。' }, 503);
  const body = await readValidBody(request, response, config.limits);
  if (!body) return;
  const controller = new AbortController();
  const abort = () => { if (!response.writableEnded) controller.abort(); };
  response.on('close', abort);
  const streaming = body.stream === true;
  /** @param {any} event */
  const write = event => {
    if (!response.destroyed && !controller.signal.aborted) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  try {
    if (streaming) {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff', 'x-accel-buffering': 'no' });
      response.flushHeaders();
      for await (const event of chatService.stream(body.messages, { signal: controller.signal })) write(event);
      if (!response.destroyed) response.end();
      return;
    }
    const result = await chatService.reply(body.messages, { signal: controller.signal });
    if (response.destroyed) return;
    if (result.error) return json(response, { error: result.error }, result.status);
    return json(response, { reply: result.reply });
  } catch {
    if (controller.signal.aborted || response.destroyed) return;
    const error = '本次回复生成异常，请稍后重试。';
    if (streaming) { write({ type: 'error', error, status: 502 }); response.end(); }
    else json(response, { error }, 502);
  } finally { response.removeListener('close', abort); }
}
