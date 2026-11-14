import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDiscordAuth } from './discord-auth.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 dní
const MAX_BODY_BYTES = 16 * 1024;
const MAX_NAME_LEN = 80;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 60 * 1000;
const SCHEMA_VERSION = 4;
// Osobní PIN je vždy řetězec z 6–12 číslic; úvodní nuly se zachovávají.
const PIN_RE = /^\d{6,12}$/;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class CatalogError extends Error {}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// Povolené domény pro odkazy na zdroj dat (import z veřejné wiki).
const SOURCE_URL_HOSTS = new Set(['fishaofunwiki.com', 'www.fishaofunwiki.com']);
// Obrázky dekorací se servují jen lokálně z public/assets/decorations/.
const ITEM_IMAGE_RE = /^\/assets\/decorations\/[A-Za-z0-9][A-Za-z0-9._-]*\.(webp|png|jpe?g|gif|avif|svg)$/;

function validSourceUrl(v) {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && SOURCE_URL_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

function isNonNegNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

// Načte a plně zvaliduje katalog. Vyhazuje CatalogError při jakémkoli problému.
// Z každého záznamu se přebírají jen známá pole (whitelist) – libovolná jiná
// pole ze souboru se do servovaného katalogu nikdy nedostanou.
export function loadCatalog(catalogPath) {
  let raw;
  try {
    raw = fs.readFileSync(catalogPath, 'utf8');
  } catch {
    throw new CatalogError(`Soubor katalogu nebyl nalezen: ${catalogPath}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new CatalogError('Katalog není platný JSON.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.collections)) {
    throw new CatalogError('Katalog musí být JSON objekt s polem "collections".');
  }
  // Volitelná metadata importu v kořeni – přebírají se jen známé skalární klíče.
  let meta;
  if (data.meta !== undefined) {
    if (!data.meta || typeof data.meta !== 'object' || Array.isArray(data.meta)) {
      throw new CatalogError('meta musí být objekt.');
    }
    meta = {};
    for (const k of ['source', 'importedAt', 'generator', 'sourceHash']) {
      if (data.meta[k] !== undefined) {
        if (typeof data.meta[k] !== 'string') {
          throw new CatalogError(`meta.${k} musí být řetězec.`);
        }
        meta[k] = data.meta[k];
      }
    }
    if (data.meta.sourceUrl !== undefined) {
      if (!validSourceUrl(data.meta.sourceUrl)) {
        throw new CatalogError('meta.sourceUrl musí být https URL na fishaofunwiki.com.');
      }
      meta.sourceUrl = data.meta.sourceUrl;
    }
    if (data.meta.itemCount !== undefined) {
      if (!isNonNegNumber(data.meta.itemCount)) {
        throw new CatalogError('meta.itemCount musí být konečné číslo >= 0.');
      }
      meta.itemCount = data.meta.itemCount;
    }
  }

  const collectionIds = new Set();
  // Id položky smí být v katalogu opakované – ale jen tehdy, když opakovaný
  // výskyt je v badge kolekci ("badge": true) a položka je naprosto shodná.
  // Vlastnictví je pak sdílené napříč všemi kolekcemi, kde se položka vyskytuje.
  const itemToCollections = new Map();
  const itemCanonical = new Map();
  const collections = data.collections.map((c, i) => {
    const where = `collections[${i}]`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      throw new CatalogError(`${where} musí být objekt.`);
    }
    if (!isNonEmptyString(c.id) || !isNonEmptyString(c.name)) {
      throw new CatalogError(`${where} musí mít neprázdné řetězce "id" a "name".`);
    }
    if (c.nameCs !== undefined && (!isNonEmptyString(c.nameCs) || c.nameCs.length > 160)) {
      throw new CatalogError(`${where}.nameCs musí být neprázdný řetězec do 160 znaků.`);
    }
    if (c.badge !== undefined && typeof c.badge !== 'boolean') {
      throw new CatalogError(`${where}.badge musí být true nebo false.`);
    }
    if (c.image !== undefined && (typeof c.image !== 'string' || !ITEM_IMAGE_RE.test(c.image))) {
      throw new CatalogError(`${where}.image musí být lokální cesta /assets/decorations/<soubor>.`);
    }
    if (c.description !== undefined && typeof c.description !== 'string') {
      throw new CatalogError(`${where}.description musí být řetězec.`);
    }
    if (c.sourceUrl !== undefined && !validSourceUrl(c.sourceUrl)) {
      throw new CatalogError(`${where}.sourceUrl musí být https URL na fishaofunwiki.com.`);
    }
    if (!Array.isArray(c.items)) {
      throw new CatalogError(`${where}.items musí být pole.`);
    }
    if (collectionIds.has(c.id)) {
      throw new CatalogError(`Duplicitní id kolekce "${c.id}".`);
    }
    collectionIds.add(c.id);
    const items = c.items.map((it, j) => {
      const iwhere = `${where}.items[${j}]`;
      if (!it || typeof it !== 'object' || Array.isArray(it)) {
        throw new CatalogError(`${iwhere} musí být objekt.`);
      }
      if (!isNonEmptyString(it.id) || !isNonEmptyString(it.name)) {
        throw new CatalogError(`${iwhere} musí mít neprázdné řetězce "id" a "name".`);
      }
      if (it.nameCs !== undefined && (!isNonEmptyString(it.nameCs) || it.nameCs.length > 160)) {
        throw new CatalogError(`${iwhere}.nameCs musí být neprázdný řetězec do 160 znaků.`);
      }
      if (it.description !== undefined && typeof it.description !== 'string') {
        throw new CatalogError(`${iwhere}.description musí být řetězec.`);
      }
      if (it.image !== undefined && (typeof it.image !== 'string' || !ITEM_IMAGE_RE.test(it.image))) {
        throw new CatalogError(`${iwhere}.image musí být lokální cesta /assets/decorations/<soubor>.`);
      }
      if (it.sourceUrl !== undefined && !validSourceUrl(it.sourceUrl)) {
        throw new CatalogError(`${iwhere}.sourceUrl musí být https URL na fishaofunwiki.com.`);
      }
      for (const f of ['set', 'type', 'rarity', 'availability', 'season', 'source', 'acquisitionDetail']) {
        if (it[f] !== undefined && typeof it[f] !== 'string') {
          throw new CatalogError(`${iwhere}.${f} musí být řetězec.`);
        }
      }
      for (const f of ['level', 'price']) {
        if (it[f] !== undefined && it[f] !== null && !isNonNegNumber(it[f])) {
          throw new CatalogError(`${iwhere}.${f} musí být konečné číslo >= 0 nebo null.`);
        }
      }
      for (const f of ['width', 'height']) {
        if (it[f] !== undefined && !isNonNegNumber(it[f])) {
          throw new CatalogError(`${iwhere}.${f} musí být konečné číslo >= 0.`);
        }
      }
      const item = { id: it.id, name: it.name };
      for (const f of [
        'description', 'nameCs', 'image', 'sourceUrl', 'set', 'type', 'rarity', 'availability',
        'season', 'source', 'level', 'price', 'width', 'height', 'acquisitionDetail',
      ]) {
        if (it[f] !== undefined) item[f] = it[f];
      }
      const memberships = itemToCollections.get(it.id);
      if (memberships) {
        if (c.badge !== true || itemCanonical.get(it.id) !== JSON.stringify(item)) {
          throw new CatalogError(
            `Duplicitní id předmětu "${it.id}". Id předmětů musí být jedinečná v celém katalogu `
            + '– výjimka jen pro naprosto shodné položky v badge kolekcích.'
          );
        }
        memberships.add(c.id);
      } else {
        itemToCollections.set(it.id, new Set([c.id]));
        itemCanonical.set(it.id, JSON.stringify(item));
      }
      return item;
    });
    const collection = { id: c.id, name: c.name };
    if (c.nameCs !== undefined) collection.nameCs = c.nameCs;
    if (c.image !== undefined) collection.image = c.image;
    if (c.description !== undefined) collection.description = c.description;
    if (c.sourceUrl !== undefined) collection.sourceUrl = c.sourceUrl;
    if (c.badge !== undefined) collection.badge = c.badge;
    collection.items = items;
    return collection;
  });
  return { collections, itemToCollections, meta };
}

// Formát uloženého tajemství: "s1:<sůl hex>:<scrypt hash hex>" – sůl je vždy
// unikátní na záznam, porovnání probíhá v konstantním čase.
function hashSecretSync(secret) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(secret, salt, 32);
  return `s1:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function scryptAsync(secret, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(secret, salt, 32, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(secret, salt);
  return `s1:${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function verifySecret(secret, stored) {
  try {
    const [tag, saltHex, hashHex] = String(stored).split(':');
    if (tag !== 's1' || !saltHex || !hashHex) return false;
    const hash = await scryptAsync(secret, Buffer.from(saltHex, 'hex'));
    const expected = Buffer.from(hashHex, 'hex');
    return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
  } catch {
    return false;
  }
}

function initDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collectors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_norm TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_collectors_norm
      ON collectors (name_norm, collection_id);
    CREATE TABLE IF NOT EXISTS owned_items (
      collector_id TEXT NOT NULL REFERENCES collectors(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL,
      PRIMARY KEY (collector_id, item_id)
    );
  `);
  return db;
}

function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

// Konzistentní záloha živé databáze – VACUUM INTO vytvoří samostatný soubor
// (surový WAL se nikdy nekopíruje). Vrací jen jméno souboru pro zalogování,
// obsah (zahashovaná tajemství) se nikam nevypisuje.
function backupDb(db, dataDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `club-backup-${stamp}-${crypto.randomBytes(4).toString('hex')}.sqlite`;
  const dest = path.join(dataDir, name).replace(/'/g, "''");
  db.exec(`VACUUM INTO '${dest}'`);
  return name;
}

// Aditivní, idempotentní migrace schématu (v1 → v2: uživatelé, vazba sessions a
// collectors na účet, hlavní sběratelé). Existující databázi před změnou
// zálohujeme; čerstvě vytvořenou ne – není co ztratit. Celá změna běží v jedné
// transakci a verzi schématu zapisujeme do meta, takže opakovaný běh je no-op.
function migrateDb(db, dataDir, { hadExistingFile }) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  const version = row ? Number(row.value) : 1;
  if (version >= SCHEMA_VERSION) return;

  if (hadExistingFile) {
    const name = backupDb(db, dataDir);
    console.log(`Databáze byla před migrací schématu zálohována: ${name}`);
  }

  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_norm TEXT NOT NULL UNIQUE,
        pin_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS primary_assignments (
        collection_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id)
      );
    `);
    if (!columnExists(db, 'sessions', 'user_id')) {
      db.exec('ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users(id)');
    }
    if (!columnExists(db, 'collectors', 'user_id')) {
      db.exec('ALTER TABLE collectors ADD COLUMN user_id TEXT REFERENCES users(id)');
    }
    if (!columnExists(db, 'sessions', 'auth_method')) {
      db.exec('ALTER TABLE sessions ADD COLUMN auth_method TEXT');
    }
    // Sběratel je dvojice (uživatel, kolekce) – staré záznamy bez vlastníka
    // (user_id IS NULL, jen ke čtení) unique index neomezí.
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_collectors_user_collection
        ON collectors (user_id, collection_id) WHERE user_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS discord_accounts (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        discord_id TEXT NOT NULL UNIQUE,
        username TEXT NOT NULL,
        display_name TEXT NOT NULL
      );
    `);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)")
      .run(String(SCHEMA_VERSION));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function normalizeName(name) {
  return name.trim().replace(/\s+/g, ' ').normalize('NFC');
}

export function createApp(options = {}) {
  const dataDir = options.dataDir ?? process.env.DATA_DIR ?? path.join(ROOT, 'data');
  const catalogPath = options.catalogPath ?? path.join(dataDir, 'catalog.json');
  const publicDir = options.publicDir ?? path.join(ROOT, 'public');
  const rootDir = options.rootDir ?? ROOT;
  const cookieSecure = options.cookieSecure
    || process.env.COOKIE_SECURE === 'true' || process.env.COOKIE_SECURE === '1'
    || String(options.discord?.redirectUri ?? process.env.DISCORD_REDIRECT_URI ?? '').startsWith('https:');
  const sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
  const loginMaxAttempts = options.loginMaxAttempts ?? LOGIN_MAX_ATTEMPTS;
  const loginWindowMs = options.loginWindowMs ?? LOGIN_WINDOW_MS;
  const configuredPassword = options.password ?? process.env.CLUB_PASSWORD;
  const discordConfig = options.discord ?? {
    clientId: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    redirectUri: process.env.DISCORD_REDIRECT_URI,
  };

  fs.mkdirSync(dataDir, { recursive: true });
  loadCatalog(catalogPath); // rychlé selhání při neplatném katalogu
  const dbPath = path.join(dataDir, 'club.sqlite');
  const hadExistingDb = fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0;
  const db = initDb(dbPath);
  migrateDb(db, dataDir, { hadExistingFile: hadExistingDb });

  // Klubové heslo slouží už jen jako pozvánka při registraci: buď z prostředí
  // (CLUB_PASSWORD), nebo náhodně vygenerované při prvním spuštění – nikdy není
  // napevno v kódu a v DB leží jen scrypt hash. Jeho změna nezneplatňuje
  // existující uživatelské relace.
  let generatedPassword = null;
  const storedHash = db.prepare("SELECT value FROM meta WHERE key = 'password_hash'").get();
  if (typeof configuredPassword === 'string' && configuredPassword.length > 0) {
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('password_hash', ?)")
      .run(hashSecretSync(configuredPassword));
  } else if (!storedHash) {
    generatedPassword = crypto.randomBytes(9).toString('base64url');
    db.prepare("INSERT INTO meta (key, value) VALUES ('password_hash', ?)")
      .run(hashSecretSync(generatedPassword));
  }

  // Dummy hash pro vyrovnání doby odpovědi při přihlášení neexistujícího účtu.
  const dummyPinHash = hashSecretSync(crypto.randomBytes(12).toString('hex'));

  const q = {
    passwordHash: db.prepare("SELECT value FROM meta WHERE key = 'password_hash'"),
    getSession: db.prepare('SELECT token, expires_at, user_id, auth_method FROM sessions WHERE token = ?'),
    insertSession: db.prepare('INSERT INTO sessions (token, expires_at, user_id, auth_method) VALUES (?, ?, ?, ?)'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
    pruneSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    getUser: db.prepare('SELECT id, name FROM users WHERE id = ?'),
    hasDiscordLink: db.prepare('SELECT 1 FROM discord_accounts WHERE user_id = ?'),
    getUserByNorm: db.prepare('SELECT * FROM users WHERE name_norm = ?'),
    insertUser: db.prepare(
      'INSERT INTO users (id, name, name_norm, pin_hash, created_at) VALUES (?, ?, ?, ?, ?)'
    ),
    allUsers: db.prepare('SELECT id, name FROM users ORDER BY created_at, rowid'),
    getCollector: db.prepare('SELECT * FROM collectors WHERE id = ?'),
    findUserCollector: db.prepare('SELECT * FROM collectors WHERE user_id = ? AND collection_id = ?'),
    insertCollector: db.prepare(
      'INSERT INTO collectors (id, name, name_norm, collection_id, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?)'
    ),
    allCollectors: db.prepare(
      `SELECT c.*, u.name AS user_name FROM collectors c
       LEFT JOIN users u ON u.id = c.user_id
       ORDER BY c.created_at, c.rowid`
    ),
    // Sdílené vlastnictví: položka patřící do více kolekcí (např. rostlina
    // v sadě i v odznaku) se počítá jako vlastněná všude, kde ji uživatel má
    // zaškrtnutou u kteréhokoli svých sběratelů.
    ownedIds: db.prepare(
      `SELECT oi.item_id FROM owned_items oi
       JOIN collectors oc ON oc.id = oi.collector_id
       WHERE oc.user_id = ? OR oc.id = ?
       GROUP BY oi.item_id ORDER BY MIN(oi.rowid)`
    ),
    addOwned: db.prepare('INSERT OR IGNORE INTO owned_items (collector_id, item_id) VALUES (?, ?)'),
    removeOwnedForUser: db.prepare(
      `DELETE FROM owned_items WHERE item_id = ?
       AND collector_id IN (SELECT id FROM collectors WHERE user_id = ?)`
    ),
    getPrimary: db.prepare('SELECT collection_id, user_id FROM primary_assignments WHERE collection_id = ?'),
    insertPrimary: db.prepare('INSERT INTO primary_assignments (collection_id, user_id) VALUES (?, ?)'),
    deletePrimary: db.prepare('DELETE FROM primary_assignments WHERE collection_id = ?'),
    allPrimary: db.prepare('SELECT collection_id, user_id FROM primary_assignments ORDER BY rowid'),
  };

  // Jednoduché omezení počtu pokusů u přihlášení a registrace (v paměti),
  // klíčované na endpoint + IP + jméno účtu.
  const authAttempts = new Map();
  function authAttemptAllowed(key) {
    const now = Date.now();
    const rec = authAttempts.get(key);
    if (!rec || now - rec.start > loginWindowMs) {
      authAttempts.set(key, { start: now, count: 1 });
      return true;
    }
    rec.count += 1;
    return rec.count <= loginMaxAttempts;
  }

  function sessionCookie(token, maxAgeSec) {
    return `sid=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAgeSec}`
      + (cookieSecure ? '; Secure' : '');
  }

  function sessionToken(req) {
    const header = req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() === 'sid') return part.slice(eq + 1).trim();
    }
    return null;
  }

  // Vrátí přihlášeného uživatele {id, name} nebo null. Relace bez vazby na
  // účet (user_id IS NULL – např. staré relace před migrací) se neuznává.
  const enablePinAuthForTests = options.enablePinAuthForTests === true;
  function sessionUser(req) {
    const token = sessionToken(req);
    if (!token) return null;
    const row = q.getSession.get(token);
    if (!row) return null;
    if (row.expires_at <= Date.now()) {
      q.deleteSession.run(token);
      return null;
    }
    if (row.user_id == null) return null;
    if (!enablePinAuthForTests && (row.auth_method !== 'discord' || !q.hasDiscordLink.get(row.user_id))) return null;
    const user = q.getUser.get(row.user_id);
    return user ? { id: user.id, name: user.name } : null;
  }

  function currentSessionToken(req) { return sessionToken(req); }

  function issueSession(res, user, authMethod = 'pin') {
    const token = crypto.randomBytes(32).toString('base64url');
    q.pruneSessions.run(Date.now());
    q.insertSession.run(token, Date.now() + sessionTtlMs, user.id, authMethod);
    res.setHeader('Set-Cookie', sessionCookie(token, Math.floor(sessionTtlMs / 1000)));
    return token;
  }

  const discordAuth = createDiscordAuth({
    db, discord: discordConfig, cookieSecure,
    issueSession: (res, user) => issueSession(res, user, 'discord'),
    authAttemptAllowed,
    resetAuthAttempt: (key) => authAttempts.delete(key),
    passwordHash: () => q.passwordHash.get()?.value,
    verifySecret,
  });

  // Mutace přijímáme jen ze stejného původu (proti CSRF; SameSite=Strict je druhá vrstva).
  function originOk(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  function requireJson(req) {
    const type = String(req.headers['content-type'] || '');
    if (!type.toLowerCase().startsWith('application/json')) {
      throw new HttpError(415, 'Požadavek musí mít Content-Type application/json.');
    }
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Příliš velký požadavek.'));
        req.resume();
        return;
      }
      const chunks = [];
      let size = 0;
      let tooBig = false;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          tooBig = true;
        } else if (!tooBig) {
          chunks.push(chunk);
        }
      });
      req.on('end', () => {
        if (tooBig) {
          reject(new HttpError(413, 'Příliš velký požadavek.'));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new HttpError(400, 'Neplatná data požadavku.'));
        }
      });
      req.on('error', reject);
    });
  }

  function collectorJson(row, catalog) {
    const ownedItemIds = q.ownedIds.all(row.user_id ?? null, row.id)
      .map((r) => r.item_id)
      // Položky smazané z katalogu ve stavu neukazujeme, ale v DB zůstávají.
      .filter((id) => catalog.itemToCollections.get(id)?.has(row.collection_id));
    // Jméno vlastněného sběratele se odvozuje od účtu; u zděděných záznamů
    // (user_id IS NULL) zůstává původně uložené jméno.
    const name = row.user_id
      ? (row.user_name ?? q.getUser.get(row.user_id)?.name ?? row.name)
      : row.name;
    return { id: row.id, name, collectionId: row.collection_id, ownedItemIds, userId: row.user_id ?? null };
  }

  function primaryAssignmentsJson() {
    return q.allPrimary.all()
      .map((r) => ({ collectionId: r.collection_id, userId: r.user_id }));
  }

  function statePayload(me) {
    const catalog = loadCatalog(catalogPath);
    const collectors = q.allCollectors.all().map((row) => collectorJson(row, catalog));
    const data = {
      collections: catalog.collections,
      collectors,
      // Veřejný seznam identit – nikdy tu nejsou PINy, hashe ani jiná tajemství.
      users: q.allUsers.all(),
      currentUser: { id: me.id, name: me.name },
      primaryAssignments: primaryAssignmentsJson(),
    };
    if (catalog.meta !== undefined) data.meta = catalog.meta;
    return { status: 200, data };
  }

  async function handleApi(req, res, pathname) {
    if (req.method !== 'GET' && !originOk(req)) {
      throw new HttpError(403, 'Neplatný původ požadavku.');
    }

    if (pathname === '/api/session' && req.method === 'GET') {
      const user = sessionUser(req);
      return { status: 200, data: { authenticated: user !== null, user } };
    }

    if (pathname === '/api/auth/discord/config' && req.method === 'GET') {
      return { status: 200, data: discordAuth.config(sessionUser(req)) };
    }
    if (pathname === '/api/auth/discord/start' && req.method === 'POST') {
      requireJson(req);
      try { return { status: 200, data: await discordAuth.start(req, res, await readJsonBody(req)) }; }
      catch (err) { if (Number.isInteger(err?.status)) throw new HttpError(err.status, err.message); throw err; }
    }

    // Registrace nového člena: vlastní jméno + osobní PIN + klubová pozvánka
    // (CLUB_PASSWORD). Pozvánka slouží jen zde, nikdy se jí nepřihlašuje.
    if (pathname === '/api/register' && req.method === 'POST') {
      if (!enablePinAuthForTests) throw new HttpError(410, 'Použijte přihlášení přes Discord.');
      requireJson(req);
      const body = await readJsonBody(req);
      const name = typeof body?.name === 'string' ? normalizeName(body.name) : '';
      const norm = name.toLowerCase();
      const ip = req.socket.remoteAddress || '';
      if (!name || name.length > MAX_NAME_LEN) {
        throw new HttpError(400, `Jméno musí mít 1 až ${MAX_NAME_LEN} znaků.`);
      }
      if (typeof body?.pin !== 'string' || !PIN_RE.test(body.pin)) {
        throw new HttpError(400, 'PIN musí být řetězec ze 6 až 12 číslic.');
      }
      if (typeof body?.clubPassword !== 'string' || body.clubPassword.length === 0) {
        throw new HttpError(400, 'Chybí klubová pozvánka (clubPassword).');
      }
      if (!authAttemptAllowed(`register|${ip}|${norm}`)) {
        throw new HttpError(429, 'Příliš mnoho pokusů. Zkuste to prosím později.');
      }
      const hashRow = q.passwordHash.get();
      if (!(await verifySecret(body.clubPassword, hashRow?.value))) {
        throw new HttpError(403, 'Neplatná klubová pozvánka.');
      }
      if (q.getUserByNorm.get(norm)) {
        throw new HttpError(409, 'Toto jméno už používá jiný člen.');
      }
      const pinHash = await hashSecret(body.pin);
      const id = crypto.randomUUID();
      try {
        q.insertUser.run(id, name, norm, pinHash, Date.now());
      } catch (err) {
        if (err instanceof Error && /UNIQUE/i.test(err.message)) {
          throw new HttpError(409, 'Toto jméno už používá jiný člen.');
        }
        throw err;
      }
      authAttempts.delete(`register|${ip}|${norm}`);
      // Registrace záměrně NEPŘIŘAZUJE zděděné sběratele podle jména – k tomu
      // slouží offline skript scripts/assign-legacy.mjs.
      issueSession(res, { id, name });
      return { status: 201, data: { authenticated: true, user: { id, name } } };
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      if (!enablePinAuthForTests) throw new HttpError(410, 'Použijte přihlášení přes Discord.');
      requireJson(req);
      const body = await readJsonBody(req);
      const name = typeof body?.name === 'string' ? normalizeName(body.name) : '';
      const norm = name.toLowerCase();
      const ip = req.socket.remoteAddress || '';
      const genericError = new HttpError(401, 'Neplatné jméno nebo PIN.');
      if (!name || typeof body?.pin !== 'string') throw genericError;
      if (!authAttemptAllowed(`login|${ip}|${norm}`)) {
        throw new HttpError(429, 'Příliš mnoho pokusů o přihlášení. Zkuste to prosím později.');
      }
      const user = q.getUserByNorm.get(norm);
      // PIN ověříme vždy – i u neexistujícího účtu – aby odpověď netrápila
      // rozdílným načasováním; chyba je vždy stejná obecná hláška.
      const ok = await verifySecret(body.pin, user?.pin_hash ?? dummyPinHash);
      if (!user || !ok) throw genericError;
      authAttempts.delete(`login|${ip}|${norm}`);
      const publicUser = { id: user.id, name: user.name };
      issueSession(res, publicUser);
      return { status: 200, data: { authenticated: true, user: publicUser } };
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      const token = sessionToken(req);
      if (token) q.deleteSession.run(token);
      res.setHeader('Set-Cookie', sessionCookie('', 0));
      return { status: 200, data: { authenticated: false, user: null } };
    }

    const me = sessionUser(req);
    if (!me) {
      throw new HttpError(401, 'Nejste přihlášeni.');
    }

    if (pathname === '/api/state' && req.method === 'GET') {
      return statePayload(me);
    }

    // Vytváření sběratelů libovolného jména bylo odebráno – sběratel vzniká
    // automaticky při první úpravě vlastní kolekce přes /api/me/collections/…
    if (pathname === '/api/collectors' && req.method === 'POST') {
      throw new HttpError(410, 'Endpoint byl odebrán – sběratel vzniká automaticky při úpravě vlastní kolekce.');
    }

    // Úprava položek vlastní kolekce. Uživatel se určuje jen z relace – tělo
    // požadavku nemůže úpravu podsunout cizímu účtu.
    const meItemMatch = /^\/api\/me\/collections\/([^/]+)\/items\/([^/]+)$/.exec(pathname);
    if (meItemMatch && req.method === 'PUT') {
      const collectionId = decodeURIComponent(meItemMatch[1]);
      const itemId = decodeURIComponent(meItemMatch[2]);
      requireJson(req);
      const body = await readJsonBody(req);
      if (typeof body?.owned !== 'boolean') {
        throw new HttpError(400, "Hodnota 'owned' musí být true nebo false.");
      }
      const catalog = loadCatalog(catalogPath);
      if (!catalog.collections.some((c) => c.id === collectionId)) {
        throw new HttpError(404, 'Kolekce nebyla nalezena.');
      }
      const itemCollections = catalog.itemToCollections.get(itemId);
      if (!itemCollections) {
        throw new HttpError(404, 'Předmět nebyl nalezen.');
      }
      if (!itemCollections.has(collectionId)) {
        throw new HttpError(400, 'Předmět nepatří do této kolekce.');
      }
      let collector = q.findUserCollector.get(me.id, collectionId);
      if (!collector) {
        const id = crypto.randomUUID();
        try {
          q.insertCollector.run(id, me.name, me.name.toLowerCase(), collectionId, Date.now(), me.id);
        } catch (err) {
          if (!(err instanceof Error && /UNIQUE/i.test(err.message))) throw err;
        }
        collector = q.findUserCollector.get(me.id, collectionId);
      }
      if (!collector) {
        throw new HttpError(500, 'Sběratele se nepodařilo založit.');
      }
      // Nastavujeme vždy přesně požadovaný stav jedné položky (idempotentně),
      // nikdy se netoggleuje a nikdy se nepřepisuje celý stav sběratele.
      if (body.owned) {
        q.addOwned.run(collector.id, itemId);
      } else {
        q.removeOwnedForUser.run(itemId, me.id);
      }
      return { status: 200, data: { collector: collectorJson(collector, catalog) } };
    }

    // „Hlavní sběratel" kolekce: max. jeden na kolekci, jeden člen jich ale
    // může držet více. Nárokuje/uvolňuje vždy jen přihlášený uživatel.
    const primaryMatch = /^\/api\/collections\/([^/]+)\/primary$/.exec(pathname);
    if (primaryMatch && req.method === 'PUT') {
      const collectionId = decodeURIComponent(primaryMatch[1]);
      requireJson(req);
      const body = await readJsonBody(req);
      if (typeof body?.primary !== 'boolean') {
        throw new HttpError(400, "Hodnota 'primary' musí být true nebo false.");
      }
      const catalog = loadCatalog(catalogPath);
      if (!catalog.collections.some((c) => c.id === collectionId)) {
        throw new HttpError(404, 'Kolekce nebyla nalezena.');
      }
      const row = q.getPrimary.get(collectionId);
      if (body.primary) {
        if (!row) {
          try {
            q.insertPrimary.run(collectionId, me.id);
          } catch (err) {
            if (!(err instanceof Error && /UNIQUE/i.test(err.message))) throw err;
            if (q.getPrimary.get(collectionId)?.user_id !== me.id) {
              throw new HttpError(409, 'Hlavního sběratele této kolekce už drží jiný člen.');
            }
          }
        } else if (row.user_id !== me.id) {
          throw new HttpError(409, 'Hlavního sběratele této kolekce už drží jiný člen.');
        }
      } else if (row) {
        if (row.user_id !== me.id) {
          throw new HttpError(403, 'Hlavního sběratele může zrušit jen člen, který ho drží.');
        }
        q.deletePrimary.run(collectionId);
      }
      return { status: 200, data: { primaryAssignments: primaryAssignmentsJson() } };
    }

    // Zachovaná stará cesta – nově striktně jen pro sběratele vlastněného
    // přihlášeným účtem; zděděné (user_id IS NULL) i cizí záznamy vrací 403.
    const itemMatch = /^\/api\/collectors\/([^/]+)\/items\/([^/]+)$/.exec(pathname);
    if (itemMatch && req.method === 'PUT') {
      const collectorId = decodeURIComponent(itemMatch[1]);
      const itemId = decodeURIComponent(itemMatch[2]);
      requireJson(req);
      const body = await readJsonBody(req);
      if (typeof body?.owned !== 'boolean') {
        throw new HttpError(400, "Hodnota 'owned' musí být true nebo false.");
      }
      const collector = q.getCollector.get(collectorId);
      if (!collector) {
        throw new HttpError(404, 'Sběratel nebyl nalezen.');
      }
      if (collector.user_id !== me.id) {
        throw new HttpError(403, 'Tohoto sběratele může upravovat jen jeho vlastník.');
      }
      const catalog = loadCatalog(catalogPath);
      const itemCollections = catalog.itemToCollections.get(itemId);
      if (!itemCollections) {
        throw new HttpError(404, 'Předmět nebyl nalezen.');
      }
      if (!itemCollections.has(collector.collection_id)) {
        throw new HttpError(400, 'Předmět nepatří do kolekce tohoto sběratele.');
      }
      if (body.owned) {
        q.addOwned.run(collectorId, itemId);
      } else {
        q.removeOwnedForUser.run(itemId, me.id);
      }
      return { status: 200, data: { collector: collectorJson(collector, catalog) } };
    }

    throw new HttpError(404, 'Neznámý požadavek.');
  }

  function sendJson(res, status, obj) {
    const payload = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  function serveStatic(req, res, pathname) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, 'Neplatná cesta.');
    }
    let base;
    let file;
    if (rel === '/tokens.css') {
      base = rootDir;
      file = path.join(rootDir, 'tokens.css');
    } else {
      if (rel === '/' || rel === '') rel = '/index.html';
      base = publicDir;
      file = path.join(publicDir, rel);
    }
    const resolved = path.resolve(file);
    if (resolved !== path.resolve(base) && !resolved.startsWith(path.resolve(base) + path.sep)) {
      throw new HttpError(403, 'Zakázaná cesta.');
    }
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new HttpError(404, 'Soubor nebyl nalezen.');
    }
    if (!stat.isFile()) {
      throw new HttpError(404, 'Soubor nebyl nalezen.');
    }
    const type = MIME_TYPES[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(resolved).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    try {
      const parsedUrl = new URL(req.url, 'http://internal');
      const { pathname } = parsedUrl;
      if (pathname === '/api/auth/discord/callback' && req.method === 'GET') {
        await discordAuth.callback(req, res, parsedUrl);
        return;
      }
      if (pathname.startsWith('/api/')) {
        const { status, data } = await handleApi(req, res, pathname);
        sendJson(res, status, data);
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        serveStatic(req, res, pathname);
      } else {
        throw new HttpError(404, 'Neznámý požadavek.');
      }
    } catch (err) {
      if (err instanceof HttpError || err instanceof CatalogError) {
        const status = err instanceof CatalogError ? 500 : err.status;
        if (!res.headersSent) sendJson(res, status, { error: err.message });
        else res.destroy();
      } else {
        console.error(err);
        if (!res.headersSent) sendJson(res, 500, { error: 'Interní chyba serveru.' });
        else res.destroy();
      }
    }
  });

  return { server, db, dataDir, catalogPath, get generatedPassword() { return generatedPassword; } };
}

function main() {
  try {
    process.loadEnvFile();
  } catch {
    // .env nemusí existovat – výchozí hodnoty postačí pro lokální běh
  }
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  let app;
  try {
    app = createApp();
  } catch (err) {
    console.error(`Server se nepodařilo spustit: ${err.message}`);
    process.exit(1);
  }
  const { server, db } = app;
  server.listen(port, host, () => {
    const addr = server.address();
    console.log(`Server běží na http://${addr.address}:${addr.port}`);
    if (app.generatedPassword) {
      console.log('');
      console.log('!!! CLUB_PASSWORD nebylo nastaveno – vygenerována náhodná klubová pozvánka:');
      console.log(`    ${app.generatedPassword}`);
      console.log('    Slouží jen k registraci nových členů. Zobrazí se pouze teď.');
      console.log('    Uložte si ji, nebo nastavte CLUB_PASSWORD v souboru .env.');
      console.log('');
    }
  });
  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
