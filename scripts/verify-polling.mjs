import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../server.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const dir = mkdtempSync(path.join(os.tmpdir(), 'fishdeco-polling-'));
writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ collections: [] }));
const app = createApp({ dataDir: dir, password: 'test-only-invite' });
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.clock.install();
  const user = { id: 'self', name: 'Alice' };
  const state = { currentUser: user, users: [user], collections: [
    { id: 'a', name: 'Set', items: [{ id: 'chair', name: 'Chair' }] },
  ], collectors: [], primaryAssignments: [] };
  let reads = 0;
  let lastConditional;
  let hold = null;
  const seen = [];
  await page.route('**/api/session', (route) => route.fulfill({ json: { authenticated: true, user } }));
  await page.route('**/api/auth/discord/config', (route) => route.fulfill({ json: { enabled: true, linked: true } }));
  await page.route('**/api/state', async (route) => {
    reads++;
    lastConditional = route.request().headers()['if-none-match'];
    seen.push(lastConditional);
    if (hold) { const next = hold; hold = null; await next(route); return; }
    if (lastConditional === '"initial"') await route.fulfill({ status: 304, headers: { ETag: '"initial"' } });
    else await route.fulfill({ json: state, headers: { ETag: '"initial"' } });
  });
  await page.goto(`http://127.0.0.1:${app.server.address().port}`);
  await page.locator('[data-item-id="chair"]').waitFor();
  assert.equal(reads, 1);
  await page.clock.runFor(29900);
  assert.equal(reads, 1);
  await page.clock.runFor(200);
  await page.waitForFunction(() => !S.polling);
  assert.equal(reads, 2);
  assert.equal(lastConditional, '"initial"');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(10 * 60000);
  assert.equal(reads, 2, 'no hidden-tab polling over ten virtual minutes');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
  await page.waitForFunction(() => !S.polling);
  assert.equal(reads, 3, 'return immediately refreshes once despite focus and visibility events');

  // A response overtaken by a user edit must not advance the accepted validator.
  let release;
  let arrived;
  const arrival = new Promise((resolve) => { arrived = resolve; });
  hold = async (route) => {
    arrived();
    await new Promise((resolve) => { release = resolve; });
    await route.fulfill({ json: state, headers: { ETag: '"discarded"' } });
  };
  const pendingPoll = page.evaluate(() => poll());
  await arrival;
  await page.route('**/api/me/collections/a/items/chair', (route) => route.fulfill({ json: {
    collector: { id: 'self-a', name: 'Alice', userId: 'self', collectionId: 'a', ownedItemIds: ['chair'] },
  } }));
  await page.locator('[data-item-id="chair"] input').check();
  await page.waitForFunction(() => S.pending.size === 0);
  release();
  await pendingPoll;
  assert.equal(await page.evaluate(() => S.stateEtag), '"initial"');
  await page.evaluate(() => poll());
  assert.equal(seen.at(-1), '"initial"');
  assert.equal(await page.locator('[data-item-id="chair"] input').isChecked(), true);
  console.log('Polling checks passed: 30s visible interval, ten hidden minutes without requests, immediate deduplicated return, 304, discarded ETag race.');
} finally {
  await browser?.close();
  app.server.closeAllConnections();
  await new Promise((resolve) => app.server.close(resolve));
  app.db.close();
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(dir).startsWith('fishdeco-polling-'));
  rmSync(dir, { recursive: true, force: true });
}
