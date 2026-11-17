import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './server/config.js';
import { createServer } from './server/create-server.js';
import { createMiMoClient } from './server/services/mimo-client.js';
import { createMockModelClient } from './server/services/mock-model-client.js';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const isExecutable = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isExecutable) {
  const config = loadConfig(process.env, projectRoot);
  const modelClient = config.mode === 'mock' ? createMockModelClient() : createMiMoClient({ ...config.mimo, model: config.model, fetchImpl: fetch });
  const staticRoot = process.argv.includes('--static') ? path.join(projectRoot, 'dist', 'web') : null;
  const server = createServer({ config, modelClient, staticRoot });
  server.listen(Number(process.env.PORT || 9000), '0.0.0.0', () => console.log(`Listening on ${process.env.PORT || 9000}; MODEL_MODE=${config.mode}${config.mode === 'mock' ? ' (模拟响应，无模型请求)' : ''}`));
}
