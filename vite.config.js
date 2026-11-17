import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

/** @param {string} relative */
const fromRoot = relative => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  root: fromRoot('./src/client/'),
  publicDir: fromRoot('./public/'),
  build: {
    outDir: fromRoot('./dist/web/'),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:9000',
    },
  },
});
