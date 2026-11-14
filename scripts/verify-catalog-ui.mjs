// Verify the actual catalog against the UI, using a disposable database only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from '../server.mjs';
import { createDiscordFixture } from './discord-fixture.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'data/catalog.json'), 'utf8'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fishdeco-catalog-ui-'));
fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(catalog));
const discord = createDiscordFixture();
const app = createApp({ dataDir: dir, password: 'catalog-browser-test-only', discord: discord.config });
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await discord.install(page, base, { id: '333333333333333333', username: 'tester', global_name: 'Testující člen', bot: false });
  await page.goto(base);
  await discord.login(page, 'catalog-browser-test-only');
  await page.waitForFunction((n) => document.querySelectorAll('#collection-list button').length === n, catalog.collections.length);
  const items = catalog.collections.flatMap((c) => c.items);
  assert.equal(items.length, 231);
  assert.equal(catalog.collections.length, 15);
  assert.ok(catalog.collections.every((c) => c.nameCs && !/[?\uFFFD]/.test(c.nameCs)));
  assert.ok(items.every((i) => i.nameCs && !/[?\uFFFD]/.test(i.nameCs)));
  assert.equal(await page.locator('#collection-list .col-link__image').count(), 15);

  // Decode every actual WEBP in Chromium, rather than just checking file headers.
  const failedImages = await page.evaluate(async (urls) => {
    const failures = [];
    let next = 0;
    await Promise.all(Array.from({ length: 5 }, async () => {
      while (next < urls.length) {
        const url = urls[next++];
        const img = new Image();
        img.src = url;
        try { await img.decode(); if (!img.naturalWidth) failures.push(url); }
        catch { failures.push(url); }
      }
    }));
    return failures;
  }, [...items.map((i) => i.image), ...catalog.collections.map((c) => c.image)]);
  assert.deepEqual(failedImages, []);

  for (const c of catalog.collections) {
    await page.locator(`[data-collection-id="${c.id}"]`).click();
    assert.equal(await page.locator('#col-title .collection-heading__name').textContent(), c.nameCs);
    assert.equal(await page.locator('#col-title img').getAttribute('src'), c.image);
    assert.deepEqual(await page.locator('#items .item__name').allTextContents(), c.items.map((i) => i.nameCs));
    assert.deepEqual(await page.locator('#items .item__original-name').allTextContents(), c.items.map((i) => i.name));
    assert.equal(await page.locator('#items > li:not([hidden])').count(), c.items.length);
    assert.equal(await page.locator('#items img').count(), c.items.length);
    assert.equal(await page.locator('#items .item__wiki').count(), c.items.length);
    assert.equal(await page.locator('#people .person__frac').first().textContent(), `0/${c.items.length}`);
  }
  await page.locator('#col-search').fill('jednoducha');
  assert.equal(await page.locator('#collection-list button').count(), 1);
  assert.equal(await page.locator('#collection-list button').getAttribute('data-collection-id'), 'simple-set');
  await page.locator('#col-search').fill('simple');
  assert.equal(await page.locator('#collection-list button').count(), 1);
  await page.locator('#col-search').fill('ostatni');
  assert.equal(await page.locator('#collection-list button').count(), 1);
  await page.locator('#collection-list button').click();
  assert.equal(await page.locator('#items > li:not([hidden])').count(), 63);
  await page.locator('#col-search').fill('');
  await page.locator('[data-collection-id="simple-set"]').click();
  await page.locator('#item-search').fill('simple wall');
  assert.equal(await page.locator('#items > li:not([hidden])').count(), 2);
  await page.locator('#item-search').fill('jednoducha stena');
  assert.equal(await page.locator('#items > li:not([hidden])').count(), 2);
  await page.locator('#filter-clear').click();
  await page.locator('#filter-type').selectOption('Wall');
  assert.equal(await page.locator('#items > li:not([hidden])').count(), 2);
  await page.locator('#filter-clear').click();
  await page.locator('#item-search').fill('nonexistent-decoration');
  assert.equal(await page.locator('#items > li:not([hidden])').count(), 0);
  assert.equal(await page.locator('#items-empty').isVisible(), true);
  await page.locator('#filter-clear').click();

  const owned = page.locator('[data-item-id="simple-wall-1"] input');
  await owned.check();
  await page.waitForFunction(() => !document.querySelector('[data-item-id="simple-wall-1"] input').disabled);
  await page.locator('#filter-own').selectOption('owned');
  assert.equal(await page.locator('#items > li:not([hidden])').count(), 1);
  await page.locator('#filter-own').selectOption('missing');
  assert.equal(await page.locator('#items > li:not([hidden])').count(), 13);
  await page.locator('#filter-clear').click();
  assert.equal(await page.locator('#items > li:not([hidden])').count(), 14);
  assert.equal(await page.locator('#filter-own').inputValue(), '');
  await page.locator('[data-item-id="simple-wall-1"] summary').click();
  assert.match(await page.locator('[data-item-id="simple-wall-1"] dl').textContent(), /65/);
  await page.locator('#refresh').click();
  assert.equal(await page.locator('[data-item-id="simple-wall-1"] details').getAttribute('open'), '');
  await page.locator('[data-item-id="simple-wall-1"] summary').focus();
  assert.equal(await page.evaluate(async () => {
    await poll();
    return document.activeElement === document.querySelector('[data-item-id="simple-wall-1"] summary');
  }), true);
  assert.equal(await page.locator('#source-note a').getAttribute('href'), catalog.meta.sourceUrl);

  for (const width of [320, 375, 414, 768, 1024, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ['dark', 'light']) {
      if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('#app .theme-toggle').click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow: ${width}, ${theme}`);
      const clipped = await page.locator('#filters').evaluate((node) => node.scrollWidth > node.clientWidth);
      assert.equal(clipped, false, `clipped filters: ${width}, ${theme}`);
    }
  }
  assert.deepEqual(errors, []);
  // Optional local review screenshots, with seeded members in this temporary DB only.
  if (process.env.FISHDECO_VISUAL_DIR) {
    const targetDir = path.resolve(process.env.FISHDECO_VISUAL_DIR);
    fs.mkdirSync(targetDir, { recursive: true });
    const context = await browser.newContext();
    try {
      const jana = await context.newPage();
      await discord.install(jana, base, { id: '444444444444444444', username: 'jana', global_name: 'Jana', bot: false });
      await jana.goto(base);
      await discord.login(jana, 'catalog-browser-test-only');
      const simple = catalog.collections.find((c) => c.id === 'simple-set');
      for (const item of simple.items.slice(0, 7)) {
        assert.equal((await context.request.put(`${base}/api/me/collections/simple-set/items/${item.id}`, { data: { owned: true } })).status(), 200);
      }
      assert.equal((await context.request.put(`${base}/api/collections/simple-set/primary`, { data: { primary: true } })).status(), 200);
      await page.evaluate(async (ids) => {
        for (const id of ids) await fetch(`/api/me/collections/simple-set/items/${id}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owned: true }),
        });
        await poll();
      }, simple.items.map((i) => i.id));
      await page.locator('#people .person-link').filter({ hasText: 'Jana' }).click();
      for (const theme of ['dark', 'light']) {
        for (const width of [1280, 375, 320]) {
          await page.setViewportSize({ width, height: 1000 });
          if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('#app .theme-toggle').click();
          await page.evaluate(() => scrollTo(0, 0));
          await page.screenshot({ path: path.join(targetDir, `${theme}-${width}.png`), fullPage: true, animations: 'disabled' });
        }
      }
    } finally { await context.close(); }
  }
  console.log(`Actual catalog verified: ${catalog.collections.length} groups, ${items.length} rows and decoded images, filters, ownership, attribution, both themes at six widths. No production data touched.`);
} finally {
  await browser?.close();
  app.server.closeAllConnections();
  await new Promise((resolve) => app.server.close(resolve));
  app.db.close();
  const resolved = path.resolve(dir);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('fishdeco-catalog-ui-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
