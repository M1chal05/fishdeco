import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('import discovers source dynamically and preserves catalog if an image is missing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fishdeco-import-'));
  const out = path.join(dir, 'catalog.json');
  const report = path.join(dir, 'report.json');
  const assets = path.join(dir, 'images');
  let missing = false;
  let missingIcon = false;
  const items = [{
    slug: 'fixture-wall', name: 'Fixture Wall', set: 'Fixture Set', type: 'Wall',
    rarity: 'Unknown', availability: 'Furniture Factory', level: null,
    season: 'Always', source: 'Furniture Factory', price: 0,
    image: '/decorations/fixture-wall.webp', width: 128, height: 128,
  }];
  const image = fs.readFileSync(path.join(root, 'public/assets/decorations/simple-wall-1.webp'));
  const fixture = http.createServer((req, res) => {
    if (req.url === '/category/decorations') {
      res.end('<script type="module" src="/assets/index-fixture.js"></script>');
    } else if (req.url === '/assets/index-fixture.js') {
      res.end('const chunks = ["assets/decorations-fixture.js", "assets/App-fixture.js"]');
    } else if (req.url === '/assets/App-fixture.js') {
      res.end('const chunks = ["assets/DecorationsPage-fixture.js"]');
    } else if (req.url === '/assets/DecorationsPage-fixture.js') {
      res.end('const icons={"Fixture Set":`/decorations-set-badges/fixture-set.webp`};');
    } else if (req.url === '/decorations-set-badges/fixture-set.webp' && !missingIcon) {
      res.setHeader('Content-Type', 'image/webp');
      res.end(image);
    } else if (req.url === '/assets/decorations-fixture.js') {
      res.end('var data=JSON.parse(`' + JSON.stringify(items) + '`);export{data};');
    } else if (req.url === items[0].image && !missing) {
      res.setHeader('Content-Type', 'image/webp');
      res.end(image);
    } else {
      res.writeHead(404).end();
    }
  });
  try {
    await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    const args = ['scripts/import-wiki.mjs', '--out', out, '--report', report, '--assets-dir', assets];
    const options = {
      cwd: root, timeout: 20_000,
      env: { ...process.env, FISHDECO_WIKI_ORIGIN: `http://127.0.0.1:${fixture.address().port}` },
    };
    await run(process.execPath, args, options);
    const original = fs.readFileSync(out, 'utf8');
    const catalog = JSON.parse(original);
    assert.equal(catalog.collections[0].items[0].price, 0);
    assert.equal(catalog.collections[0].items[0].rarity, 'Unknown');
    assert.deepEqual(fs.readFileSync(path.join(assets, 'fixture-wall.webp')), image);
    assert.equal(catalog.collections[0].image, '/assets/decorations/set-fixture-set.webp');
    assert.deepEqual(fs.readFileSync(path.join(assets, 'set-fixture-set.webp')), image);
    missingIcon = true;
    await assert.rejects(run(process.execPath, args, options), /IMPORT SELHAL/);
    assert.equal(fs.readFileSync(out, 'utf8'), original, 'failed icon download preserves catalogue');
    missingIcon = false;
    missing = true;
    await assert.rejects(run(process.execPath, args, options), /IMPORT SELHAL/);
    assert.equal(fs.readFileSync(out, 'utf8'), original);
    assert.equal(JSON.parse(fs.readFileSync(report, 'utf8')).status, 'failed');
    assert.deepEqual(fs.readFileSync(path.join(assets, 'fixture-wall.webp')), image);
  } finally {
    fixture.closeAllConnections();
    await new Promise((resolve) => fixture.close(resolve));
    const resolved = path.resolve(dir);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(resolved).startsWith('fishdeco-import-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
