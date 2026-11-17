import fs from 'node:fs';
import path from 'node:path';

/** @param {any} value */
function freeze(value) {
  Object.freeze(value);
  for (const item of Object.values(value)) {
    if (item && typeof item === 'object' && !Object.isFrozen(item)) freeze(item);
  }
  return value;
}

/** @param {NodeJS.ProcessEnv} env @param {string} root */
export function loadConfig(env, root) {
  const mode = env.MODEL_MODE || 'mock';
  if (mode !== 'mock' && mode !== 'mimo') throw new Error('MODEL_MODE must be mock or mimo');
  return freeze({
    mode,
    model: 'mimo-v2.5-pro',
    limits: {
      maxMessages: 60,
      maxBodyBytes: 160_000,
      windowMs: 60_000,
      maxRequestsPerWindow: 10,
      maxReportQuestions: 3
    },
    prompts: {
      system: fs.readFileSync(path.join(root, 'system-prompt.md'), 'utf8'),
      consultantCorpus: fs.readFileSync(path.join(root, 'consultant-corpus.md'), 'utf8'),
      report: fs.readFileSync(path.join(root, 'report-prompt.md'), 'utf8')
    },
    mimo: {
      url: env.MIMO_API_URL || 'https://api.xiaomimimo.com/v1/chat/completions',
      apiKey: env.MIMO_API_KEY || ''
    }
  });
}
