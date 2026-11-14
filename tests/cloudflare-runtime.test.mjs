import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('Cloudflare workerd + real D1: catalogue, persistent auth, atomic revision and primary release', { timeout: 60000 }, async () => {
  const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('../cloudflare/worker.mjs', import.meta.url))], bundle: true, format: 'esm', platform: 'browser', write: false });
  const upstreamCalls = [];
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: outputFiles[0].text, compatibilityDate: '2026-11-01',
    outboundService: async (request) => {
      upstreamCalls.push(request.url);
      if (request.url === 'https://discord.com/api/oauth2/token') {
        const form = new URLSearchParams(await request.text());
        assert.equal(form.get('client_secret'), 'test-secret');
        assert.equal(form.get('code'), 'runtime-test-code');
        assert.ok(form.get('code_verifier'));
        return Response.json({ access_token: 'runtime-test-token' });
      }
      assert.equal(request.url, 'https://discord.com/api/v10/users/@me');
      assert.equal(request.headers.get('Authorization'), 'Bearer runtime-test-token');
      return Response.json({ id: '222222222222222222', username: 'bob', global_name: 'Bob' });
    },
    assets: { directory: fileURLToPath(new URL('../public/', import.meta.url)), binding: 'ASSETS', run_worker_first: ['/api/*'], routerConfig: { has_user_worker: true } },
    d1Databases: { DB: 'test-only-db' }, bindings: { CLUB_PASSWORD: 'test-invite', DISCORD_CLIENT_ID: '123456789',
      DISCORD_CLIENT_SECRET: 'test-secret', DISCORD_REDIRECT_URI: 'https://club.example/api/auth/discord/callback' } }));
  try {
    const db = await mf.getD1Database('DB');
    const schema = readFileSync(new URL('../cloudflare/migrations/0001_initial.sql', import.meta.url), 'utf8');
    // D1 exec expects one SQL statement per line; migrations remain readable multiline SQL.
    for (const sql of schema.split(';').map((s) => s.trim()).filter(Boolean)) await db.prepare(sql).run();
    const request = (path, init) => mf.dispatchFetch(`https://club.example${path}`, init);
    const home = await request('/');
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Fishdeco/);
    assert.match(home.headers.get('Content-Security-Policy') || '', /frame-ancestors 'none'/);
    const script = await request('/app.js');
    assert.equal(script.status, 200);
    assert.match(script.headers.get('Content-Type'), /javascript/);
    const image = await request('/assets/decorations/simple-bed.webp');
    assert.equal(image.status, 200);
    assert.match(image.headers.get('Content-Type'), /image\/webp/);
    const unauthenticated = await request('/api/state');
    assert.equal(unauthenticated.status, 401, await unauthenticated.text());
    const sid = 'runtime-fixture-token';
    await db.batch([
      db.prepare('INSERT INTO users(id,name,name_norm,created_at) VALUES(?,?,?,?)').bind('alice', 'Alice', 'alice', Date.now()),
      db.prepare('INSERT INTO discord_accounts(user_id,discord_id,username,display_name) VALUES(?,?,?,?)').bind('alice', '111111111111111111', 'alice', 'Alice'),
      db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(createHash('sha256').update(sid).digest('base64url'), 'alice', Date.now() + 86400000),
    ]);
    const headers = { Cookie: `sid=${sid}`, 'Content-Type': 'application/json', Origin: 'https://club.example' };
    const first = await request('/api/state', { headers });
    assert.equal(first.status, 200);
    const tag = first.headers.get('ETag');
    const state = await first.json();
    assert.equal(state.collections.length, 17);
    assert.equal(state.collections.reduce((n, c) => n + c.items.length, 0), 234);
    const collection = state.collections[0];
    const put = (path, body) => request(path, { method: 'PUT', headers, body: JSON.stringify(body) });
    const owned = await put(`/api/me/collections/${collection.id}/items/${collection.items[0].id}`, { owned: true });
    assert.equal(owned.status, 200);
    assert.deepEqual((await owned.json()).collector.ownedItemIds, [collection.items[0].id]);
    const changed = await request('/api/state', { headers: { ...headers, 'If-None-Match': tag } });
    assert.equal(changed.status, 200);
    const changedTag = changed.headers.get('ETag');
    assert.notEqual(changedTag, tag);
    assert.equal((await request('/api/state', { headers: { ...headers, 'If-None-Match': changedTag } })).status, 304);
    const primaryPath = `/api/collections/${collection.id}/primary`;
    assert.equal((await put(primaryPath, { primary: true })).status, 200);
    const assigned = await request('/api/state', { headers: { ...headers, 'If-None-Match': changedTag } });
    assert.equal(assigned.status, 200, 'D1 changes() advances revision in atomic batch');
    assert.deepEqual((await assigned.json()).primaryAssignments, [{ collectionId: collection.id, userId: 'alice' }]);
    const released = await put(primaryPath, { primary: false });
    assert.equal(released.status, 200);
    assert.deepEqual((await released.json()).primaryAssignments, []);
    const start = await request('/api/auth/discord/start', { method: 'POST', headers, body: JSON.stringify({ mode: 'login', clubPassword: 'test-invite' }) });
    assert.equal(start.status, 200, 'Web Crypto PKCE and D1 state work in workerd');
    const authUrl = new URL((await start.json()).url);
    assert.equal(authUrl.origin + authUrl.pathname, 'https://discord.com/oauth2/authorize');
    const binding = start.headers.getSetCookie().find((cookie) => cookie.startsWith('discord_oauth=')).split(';')[0];
    const callback = await request(`/api/auth/discord/callback?code=runtime-test-code&state=${authUrl.searchParams.get('state')}`, { headers: { Cookie: binding }, redirect: 'manual' });
    assert.equal(callback.headers.get('Location'), '/?discord=linked');
    assert.deepEqual(upstreamCalls, ['https://discord.com/api/oauth2/token', 'https://discord.com/api/v10/users/@me']);
    assert.ok((await db.prepare('SELECT id FROM users WHERE name=?').bind('Bob').first()).id);
  } finally { await mf.dispose(); }
});
