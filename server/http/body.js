import { json } from './response.js';

/** @param {import('node:http').IncomingMessage} request @param {number} maxBodyBytes */
export function readBody(request, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    request.on('data', /** @param {Buffer} chunk */ chunk => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/** @param {any} messages @param {number} maxMessages */
export function validMessages(messages, maxMessages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > maxMessages) return false;
  return messages.every(message =>
    message &&
    (message.role === 'user' || message.role === 'assistant') &&
    typeof message.content === 'string' &&
    message.content.trim().length > 0 &&
    message.content.length <= 8_000
  );
}

/** @param {any} answers @param {number} maxReportQuestions */
export function validReportAnswers(answers, maxReportQuestions) {
  return Array.isArray(answers) && answers.length <= maxReportQuestions && answers.every(item =>
    item && typeof item.question === 'string' && item.question.length <= 1_000 &&
    typeof item.answer === 'string' && item.answer.length <= 4_000
  );
}

/** @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response @param {any} limits */
export async function readValidBody(request, response, limits) {
  let body;
  try {
    body = JSON.parse(await readBody(request, limits.maxBodyBytes));
  } catch (caught) {
    const error = /** @type {{ status?: number }} */ (caught);
    json(response, { error: error.status === 413 ? '对话内容过长，请导出后开始新对话。' : '请求内容格式不正确。' }, error.status || 400);
    return null;
  }
  if (!validMessages(body.messages, limits.maxMessages)) {
    json(response, { error: `对话记录无效或超过${limits.maxMessages}条消息。` }, 400);
    return null;
  }
  return body;
}
