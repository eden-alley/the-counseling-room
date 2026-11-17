import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const clientRoot = fileURLToPath(new URL('../../src/client/', import.meta.url));

function collect(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory()
      ? collect(path.join(directory, entry.name))
      : /\.(?:html|css|js)$/.test(entry.name) ? [path.join(directory, entry.name)] : []);
}

export function readFrontendSource() {
  return collect(clientRoot).sort().map(file => readFileSync(file, 'utf8')).join('\n');
}
