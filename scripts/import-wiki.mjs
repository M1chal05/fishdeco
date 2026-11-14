#!/usr/bin/env node
// Import katalogu dekorací z https://www.fishaofunwiki.com/category/decorations
//
// Zdroj je veřejné SPA: stránka kategorie → hlavní JS modul → chunk
// assets/decorations-*.js, který obsahuje `var e=JSON.parse(`[...]`)`.
// Payload se čte čistě jako DATA (JSON.parse), žádný vzdálený kód se nevykonává.
// Skript stáhne i všechny obrázky dekorací do public/assets/decorations/,
// aby aplikace nezávisela na hotlinku.
//
// Bezpečný provoz: dokud není vše staženo a zvalidováno, produkční
// data/catalog.json se nepřepisuje (zápis probíhá atomicky přes tmp+rename).
// SQLite databáze se nikdy nedotýká.
//
// Použití:
//   node scripts/import-wiki.mjs            # plný import
//   node scripts/import-wiki.mjs --dry-run  # jen stáhne+ověří, nic nezapíše
//   npm run import
//
// Volby: --out <soubor>  --assets-dir <adresář>  --report <soubor>
//        --concurrency <n>  --dry-run  --help
// Pro testování lze přesměrovat zdroj: FISHDECO_WIKI_ORIGIN=http://127.0.0.1:NNNN

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');

const WIKI_ORIGIN = (process.env.FISHDECO_WIKI_ORIGIN ?? 'https://www.fishaofunwiki.com')
  .replace(/\/+$/, '');
const CATEGORY_PATH = '/category/decorations';
const USER_AGENT = 'fishdeco-catalog-import/1.0 (+local club app; data provenance)';
const FETCH_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 700;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SOURCE_IMAGE_RE = /^\/decorations\/[A-Za-z0-9._-]+\.[a-z0-9]+$/;

// Typové sběrací odznaky z wiki (assets/collections-*.js): Plants a Paintings.
// Id položky v katalogu musí být jedinečné, proto se tyto položky vyčleňují
// jen z kolekce "Other" – rostliny a obrazy z tematických sad zůstávají
// ve svých sadách.
const BADGE_COLLECTIONS = [
  { id: 'plants', name: 'Plants', itemType: 'Plant', icon: '/decorations-set-badges/plant-set.webp' },
  { id: 'paintings', name: 'Paintings', itemType: 'Painting', icon: '/decorations-set-badges/painting-set.webp' },
];

class ImportError extends Error {}

function usage() {
  console.log(`Použití: node scripts/import-wiki.mjs [volby]
  --out <soubor>       výstupní katalog (výchozí data/catalog.json)
  --assets-dir <dir>   cíl obrázků (výchozí public/assets/decorations)
  --report <soubor>    report importu (výchozí data/import-report.json)
  --concurrency <n>    paralelní stahování obrázků (výchozí 5, max 6)
  --dry-run            vše stáhne a ověří, ale nic nezapisuje
  --help               nápověda`);
}

function parseArgs(argv) {
  const opts = {
    out: path.join(ROOT, 'data', 'catalog.json'),
    assetsDir: path.join(ROOT, 'public', 'assets', 'decorations'),
    report: path.join(ROOT, 'data', 'import-report.json'),
    concurrency: 5,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => {
      if (i + 1 >= argv.length) throw new ImportError(`Volba ${a} vyžaduje hodnotu.`);
      return argv[++i];
    };
    if (a === '--out') opts.out = path.resolve(take());
    else if (a === '--assets-dir') opts.assetsDir = path.resolve(take());
    else if (a === '--report') opts.report = path.resolve(take());
    else if (a === '--concurrency') {
      opts.concurrency = Number(take());
      if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1 || opts.concurrency > 6) {
        throw new ImportError('--concurrency musí být celé číslo 1–6.');
      }
    } else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--help' || a === '-h') {
      usage();
      process.exit(0);
    } else {
      throw new ImportError(`Neznámá volba: ${a}`);
    }
  }
  return opts;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, { maxBytes = MAX_JSON_BYTES } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: '*/*' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'follow',
      });
      if (res.status === 404) {
        throw new ImportError(`HTTP 404: ${url}`);
      }
      if (res.status !== 200) {
        throw new ImportError(`HTTP ${res.status}: ${url}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new ImportError(`Prázdná odpověď: ${url}`);
      if (buf.length > maxBytes) {
        throw new ImportError(`Příliš velká odpověď (${buf.length} B): ${url}`);
      }
      return { buf, res };
    } catch (err) {
      lastErr = err;
      // 404 opakovat nemá smysl; u ostatního zkusíme znovu s krátkou pauzou
      if (err instanceof ImportError && /HTTP 404/.test(err.message)) break;
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  throw lastErr;
}

async function fetchText(url, opts) {
  const { buf } = await fetchWithRetry(url, opts);
  return buf.toString('utf8');
}

// --- Objevování zdrojových souborů -------------------------------------------

function findMainModulePath(html) {
  const re = /<script[^>]+type="module"[^>]+src="([^"]+\.js)"|<script[^>]+src="([^"]+\.js)"[^>]+type="module"/g;
  const seen = new Set();
  let m;
  while ((m = re.exec(html))) {
    const src = m[1] ?? m[2];
    if (!seen.has(src)) seen.add(src);
  }
  const candidates = [...seen].filter((s) => /^\/(assets\/)?[^"'\s]+$/.test(s));
  if (candidates.length === 0) {
    throw new ImportError('V HTML stránky kategorie nebyl nalezen hlavní <script type="module">.');
  }
  // Hlavní bundle typicky sedí v /assets/index-*.js
  const preferred = candidates.find((s) => /\/assets\/index-[^/]+\.js$/.test(s));
  return preferred ?? candidates[0];
}

function findDecorationsChunkPath(mainJs) {
  // Odkazy na chunk se mohou objevit jako "assets/decorations-X.js" i "./decorations-X.js"
  const re = /[^"'()\s]*decorations-[A-Za-z0-9_-]+\.js/g;
  const byName = new Map();
  let m;
  while ((m = re.exec(mainJs))) {
    const p = m[0];
    const base = p.slice(p.lastIndexOf('/') + 1);
    // Preferuj variantu ukotvenou v assets/ (kořen webu) před relativní "./"
    if (!byName.has(base) || /(^|\/)assets\//.test(p)) byName.set(base, p);
  }
  if (byName.size === 0) {
    throw new ImportError('V hlavním JS modulu nebyl nalezen odkaz na chunk decorations-*.js.');
  }
  if (byName.size > 1) {
    throw new ImportError(`Nalezeno více různých decorations chunků: ${[...byName.keys()].join(', ')}`);
  }
  const rel = [...byName.values()][0];
  // Normalizace na cestu od kořene webu (např. "assets/decorations-X.js" → "/assets/decorations-X.js")
  return rel.startsWith('/') ? rel : `/${rel.replace(/^\.\//, '')}`;
}

function findPageChunk(source, name) {
  const match = source.match(new RegExp(`(?:assets/|\\./)(${name}-[A-Za-z0-9_-]+\\.js)`));
  return match ? `/assets/${match[1]}` : null;
}

async function discoverSetIcons(mainJs, items) {
  let pagePath = findPageChunk(mainJs, 'DecorationsPage');
  if (!pagePath) {
    const appPath = findPageChunk(mainJs, 'App');
    if (!appPath) return { pageUrl: null, jobs: [] }; // Minimal/older wiki builds.
    pagePath = findPageChunk(await fetchText(`${WIKI_ORIGIN}${appPath}`), 'DecorationsPage');
    if (!pagePath) throw new ImportError('V aplikaci wiki chybí stránka DecorationsPage.');
  }
  const pageUrl = `${WIKI_ORIGIN}${pagePath}`;
  const page = await fetchText(pageUrl);
  // Read only literal image mappings; never execute the remote page module.
  const images = new Map();
  const re = /"([^"\r\n]+)":`(\/(?:decorations-set-badges|decorations)\/[A-Za-z0-9._-]+\.webp)`/g;
  for (const match of page.matchAll(re)) images.set(match[1], match[2]);
  const jobs = [...new Set(items.map((item) => item.set))].map((set) => {
    const sourceImage = images.get(set) || (set === 'Other' ? '/decorations-logo.webp' : null);
    if (!sourceImage) throw new ImportError(`Na stránce wiki chybí ikona sady ${set}.`);
    return { set, slug: `set-${collectionIdFor(set)}`, sourceImage };
  });
  return { pageUrl, jobs };
}

function loadCzechNames() {
  const names = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'names.cs.json'), 'utf8'));
  for (const key of ['collections', 'items']) {
    if (!names[key] || typeof names[key] !== 'object' || Array.isArray(names[key])) {
      throw new ImportError(`České názvy: ${key} musí být objekt.`);
    }
    for (const value of Object.values(names[key])) {
      if (typeof value !== 'string' || !value.trim() || value.length > 160) {
        throw new ImportError('České názvy musí být neprázdné řetězce do 160 znaků.');
      }
    }
  }
  return names;
}

// --- Bezpečná extrakce JSON payloadu (data only, žádné eval) ------------------

function extractJsonPayload(chunkSource) {
  const marker = 'JSON.parse(';
  const idx = chunkSource.indexOf(marker);
  if (idx === -1) {
    throw new ImportError('V decorations chunku chybí JSON.parse( — formát zdroje se změnil?');
  }
  let i = idx + marker.length;
  while (/\s/.test(chunkSource[i])) i++;
  const quote = chunkSource[i];
  if (quote !== '`' && quote !== '"' && quote !== "'") {
    throw new ImportError('Argument JSON.parse není řetězcový literál — formát se změnil.');
  }
  // Sken literálu s ohledem na escape sekvence; ` nebo " ukončuje literál
  let raw = '';
  let hadEscapes = false;
  let j = i + 1;
  for (; j < chunkSource.length; j++) {
    const ch = chunkSource[j];
    if (ch === '\\') {
      hadEscapes = true;
      raw += ch + (chunkSource[j + 1] ?? '');
      j++;
      continue;
    }
    if (ch === quote) break;
    raw += ch;
  }
  if (j >= chunkSource.length) {
    throw new ImportError('Neukončený řetězcový literál v decorations chunku.');
  }
  const parseJson = (s) => JSON.parse(s);
  try {
    return parseJson(raw);
  } catch (err) {
    if (!hadEscapes) {
      throw new ImportError(`JSON payload v chunku se nepodařilo naparsovat: ${err.message}`);
    }
    // Záložní cesta: od-escapovat template-literal a zkusit znovu
    const unescaped = raw
      .replace(/\\`/g, '`')
      .replace(/\\\$/g, '$')
      .replace(/\\\\/g, '\\');
    try {
      return parseJson(unescaped);
    } catch (err2) {
      throw new ImportError(`JSON payload v chunku se nepodařilo naparsovat: ${err2.message}`);
    }
  }
}

// --- Validace a transformace payloadu -----------------------------------------

const ITEM_STRING_FIELDS = ['name', 'slug', 'set', 'type', 'rarity', 'availability', 'season', 'source'];
const KNOWN_ITEM_FIELDS = new Set([
  ...ITEM_STRING_FIELDS, 'level', 'price', 'image', 'width', 'height', 'acquisitionDetail',
]);

function fail(msg) {
  throw new ImportError(msg);
}

function validateDecorations(arr) {
  if (!Array.isArray(arr) || arr.length === 0) {
    fail('Payload není neprázdné pole dekorací.');
  }
  const slugs = new Set();
  const images = new Set();
  const unmappedFields = new Set();
  const items = arr.map((d, i) => {
    const where = `payload[${i}]`;
    if (!d || typeof d !== 'object' || Array.isArray(d)) {
      fail(`${where} není objekt.`);
    }
    for (const k of Object.keys(d)) {
      if (!KNOWN_ITEM_FIELDS.has(k)) unmappedFields.add(k);
    }
    for (const f of ITEM_STRING_FIELDS) {
      if (typeof d[f] !== 'string' || d[f].length === 0) {
        fail(`${where}.${f} musí být neprázdný řetězec (je ${JSON.stringify(d[f])}).`);
      }
    }
    if (!SLUG_RE.test(d.slug)) {
      fail(`${where}.slug "${d.slug}" nemá bezpečný kebab-case formát.`);
    }
    if (slugs.has(d.slug)) fail(`Duplicitní slug "${d.slug}".`);
    slugs.add(d.slug);
    const checkNum = (v, field, nullable) => {
      if (nullable && v === null) return;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        fail(`${where}.${field} musí být konečné číslo >= 0${nullable ? ' nebo null' : ''} (je ${JSON.stringify(v)}).`);
      }
    };
    checkNum(d.level, 'level', true);
    checkNum(d.price, 'price', true);
    checkNum(d.width, 'width', false);
    checkNum(d.height, 'height', false);
    if (typeof d.image !== 'string' || !SOURCE_IMAGE_RE.test(d.image)) {
      fail(`${where}.image "${d.image}" není bezpečná cesta /decorations/*.`);
    }
    if (images.has(d.image)) fail(`Duplicitní image "${d.image}".`);
    images.add(d.image);
    if (d.acquisitionDetail !== undefined && typeof d.acquisitionDetail !== 'string') {
      fail(`${where}.acquisitionDetail musí být řetězec.`);
    }
    return {
      slug: d.slug,
      name: d.name,
      set: d.set,
      type: d.type,
      rarity: d.rarity,
      availability: d.availability,
      level: d.level,
      season: d.season,
      source: d.source,
      price: d.price,
      sourceImage: d.image,
      width: d.width,
      height: d.height,
      acquisitionDetail: d.acquisitionDetail,
    };
  });
  return { items, unmappedFields: [...unmappedFields].sort() };
}

function collectionIdFor(setName) {
  return setName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildCatalog(items, meta, icons, names) {
  const order = [];
  const bySet = new Map();
  for (const it of items) {
    if (!bySet.has(it.set)) {
      bySet.set(it.set, []);
      order.push(it.set);
    }
    bySet.get(it.set).push(it);
  }
  const collIds = new Set();
  const collections = order.map((setName) => {
    const id = collectionIdFor(setName);
    if (!id || collIds.has(id)) {
      fail(`Id kolekce pro sadu "${setName}" je prázdné nebo koliduje ("${id}").`);
    }
    collIds.add(id);
    return {
      id,
      name: setName,
      ...(names.collections[id] ? { nameCs: names.collections[id] } : {}),
      ...(icons.has(setName) ? { image: `/assets/decorations/${icons.get(setName).slug}.webp` } : {}),
      sourceUrl: `${WIKI_ORIGIN}${CATEGORY_PATH}`,
      items: bySet.get(setName).map((it) => {
        const item = {
          id: it.slug,
          name: it.name,
          ...(names.items[it.slug] ? { nameCs: names.items[it.slug] } : {}),
          image: `/assets/decorations/${it.slug}.webp`,
          sourceUrl: `${WIKI_ORIGIN}${CATEGORY_PATH}?decoration=${encodeURIComponent(it.slug)}`,
          set: it.set,
          type: it.type,
          rarity: it.rarity,
          availability: it.availability,
          level: it.level,
          season: it.season,
          source: it.source,
          price: it.price,
          width: it.width,
          height: it.height,
        };
        if (it.acquisitionDetail !== undefined) item.acquisitionDetail = it.acquisitionDetail;
        return item;
      }),
    };
  });
  // Odznaky: typové položky z "Other" se přesunou do samostatných kolekcí.
  const otherIdx = collections.findIndex((c) => c.id === 'other');
  if (otherIdx !== -1) {
    const other = collections[otherIdx];
    const buckets = BADGE_COLLECTIONS.map(() => []);
    const rest = [];
    for (const it of other.items) {
      const bi = BADGE_COLLECTIONS.findIndex((b) => b.itemType === it.type);
      (bi === -1 ? rest : buckets[bi]).push(it);
    }
    other.items = rest;
    const badges = BADGE_COLLECTIONS
      .map((b, i) => ({ b, items: buckets[i] }))
      .filter(({ items: list }) => list.length > 0)
      .map(({ b, items: list }) => ({
        id: b.id,
        name: b.name,
        ...(names.collections[b.id] ? { nameCs: names.collections[b.id] } : {}),
        ...(icons.has(b.name) ? { image: `/assets/decorations/${icons.get(b.name).slug}.webp` } : {}),
        sourceUrl: `${WIKI_ORIGIN}${CATEGORY_PATH}`,
        items: list,
      }));
    collections.splice(otherIdx + 1, 0, ...badges);
  }
  return { meta, collections };
}

// --- Stahování obrázků ---------------------------------------------------------

function isWebp(buf) {
  return buf.length >= 12
    && buf.toString('latin1', 0, 4) === 'RIFF'
    && buf.toString('latin1', 8, 12) === 'WEBP';
}

function looksLikeHtml(buf) {
  const head = buf.toString('latin1', 0, Math.min(buf.length, 256)).trimStart().toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml');
}

async function downloadImages(items, concurrency, onProgress) {
  const results = new Map(); // slug -> {buf, sourceImage, bytes}
  const failures = [];
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const it = items[cursor++];
      const url = `${WIKI_ORIGIN}${it.sourceImage}`;
      try {
        const { buf, res } = await fetchWithRetry(url, { maxBytes: MAX_IMAGE_BYTES });
        const ctype = String(res.headers.get('content-type') || '').toLowerCase();
        if (ctype.includes('text/html') || looksLikeHtml(buf)) {
          throw new ImportError('odpověď je HTML, ne obrázek');
        }
        if (!isWebp(buf)) {
          throw new ImportError(`chybí WEBP signatura (content-type: ${ctype || '?'})`);
        }
        results.set(it.slug, { buf, sourceImage: it.sourceImage, bytes: buf.length });
      } catch (err) {
        failures.push({ slug: it.slug, url, error: err.message });
      }
      onProgress?.(results.size + failures.length, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return { results, failures };
}

// --- Bezpečný zápis souborů -----------------------------------------------------

function safeJoinInside(baseDir, fileName) {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, fileName);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new ImportError(`Nebezpečná cesta mimo cílový adresář: ${fileName}`);
  }
  return target;
}

function writeAtomic(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// --- Hlavní běh -----------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const startedAt = new Date();
  const report = {
    status: 'started',
    generator: 'scripts/import-wiki.mjs',
    wikiOrigin: WIKI_ORIGIN,
    categoryUrl: `${WIKI_ORIGIN}${CATEGORY_PATH}`,
    fetchedAt: startedAt.toISOString(),
    steps: {},
  };
  const writeReport = () => {
    if (!opts.dryRun) {
      fs.mkdirSync(path.dirname(opts.report), { recursive: true });
      writeAtomic(opts.report, JSON.stringify(report, null, 2) + '\n');
    }
  };

  try {
    console.log(`[1/4] Načítám stránku kategorie ${report.categoryUrl}`);
    const html = await fetchText(`${WIKI_ORIGIN}${CATEGORY_PATH}`);
    const mainModulePath = findMainModulePath(html);
    report.steps.mainModule = `${WIKI_ORIGIN}${mainModulePath}`;

    console.log(`[2/4] Hledám decorations chunk v ${mainModulePath}`);
    const mainJs = await fetchText(report.steps.mainModule, { maxBytes: MAX_JSON_BYTES });
    const chunkPath = findDecorationsChunkPath(mainJs);
    const chunkUrl = `${WIKI_ORIGIN}${chunkPath}`;
    report.steps.decorationsChunk = chunkUrl;

    console.log(`[3/4] Stahuji a validuji data z ${chunkPath}`);
    const chunkSource = await fetchText(chunkUrl, { maxBytes: MAX_JSON_BYTES });
    const payload = extractJsonPayload(chunkSource);
    const { items, unmappedFields } = validateDecorations(payload);
    report.sourceHash = `sha256:${sha256(chunkSource)}`;
    report.unmappedFields = unmappedFields;

    const countsBySet = {};
    for (const it of items) countsBySet[it.set] = (countsBySet[it.set] ?? 0) + 1;
    report.sets = Object.entries(countsBySet).map(([set, count]) => ({ set, count }));
    report.itemCount = items.length;
    const names = loadCzechNames();
    report.czechNames = {
      collectionsMissing: [...new Set(items.map((i) => i.set))].filter((set) => !names.collections[collectionIdFor(set)]),
      itemsMissing: items.filter((i) => !names.items[i.slug]).map((i) => i.slug),
    };
    const iconSource = await discoverSetIcons(mainJs, items);
    report.steps.setIconsPage = iconSource.pageUrl;
    const otherItemTypes = new Set(
      items.filter((it) => collectionIdFor(it.set) === 'other').map((it) => it.type)
    );
    iconSource.jobs.push(...BADGE_COLLECTIONS
      .filter((b) => otherItemTypes.has(b.itemType))
      .map((b) => ({ set: b.name, slug: `set-${b.id}`, sourceImage: b.icon })));
    const icons = new Map(iconSource.jobs.map((job) => [job.set, job]));
    const imageJobs = [...items, ...iconSource.jobs];
    if (new Set(imageJobs.map((job) => job.slug)).size !== imageJobs.length) fail('Kolize názvů obrázků sad a dekorací.');
    console.log(`      ${items.length} dekorací v ${report.sets.length} sadách: `
      + report.sets.map((s) => `${s.set}=${s.count}`).join(', '));

    // Diff proti existujícímu katalogu (jen pro report, import nikdy neblokuje)
    try {
      const prev = JSON.parse(fs.readFileSync(opts.out, 'utf8'));
      const prevIds = new Set(
        (prev.collections ?? []).flatMap((c) => (c.items ?? []).map((i) => i.id))
      );
      const nextIds = new Set(items.map((i) => i.slug));
      report.previousCatalog = {
        itemCount: prevIds.size,
        addedSlugs: [...nextIds].filter((id) => !prevIds.has(id)).sort(),
        removedSlugs: [...prevIds].filter((id) => !nextIds.has(id)).sort(),
      };
    } catch {
      report.previousCatalog = { note: 'předchozí katalog chybí nebo není čitelný' };
    }

    console.log(`[4/4] Stahuji ${items.length} obrázků a ${icons.size} ikon sad (paralelně ${opts.concurrency})`);
    const lastLog = { at: 0 };
    const { results, failures } = await downloadImages(imageJobs, opts.concurrency, (done, total) => {
      const now = Date.now();
      if (now - lastLog.at > 1500 || done === total) {
        lastLog.at = now;
        console.log(`      obrázky: ${done}/${total}`);
      }
    });
    report.images = {
      expected: items.length,
      downloaded: items.filter((it) => results.has(it.slug)).length,
      failed: failures,
      bytesTotal: items.reduce((n, it) => n + (results.get(it.slug)?.bytes || 0), 0),
      items: items.map((it) => {
        const r = results.get(it.slug);
        return r
          ? { slug: it.slug, file: `${it.slug}.webp`, sourceImage: r.sourceImage, bytes: r.bytes }
          : { slug: it.slug, sourceImage: it.sourceImage, missing: true };
      }),
    };
    report.setIcons = iconSource.jobs.map((it) => ({
      set: it.set, file: `${it.slug}.webp`, sourceUrl: `${WIKI_ORIGIN}${it.sourceImage}`,
      bytes: results.get(it.slug)?.bytes || 0,
    }));
    if (failures.length > 0) {
      fail(`${failures.length} obrázků se nepodařilo stáhnout/ověřit: `
        + failures.slice(0, 10).map((f) => `${f.slug} (${f.error})`).join(', ')
        + (failures.length > 10 ? '…' : ''));
    }

    const meta = {
      source: 'FishaoFunWiki',
      sourceUrl: `${WIKI_ORIGIN}${CATEGORY_PATH}`,
      importedAt: startedAt.toISOString(),
      generator: 'scripts/import-wiki.mjs',
      sourceHash: report.sourceHash,
      itemCount: items.length,
    };
    const catalog = buildCatalog(items, meta, icons, names);
    const catalogJson = JSON.stringify(catalog, null, 2) + '\n';
    report.catalogHash = `sha256:${sha256(catalogJson)}`;
    report.catalogPath = path.relative(ROOT, opts.out) || opts.out;
    report.assetsDir = path.relative(ROOT, opts.assetsDir) || opts.assetsDir;

    if (opts.dryRun) {
      report.status = 'dry-run-ok';
      console.log('DRY-RUN: vše ověřeno, nic se nezapisuje.');
    } else {
      // Zápis až teď, kdy je vše kompletní a validní
      fs.mkdirSync(opts.assetsDir, { recursive: true });
      for (const it of imageJobs) {
        const { buf } = results.get(it.slug);
        writeAtomic(safeJoinInside(opts.assetsDir, `${it.slug}.webp`), buf);
      }
      fs.mkdirSync(path.dirname(opts.out), { recursive: true });
      writeAtomic(opts.out, catalogJson);
      report.status = 'ok';
      console.log(`Zapsáno: ${opts.out}`);
      console.log(`Obrázky: ${opts.assetsDir} (${results.size} souborů)`);
    }
    report.finishedAt = new Date().toISOString();
    writeReport();
    if (!opts.dryRun) console.log(`Report: ${opts.report}`);
    console.log(`HOTOVO: ${items.length} položek, ${report.sets.length} sad, ${results.size} obrázků.`);
  } catch (err) {
    report.status = 'failed';
    report.error = err.message;
    report.finishedAt = new Date().toISOString();
    try { writeReport(); } catch { /* report je vedlejší */ }
    console.error(`IMPORT SELHAL: ${err.message}`);
    console.error('Import nebyl úspěšně dokončen; zkontrolujte report a výstupní soubory. SQLite databáze se importer nedotýká.');
    process.exit(1);
  }
}

main();
