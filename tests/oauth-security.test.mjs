import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';

async function fixture(t, behavior = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fishdeco-oauth-security-'));
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ collections: [] }));
  let calls = 0;
  const app = createApp({ dataDir: dir, password: 'security-test-invite', discord: {
    clientId: '123456789012345678', clientSecret: 'security-test-client-secret',
    redirectUri: 'http://127.0.0.1:3000/api/auth/discord/callback',
    fetch: async (url) => {
      calls++;
      if (behavior.fail) return Response.json({ error: 'secret-provider-error' }, { status: 400 });
      return String(url).includes('/token')
        ? Response.json({ access_token: 'private-access-token' })
        : Response.json(behavior.profile || { id: '555555555555555555', username: 'tester', global_name: 'Tester' });
    },
  } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    app.db.close();
    const target = path.resolve(dir);
    assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(target).startsWith('fishdeco-oauth-security-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  const start = async (password = 'security-test-invite', headers = {}) => {
    const res = await fetch(`${base}/api/auth/discord/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ mode: 'login', clubPassword: password }),
    });
    if (res.status !== 200) return { res };
    const data = await res.json();
    const state = new URL(data.url).searchParams.get('state');
    return { res, state, nonce: res.headers.getSetCookie()[0].split(';')[0] };
  };
  const callback = (state, cookie = '', extra = '') => fetch(`${base}/api/auth/discord/callback?code=fixture-code&state=${state}${extra}`, {
    redirect: 'manual', headers: { cookie },
  });
  return { app, base, start, callback, calls: () => calls };
}

test('OAuth state is browser-bound, single-use, and issuer is checked before any upstream request', async (t) => {
  const f = await fixture(t);
  const a = await f.start();
  const noCookie = await f.callback(a.state);
  assert.equal(noCookie.headers.get('location'), '/?discord_error=failed');
  assert.equal((await f.callback(a.state, a.nonce)).headers.get('location'), '/?discord_error=expired');
  const b = await f.start();
  assert.equal((await f.callback(b.state, 'discord_oauth=wrong')).headers.get('location'), '/?discord_error=failed');
  const c = await f.start();
  assert.equal((await f.callback('made-up-state', c.nonce)).headers.get('location'), '/?discord_error=expired');
  assert.equal((await f.callback(c.state, c.nonce, '&iss=https%3A%2F%2Fattacker.invalid')).headers.get('location'), '/?discord_error=failed');
  assert.equal(f.calls(), 0);
  assert.equal(f.app.db.prepare('SELECT count(*) n FROM users').get().n, 0);
});

test('OAuth state expires and cancelled authorization never creates a session', async (t) => {
  const f = await fixture(t);
  const a = await f.start();
  const originalNow = Date.now;
  try {
    const now = originalNow();
    Date.now = () => now + 11 * 60_000;
    assert.equal((await f.callback(a.state, a.nonce)).headers.get('location'), '/?discord_error=expired');
  } finally { Date.now = originalNow; }
  const b = await f.start();
  const cancelled = await f.callback(b.state, b.nonce, '&error=access_denied&error_description=private-description');
  assert.equal(cancelled.headers.get('location'), '/?discord_error=cancelled');
  assert.equal(f.calls(), 0);
  assert.equal(f.app.db.prepare('SELECT count(*) n FROM sessions').get().n, 0);
});

test('OAuth start rejects cross-origin requests and rate-limits incorrect club passwords', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.start('security-test-invite', { Origin: 'https://attacker.invalid' })).res.status, 403);
  for (let i = 0; i < 5; i++) assert.equal((await f.start('wrong-password')).res.status, 403);
  assert.equal((await f.start()).res.status, 429);
  assert.equal(f.calls(), 0);
});

test('Provider failure and malformed profiles fail closed without revealing tokens or provider errors', async (t) => {
  for (const behavior of [{ fail: true }, { profile: { id: '555555555555555555', username: 42 } }, { profile: { id: '555555555555555555', username: 'bot', bot: true } }]) {
    await t.test(JSON.stringify(behavior), async (t) => {
      const f = await fixture(t, behavior);
      const a = await f.start();
      const res = await f.callback(a.state, a.nonce);
      assert.equal(res.headers.get('location'), '/?discord_error=failed');
      assert.equal(f.app.db.prepare('SELECT count(*) n FROM users').get().n, 0);
      assert.equal(f.app.db.prepare('SELECT count(*) n FROM sessions').get().n, 0);
      assert.ok(!JSON.stringify([...res.headers]).includes('private-access-token'));
      assert.ok(!JSON.stringify([...res.headers]).includes('secret-provider-error'));
    });
  }
});

test('Production rejects pre-Discord PIN sessions even if the user has a Discord account', async (t) => {
  const f = await fixture(t);
  f.app.db.prepare('INSERT INTO users(id,name,name_norm,pin_hash,created_at) VALUES(?,?,?,?,?)').run('legacy-user', 'Member', 'member', 'not-a-pin', Date.now());
  f.app.db.prepare('INSERT INTO discord_accounts(user_id,discord_id,username,display_name) VALUES(?,?,?,?)').run('legacy-user', '777777777777777777', 'member', 'Member');
  f.app.db.prepare('INSERT INTO sessions(token,expires_at,user_id,auth_method) VALUES(?,?,?,?)').run('legacy-session', Date.now() + 60_000, 'legacy-user', 'pin');
  const res = await fetch(`${f.base}/api/session`, { headers: { cookie: 'sid=legacy-session' } });
  assert.deepEqual(await res.json(), { authenticated: false, user: null });
});
