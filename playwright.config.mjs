import { defineConfig } from '@playwright/test';

process.env.PW_DISABLE_TS_ESM ??= '1';

export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    channel: 'msedge',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run build && node ./node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173',
    port: 4173,
    reuseExistingServer: false,
  },
});
