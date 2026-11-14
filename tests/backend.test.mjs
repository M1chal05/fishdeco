import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';

const CLUB = 'tajna-pozvanka';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSIGN_SCRIPT = path.join(ROOT, 'scripts', 'assign-legacy.mjs');

const CATALOG = {
  collections: [
    {
      id: 'dekorace',
      name: 'Dekorace',
      description: 'Akváriové dekorace',
      items: [
        { id: 'item-a', name: 'Amfora' },
        { id: 'item-b', name: 'Dutina', description: 'Úkryt' },
      ],
    },
    {
      id: 'rostliny',
      name: 'Rostliny',
      items: [{ id: 'item-c', name: 'Anubias' }],
    },
  ],
};

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fishdeco-test-'));
}

function rmDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function stopApp(app) {
  app.server.closeAllConnections?.(); // fetch drží keep-alive sockety
  await new Promise((resolve) => app.server.close(resolve));
  app.db.close();
}

async function start(t, { catalog = CATALOG, appOptions = {}, catalogJson, listen = true } = {}) {
  const dir = makeTmpDir();
  fs.writeFileSync(
    path.join(dir, 'catalog.json'),
    catalogJson !== undefined ? catalogJson : JSON.stringify(catalog)
  );
  const app = createApp({ dataDir: dir, password: CLUB, enablePinAuthForTests: true, ...appOptions });
  let base = null;
  if (listen) {
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.server.address().port}`;
  }
  t.after(async () => {
    await stopApp(app);
    rmDir(dir);
  });
  return { base, dir, app };
}

function cookieOf(res) {
  const setCookies = res.headers.getSetCookie();
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}

function jsonPost(base, path, payload, extraHeaders = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(payload),
  });
}

function jsonPut(base, path, payload, extraHeaders = {}) {
  return fetch(`${base}${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(payload),
  });
}

function register(base, name, pin, clubPassword = CLUB, extraHeaders = {}) {
  return jsonPost(base, '/api/register', { name, pin, clubPassword }, extraHeaders);
}

function login(base, name, pin, extraHeaders = {}) {
  return jsonPost(base, '/api/login', { name, pin }, extraHeaders);
}

async function registerUser(base, name, pin = '123456') {
  const res = await register(base, name, pin);
  assert.equal(res.status, 201, `registrace "${name}" má uspět`);
  const body = await res.json();
  return { cookie: cookieOf(res), user: body.user };
}

function scryptHash(secret) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(secret, salt, 32);
  return `s1:${salt.toString('hex')}:${hash.toString('hex')}`;
}

// Vytvoří databázi ve schématu v1 (před osobními účty): společné heslo,
// sběratelé bez user_id, staré relace bez vazby na účet.
function buildLegacyDb(dir, { clubPassword = CLUB } = {}) {
  const db = new DatabaseSync(path.join(dir, 'club.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE sessions (token TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE collectors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_norm TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_collectors_norm ON collectors (name_norm, collection_id);
    CREATE TABLE owned_items (
      collector_id TEXT NOT NULL REFERENCES collectors(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL,
      PRIMARY KEY (collector_id, item_id)
    );
  `);
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
    .run('password_hash', scryptHash(clubPassword));
  const addCollector = db.prepare(
    'INSERT INTO collectors (id, name, name_norm, collection_id, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  const addItem = db.prepare('INSERT INTO owned_items (collector_id, item_id) VALUES (?, ?)');
  addCollector.run('leg-1', 'Pepa', 'pepa', 'dekorace', 1000);
  addCollector.run('leg-2', 'Ema', 'ema', 'dekorace', 2000);
  for (const item of ['item-a', 'item-b']) addItem.run('leg-1', item);
  addItem.run('leg-2', 'item-a');
  db.prepare('INSERT INTO sessions (token, expires_at) VALUES (?, ?)')
    .run('stara-sdilena-relace', Date.now() + 60_000);
  db.close();
}

test('GET /api/session bez přihlášení vrátí authenticated:false a user:null', async (t) => {
  const { base } = await start(t);
  const res = await fetch(`${base}/api/session`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { authenticated: false, user: null });
});

test('registrace: validace jména, PINu a pozvánky', async (t) => {
  const { base } = await start(t);

  const ok = await register(base, '  Pepa   Novák ', '007007');
  assert.equal(ok.status, 201);
  const body = await ok.json();
  assert.equal(body.authenticated, true);
  assert.equal(body.user.name, 'Pepa Novák');
  assert.ok(body.user.id);
  assert.deepEqual(Object.keys(body.user).sort(), ['id', 'name']);
  const setCookie = ok.headers.getSetCookie()[0];
  assert.match(setCookie, /sid=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);

  const session = await fetch(`${base}/api/session`, { headers: { cookie: cookieOf(ok) } });
  assert.deepEqual(await session.json(), { authenticated: true, user: body.user });

  // Jméno je unikátní i bez ohledu na velikost písmen a mezery.
  assert.equal((await register(base, 'pepa  novák', '111111')).status, 409);
  // Špatná pozvánka.
  assert.equal((await register(base, 'Ema', '123456', 'spatna')).status, 403);
  assert.equal((await register(base, 'Ema', '123456', '')).status, 400);
  // PIN: jen řetězec z 6–12 číslic.
  for (const pin of ['12345', '1234567890123', '12a456', 123456, null]) {
    assert.equal((await register(base, 'Ema', pin)).status, 400, `PIN ${pin} má být odmítnut`);
  }
  // Jméno: neprázdné, max 80 znaků po normalizaci.
  assert.equal((await register(base, '   ', '123456')).status, 400);
  assert.equal((await register(base, 'x'.repeat(81), '123456')).status, 400);
  assert.equal((await register(base, null, '123456')).status, 400);

  // PIN s úvodními nulami se zachovává jako řetězec – přihlášení funguje.
  const again = await login(base, 'pepa novák', '007007');
  assert.equal(again.status, 200);
});

test('přihlášení: obecná chyba 401, klubová pozvánka není PIN', async (t) => {
  const { base } = await start(t);
  await registerUser(base, 'Pepa', '654321');

  const badPin = await login(base, 'Pepa', '000000');
  assert.equal(badPin.status, 401);
  const unknown = await login(base, 'Neznamy', '654321');
  assert.equal(unknown.status, 401);
  assert.equal((await badPin.json()).error, (await unknown.json()).error);

  // Klubové heslo se NIKDY nepoužívá jako přihlašovací údaj.
  assert.equal((await login(base, 'Pepa', CLUB)).status, 401);

  const ok = await login(base, 'Pepa', '654321');
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.authenticated, true);
  assert.equal(body.user.name, 'Pepa');
  assert.match(ok.headers.getSetCookie()[0], /sid=/);
});

test('chráněné endpointy bez přihlášení vrací 401', async (t) => {
  const { base } = await start(t);
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  assert.equal((await jsonPut(base, '/api/me/collections/dekorace/items/item-a', { owned: true })).status, 401);
  assert.equal((await jsonPut(base, '/api/collections/dekorace/primary', { primary: true })).status, 401);
});

test('GET /api/state: katalog, uživatelé bez tajemství, currentUser, hlavní sběratelé', async (t) => {
  const { base } = await start(t);
  const { cookie, user } = await registerUser(base, 'Pepa');
  await registerUser(base, 'Ema');

  const res = await fetch(`${base}/api/state`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.deepEqual(body.collections, CATALOG.collections);
  assert.deepEqual(body.collectors, []);
  assert.deepEqual(body.currentUser, user);
  assert.deepEqual(body.primaryAssignments, []);
  assert.equal(body.users.length, 2);
  for (const u of body.users) {
    assert.deepEqual(Object.keys(u).sort(), ['id', 'name']);
  }
});

test('úprava vlastní kolekce přes /api/me: auto-vytvoření sběratele, idempotence, validace', async (t) => {
  const { base } = await start(t);
  const { cookie, user } = await registerUser(base, 'Pepa');
  const put = (cid, iid, payload) =>
    jsonPut(base, `/api/me/collections/${cid}/items/${iid}`, payload, { cookie });

  // První úprava (klidně owned:false) založí sběratele vázaného na účet.
  const off = await put('dekorace', 'item-a', { owned: false });
  assert.equal(off.status, 200);
  const { collector } = await off.json();
  assert.equal(collector.userId, user.id);
  assert.equal(collector.name, 'Pepa');
  assert.equal(collector.collectionId, 'dekorace');
  assert.deepEqual(collector.ownedItemIds, []);

  const on = await put('dekorace', 'item-a', { owned: true });
  assert.deepEqual((await on.json()).collector.ownedItemIds, ['item-a']);
  const onAgain = await put('dekorace', 'item-a', { owned: true });
  assert.deepEqual((await onAgain.json()).collector.ownedItemIds, ['item-a']);
  const second = await put('dekorace', 'item-b', { owned: true });
  assert.deepEqual((await second.json()).collector.ownedItemIds.sort(), ['item-a', 'item-b']);
  const backOff = await put('dekorace', 'item-a', { owned: false });
  assert.deepEqual((await backOff.json()).collector.ownedItemIds, ['item-b']);

  assert.equal((await put('dekorace', 'item-b', { owned: 'ano' })).status, 400);
  assert.equal((await put('dekorace', 'item-c', { owned: true })).status, 400); // jiná kolekce
  assert.equal((await put('dekorace', 'neni', { owned: true })).status, 404);
  assert.equal((await put('neexistuje', 'item-a', { owned: true })).status, 404);
});

test('dva uživatelé: každý upravuje jen sám sebe, tělo požadavku nic nezfalšuje', async (t) => {
  const { base } = await start(t);
  const pepa = await registerUser(base, 'Pepa');
  const ema = await registerUser(base, 'Ema');

  const on = await jsonPut(base, '/api/me/collections/dekorace/items/item-a',
    { owned: true }, { cookie: pepa.cookie });
  const pepaCollector = (await on.json()).collector;

  // Ema nemůže měnit Pepův sběratelský záznam starou cestou.
  const foreign = await jsonPut(base, `/api/collectors/${pepaCollector.id}/items/item-a`,
    { owned: false }, { cookie: ema.cookie });
  assert.equal(foreign.status, 403);

  // Padělané userId v těle se ignoruje – zápis jde vždy pod přihlášeného.
  const forged = await jsonPut(base, '/api/me/collections/dekorace/items/item-b',
    { owned: true, userId: pepa.user.id, collectorId: 'cizi' }, { cookie: ema.cookie });
  assert.equal(forged.status, 200);
  const emaCollector = (await forged.json()).collector;
  assert.equal(emaCollector.userId, ema.user.id);
  assert.notEqual(emaCollector.id, pepaCollector.id);
  assert.deepEqual(emaCollector.ownedItemIds, ['item-b']);

  const state = await (await fetch(`${base}/api/state`, { headers: { cookie: ema.cookie } })).json();
  const mine = state.collectors.find((c) => c.id === emaCollector.id);
  const his = state.collectors.find((c) => c.id === pepaCollector.id);
  assert.equal(mine.userId, ema.user.id);
  assert.equal(his.userId, pepa.user.id);
  assert.deepEqual(his.ownedItemIds, ['item-a']); // Pepův záznam zůstal nedotčený
});

test('vlastní sběratel jde upravit i starou cestou, zděděný a cizí ne', async (t) => {
  const { base, app } = await start(t);
  const pepa = await registerUser(base, 'Pepa');

  // Zděděný sběratel bez vlastníka (jako po migraci).
  app.db.prepare(
    'INSERT INTO collectors (id, name, name_norm, collection_id, created_at, user_id) VALUES (?, ?, ?, ?, ?, NULL)'
  ).run('legacy-1', 'Starej', 'starej', 'dekorace', 1);

  const legacy = await jsonPut(base, '/api/collectors/legacy-1/items/item-a',
    { owned: true }, { cookie: pepa.cookie });
  assert.equal(legacy.status, 403);

  const mine = await jsonPut(base, '/api/me/collections/dekorace/items/item-a',
    { owned: true }, { cookie: pepa.cookie });
  const myId = (await mine.json()).collector.id;
  const ownViaLegacy = await jsonPut(base, `/api/collectors/${myId}/items/item-a`,
    { owned: false }, { cookie: pepa.cookie });
  assert.equal(ownViaLegacy.status, 200);
  assert.deepEqual((await ownViaLegacy.json()).collector.ownedItemIds, []);
});

test('POST /api/collectors je odebráno (410)', async (t) => {
  const { base } = await start(t);
  const { cookie } = await registerUser(base, 'Pepa');
  const res = await jsonPost(base, '/api/collectors',
    { name: 'Pepa', collectionId: 'dekorace' }, { cookie });
  assert.equal(res.status, 410);
});

test('hlavní sběratel: nárok, kolize, zrušení, více kolekcí jednoho člena', async (t) => {
  const { base } = await start(t);
  const pepa = await registerUser(base, 'Pepa');
  const ema = await registerUser(base, 'Ema');
  const putPrimary = (cid, payload, cookie) =>
    jsonPut(base, `/api/collections/${cid}/primary`, payload, { cookie });

  const claim = await putPrimary('dekorace', { primary: true }, pepa.cookie);
  assert.equal(claim.status, 200);
  assert.deepEqual(await claim.json(), {
    primaryAssignments: [{ collectionId: 'dekorace', userId: pepa.user.id }],
  });

  // Idempotentní znovu-nárok vlastního člena.
  assert.equal((await putPrimary('dekorace', { primary: true }, pepa.cookie)).status, 200);
  // Cizí nárok na obsazenou kolekci → 409.
  assert.equal((await putPrimary('dekorace', { primary: true }, ema.cookie)).status, 409);
  // Cizí zrušení → 403.
  assert.equal((await putPrimary('dekorace', { primary: false }, ema.cookie)).status, 403);
  // Zrušení nepřiřazené kolekce je idempotentní.
  assert.equal((await putPrimary('rostliny', { primary: false }, ema.cookie)).status, 200);

  // Tentýž člen může držet hlavní místo ve více kolekcích.
  const multi = await putPrimary('rostliny', { primary: true }, pepa.cookie);
  assert.equal(multi.status, 200);
  assert.deepEqual((await multi.json()).primaryAssignments.sort(
    (a, b) => a.collectionId.localeCompare(b.collectionId)
  ), [
    { collectionId: 'dekorace', userId: pepa.user.id },
    { collectionId: 'rostliny', userId: pepa.user.id },
  ]);

  // Vlastník zruší – kolekce se uvolní, druhá zůstane.
  const released = await putPrimary('dekorace', { primary: false }, pepa.cookie);
  assert.equal(released.status, 200);
  assert.deepEqual(await released.json(), {
    primaryAssignments: [{ collectionId: 'rostliny', userId: pepa.user.id }],
  });
  assert.equal((await putPrimary('dekorace', { primary: true }, ema.cookie)).status, 200);

  assert.equal((await putPrimary('neexistuje', { primary: true }, ema.cookie)).status, 404);
  assert.equal((await putPrimary('rostliny', { primary: 'ano' }, ema.cookie)).status, 400);
});

test('data a přihlášení přetrvají restart serveru', async (t) => {
  const dir = makeTmpDir();
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(CATALOG));

  const app1 = createApp({ dataDir: dir, password: CLUB, enablePinAuthForTests: true });
  await new Promise((resolve) => app1.server.listen(0, '127.0.0.1', resolve));
  const base1 = `http://127.0.0.1:${app1.server.address().port}`;
  const { cookie, user } = await registerUser(base1, 'Pepa', '246810');
  await jsonPut(base1, '/api/me/collections/dekorace/items/item-a', { owned: true }, { cookie });
  await jsonPut(base1, '/api/collections/dekorace/primary', { primary: true }, { cookie });
  await stopApp(app1);

  const app2 = createApp({ dataDir: dir, password: CLUB, enablePinAuthForTests: true });
  await new Promise((resolve) => app2.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await stopApp(app2);
    rmDir(dir);
  });
  const base2 = `http://127.0.0.1:${app2.server.address().port}`;

  // Relace i data přežila restart.
  const session = await fetch(`${base2}/api/session`, { headers: { cookie } });
  assert.deepEqual(await session.json(), { authenticated: true, user });
  const state = await (await fetch(`${base2}/api/state`, { headers: { cookie } })).json();
  const saved = state.collectors.find((c) => c.userId === user.id);
  assert.deepEqual(saved.ownedItemIds, ['item-a']);
  assert.deepEqual(state.primaryAssignments, [{ collectionId: 'dekorace', userId: user.id }]);

  // A funguje i čerstvé přihlášení stejným PINem.
  assert.equal((await login(base2, 'Pepa', '246810')).status, 200);
  assert.equal((await login(base2, 'Pepa', '246811')).status, 401);
});

test('staré sdílené relace bez uživatele se po migraci neuznávají', async (t) => {
  const { base, app } = await start(t);
  app.db.prepare('INSERT INTO sessions (token, expires_at, user_id) VALUES (?, ?, NULL)')
    .run('relace-bez-uctu', Date.now() + 60_000);
  const cookie = 'sid=relace-bez-uctu';
  const session = await fetch(`${base}/api/session`, { headers: { cookie } });
  assert.deepEqual(await session.json(), { authenticated: false, user: null });
  assert.equal((await fetch(`${base}/api/state`, { headers: { cookie } })).status, 401);
});

test('migrace v1→v2: záloha, zachovaná data, žádné auto-přiřazení', async (t) => {
  const dir = makeTmpDir();
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(CATALOG));
  buildLegacyDb(dir);

  const app1 = createApp({ dataDir: dir, password: CLUB, enablePinAuthForTests: true });
  await new Promise((resolve) => app1.server.listen(0, '127.0.0.1', resolve));
  const base1 = `http://127.0.0.1:${app1.server.address().port}`;
  t.after(async () => {
    await stopApp(app1);
    rmDir(dir);
  });

  // Před migrací vznikla konzistentní záloha v data adresáři.
  const backups = fs.readdirSync(dir).filter((f) => /^club-backup-.*\.sqlite$/.test(f));
  assert.equal(backups.length, 1);
  const backup = new DatabaseSync(path.join(dir, backups[0]));
  try {
    assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM collectors').get().n, 2);
  } finally {
    backup.close();
  }

  // Stará sdílená relace se neuznává.
  const oldCookie = 'sid=stara-sdilena-relace';
  const oldSession = await fetch(`${base1}/api/session`, { headers: { cookie: oldCookie } });
  assert.deepEqual(await oldSession.json(), { authenticated: false, user: null });
  assert.equal((await fetch(`${base1}/api/state`, { headers: { cookie: oldCookie } })).status, 401);

  // Registrace klubovou pozvánkou funguje i nad migrovanou databází.
  const pepa = await registerUser(base1, 'Pepa', '112233');
  const state = await (await fetch(`${base1}/api/state`, { headers: { cookie: pepa.cookie } })).json();
  const legacyRows = state.collectors.filter((c) => c.userId === null);
  assert.equal(legacyRows.length, 2);
  const legPepa = legacyRows.find((c) => c.name === 'Pepa');
  assert.equal(legPepa.id, 'leg-1');
  assert.deepEqual(legPepa.ownedItemIds.sort(), ['item-a', 'item-b']);
  // Registrace účtu se stejným jménem zděděný záznam NEPŘEVZALA.
  assert.equal(legPepa.userId, null);
  assert.equal(state.collectors.some((c) => c.userId === pepa.user.id), false);

  // Zděděný sběratel je jen ke čtení.
  const writeLegacy = await jsonPut(base1, '/api/collectors/leg-1/items/item-a',
    { owned: false }, { cookie: pepa.cookie });
  assert.equal(writeLegacy.status, 403);
});

test('migrace se při dalším spuštění neopakuje (schema_version)', async (t) => {
  const dir = makeTmpDir();
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(CATALOG));
  buildLegacyDb(dir);
  let app2 = null;
  t.after(async () => {
    if (app2) await stopApp(app2);
    rmDir(dir);
  });

  const app1 = createApp({ dataDir: dir, password: CLUB, enablePinAuthForTests: true });
  await stopApp(app1);
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('club-backup-')).length, 1);

  app2 = createApp({ dataDir: dir, password: CLUB, enablePinAuthForTests: true });
  await new Promise((resolve) => app2.server.listen(0, '127.0.0.1', resolve));
  // Druhá migrace neproběhla – záloha je pořád jen jedna.
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('club-backup-')).length, 1);
});

test('assign-legacy.mjs: suchý běh, přiřazení i konflikt', async (t) => {
  const dir = makeTmpDir();
  t.after(() => rmDir(dir));
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(CATALOG));
  buildLegacyDb(dir);
  const run = (...args) => execFileSync(
    process.execPath, [ASSIGN_SCRIPT, '--data-dir', dir, ...args], { encoding: 'utf8' }
  );

  // Schéma v2 připraví krátký běh aplikace; účet vložíme přímo (bez tajemství).
  const app = createApp({ dataDir: dir, password: CLUB, enablePinAuthForTests: true });
  app.db.prepare(
    'INSERT INTO users (id, name, name_norm, pin_hash, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run('user-ema', 'Ema', 'ema', scryptHash('999999'), 1);
  await stopApp(app);

  // Cílový účet musí existovat.
  assert.throws(() => run('--from', 'Pepa', '--to', 'Neexistuje'));
  // --dry-run nic nezapíše.
  const dry = run('--from', 'Pepa', '--to', 'Ema', '--dry-run');
  assert.match(dry, /dry-run/);
  const queryGet = (sql, ...params) => {
    const check = new DatabaseSync(path.join(dir, 'club.sqlite'));
    try {
      return check.prepare(sql).get(...params);
    } finally {
      check.close();
    }
  };
  const queryAll = (sql, ...params) => {
    const check = new DatabaseSync(path.join(dir, 'club.sqlite'));
    try {
      return check.prepare(sql).all(...params);
    } finally {
      check.close();
    }
  };
  assert.equal(queryGet('SELECT user_id FROM collectors WHERE id = ?', 'leg-1').user_id, null);

  // Skutečné přiřazení: záznam přejde na účet, předměty zůstanou.
  const done = run('--from', 'Pepa', '--to', 'Ema');
  assert.match(done, /Hotovo: 1 záznamů/);
  assert.equal(queryGet('SELECT user_id FROM collectors WHERE id = ?', 'leg-1').user_id, 'user-ema');
  assert.deepEqual(
    queryAll('SELECT item_id FROM owned_items WHERE collector_id = ? ORDER BY item_id', 'leg-1')
      .map((r) => r.item_id),
    ['item-a', 'item-b']
  );
  // leg-2 zůstal nepřiřazený (jiné jméno).
  assert.equal(queryGet('SELECT user_id FROM collectors WHERE id = ?', 'leg-2').user_id, null);

  // Konflikt: přiřazení leg-2 (kolekce "dekorace") na účet Emy by se srazilo
  // s leg-1, který tam už vlastní → skript selže a nic nezmění.
  assert.throws(() => run('--from', 'Ema', '--to', 'Ema'));
  assert.equal(queryGet('SELECT user_id FROM collectors WHERE id = ?', 'leg-2').user_id, null);
});

test('omezení počtu pokusů o přihlášení (rate limit na IP + jméno)', async (t) => {
  const { base } = await start(t, { appOptions: { loginMaxAttempts: 3, loginWindowMs: 60_000 } });
  await registerUser(base, 'Pepa', '123456');
  await registerUser(base, 'Ema', '123456');

  for (let i = 0; i < 3; i++) {
    assert.equal((await login(base, 'Pepa', '000000')).status, 401);
  }
  // Další pokus o stejné jméno je zablokovaný i se správným PINem.
  assert.equal((await login(base, 'Pepa', '123456')).status, 429);
  // Jiné jméno z téže IP blokované není.
  assert.equal((await login(base, 'Ema', '123456')).status, 200);
});

test('mutace s cizím Origin se odmítnou, stejný projde', async (t) => {
  const { base } = await start(t);
  const foreign = await register(base, 'Pepa', '123456', CLUB, { origin: 'http://evil.example' });
  assert.equal(foreign.status, 403);
  const same = await register(base, 'Pepa', '123456', CLUB, { origin: base });
  assert.equal(same.status, 201);
});

test('odhlášení zneplatní relaci', async (t) => {
  const { base } = await start(t);
  const { cookie } = await registerUser(base, 'Pepa');
  const out = await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie } });
  assert.equal(out.status, 200);
  assert.deepEqual(await out.json(), { authenticated: false, user: null });
  assert.equal((await fetch(`${base}/api/state`, { headers: { cookie } })).status, 401);
});

test('neplatný katalog způsobí jasnou chybu', async (t) => {
  await assert.rejects(
    () => start(t, { catalogJson: '{ "collections": "neni-pole" }' }),
    /polem "collections"/
  );
  await assert.rejects(
    () => start(t, { catalogJson: '{neplatny json' }),
    /platný JSON/
  );
  await assert.rejects(
    () => start(t, {
      catalog: {
        collections: [
          { id: 'a', name: 'A', items: [{ id: 'x', name: 'X' }] },
          { id: 'b', name: 'B', items: [{ id: 'x', name: 'Jiný X' }] },
        ],
      },
    }),
    /Duplicitní id předmětu "x"/
  );
});

const META_ITEM = {
  id: 'simple-wall-1',
  name: 'Simple Wall 1',
  nameCs: 'Jednoduchá stěna 1',
  image: '/assets/decorations/simple-wall-1.webp',
  sourceUrl: 'https://www.fishaofunwiki.com/category/decorations?decoration=simple-wall-1',
  set: 'Simple Set',
  type: 'Wall',
  rarity: 'Very common',
  availability: 'Free in inventory',
  level: null,
  season: 'Always',
  source: 'Furniture Shop',
  price: 65,
  width: 128,
  height: 128,
  acquisitionDetail: 'Carp’s Deco Shop',
};

const META_CATALOG = {
  meta: {
    source: 'FishaoFunWiki',
    sourceUrl: 'https://www.fishaofunwiki.com/category/decorations',
    importedAt: '2026-11-14T00:00:00.000Z',
    generator: 'scripts/import-wiki.mjs',
    sourceHash: 'sha256:abc',
    itemCount: 1,
    neznamyKlic: 'ignorován',
  },
  collections: [
    {
      id: 'simple-set',
      name: 'Simple Set',
      nameCs: 'Jednoduchá sada',
      image: '/assets/decorations/set-simple-set.webp',
      sourceUrl: 'https://www.fishaofunwiki.com/category/decorations',
      items: [META_ITEM],
    },
  ],
};

test('metadata katalogu (položky, kolekce, meta) přežijí GET /api/state', async (t) => {
  const { base } = await start(t, { catalog: META_CATALOG });
  const { cookie } = await registerUser(base, 'Pepa');
  const res = await fetch(`${base}/api/state`, { headers: { cookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  const { neznamyKlic, ...expectedMeta } = META_CATALOG.meta;
  assert.deepEqual(body.meta, expectedMeta);
  assert.equal(body.collections[0].sourceUrl, META_CATALOG.collections[0].sourceUrl);
  assert.equal(body.collections[0].nameCs, 'Jednoduchá sada');
  assert.equal(body.collections[0].image, '/assets/decorations/set-simple-set.webp');
  assert.deepEqual(body.collections[0].items, [META_ITEM]);
});

test('neznámá pole položky se ze servovaného katalogu vyřadí', async (t) => {
  const { base } = await start(t, {
    catalog: {
      collections: [
        {
          id: 'c', name: 'C',
          items: [{ id: 'i', name: 'I', image: '/assets/decorations/i.webp', evil: 'x', onclick: 'y' }],
        },
      ],
    },
  });
  const { cookie } = await registerUser(base, 'Pepa');
  const body = await (await fetch(`${base}/api/state`, { headers: { cookie } })).json();
  const item = body.collections[0].items[0];
  assert.equal(item.image, '/assets/decorations/i.webp');
  assert.ok(!('evil' in item));
  assert.ok(!('onclick' in item));
});

test('neplatná metadata v katalogu jsou odmítnuta', async (t) => {
  const item = (extra) => ({
    collections: [
      { id: 'c', name: 'C', items: [{ id: 'i', name: 'I', ...extra }] },
    ],
  });
  const cases = [
    ['nameCs prázdný', item({ nameCs: '' })],
    ['nameCs není řetězec', item({ nameCs: 42 })],
    ['nameCs příliš dlouhý', item({ nameCs: 'a'.repeat(161) })],
    ['image kolekce traversal', { collections: [{ id: 'c', name: 'C', image: '/assets/decorations/../../x.webp', items: [] }] }],
    ['nameCs kolekce prázdný', { collections: [{ id: 'c', name: 'C', nameCs: '', items: [] }] }],
    ['image traversal', item({ image: '/assets/decorations/../../server.mjs' })],
    ['image vnořená cesta', item({ image: '/assets/decorations/sub/i.webp' })],
    ['image vzdálená URL', item({ image: 'https://www.fishaofunwiki.com/decorations/i.webp' })],
    ['image jiný adresář', item({ image: '/assets/other/i.webp' })],
    ['image bez přípony', item({ image: '/assets/decorations/i' })],
    ['sourceUrl http', item({ sourceUrl: 'http://www.fishaofunwiki.com/x' })],
    ['sourceUrl cizí doména', item({ sourceUrl: 'https://evil.example.com/x' })],
    ['sourceUrl subdoména', item({ sourceUrl: 'https://evil.fishaofunwiki.com/x' })],
    ['sourceUrl ne-URL', item({ sourceUrl: 'fishaofunwiki.com' })],
    ['level záporný', item({ level: -1 })],
    ['level řetězec', item({ level: '12' })],
    ['price záporná', item({ price: -5 })],
    ['price řetězec', item({ price: '65' })],
    ['width null', item({ width: null })],
    ['width řetězec', item({ width: '128' })],
    ['height záporná', item({ height: -1 })],
    ['set číslo', item({ set: 3 })],
    ['rarity null', item({ rarity: null })],
    ['acquisitionDetail číslo', item({ acquisitionDetail: 42 })],
    ['sourceUrl kolekce cizí', {
      collections: [
        { id: 'c', name: 'C', sourceUrl: 'https://example.com', items: [] },
      ],
    }],
    ['sourceUrl kolekce http', {
      collections: [
        { id: 'c', name: 'C', sourceUrl: 'http://fishaofunwiki.com/x', items: [] },
      ],
    }],
    ['meta není objekt', { meta: 'x', collections: [] }],
    ['meta.sourceUrl cizí', {
      meta: { sourceUrl: 'https://example.com' }, collections: [],
    }],
    ['meta.itemCount záporný', { meta: { itemCount: -1 }, collections: [] }],
  ];
  for (const [label, catalog] of cases) {
    await assert.rejects(
      () => start(t, { catalog }),
      (err) => {
        assert.ok(err instanceof Error, label);
        assert.notEqual(err.message, '', label);
        return true;
      },
      `katalog s chybou "${label}" má být odmítnut`
    );
  }
});

test('statické soubory: index, tokens.css a ochrana proti traversal', async (t) => {
  const dir = makeTmpDir();
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(CATALOG));
  const pub = path.join(dir, 'public');
  fs.mkdirSync(pub);
  fs.writeFileSync(path.join(pub, 'index.html'), '<h1>ahoj</h1>');
  fs.writeFileSync(path.join(dir, 'tokens.css'), ':root{}');
  const app = createApp({ dataDir: dir, password: CLUB, publicDir: pub, rootDir: dir, enablePinAuthForTests: true });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await stopApp(app);
    rmDir(dir);
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /ahoj/);

  const tokens = await fetch(`${base}/tokens.css`);
  assert.equal(tokens.status, 200);
  assert.match(tokens.headers.get('content-type'), /text\/css/);

  // catalog.json existuje mimo publicDir – nesmí jít přečíst přes traversal
  const traversal = await fetch(`${base}/%2e%2e%2fcatalog.json`);
  assert.notEqual(traversal.status, 200);
});
