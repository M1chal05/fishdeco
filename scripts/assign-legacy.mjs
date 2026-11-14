#!/usr/bin/env node
// Přiřazení zděděných sběratelů (user_id IS NULL) k registrovanému účtu.
//
// Slouží k jednorázové migraci dat z doby před osobními účty: všechny
// nepřiřazené sběratele se zadaným jménem připíše existujícímu účtu.
// Odškrtnuté předměty (owned_items) se zachovají – vážou se na collector.id,
// který se nemění. Nic se nemaže, nespojuje ani nevytváří.
//
// Spusťte vždy při VYPNUTÉM serveru (jediný zapisující proces).
// Skript sám nikdy nevytváří uživatele ani hesla/PINy – pracuje jen nad
// existujícími záznamy a na příkazové řádce přijímá pouze jména.
//
// Použití:
//   node scripts/assign-legacy.mjs --from "Pepa" --to "Pepa Novák"
//   node scripts/assign-legacy.mjs --from "Pepa" --to "pepa" --dry-run
//
// Volby:
//   --from <jméno>     jméno ZDĚDĚNÝCH sběratelů (nepřiřazených záznamů)
//   --to <jméno>       jméno REGISTROVANÉHO účtu (musí existovat v users)
//   --data-dir <dir>   adresář s club.sqlite (výchozí DATA_DIR nebo ./data)
//   --dry-run          jen vypíše, co by se změnilo; nic nezapisuje
//   --help             nápověda

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');

class CliError extends Error {}

function usage() {
  console.log(`Použití: node scripts/assign-legacy.mjs --from <jméno> --to <jméno> [volby]
  --from <jméno>     jméno zděděných (nepřiřazených) sběratelů
  --to <jméno>       jméno existujícího registrovaného účtu
  --data-dir <dir>   adresář s club.sqlite (výchozí DATA_DIR nebo ./data)
  --dry-run          jen zobrazí plánované změny, nic nezapisuje
  --help             nápověda

Spusťte při vypnutém serveru.`);
}

function parseArgs(argv) {
  const opts = {
    dataDir: process.env.DATA_DIR ?? path.join(ROOT, 'data'),
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--from') {
      opts.from = argv[++i];
    } else if (arg === '--to') {
      opts.to = argv[++i];
    } else if (arg === '--data-dir') {
      opts.dataDir = path.resolve(argv[++i]);
    } else {
      usage();
      throw new CliError(`Neznámá nebo chybějící volba: ${arg}`);
    }
  }
  if (opts.from === undefined || opts.to === undefined) {
    usage();
    throw new CliError('Chybí povinné volby --from a --to.');
  }
  return opts;
}

function normalizeName(name) {
  return name.trim().replace(/\s+/g, ' ').normalize('NFC');
}

function run(opts) {
  const legacyNorm = normalizeName(opts.from).toLowerCase();
  const userNorm = normalizeName(opts.to).toLowerCase();
  if (!legacyNorm || !userNorm) {
    throw new CliError('Jména nesmí být prázdná.');
  }

  const dbPath = path.join(opts.dataDir, 'club.sqlite');
  if (!fs.existsSync(dbPath)) {
    throw new CliError(`Databáze nebyla nalezena: ${dbPath}`);
  }

  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON');

    const versionRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    if (!versionRow || Number(versionRow.value) < 2) {
      throw new CliError('Databáze nemá schéma verze 2 – nejdříve jednou spusťte server, aby proběhla migrace.');
    }

    const user = db.prepare('SELECT id, name FROM users WHERE name_norm = ?').get(userNorm);
    if (!user) {
      throw new CliError(`Registrovaný účet "${normalizeName(opts.to)}" neexistuje. Nejdřív ho založte přes registraci.`);
    }

    const legacy = db.prepare(
      'SELECT id, name, collection_id FROM collectors WHERE user_id IS NULL AND name_norm = ? ORDER BY created_at, rowid'
    ).all(legacyNorm);
    if (legacy.length === 0) {
      console.log(`Žádné nepřiřazené záznamy se jménem "${normalizeName(opts.from)}" – není co dělat.`);
      return;
    }

    // Kolize: účet už má vlastního sběratele ve stejné kolekci. V takovém
    // případě raději nic nezměníme, než abychom data mlčky sloučili/smazali.
    const owned = db.prepare('SELECT id FROM collectors WHERE user_id = ? AND collection_id = ?');
    const conflicts = legacy.filter((c) => owned.get(user.id, c.collection_id));
    if (conflicts.length > 0) {
      const list = conflicts.map((c) => `  - kolekce "${c.collection_id}"`).join('\n');
      throw new CliError(
        `Účet "${user.name}" má ve stejných kolekcích už vlastní záznamy, konflikt:\n${list}\n` +
        'Nic se nezměnilo. Vyřešte ručně a spusťte znovu.'
      );
    }

    const itemCounts = db.prepare('SELECT COUNT(*) AS n FROM owned_items WHERE collector_id = ?');
    console.log(`Nalezeno ${legacy.length} nepřiřazených záznamů "${normalizeName(opts.from)}":`);
    for (const c of legacy) {
      console.log(`  - kolekce "${c.collection_id}" (${itemCounts.get(c.id).n} předmětů)`);
    }

    if (opts.dryRun) {
      console.log(`--dry-run: záznamy by se přiřadily účtu "${user.name}" (${user.id}). Nic se nezměnilo.`);
      return;
    }

    db.exec('BEGIN');
    try {
      const update = db.prepare('UPDATE collectors SET user_id = ? WHERE id = ? AND user_id IS NULL');
      for (const c of legacy) update.run(user.id, c.id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    console.log(`Hotovo: ${legacy.length} záznamů přiřazeno účtu "${user.name}". Předměty zůstaly zachovány.`);
  } finally {
    db.close();
  }
}

try {
  run(parseArgs(process.argv.slice(2)));
} catch (err) {
  if (err instanceof CliError) {
    console.error(`Chyba: ${err.message}`);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
