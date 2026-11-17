import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';

test('production build embeds the configured public API base', async () => {
  const apiBase = 'https://api-base-build-test.example';
  const previous = process.env.VITE_API_BASE;
  process.env.VITE_API_BASE = apiBase;

  try {
    const result = await build({
      configFile: fileURLToPath(new URL('../../vite.config.js', import.meta.url)),
      build: { write: false, minify: false },
    });
    const outputs = Array.isArray(result)
      ? result.flatMap(item => item.output)
      : result.output;
    const bundledJavaScript = outputs
      .filter(output => output.type === 'chunk')
      .map(output => output.code)
      .join('\n');

    assert.match(bundledJavaScript, new RegExp(apiBase.replaceAll('.', '\\.')));
  } finally {
    if (previous === undefined) delete process.env.VITE_API_BASE;
    else process.env.VITE_API_BASE = previous;
  }
});
