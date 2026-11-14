import { cp, mkdir, copyFile, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { loadCatalog } from '../server.mjs';

// Publish an explicit static directory, never the project root (.env / databases).
const output = new URL('../.cloudflare-assets/', import.meta.url);
const catalogPath = fileURLToPath(new URL('../data/catalog.json', import.meta.url));
const { collections, meta } = loadCatalog(catalogPath);
const safeCatalog = meta === undefined ? { collections } : { collections, meta };
if (!isDeepStrictEqual(JSON.parse(await readFile(catalogPath, 'utf8')), safeCatalog)) {
  throw new Error('Catalogue contains unknown fields; remove them before publishing the bundled catalogue.');
}
const workspace = fileURLToPath(new URL('../', import.meta.url));
const outputPath = resolve(fileURLToPath(output));
if (dirname(outputPath) !== resolve(workspace) || basename(outputPath) !== '.cloudflare-assets') {
  throw new Error('Static output must be the dedicated directory inside this workspace.');
}
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(new URL('../public/', import.meta.url), output, { recursive: true });
await copyFile(new URL('../tokens.css', import.meta.url), new URL('tokens.css', output));
console.log(`Static assets ready: ${fileURLToPath(output)}`);
