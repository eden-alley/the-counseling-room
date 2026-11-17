import { expect, test } from '@playwright/test';

const CURRENT_SESSION_KEY = 'ape-v2-current-session';
const HISTORY_KEY = 'ape-v2-session-history';
const seededSession = {
  id: 'browser-seeded-session',
  startedAt: '2026-08-27T00:00:00.000Z',
  endedAt: null,
  updatedAt: '2026-08-27T00:00:00.000Z',
  entryType: 'free_conversation',
  entryLabel: '开始探索',
  title: '开始探索',
  durationSeconds: 0,
  messageCount: 1,
  messages: [{ role: 'user', content: '我想整理最近的困惑。' }],
  promptContext: '自由聊聊',
  summaryMarkdown: '',
};

test('preserves the counseling room save-and-exit flow without network access', async ({ page }) => {
  const unexpectedRequests = [];
  await page.addInitScript(({ currentKey, session }) => {
    window.localStorage.setItem(currentKey, JSON.stringify(session));
    window.matchMedia = query => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
    });
  }, { currentKey: CURRENT_SESSION_KEY, session: seededSession });

  await page.route('**/*', async route => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname === '/api/health') return route.fulfill({ json: { ready: true, capabilities: { sessions_v1: false } } });
    const isMimo = /(^|\.)xiaomimimo\.com$/i.test(requestUrl.hostname) || /mimo/i.test(requestUrl.hostname);
    const isApi = requestUrl.pathname === '/api' || requestUrl.pathname.startsWith('/api/');
    if (isMimo || isApi) {
      unexpectedRequests.push(requestUrl.href);
      await route.abort();
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  await expect(page.locator('#landingScreen')).toBeVisible();
  await expect(page.locator('#roomScreen')).toBeHidden();

  await page.locator('#entryDoorHotspot').click();
  await page.locator('#entryIntroVideo').dispatchEvent('ended');
  await expect(page.locator('#roomScreen')).toBeVisible();

  await page.locator('#consultationChairHotspot').dispatchEvent('click');
  await expect(page.locator('#chatScreen')).toBeHidden();

  await page.locator('#bookHotspot').click();
  const consultation = page.locator('#consultationUiLayer');
  await expect(consultation).toHaveAttribute('aria-hidden', 'false');
  await expect(consultation).toHaveAttribute('data-active-section', 'explore');
  await expect(page.locator('#consultationEndModal')).toHaveAttribute('data-modal-state', 'closed');
  await expect(page.locator('#consultationExitModal')).toHaveAttribute('data-modal-state', 'closed');

  await page.locator('#consultationEndButton').click();
  await expect(page.locator('#consultationEndModal')).toHaveAttribute('data-modal-state', 'open');
  await expect(page.locator('#consultationExitModal')).toHaveAttribute('data-modal-state', 'closed');
  await page.locator('#consultationEndContinueButton').click();
  await expect(page.locator('#consultationEndModal')).toHaveAttribute('data-modal-state', 'closed');
  await expect.poll(() => page.evaluate(key => window.localStorage.getItem(key), CURRENT_SESSION_KEY)).not.toBeNull();

  await page.locator('#consultationUiCloseButton').click();
  await expect(page.locator('#consultationExitModal')).toHaveAttribute('data-modal-state', 'open');
  await expect(page.locator('#consultationEndModal')).toHaveAttribute('data-modal-state', 'closed');
  await page.locator('#consultationExitSaveButton').click();
  await expect(consultation).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('#roomScreen')).toHaveAttribute('data-scene-state', 'room');
  await expect.poll(() => page.evaluate(key => window.localStorage.getItem(key), CURRENT_SESSION_KEY)).toBeNull();
  await expect.poll(() => page.evaluate(key => JSON.parse(window.localStorage.getItem(key) || '[]'), HISTORY_KEY)).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: seededSession.id })]),
  );
  expect(unexpectedRequests).toEqual([]);
});

test('report return restores usable chat and Escape preserves the draft', async ({ page }) => {
  const unexpected = []; const requests = [];
  await page.addInitScript(({ key, session }) => localStorage.setItem(key, JSON.stringify(session)), { key: CURRENT_SESSION_KEY, session: seededSession });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:4173') { unexpected.push(url.href); return route.abort(); }
    if (url.pathname.startsWith('/api/')) {
      requests.push(url.pathname);
      if (url.pathname === '/api/health') return route.fulfill({ json: { ready: true, capabilities: { sessions_v1: false } } });
      if (url.pathname === '/api/report/audit') return route.fulfill({ json: { questions: [] } });
      if (url.pathname === '/api/report/generate') return route.fulfill({ json: { report: '# 本地模拟报告' } });
      unexpected.push(url.href); return route.abort();
    }
    return route.continue();
  });
  await page.goto('/');
  await page.locator('#entryDoorHotspot').click();
  await page.locator('#entryIntroVideo').dispatchEvent('ended');
  await page.locator('#bookHotspot').click();
  await expect(page.locator('#consultationUiLayer')).toHaveAttribute('aria-hidden', 'false');
  await page.locator('#consultationUiCloseButton').click();
  await expect(page.locator('#consultationExitModal')).toHaveAttribute('data-modal-state', 'open');
  await page.keyboard.press('Escape');
  await expect(page.locator('#consultationExitModal')).toHaveAttribute('data-modal-state', 'closed');
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).id, CURRENT_SESSION_KEY)).toBe(seededSession.id);
  await page.locator('#consultationEndButton').click();
  await page.locator('#consultationEndReportButton').click();
  await expect(page.locator('#reportOutput')).toContainText('本地模拟报告');
  await page.locator('#summaryBackBtn').click();
  await expect(page.locator('#roomScreen')).toHaveAttribute('data-scene-state', 'consultation-ui');
  await expect(page.locator('#consultationUiLayer')).toHaveCSS('opacity', '1');
  await page.locator('#input').fill('返回后仍能输入');
  await expect(page.locator('#input')).toHaveValue('返回后仍能输入');
  await expect(page.locator('#chat')).toContainText(seededSession.messages[0].content);
  expect(requests).toEqual(['/api/health', '/api/report/audit', '/api/report/generate']);
  expect(unexpected).toEqual([]);
});
