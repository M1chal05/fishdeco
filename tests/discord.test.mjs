import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server.mjs';

const catalog = path.resolve('data/catalog.json');

async function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fishdeco-discord-'));
  fs.copyFileSync(catalog, path.join(dir, 'catalog.json'));
  const app = createApp({ dataDir: dir, password: 'club-invite-test', discord: options.discord });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { ...app, dir, base, async close() { await new Promise((resolve) => app.server.close(resolve)); app.db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('Discord OAuth disabled by default and old PIN endpoints are disabled in production mode', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await (await fetch(`${f.base}/api/auth/discord/config`)).json(), { enabled: false, linked: false });
    assert.equal((await fetch(`${f.base}/api/login`, json({ name: 'x', pin: '123456' }))).status, 410);
    assert.equal((await fetch(`${f.base}/api/register`, json({ name: 'x', pin: '123456', clubPassword: 'club-invite-test' }))).status, 410);
  } finally { await f.close(); }
});

test('Discord sign-in validates invitation, uses PKCE, creates an account, and consumes state once', async () => {
  let tokenBody;
  const discord = {
    clientId: 'test-client', clientSecret: 'never-return-this', redirectUri: 'http://127.0.0.1:3000/api/auth/discord/callback',
    authorizeUrl: 'https://discord.test/oauth2/authorize', tokenUrl: 'https://discord.test/api/oauth2/token', userUrl: 'https://discord.test/api/v10/users/@me',
    fetch: async (url, init) => {
      if (String(url).includes('/token')) { tokenBody = String(init.body); return Response.json({ access_token: 'access-secret' }); }
      assert.equal(init.headers.Authorization, 'Bearer access-secret');
      return Response.json({ id: '123456789012345678', username: 'luna', global_name: 'Luna' });
    },
  };
  const f = await fixture({ discord });
  try {
    const noInvite = await fetch(`${f.base}/api/auth/discord/start`, json({ mode: 'login', clubPassword: 'wrong' }));
    assert.equal(noInvite.status, 403);
    const started = await fetch(`${f.base}/api/auth/discord/start`, json({ mode: 'login', clubPassword: 'club-invite-test' }));
    assert.equal(started.status, 200);
    const { url } = await started.json();
    const auth = new URL(url);
    assert.equal(auth.searchParams.get('scope'), 'identify');
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(auth.searchParams.get('code_challenge'));
    assert.equal(auth.searchParams.has('client_secret'), false);
    const nonce = started.headers.get('set-cookie').split(';')[0];
    const callback = await fetch(`${f.base}/api/auth/discord/callback?code=auth-code&state=${auth.searchParams.get('state')}`, { headers: { cookie: nonce }, redirect: 'manual' });
    assert.equal(callback.status, 303);
    assert.match(tokenBody, /client_secret=never-return-this/);
    assert.match(tokenBody, /code_verifier=/);
    assert.equal(tokenBody.includes('access-secret'), false);
    assert.equal(callback.headers.get('location'), '/?discord=linked');
    const cookieHeader = callback.headers.get('set-cookie');
    assert.match(cookieHeader, /sid=/);
    assert.match(cookieHeader, /discord_oauth=/);
    const sessionCookie = cookieHeader.match(/sid=[^;,]+/)[0];
    const session = await fetch(`${f.base}/api/session`, { headers: { cookie: sessionCookie } });
    const payload = await session.json();
    assert.equal(payload.authenticated, true);
    assert.equal(payload.user.name, 'Luna');
    const config = await fetch(`${f.base}/api/auth/discord/config`, { headers: { cookie: sessionCookie } });
    assert.deepEqual(await config.json(), { enabled: true, linked: true, username: 'luna', displayName: 'Luna' });
    assert.equal((await fetch(`${f.base}/api/auth/discord/callback?code=again&state=${auth.searchParams.get('state')}`, { headers: { cookie: nonce }, redirect: 'manual' })).headers.get('location'), '/?discord_error=expired');
  } finally { await f.close(); }
});

test('different Discord IDs with the same display name get separate accounts', async () => {
  let profile = { id: '987654321012345678', username: 'other', global_name: 'Member' };
  const discord = {
    clientId: 'id', clientSecret: 'secret', redirectUri: 'http://127.0.0.1:3000/api/auth/discord/callback',
    fetch: async (url) => String(url).includes('/token') ? Response.json({ access_token: 'token' }) : Response.json(profile),
  };
  const f = await fixture({ discord });
  try {
    async function signIn() {
      const started = await fetch(`${f.base}/api/auth/discord/start`, json({ mode: 'login', clubPassword: 'club-invite-test' }));
      const auth = new URL((await started.json()).url);
      const nonce = started.headers.get('set-cookie').split(';')[0];
      const result = await fetch(`${f.base}/api/auth/discord/callback?code=code&state=${auth.searchParams.get('state')}`, { headers: { cookie: nonce }, redirect: 'manual' });
      return { result, cookie: result.headers.get('set-cookie').match(/sid=[^;,]+/)[0] };
    }
    const first = await signIn();
    profile = { id: '987654321012345679', username: 'other2', global_name: 'Member' };
    const second = await signIn();
    assert.equal(first.result.status, 303);
    assert.equal(second.result.status, 303);
    const firstSession = await (await fetch(`${f.base}/api/session`, { headers: { cookie: first.cookie } })).json();
    const secondSession = await (await fetch(`${f.base}/api/session`, { headers: { cookie: second.cookie } })).json();
    assert.notEqual(firstSession.user.id, secondSession.user.id);
    assert.notEqual(firstSession.user.name, secondSession.user.name);
  } finally { await f.close(); }
});

test('OAuth state is bound to the initiating browser cookie and consumed on callback', async () => {
  const f = await fixture({ discord: {
    clientId: 'id', clientSecret: 'secret', redirectUri: 'http://127.0.0.1:3000/api/auth/discord/callback',
    fetch: async () => { throw new Error('Provider must not be called for an invalid callback.'); },
  } });
  try {
    const started = await fetch(`${f.base}/api/auth/discord/start`, json({ mode: 'login', clubPassword: 'club-invite-test' }));
    const auth = new URL((await started.json()).url);
    const nonce = started.headers.get('set-cookie').split(';')[0];
    const wrongState = await fetch(`${f.base}/api/auth/discord/callback?code=code&state=wrong`, { headers: { cookie: nonce }, redirect: 'manual' });
    assert.equal(wrongState.headers.get('location'), '/?discord_error=expired');
    const missingCookie = await fetch(`${f.base}/api/auth/discord/callback?code=code&state=${auth.searchParams.get('state')}`, { redirect: 'manual' });
    assert.equal(missingCookie.headers.get('location'), '/?discord_error=failed');
    const replay = await fetch(`${f.base}/api/auth/discord/callback?code=code&state=${auth.searchParams.get('state')}`, { headers: { cookie: nonce }, redirect: 'manual' });
    assert.equal(replay.headers.get('location'), '/?discord_error=expired');
  } finally { await f.close(); }
});
