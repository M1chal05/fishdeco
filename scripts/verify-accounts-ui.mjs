// End-to-end checks with two isolated member sessions and a temporary SQLite DB.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../server.mjs';
import { createDiscordFixture } from './discord-fixture.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fishdeco-accounts-ui-'));
const catalogPath = path.join(dir, 'catalog.json');
const catalog = { collections: [
  { id: 'set-a', name: 'Testovací sada', items: [{ id: 'a', name: 'První dekorace' }, { id: 'b', name: 'Druhá dekorace' }] },
  { id: 'set-b', name: 'Druhá sada', items: [{ id: 'c', name: 'Další dekorace' }] },
  { id: 'set-empty', name: 'Prázdná sada', items: [] },
] };
fs.writeFileSync(catalogPath, JSON.stringify(catalog));
const discord = createDiscordFixture();
const app = createApp({ dataDir: dir, password: 'browser-test-invite-only', discord: discord.config });
// This is the disposable database, never the actual data directory.
app.db.prepare('INSERT INTO collectors (id,name,name_norm,collection_id,created_at) VALUES (?,?,?,?,?)')
  .run('legacy', 'Starší člen', 'starší člen', 'set-a', Date.now());
app.db.prepare('INSERT INTO owned_items (collector_id,item_id) VALUES (?,?)').run('legacy', 'a');
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
const refresh = (p) => p.evaluate(async () => { await poll(); });
const check = (p, item) => p.locator(`[data-item-id="${item}"] .item__check`);
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const alice = await browser.newPage();
  const bob = await browser.newPage();
  const errors = [];
  for (const [p, name, id] of [[alice, 'Anežka', '111111111111111111'], [bob, 'Borek', '222222222222222222']]) {
    p.setDefaultTimeout(10_000);
    p.on('pageerror', (e) => errors.push(e.message));
    await discord.install(p, base, { id, username: id === '111111111111111111' ? 'anezka' : 'borek', global_name: name, bot: false });
    await p.goto(base);
    await p.locator('#login-view').waitFor({ state: 'visible' });
    assert.equal(await p.locator('#clubpass-field > span').first().textContent(), 'Heslo');
    assert.equal(await p.locator('#auth-back').count(), 0);
    assert.equal(await p.locator('html').getAttribute('data-theme'), 'dark');
    await p.locator('#login-view .theme-toggle').click();
    await p.reload();
    await p.locator('#login-view').waitFor({ state: 'visible' });
    assert.equal(await p.locator('html').getAttribute('data-theme'), 'light');
    if (name === 'Anežka') {
      await p.locator('#login-clubpass').fill('incorrect-club-password');
      await p.locator('#club-verify').click();
      await p.locator('#login-error').waitFor({ state: 'visible' });
      assert.equal(await p.locator('#discord-login').isVisible(), false);
    }
    await discord.login(p, 'browser-test-invite-only');
    await p.locator('#col-title').filter({ hasText: 'Testovací sada' }).waitFor();
    assert.match(await p.locator('#rail-user').textContent(), new RegExp(name));
    assert.equal(await p.locator('#me-select, #add-form').count(), 0);
    const sid = (await p.context().cookies()).find((c) => c.name === 'sid');
    const daysRemaining = (sid.expires - Date.now() / 1000) / 86400;
    assert.ok(daysRemaining > 89.9 && daysRemaining <= 90.01);
    let oauthNavigations = 0;
    const countOAuth = (request) => { if (request.url().startsWith('https://discord.com/oauth2/authorize')) oauthNavigations++; };
    p.on('request', countOAuth);
    await p.reload();
    await p.locator('#app').waitFor({ state: 'visible' });
    await p.locator('#col-title').filter({ hasText: 'Testovací sada' }).waitFor();
    assert.equal(await p.locator('#login-view').isVisible(), false);
    assert.equal(oauthNavigations, 0);
    p.off('request', countOAuth);
    if (name === 'Anežka') {
      const restored = await browser.newContext({ storageState: await p.context().storageState() });
      try {
        const reopened = await restored.newPage();
        await reopened.goto(base);
        await reopened.locator('#app').waitFor({ state: 'visible' });
        assert.equal(await reopened.locator('#login-view').isVisible(), false);
      } finally { await restored.close(); }
    }
    await p.locator('#app .theme-toggle').click();
  }
  await refresh(alice);
  assert.equal(await alice.locator('#people .person-link').count(), 3);
  // A delayed first save must never appear in another member's inventory.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await alice.route('**/api/me/collections/set-a/items/a', async (route) => { await held; await route.continue(); });
  await check(alice, 'a').check();
  await alice.locator('#people .person-link').filter({ hasText: 'Borek' }).click();
  assert.equal(await check(alice, 'a').isChecked(), false);
  assert.equal(await check(alice, 'a').isDisabled(), true);
  const response = alice.waitForResponse((r) => r.url().endsWith('/items/a') && r.request().method() === 'PUT');
  release();
  await response;
  await alice.unroute('**/api/me/collections/set-a/items/a');
  await alice.locator('#view-self').click();
  await alice.waitForFunction(() => document.querySelector('[data-item-id="a"] input').checked);
  await check(alice, 'b').check();
  await alice.waitForFunction(() => !document.querySelector('[data-item-id="b"] input').disabled);
  await check(bob, 'b').check();
  await bob.waitForFunction(() => !document.querySelector('[data-item-id="b"] input').disabled);
  await refresh(bob);
  assert.match(await bob.locator('#done-list').textContent(), /Anežka/);
  assert.match(await bob.locator('#leaders-list').textContent(), /2\/2/);
  await bob.locator('#done-list .person-link').filter({ hasText: 'Anežka' }).click();
  assert.equal(await check(bob, 'a').isDisabled(), true);
  assert.equal(await check(bob, 'a').isChecked(), true);
  assert.equal(await bob.locator('[data-item-id="a"]').evaluate((n) => n.classList.contains('item--owned') && n.classList.contains('item--readonly')), true);
  assert.equal(await bob.locator('[data-item-id="a"] .item__state').textContent(), 'Získáno');
  await bob.locator('#filter-own').selectOption('owned');
  assert.equal(await bob.locator('#items > li:not([hidden])').count(), 2);
  await bob.locator('#filter-clear').click();
  await bob.locator('#view-self').click();
  assert.equal(await check(bob, 'a').isChecked(), false);
  assert.equal(await check(bob, 'a').isDisabled(), false);
  assert.equal(await bob.locator('[data-item-id="a"]').evaluate((n) => n.classList.contains('item--missing')), true);
  // Clicking an owner inside a row opens a read-only view and performs no PUT.
  let writes = 0;
  const countWrite = (r) => { if (r.method() === 'PUT') writes++; };
  bob.on('request', countWrite);
  await bob.locator('[data-item-id="a"] .item__owners .person-link').filter({ hasText: 'Anežka' }).click();
  assert.equal(writes, 0);
  await bob.locator('#view-self').click();
  bob.off('request', countWrite);
  // Server rejects a forged request using someone else's collector ID.
  const forbidden = await bob.evaluate(async () => {
    const state = await (await fetch('/api/state')).json();
    const foreign = state.collectors.find((c) => c.userId && c.userId !== state.currentUser.id);
    return (await fetch(`/api/collectors/${foreign.id}/items/a`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owned: false }),
    })).status;
  });
  assert.equal(forbidden, 403);
  // Legacy data stays visible but cannot be edited.
  await alice.locator('#people .person-link').filter({ hasText: 'Starší člen' }).click();
  assert.equal(await check(alice, 'a').isChecked(), true);
  assert.equal(await check(alice, 'a').isDisabled(), true);
  await alice.locator('#view-self').click();

  // Same member can be primary for multiple sets; another cannot take over.
  await alice.locator('#primary-btn').click();
  await alice.waitForFunction(() => document.querySelector('#primary-btn').dataset.mode === 'release');
  await alice.locator('[data-collection-id="set-b"]').click();
  await alice.locator('#primary-btn').click();
  await alice.waitForFunction(() => document.querySelector('#primary-btn').dataset.mode === 'release');
  await refresh(bob);
  assert.equal(await bob.locator('#primary-btn').isVisible(), false);
  assert.match(await bob.locator('#primary-name').textContent(), /Anežka/);
  const collisions = await bob.evaluate(async () => {
    const put = (primary) => fetch('/api/collections/set-a/primary', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ primary }),
    }).then((r) => r.status);
    return [await put(true), await put(false)];
  });
  assert.deepEqual(collisions, [409, 403]);
  await alice.locator('[data-collection-id="set-a"]').click();
  await alice.locator('#primary-btn').click();
  await alice.waitForFunction(() => document.querySelector('#primary-btn').dataset.mode === 'claim');
  await refresh(bob);
  await bob.locator('#primary-btn').click();
  await bob.waitForFunction(() => document.querySelector('#primary-btn').dataset.mode === 'release');

  // Empty collections never make everybody appear complete.
  await alice.locator('[data-collection-id="set-empty"]').click();
  assert.equal(await alice.locator('#done-list .person-link').count(), 0);
  await alice.locator('[data-collection-id="set-a"]').click();
  for (const width of [320, 375, 414, 768, 1024, 1280]) {
    await alice.setViewportSize({ width, height: 900 });
    for (const theme of ['dark', 'light']) {
      if (await alice.locator('html').getAttribute('data-theme') !== theme) await alice.locator('#app .theme-toggle').click();
      assert.equal(await alice.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${width}/${theme}`);
    }
  }
  await alice.locator('#logout').click();
  await alice.locator('#login-view').waitFor({ state: 'visible' });
  assert.equal(await alice.locator('#items').textContent(), '');
  await discord.login(alice, 'browser-test-invite-only');
  await alice.waitForFunction(() => document.querySelector('[data-item-id="a"] input')?.checked);
  fs.writeFileSync(catalogPath, JSON.stringify({ collections: [] }));
  await refresh(alice);
  await alice.locator('#app-empty').waitFor({ state: 'visible' });
  assert.equal(await alice.locator('#summary-sec').isVisible(), false);
  assert.deepEqual(errors, []);
  console.log('Two-account browser checks passed: mocked Discord OAuth and club password, read-only member views, summaries, legacy records, own-only writes, primary exclusivity/multiple sets, responsive themes and empty catalog.');
} finally {
  await browser?.close();
  app.server.closeAllConnections();
  await new Promise((resolve) => app.server.close(resolve));
  app.db.close();
  const resolved = path.resolve(dir);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('fishdeco-accounts-ui-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
