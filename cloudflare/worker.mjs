import defaultCatalog from '../data/catalog.json' with { type: 'json' };

const SESSION_TTL = 90 * 24 * 60 * 60 * 1000;
const OAUTH_TTL = 10 * 60 * 1000;
const AUTH_URL = 'https://discord.com/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/oauth2/token';
const PROFILE_URL = 'https://discord.com/api/v10/users/@me';
const enc = new TextEncoder();

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function b64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function randomToken(size = 32) { const bytes = new Uint8Array(size); crypto.getRandomValues(bytes); return b64url(bytes); }
async function hash(value) { return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value)))); }
async function equalText(a, b) {
  const key = await crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const [left, right] = await Promise.all([crypto.subtle.sign('HMAC', key, enc.encode(a)), crypto.subtle.sign('HMAC', key, enc.encode(b))]);
  const x = new Uint8Array(left), y = new Uint8Array(right);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', ...headers } });
}
function redirect(location, cookies = []) {
  const headers = new Headers({ Location: location, 'Cache-Control': 'private, no-store' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
}
function error(status, message) { throw new HttpError(status, message); }
function cookieValue(request, name) {
  const part = (request.headers.get('Cookie') || '').split(';').map((x) => x.trim()).find((x) => x.startsWith(`${name}=`));
  return part ? part.slice(name.length + 1) : null;
}
function secureCookie(request) { return new URL(request.url).protocol === 'https:' ? '; Secure' : ''; }
function sessionCookie(request, value, age) { return `sid=${value}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${age}${secureCookie(request)}`; }
function oauthCookie(request, value, age) { return `discord_oauth=${value}; HttpOnly; Path=/api/auth/discord; SameSite=Lax; Max-Age=${age}${secureCookie(request)}`; }
function normalizeName(value) { return value.trim().replace(/\s+/g, ' ').normalize('NFC'); }
function validRedirect(value) {
  try {
    const u = new URL(value);
    return (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))
      && !u.username && !u.password && u.pathname === '/api/auth/discord/callback' && !u.search && !u.hash;
  } catch { return false; }
}
function readDiscordConfig(env) {
  const clientId = env.DISCORD_CLIENT_ID;
  const clientSecret = env.DISCORD_CLIENT_SECRET;
  const redirectUri = env.DISCORD_REDIRECT_URI;
  return { clientId, clientSecret, redirectUri, enabled: typeof clientId === 'string' && !!clientId.trim()
    && typeof clientSecret === 'string' && !!clientSecret && typeof env.CLUB_PASSWORD === 'string'
    && !!env.CLUB_PASSWORD && validRedirect(redirectUri) };
}
function makeCatalog(catalog) {
  const collections = catalog.collections || [];
  const itemToCollection = new Map();
  const collectionIds = new Set();
  for (const collection of collections) {
    collectionIds.add(collection.id);
    for (const item of collection.items || []) itemToCollection.set(item.id, collection.id);
  }
  return { collections, itemToCollection, collectionIds, meta: catalog.meta };
}
async function readBody(request) {
  const type = request.headers.get('Content-Type') || '';
  if (!type.toLowerCase().startsWith('application/json')) error(415, 'Požadavek musí mít Content-Type application/json.');
  const reader = request.body?.getReader();
  if (!reader) error(400, 'Neplatná data požadavku.');
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16 * 1024) { await reader.cancel(); error(413, 'Příliš velký požadavek.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { error(400, 'Neplatná data požadavku.'); }
}
function requireOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return;
  try { if (new URL(origin).origin !== new URL(request.url).origin) error(403, 'Neplatný původ požadavku.'); }
  catch (err) { if (err instanceof HttpError) throw err; error(403, 'Neplatný původ požadavku.'); }
}
function decodePath(value) { try { return decodeURIComponent(value); } catch { error(400, 'Neplatná cesta.'); } }

export function createWorker({ catalog = defaultCatalog, fetcher = globalThis.fetch, now = () => Date.now() } = {}) {
  const data = makeCatalog(catalog);
  // Cache lazily: async crypto must run inside a Worker request, not module scope.
  let contentPromise;
  function contentHash() { contentPromise ??= hash(JSON.stringify(catalog)); return contentPromise; }

  async function d1(env, sql, ...values) { return env.DB.prepare(sql).bind(...values); }
  async function sessionUser(request, env) {
    const token = cookieValue(request, 'sid');
    if (!token) return null;
    const tokenHash = await hash(token);
    const stmt = await d1(env, `SELECT u.id, u.name FROM sessions s JOIN users u ON u.id=s.user_id
      JOIN discord_accounts d ON d.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?`, tokenHash, now());
    return stmt.first();
  }
  async function issueSession(request, env, user) {
    const token = randomToken();
    const expires = now() + SESSION_TTL;
    await env.DB.batch([
      await d1(env, 'DELETE FROM sessions WHERE expires_at<=?', now()),
      await d1(env, 'INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', await hash(token), user.id, expires)
    ]);
    return sessionCookie(request, token, Math.floor(SESSION_TTL / 1000));
  }
  async function revision(env) {
    const row = await (await d1(env, "SELECT value FROM app_meta WHERE key='revision'")).first();
    return Number(row?.value || 0);
  }
  async function statePayload(user, env) {
    // Constant query count: users, assignments, collectors, and all owned ids in one join.
    const [users, assignments, rows] = await Promise.all([
      (await d1(env, 'SELECT id,name FROM users ORDER BY created_at,id')).all(),
      (await d1(env, 'SELECT collection_id,user_id FROM primary_assignments ORDER BY collection_id')).all(),
      (await d1(env, `SELECT c.id,c.name,c.collection_id,c.user_id,u.name AS user_name,o.item_id
        FROM collectors c LEFT JOIN users u ON u.id=c.user_id
        LEFT JOIN owned_items o ON o.collector_id=c.id ORDER BY c.created_at,c.id,o.item_id`)).all()
    ]);
    const byId = new Map();
    for (const row of rows.results || []) {
      if (!byId.has(row.id)) byId.set(row.id, { id: row.id, name: row.user_id ? (row.user_name || row.name) : row.name,
        collectionId: row.collection_id, ownedItemIds: [], userId: row.user_id ?? null });
      if (row.item_id && data.itemToCollection.get(row.item_id) === row.collection_id) byId.get(row.id).ownedItemIds.push(row.item_id);
    }
    const result = { collections: data.collections, collectors: [...byId.values()], users: users.results || [],
      currentUser: { id: user.id, name: user.name },
      primaryAssignments: (assignments.results || []).map((r) => ({ collectionId: r.collection_id, userId: r.user_id })) };
    if (data.meta !== undefined) result.meta = data.meta;
    return result;
  }
  async function discordConfig(user, env) {
    const cfg = readDiscordConfig(env);
    if (!user) return { enabled: cfg.enabled, linked: false };
    const row = await (await d1(env, 'SELECT username,display_name FROM discord_accounts WHERE user_id=?', user.id)).first();
    return row ? { enabled: cfg.enabled, linked: true, username: row.username, displayName: row.display_name }
      : { enabled: cfg.enabled, linked: false };
  }
  async function startDiscord(request, env, body) {
    const cfg = readDiscordConfig(env);
    if (!cfg.enabled) error(503, 'Přihlášení přes Discord není nastavené.');
    if (body.mode !== 'login') error(400, 'Neplatný způsob přihlášení přes Discord.');
    const minute = Math.floor(now() / 60000);
    const ip = request.headers.get('CF-Connecting-IP') || 'loopback';
    const limitKey = await hash(`${ip}|${minute}`);
    const rate = await (await d1(env, `INSERT INTO auth_attempts(key,count,expires_at) VALUES(?,1,?)
      ON CONFLICT(key) DO UPDATE SET count=auth_attempts.count+1 RETURNING count`, limitKey, (minute + 2) * 60000)).first();
    if (Number(rate?.count) > 5) error(429, 'Příliš mnoho pokusů. Zkuste to později.');
    const expected = typeof env.CLUB_PASSWORD === 'string' ? env.CLUB_PASSWORD : '';
    const provided = typeof body.clubPassword === 'string' ? body.clubPassword : '';
    if (!expected || !await equalText(expected, provided)) error(403, 'Neplatná klubová pozvánka.');
    const state = randomToken();
    const verifier = randomToken();
    const binding = randomToken();
    const stateHash = await hash(state);
    const bindingHash = await hash(binding);
    await env.DB.batch([
      await d1(env, 'DELETE FROM oauth_states WHERE expires_at<=?', now()),
      await d1(env, 'DELETE FROM auth_attempts WHERE expires_at<=?', now()),
      await d1(env, 'INSERT INTO oauth_states(state_hash,binding_hash,verifier,expires_at) VALUES(?,?,?,?)', stateHash, bindingHash, verifier, now() + OAUTH_TTL),
      await d1(env, 'DELETE FROM auth_attempts WHERE key=?', limitKey)
    ]);
    const challenge = await hash(verifier);
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({ client_id: cfg.clientId, response_type: 'code', redirect_uri: cfg.redirectUri,
      scope: 'identify', state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
    return json({ url: url.toString() }, 200, { 'Set-Cookie': oauthCookie(request, binding, 600) });
  }
  async function callback(request, env, url) {
    const cfg = readDiscordConfig(env);
    const clear = oauthCookie(request, '', 0);
    const fail = (code) => redirect(`/?discord_error=${code}`, [clear]);
    if (!cfg.enabled) return fail('disabled');
    if (new URL(request.url).origin !== new URL(cfg.redirectUri).origin) return fail('failed');
    const state = url.searchParams.get('state');
    if (!state || state.length > 256) return fail('expired');
    const stateHash = await hash(state);
    const binding = cookieValue(request, 'discord_oauth');
    const records = await env.DB.batch([
      await d1(env, 'DELETE FROM oauth_states WHERE state_hash=? AND expires_at>? RETURNING binding_hash,verifier,expires_at', stateHash, now()),
      await d1(env, 'DELETE FROM oauth_states WHERE expires_at<=?', now())
    ]);
    const record = records[0]?.results?.[0];
    if (!record || record.expires_at <= now()) return fail('expired');
    if (!binding || !await equalText(await hash(binding), record.binding_hash)) return fail('failed');
    if (url.searchParams.has('error')) return fail('cancelled');
    if (url.searchParams.has('iss') && url.searchParams.get('iss') !== 'https://discord.com') return fail('failed');
    const code = url.searchParams.get('code');
    if (!code || code.length > 2048) return fail('failed');
    try {
      const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri,
        client_id: cfg.clientId, client_secret: cfg.clientSecret, code_verifier: record.verifier });
      const tokenResponse = await fetcher(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form, redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!tokenResponse.ok) return fail('failed');
      const tokenData = await tokenResponse.json();
      if (typeof tokenData.access_token !== 'string' || !tokenData.access_token || tokenData.access_token.length > 4096) return fail('failed');
      const profileResponse = await fetcher(PROFILE_URL, { headers: { Authorization: `Bearer ${tokenData.access_token}` }, redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!profileResponse.ok) return fail('failed');
      const profile = await profileResponse.json();
      if (typeof profile.id !== 'string' || !/^\d{5,30}$/.test(profile.id) || profile.bot === true
        || typeof profile.username !== 'string' || !profile.username.trim() || profile.username.length > 80
        || (profile.global_name != null && (typeof profile.global_name !== 'string' || profile.global_name.length > 80))) return fail('failed');
      const username = profile.username.trim();
      const displayName = (typeof profile.global_name === 'string' && profile.global_name.trim() ? profile.global_name : username).trim();
      let user = await (await d1(env, `SELECT u.id,u.name FROM discord_accounts d JOIN users u ON u.id=d.user_id WHERE d.discord_id=?`, profile.id)).first();
      const stmts = [];
      if (user) {
        stmts.push(await d1(env, 'UPDATE discord_accounts SET username=?,display_name=? WHERE discord_id=?', username, displayName, profile.id));
      } else {
        let name = normalizeName(displayName);
        let norm = name.toLowerCase();
        let collision = await (await d1(env, 'SELECT id FROM users WHERE name_norm=?', norm)).first();
        if (collision) { name = normalizeName(`${displayName} (@${username})`.slice(0, 80)); norm = name.toLowerCase(); }
        collision = await (await d1(env, 'SELECT id FROM users WHERE name_norm=?', norm)).first();
        if (collision) { name = `${name.slice(0, 66)} ${profile.id.slice(-12)}`; norm = name.toLowerCase(); }
        const id = crypto.randomUUID();
        user = { id, name };
        stmts.push(await d1(env, "INSERT INTO users(id,name,name_norm,pin_hash,created_at) VALUES(?,?,?,'discord-only',?)", id, name, norm, now()));
        stmts.push(await d1(env, 'INSERT INTO discord_accounts(user_id,discord_id,username,display_name) VALUES(?,?,?,?)', id, profile.id, username, displayName));
      }
      const token = randomToken();
      stmts.push(await d1(env, 'DELETE FROM sessions WHERE expires_at<=?', now()));
      stmts.push(await d1(env, 'INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', await hash(token), user.id, now() + SESSION_TTL));
      stmts.push(await d1(env, "UPDATE app_meta SET value=value+1 WHERE key='revision'"));
      await env.DB.batch(stmts);
      return redirect('/?discord=linked', [clear, sessionCookie(request, token, Math.floor(SESSION_TTL / 1000))]);
    } catch { return fail('failed'); }
  }
  async function mutateItem(request, env, user, collectionId, itemId, legacyCollectorId = null) {
    const body = await readBody(request);
    if (typeof body.owned !== 'boolean') error(400, "Hodnota 'owned' musí být true nebo false.");
    const collector = legacyCollectorId
      ? await (await d1(env, 'SELECT * FROM collectors WHERE id=?', legacyCollectorId)).first()
      : null;
    if (legacyCollectorId && !collector) error(404, 'Sběratel nebyl nalezen.');
    if (collector && collector.user_id !== user.id) error(403, 'Tohoto sběratele může upravovat jen jeho vlastník.');
    const targetCollection = legacyCollectorId ? collector.collection_id : collectionId;
    if (!data.collectionIds.has(targetCollection)) error(404, 'Kolekce nebyla nalezena.');
    const itemCollection = data.itemToCollection.get(itemId);
    if (!itemCollection) error(404, 'Předmět nebyl nalezen.');
    if (itemCollection !== targetCollection) error(400, 'Předmět nepatří do této kolekce.');
    let selected = collector;
    if (!selected) {
      const id = crypto.randomUUID();
      await env.DB.batch([
        await d1(env, 'INSERT OR IGNORE INTO collectors(id,name,name_norm,collection_id,created_at,user_id) VALUES(?,?,?,?,?,?)', id, user.name, user.name.toLowerCase(), targetCollection, now(), user.id),
        await d1(env, "UPDATE app_meta SET value=value+1 WHERE key='revision' AND changes()>0")
      ]);
      selected = await (await d1(env, 'SELECT * FROM collectors WHERE user_id=? AND collection_id=?', user.id, targetCollection)).first();
      if (!selected) error(500, 'Sběratele se nepodařilo založit.');
    }
    const statements = [body.owned
      ? await d1(env, 'INSERT OR IGNORE INTO owned_items(collector_id,item_id) VALUES(?,?)', selected.id, itemId)
      : await d1(env, 'DELETE FROM owned_items WHERE collector_id=? AND item_id=?', selected.id, itemId),
    await d1(env, "UPDATE app_meta SET value=value+1 WHERE key='revision'")];
    await env.DB.batch(statements);
    const owned = await (await d1(env, 'SELECT item_id FROM owned_items WHERE collector_id=? ORDER BY item_id', selected.id)).all();
    return { collector: { id: selected.id, name: user.name, collectionId: targetCollection,
      ownedItemIds: (owned.results || []).map((row) => row.item_id).filter((id) => data.itemToCollection.get(id) === targetCollection), userId: user.id } };
  }
  async function primaryMutation(request, env, user, collectionId) {
    const body = await readBody(request);
    if (typeof body.primary !== 'boolean') error(400, "Hodnota 'primary' musí být true nebo false.");
    if (!data.collectionIds.has(collectionId)) error(404, 'Kolekce nebyla nalezena.');
    if (body.primary) {
      const results = await env.DB.batch([
        await d1(env, 'INSERT OR IGNORE INTO primary_assignments(collection_id,user_id) VALUES(?,?)', collectionId, user.id),
        await d1(env, "UPDATE app_meta SET value=value+1 WHERE key='revision' AND changes()>0")
      ]);
      const inserted = Number(results[0]?.meta?.changes || 0) > 0;
      if (!inserted) {
        const current = await (await d1(env, 'SELECT user_id FROM primary_assignments WHERE collection_id=?', collectionId)).first();
        if (current?.user_id !== user.id) error(409, 'Hlavního sběratele této kolekce už drží jiný člen.');
      }
    } else {
      const current = await (await d1(env, 'SELECT user_id FROM primary_assignments WHERE collection_id=?', collectionId)).first();
      if (current && current.user_id !== user.id) error(403, 'Hlavního sběratele může zrušit jen člen, který ho drží.');
      if (current) await env.DB.batch([
        await d1(env, 'DELETE FROM primary_assignments WHERE collection_id=? AND user_id=?', collectionId, user.id),
        await d1(env, "UPDATE app_meta SET value=value+1 WHERE key='revision' AND changes()>0")
      ]);
    }
    const rows = await (await d1(env, 'SELECT collection_id,user_id FROM primary_assignments ORDER BY collection_id')).all();
    return { primaryAssignments: (rows.results || []).map((r) => ({ collectionId: r.collection_id, userId: r.user_id })) };
  }
  async function handle(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    if (pathname === '/api/auth/discord/callback' && request.method === 'GET') return callback(request, env, url);
    if (pathname === '/api/session' && request.method === 'GET') {
      const user = await sessionUser(request, env);
      return json({ authenticated: !!user, user: user ? { id: user.id, name: user.name } : null });
    }
    if (pathname === '/api/auth/discord/config' && request.method === 'GET') return json(await discordConfig(await sessionUser(request, env), env));
    if (pathname === '/api/auth/discord/start' && request.method === 'POST') {
      requireOrigin(request);
      return startDiscord(request, env, await readBody(request));
    }
    if (pathname === '/api/register' && request.method === 'POST') error(410, 'Registrace jménem a PINem byla odebrána.');
    if (pathname === '/api/login' && request.method === 'POST') error(410, 'Přihlášení jménem a PINem bylo odebráno.');
    if (pathname === '/api/logout' && request.method === 'POST') {
      requireOrigin(request);
      const token = cookieValue(request, 'sid');
      if (token) await d1(env, 'DELETE FROM sessions WHERE token_hash=?', await hash(token)).then((q) => q.run());
      return json({ authenticated: false, user: null }, 200, { 'Set-Cookie': sessionCookie(request, '', 0) });
    }
    const user = await sessionUser(request, env);
    if (!user) error(401, 'Nejste přihlášeni.');
    if (pathname === '/api/state' && request.method === 'GET') {
      const rev = await revision(env);
      const tag = `"${await contentHash()}-${rev}-${user.id}"`;
      if (request.headers.get('If-None-Match') === tag) return new Response(null, { status: 304, headers: { ETag: tag, 'Cache-Control': 'private, no-store' } });
      return json(await statePayload(user, env), 200, { ETag: tag });
    }
    if (pathname === '/api/collectors' && request.method === 'POST') error(410, 'Endpoint byl odebrán – sběratel vzniká při úpravě vlastní kolekce.');
    let match = /^\/api\/me\/collections\/([^/]+)\/items\/([^/]+)$/.exec(pathname);
    if (match && request.method === 'PUT') {
      requireOrigin(request);
      return json(await mutateItem(request, env, user, decodePath(match[1]), decodePath(match[2])));
    }
    match = /^\/api\/collections\/([^/]+)\/primary$/.exec(pathname);
    if (match && request.method === 'PUT') {
      requireOrigin(request);
      return json(await primaryMutation(request, env, user, decodePath(match[1])));
    }
    match = /^\/api\/collectors\/([^/]+)\/items\/([^/]+)$/.exec(pathname);
    if (match && request.method === 'PUT') {
      requireOrigin(request);
      return json(await mutateItem(request, env, user, null, decodePath(match[2]), decodePath(match[1])));
    }
    error(404, 'Neznámý požadavek.');
  }

  return {
    async fetch(request, env, ctx) {
      try {
        if (new URL(request.url).pathname.startsWith('/api/')) return await handle(request, env);
        if (env.ASSETS) return await env.ASSETS.fetch(request);
        return new Response('Not found', { status: 404 });
      } catch (err) {
        if (err instanceof HttpError) return json({ error: err.message }, err.status);
        return json({ error: 'Interní chyba serveru.' }, 500);
      }
    }
  };
}

export default createWorker();
