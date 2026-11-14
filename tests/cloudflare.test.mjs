import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createWorker } from '../cloudflare/worker.mjs';

const schema = readFileSync(new URL('../cloudflare/migrations/0001_initial.sql', import.meta.url), 'utf8');
const catalog = { collections: [
  { id: 'a', name: 'A', items: [{ id: 'chair', name: 'Chair' }, { id: 'bed', name: 'Bed' }] },
  { id: 'b', name: 'B', items: [{ id: 'lamp', name: 'Lamp' }] },
] };
const digest = (value) => createHash('sha256').update(value).digest('base64url');

// D1 API adapter with actual SQLite constraints/transactions; never opens user data.
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(schema);
  const log = [];
  const prepare = (sql, values = []) => ({
    bind: (...args) => prepare(sql, args),
    async first(column) {
      log.push(sql);
      const row = sqlite.prepare(sql).get(...values);
      return row ? (column ? row[column] : { ...row }) : null;
    },
    async all() { log.push(sql); return { success: true, results: sqlite.prepare(sql).all(...values).map((r) => ({ ...r })) }; },
    async run() { log.push(sql); const result = sqlite.prepare(sql).run(...values); return { success: true, results: [], meta: { changes: result.changes } }; },
    _execute() {
      log.push(sql);
      const stmt = sqlite.prepare(sql);
      if (stmt.columns().length) return { success: true, results: stmt.all(...values).map((r) => ({ ...r })) };
      const result = stmt.run(...values);
      return { success: true, results: [], meta: { changes: result.changes } };
    },
  });
  return { sqlite, log, prepare, async batch(statements) {
    sqlite.exec('BEGIN');
    try { const result = statements.map((s) => s._execute()); sqlite.exec('COMMIT'); return result; }
    catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  } };
}
function fixture() {
  const DB = database();
  let time = Date.now();
  const env = { DB, CLUB_PASSWORD: 'test-invite', DISCORD_CLIENT_ID: '123456789', DISCORD_CLIENT_SECRET: 'test-only-secret',
    DISCORD_REDIRECT_URI: 'https://club.example/api/auth/discord/callback' };
  const profiles = new Map();
  const challenges = new Map();
  let externalCalls = 0;
  const fetcher = async (url, init) => {
    externalCalls++;
    if (url === 'https://discord.com/api/oauth2/token') {
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('client_secret'), env.DISCORD_CLIENT_SECRET);
      assert.equal(digest(form.get('code_verifier')), challenges.get(form.get('code')));
      return Response.json({ access_token: form.get('code') });
    }
    assert.equal(url, 'https://discord.com/api/v10/users/@me');
    return Response.json(profiles.get(init.headers.Authorization.slice(7)));
  };
  const worker = () => createWorker({ catalog, fetcher, now: () => time });
  const send = (instance, path, { method = 'GET', body, cookie, headers = {} } = {}) => instance.fetch(new Request(`https://club.example${path}`, {
    method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json', Origin: 'https://club.example' } : {}),
      ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  }), env, {});
  const begin = async () => {
    const res = await send(worker(), '/api/auth/discord/start', { method: 'POST', body: { mode: 'login', clubPassword: 'test-invite' } });
    assert.equal(res.status, 200);
    const url = new URL((await res.json()).url);
    assert.equal(url.origin + url.pathname, 'https://discord.com/oauth2/authorize');
    assert.equal(url.searchParams.get('scope'), 'identify');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    return { url, cookie: res.headers.getSetCookie()[0].split(';')[0] };
  };
  const finish = async (flow, code, id, name) => {
    profiles.set(code, { id, username: name.toLowerCase(), global_name: name, bot: false });
    challenges.set(code, flow.url.searchParams.get('code_challenge'));
    // Deliberately use another isolate: OAuth state must live in D1.
    return send(worker(), `/api/auth/discord/callback?code=${code}&state=${flow.url.searchParams.get('state')}&iss=https%3A%2F%2Fdiscord.com`, { cookie: flow.cookie });
  };
  const login = async (id, name, code = id) => {
    const flow = await begin();
    const res = await finish(flow, code, id, name);
    assert.equal(res.headers.get('Location'), '/?discord=linked');
    const sid = res.headers.getSetCookie().find((s) => s.startsWith('sid='));
    assert.match(sid, /HttpOnly; Path=\/; SameSite=Strict; Max-Age=7776000; Secure/);
    return sid.split(';')[0];
  };
  return { DB, env, worker, send, begin, finish, login, advance: (ms) => { time += ms; }, calls: () => externalCalls };
}

test('Cloudflare: Discord survives isolates, stores only hashed session, expiry is 90 days', async () => {
  const f = fixture();
  try {
    const sid = await f.login('111111111111111111', 'Alice');
    assert.equal(f.DB.sqlite.prepare('SELECT token_hash FROM sessions').get().token_hash, digest(sid.slice(4)));
    const state = await f.send(f.worker(), '/api/state', { cookie: sid });
    assert.equal((await state.json()).currentUser.name, 'Alice');
    f.advance(89 * 86400000);
    assert.equal((await (await f.send(f.worker(), '/api/session', { cookie: sid })).json()).authenticated, true);
    f.advance(2 * 86400000);
    assert.equal((await f.send(f.worker(), '/api/state', { cookie: sid })).status, 401);
  } finally { f.DB.sqlite.close(); }
});

test('Cloudflare: unchanged ETag avoids full member scan; item edits invalidate and isolate users', async () => {
  const f = fixture();
  try {
    const alice = await f.login('111111111111111111', 'Alice');
    const bob = await f.login('222222222222222222', 'Bob');
    const first = await f.send(f.worker(), '/api/state', { cookie: alice });
    const tag = first.headers.get('ETag');
    assert.ok(tag);
    f.DB.log.length = 0;
    const unchanged = await f.send(f.worker(), '/api/state', { cookie: alice, headers: { 'If-None-Match': tag } });
    assert.equal(unchanged.status, 304);
    assert.equal(await unchanged.text(), '');
    assert.equal(f.DB.log.length, 2, 'one indexed session lookup and one revision lookup');
    assert.ok(!f.DB.log.some((sql) => /FROM collectors|FROM owned_items/.test(sql)));
    const update = await f.send(f.worker(), '/api/me/collections/a/items/chair', { method: 'PUT', cookie: alice,
      body: { owned: true, userId: 'forged', collectorId: 'forged' } });
    assert.equal(update.status, 200);
    const { collector } = await update.json();
    assert.deepEqual(collector.ownedItemIds, ['chair']);
    assert.equal((await f.send(f.worker(), `/api/collectors/${collector.id}/items/chair`, { method: 'PUT', cookie: bob, body: { owned: false } })).status, 403);
    assert.equal((await f.send(f.worker(), '/api/me/collections/b/items/chair', { method: 'PUT', cookie: bob, body: { owned: true } })).status, 400);
    const changed = await f.send(f.worker(), '/api/state', { cookie: alice, headers: { 'If-None-Match': tag } });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get('ETag'), tag);
    const logout = await f.send(f.worker(), '/api/logout', { method: 'POST', cookie: alice });
    assert.equal(logout.status, 200);
    assert.equal((await f.send(f.worker(), '/api/state', { cookie: alice, headers: { 'If-None-Match': changed.headers.get('ETag') } })).status, 401);
  } finally { f.DB.sqlite.close(); }
});

test('Cloudflare: primary claims, release, multiple sets, and collisions', async () => {
  const f = fixture();
  try {
    const alice = await f.login('111111111111111111', 'Alice');
    const bob = await f.login('222222222222222222', 'Bob');
    const primary = (sid, set, value) => f.send(f.worker(), `/api/collections/${set}/primary`, { method: 'PUT', cookie: sid, body: { primary: value } });
    assert.equal((await primary(alice, 'a', true)).status, 200);
    assert.equal((await primary(alice, 'b', true)).status, 200);
    assert.equal((await primary(bob, 'a', true)).status, 409);
    assert.equal((await primary(bob, 'a', false)).status, 403);
    assert.equal((await primary(alice, 'a', false)).status, 200);
    assert.equal((await primary(bob, 'a', true)).status, 200);
    const state = await (await f.send(f.worker(), '/api/state', { cookie: alice })).json();
    assert.equal(state.primaryAssignments.length, 2);
    assert.notEqual(state.primaryAssignments[0].userId, state.primaryAssignments[1].userId);
  } finally { f.DB.sqlite.close(); }
});

test('Cloudflare: browser-bound single-use OAuth, expiry, CSRF, size and rate limits', async () => {
  const f = fixture();
  try {
    const flow = await f.begin();
    const path = `/api/auth/discord/callback?code=stolen&state=${flow.url.searchParams.get('state')}`;
    assert.match((await f.send(f.worker(), path)).headers.get('Location'), /discord_error=/);
    assert.equal(f.calls(), 0);
    assert.match((await f.send(f.worker(), path, { cookie: flow.cookie })).headers.get('Location'), /discord_error=/);
    const expired = await f.begin();
    f.advance(11 * 60000);
    assert.match((await f.finish(expired, 'expired', '111111111111111111', 'Alice')).headers.get('Location'), /discord_error=/);
    assert.equal(f.calls(), 0);
    assert.equal((await f.send(f.worker(), '/api/auth/discord/start', { method: 'POST', body: { mode: 'login', clubPassword: 'test-invite' }, headers: { Origin: 'https://attacker.example' } })).status, 403);
    assert.equal((await f.send(f.worker(), '/api/auth/discord/start', { method: 'POST', body: { clubPassword: 'a'.repeat(17000) } })).status, 413);
    for (let i = 0; i < 5; i++) {
      assert.equal((await f.send(f.worker(), '/api/auth/discord/start', { method: 'POST', body: { mode: 'login', clubPassword: 'wrong' } })).status, 403);
    }
    assert.equal((await f.send(f.worker(), '/api/auth/discord/start', { method: 'POST', body: { mode: 'login', clubPassword: 'test-invite' } })).status, 429);
    assert.equal((await f.send(f.worker(), '/api/login', { method: 'POST', body: { name: 'Alice', pin: '123456' } })).status, 410);
  } finally { f.DB.sqlite.close(); }
});
