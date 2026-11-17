import { expect, test } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = process.cwd();
const python = path.join(root, '.venv', 'Scripts', 'python.exe');
const CURRENT = 'ape-v2-current-session';
let backend;

async function createBackend(testInfo) {
  const database = testInfo.outputPath('consultations.sqlite3');
  await fs.mkdir(path.dirname(database), { recursive: true });
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  let processHandle, output = '';
  const env = { ...process.env, MODEL_MODE: 'mock', ANALYSIS_PROVIDER: 'mock', DIALOGUE_PROVIDER: 'mock', SESSION_DB_PATH: database };
  async function start() {
    processHandle = spawn(python, ['-X', 'utf8', '-m', 'backend', '--port', String(port)], { cwd: root, env, windowsHide: true, stdio: 'pipe' });
    processHandle.stdout.on('data', data => { output += data; });
    processHandle.stderr.on('data', data => { output += data; });
    for (let attempt = 0; attempt < 70; attempt += 1) {
      if (processHandle.exitCode !== null) throw Error(`Local mock backend exited: ${output}`);
      try { if ((await (await fetch(`${origin}/api/health`)).json()).ready) return; } catch {}
      await delay(100);
    }
    throw Error(`Local mock backend did not start: ${output}`);
  }
  async function stop() {
    if (processHandle && processHandle.exitCode === null && processHandle.signalCode === null) {
      processHandle.kill();
      await once(processHandle, 'exit');
    }
  }
  async function get(sid) { return fetch(`${origin}/api/sessions/${encodeURIComponent(sid)}`); }
  function stateVersion(sid) {
    const code = 'import sqlite3,json,sys; db=sqlite3.connect(sys.argv[1]); row=db.execute("SELECT result_json FROM turns WHERE session_id=? AND status=\'completed\' ORDER BY accepted_revision DESC LIMIT 1",(sys.argv[2],)).fetchone(); print(json.loads(row[0])["session_state"]["version"])';
    const result = spawnSync(python, ['-X', 'utf8', '-c', code, database, sid], { cwd: root, env, windowsHide: true, encoding: 'utf8' });
    if (result.status !== 0) throw Error(result.stderr);
    return Number(result.stdout.trim());
  }
  await start();
  return { origin, get, start, stop, stateVersion };
}

async function enterRoom(page) {
  await page.locator('#entryDoorHotspot').click();
  await page.locator('#entryIntroVideo').dispatchEvent('ended');
  await expect(page.locator('#roomScreen')).toBeVisible();
  await page.locator('#bookHotspot').click();
  await expect(page.locator('#consultationUiLayer')).toHaveAttribute('aria-hidden', 'false');
  await expect(page.locator('#send')).toBeEnabled();
}

async function send(page, text, count) {
  await page.locator('#input').fill(text);
  await page.locator('#send').click();
  await expect(page.locator('#chat')).toContainText(text);
  await expect(page.locator('#chat .message.assistant')).toHaveCount(count + 1); // Existing static opening is displayed, not a saved assistant turn.
  await expect(page.locator('#chat')).toContainText('本地模拟');
  await expect(page.locator('#send')).toBeEnabled();
}

test.beforeEach(async ({ page }, testInfo) => {
  backend = await createBackend(testInfo);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) {
      return route.fulfill({ response: await route.fetch({ url: backend.origin + url.pathname }) });
    }
    if (url.origin !== 'http://127.0.0.1:4173') return route.abort();
    return route.continue();
  });
});
test.afterEach(async () => { await backend?.stop(); });

test('real mock backend restores after process restart; discard returns to the saved snapshot', async ({ page }) => {
  test.setTimeout(60000);
  await page.goto('/');
  await enterRoom(page);
  await send(page, '离线浏览器：第一段原文。', 1);
  const sid = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).id, CURRENT);
  const before = (await (await backend.get(sid)).json()).session;
  await page.locator('#consultationUiCloseButton').click();
  await page.locator('#consultationExitSaveButton').click();
  await expect(page.locator('#consultationUiLayer')).toHaveAttribute('aria-hidden', 'true');
  expect(await page.evaluate(key => localStorage.getItem(key), CURRENT)).toBeNull();
  expect((await (await backend.get(sid)).json()).session.hasSavedSnapshot).toBe(true);
  await backend.stop();
  expect(backend.stateVersion(sid)).toBe(1);
  await backend.start();
  await page.reload();
  await enterRoom(page);
  await page.locator('[data-consultation-section="consultation-history"]').click();
  await expect(page.locator('#historyScreen')).toBeVisible();
  await page.locator('#historyList [data-action="continue"]').first().click();
  await expect(page.locator('#legacyChat')).toContainText('离线浏览器：第一段原文。');
  expect((await (await backend.get(sid)).json()).session.messages).toEqual(before.messages);
  await page.locator('#legacyInput').fill('离线浏览器：这段续聊将丢弃。');
  await page.locator('#legacySend').click();
  await expect(page.locator('#legacyChat')).toContainText('离线浏览器：这段续聊将丢弃。');
  await expect.poll(async () => (await (await backend.get(sid)).json()).session.messages.length).toBe(4);
  await page.reload();
  await enterRoom(page);
  await expect(page.locator('#chat')).toContainText('离线浏览器：这段续聊将丢弃。');
  await page.locator('#consultationUiCloseButton').click();
  await page.locator('#consultationExitDiscardButton').click();
  await expect(page.locator('#consultationUiLayer')).toHaveAttribute('aria-hidden', 'true');
  const restored = (await (await backend.get(sid)).json()).session;
  expect(restored.messages).toEqual(before.messages);
  expect(restored.saved).toBe(true);
  await backend.stop();
  expect(backend.stateVersion(sid)).toBe(1);
});

test('new unsaved session can be discarded and report is durably saved through the existing flow', async ({ page }) => {
  test.setTimeout(60000);
  await page.goto('/');
  await enterRoom(page);
  await send(page, '离线浏览器：未保存草稿。', 1);
  const removed = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).id, CURRENT);
  await page.locator('#consultationUiCloseButton').click();
  await page.locator('#consultationExitDiscardButton').click();
  await expect(page.locator('#consultationUiLayer')).toHaveAttribute('aria-hidden', 'true');
  expect((await backend.get(removed)).status).toBe(404);
  await page.locator('#bookHotspot').click();
  await send(page, '离线浏览器：保存并生成报告。', 1);
  const sid = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).id, CURRENT);
  await page.locator('#consultationEndButton').click();
  await page.locator('#consultationEndReportButton').click();
  await expect(page.locator('#summaryScreen')).toBeVisible();
  await expect(page.locator('#reportOutput')).toContainText('模拟咨询报告');
  await expect.poll(async () => (await (await backend.get(sid)).json()).session.summaryMarkdown).toContain('模拟咨询报告');
  expect((await (await backend.get(sid)).json()).session.saved).toBe(true);
  await page.locator('#summaryBackBtn').click();
  await expect(page.locator('#input')).toBeVisible();
});

test('lost completed stream is recovered by request id without generating another turn', async ({ page }) => {
  test.setTimeout(60000);
  let sends = 0;
  await page.route('**/api/sessions/*/turns', async route => {
    sends += 1;
    const response = await route.fetch({ url: backend.origin + new URL(route.request().url()).pathname });
    expect(response.status()).toBe(200);
    await route.abort('failed'); // Server already committed; the browser receives no accepted/done event.
  });
  await page.goto('/');
  await enterRoom(page);
  await send(page, '离线浏览器：断流恢复原请求。', 1);
  expect(sends).toBe(1);
  const sid = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).id, CURRENT);
  const session = (await (await backend.get(sid)).json()).session;
  expect(session.messages).toHaveLength(2);
  expect(session.lastTurn.status).toBe('completed');
});
