import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../node_modules/@playwright/test/cli.js', import.meta.url));
const child = spawn(process.execPath, [cli, 'test', ...process.argv.slice(2)], {
  env: { ...process.env, PW_DISABLE_TS_ESM: '1' },
  stdio: 'inherit',
});

child.once('error', error => {
  console.error(error);
  process.exitCode = 1;
});
child.once('exit', code => {
  process.exitCode = code ?? 1;
});
