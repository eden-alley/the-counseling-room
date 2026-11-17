import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = fileURLToPath(new URL('../../scripts/configure-local-env.ps1', import.meta.url));
const windows = process.platform === 'win32';
const fakeDeepSeek = 'fixture-deepseek-not-a-real-key';
const fakeEmbedding = 'fixture-embedding-not-a-real-key';

function run(body, store) {
  const command = `$ErrorActionPreference = 'Stop'\n${body}`;
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(command, 'utf16le').toString('base64'),
  ], {
    encoding: 'utf8', timeout: 15000,
    env: { ...process.env, CONFIG_SCRIPT: script, TEST_STORE: store, MODEL_MODE: 'mock',
      DEEPSEEK_API_KEY: fakeDeepSeek, DASHSCOPE_API_KEY: fakeEmbedding },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes(fakeDeepSeek), 'must not print DeepSeek key');
  assert.ok(!result.stdout.includes(fakeEmbedding), 'must not print embedding key');
  return result.stdout;
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'counselor-key-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'keys.clixml');
}

test('local environment check reports availability without changing process configuration', { skip: !windows }, (t) => {
  const store = fixture(t);
  const output = run(`
$beforeDeepSeek = $env:DEEPSEEK_API_KEY
$beforeEmbedding = $env:DASHSCOPE_API_KEY
$rows = @(& $env:CONFIG_SCRIPT -CheckOnly -StorePath $env:TEST_STORE)
if ($rows.Count -ne 2 -or @($rows | Where-Object { -not $_.Configured -or $_.Source -ne 'Process' }).Count) { throw 'incorrect status' }
if ($env:DEEPSEEK_API_KEY -cne $beforeDeepSeek -or $env:DASHSCOPE_API_KEY -cne $beforeEmbedding -or $env:MODEL_MODE -ne 'mock') { throw 'check mutated configuration' }
Write-Output 'CHECK_OK'
`, store);
  assert.match(output, /CHECK_OK/);
  assert.equal(existsSync(store), false);
});

test('configuration encrypts process keys without prompting or changing user environment', { skip: !windows }, (t) => {
  const store = fixture(t);
  const output = run(`
$beforeDeepSeek = $env:DEEPSEEK_API_KEY
$beforeEmbedding = $env:DASHSCOPE_API_KEY
$beforeUserDeepSeek = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User')
$beforeUserEmbedding = [Environment]::GetEnvironmentVariable('DASHSCOPE_API_KEY', 'User')
function Read-Host { throw 'unexpected credential prompt' }
& $env:CONFIG_SCRIPT -StorePath $env:TEST_STORE
if ($env:DEEPSEEK_API_KEY -cne $beforeDeepSeek -or $env:DASHSCOPE_API_KEY -cne $beforeEmbedding) { throw 'process keys changed' }
if ([Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User') -cne $beforeUserDeepSeek -or [Environment]::GetEnvironmentVariable('DASHSCOPE_API_KEY', 'User') -cne $beforeUserEmbedding) { throw 'persisted credential change' }
if ($env:MODEL_MODE -ne 'mock') { throw 'enabled paid mode implicitly' }
Write-Output 'CONFIG_OK'
`, store);
  assert.match(output, /CONFIG_OK/);
  const encrypted = readFileSync(store, 'utf8');
  assert.ok(!encrypted.includes(fakeDeepSeek));
  assert.ok(!encrypted.includes(fakeEmbedding));
  const restored = run(`
$env:DEEPSEEK_API_KEY = $null
$env:DASHSCOPE_API_KEY = $null
function Read-Host { throw 'restart must not prompt' }
& $env:CONFIG_SCRIPT -StorePath $env:TEST_STORE -NoPrompt
if ($env:DEEPSEEK_API_KEY -cne '${fakeDeepSeek}' -or $env:DASHSCOPE_API_KEY -cne '${fakeEmbedding}') { throw 'restart did not restore keys' }
Write-Output 'RESTORED_OK'
`, store);
  assert.match(restored, /RESTORED_OK/);
});

test('damaged key store is reported without replacement or prompting', { skip: !windows }, (t) => {
  const store = fixture(t);
  writeFileSync(store, 'broken-encrypted-store');
  const output = run(`
function Read-Host { throw 'must not prompt on damage' }
try {
  & $env:CONFIG_SCRIPT -StorePath $env:TEST_STORE -NoPrompt
  throw 'damage unexpectedly accepted'
} catch {
  if ($_.Exception.Message -notlike 'Cannot decrypt local key store*') { throw }
}
Write-Output 'DAMAGE_HANDLED'
`, store);
  assert.match(output, /DAMAGE_HANDLED/);
  assert.equal(readFileSync(store, 'utf8'), 'broken-encrypted-store');
});

test('incomplete encrypted store cannot be silently repaired from environment keys', { skip: !windows }, (t) => {
  const store = fixture(t);
  run('@{} | Export-Clixml -LiteralPath $env:TEST_STORE', store);
  const before = readFileSync(store, 'utf8');
  run(`
try {
  & $env:CONFIG_SCRIPT -StorePath $env:TEST_STORE -NoPrompt
  throw 'incomplete store unexpectedly accepted'
} catch {
  if ($_.Exception.Message -notlike 'Cannot decrypt local key store*') { throw }
}
Write-Output 'INCOMPLETE_HANDLED'
`, store);
  assert.equal(readFileSync(store, 'utf8'), before);
});
