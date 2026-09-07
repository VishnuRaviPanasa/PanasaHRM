#!/usr/bin/env node
/**
 * Migration runner. SQL is the source of truth (ADR-0003).
 *
 *   node scripts/migrate.mjs status     list applied vs pending
 *   node scripts/migrate.mjs up         apply all pending, in order
 *   node scripts/migrate.mjs verify     run testing/db/*.verify.sql against the current DB
 *
 * Deliberate design choices:
 *
 * - **Forward-only.** There is no `down`. Production rollback is achieved by deploying
 *   the previous image against the new schema, which is what makes expand/contract
 *   non-optional rather than advisory. A down-migration is a comforting fiction that
 *   nobody tests and that cannot restore dropped data anyway.
 *
 * - **Checksums are recorded and enforced.** Editing a migration after it has been
 *   applied is how two environments silently diverge - one has the old shape, one has
 *   the new, and nothing reports it. That is a hard failure here.
 *
 * - **Each migration runs in its own transaction**, so a partial apply cannot happen.
 *   A migration that genuinely cannot run in a transaction (CREATE INDEX CONCURRENTLY)
 *   must say so with `-- NO-TRANSACTION` on its first line.
 *
 * Uses only `psql`, which is already required to operate this system - no dependency
 * on the application's node_modules, so it works before `npm install` and in CI.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const MIGRATIONS_DIR = 'infrastructure/db/migrations';
const VERIFY_DIR = 'testing/db';

const conn = {
  host: process.env.PGHOST ?? '127.0.0.1',
  port: process.env.PGPORT ?? process.env.HRM_PG_PORT ?? '55432',
  user: process.env.PGUSER ?? 'hrm',
  db: process.env.PGDATABASE ?? 'hrm',
};

const psql = (args, input) => {
  const base = ['-h', conn.host, '-p', String(conn.port), '-U', conn.user, '-d', conn.db,
                '-v', 'ON_ERROR_STOP=1'];
  return execFileSync('psql', [...base, ...args], {
    encoding: 'utf8',
    input,
    env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD ?? 'hrm_dev_only' },
    maxBuffer: 32 * 1024 * 1024,
  });
};

// psql emits CRLF row separators on Windows, so a per-row value keeps a trailing CR and
// compares unequal to the same value computed here. Strip CR from the whole output.
const query = (sql) => psql(['-tAq', '-c', sql]).split(String.fromCharCode(13)).join('').trim();

// Normalise line endings before hashing. A Windows checkout has CRLF and a Linux/CI
// checkout has LF, so hashing raw bytes makes the SAME migration report drift on every
// CI run. The checksum must describe the content, not the platform that checked it out.
const CR = String.fromCharCode(13);
const sha256 = (s) =>
  createHash('sha256').update(s.split(CR).join(''), 'utf8').digest('hex');

const migrations = () => {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((f) => {
      const body = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
      return { version: f.slice(0, 4), name: f, body, checksum: sha256(body) };
    });
};

const applied = () => {
  const exists = query(`SELECT to_regclass('schema_migration') IS NOT NULL`);
  if (exists !== 't') return new Map();
  const rows = query(`SELECT version || '|' || checksum FROM schema_migration ORDER BY version`);
  return new Map(rows ? rows.split('\n').map((r) => r.split('|')) : []);
};

const cmdStatus = () => {
  const done = applied();
  const all = migrations();
  if (all.length === 0) { console.log('no migrations found'); return 0; }

  let drift = 0;
  console.log(`database: ${conn.user}@${conn.host}:${conn.port}/${conn.db}\n`);
  for (const m of all) {
    const rec = done.get(m.version);
    if (!rec) { console.log(`  PENDING  ${m.name}`); continue; }
    if (rec !== m.checksum) {
      console.log(`  DRIFT    ${m.name}  <- applied checksum does not match the file`);
      drift++;
    } else {
      console.log(`  applied  ${m.name}`);
    }
  }
  if (drift > 0) {
    console.error(
      `\n${drift} migration(s) were EDITED AFTER BEING APPLIED.\n` +
      `That is how two environments silently diverge. Write a new migration instead;\n` +
      `if the edit was cosmetic and you are certain, update the recorded checksum by hand\n` +
      `and record why in docs/governance/decisions.md.`);
    return 1;
  }
  return 0;
};

const cmdUp = () => {
  const done = applied();
  const pending = migrations().filter((m) => !done.has(m.version));

  // Refuse to proceed if anything already applied has drifted.
  for (const m of migrations()) {
    const rec = done.get(m.version);
    if (rec && rec !== m.checksum) {
      console.error(`REFUSING: ${m.name} was edited after being applied. Run 'status'.`);
      return 1;
    }
  }

  if (pending.length === 0) { console.log('nothing to apply'); return 0; }

  for (const m of pending) {
    const noTx = /^--\s*NO-TRANSACTION/m.test(m.body.split('\n')[0] ?? '');
    process.stdout.write(`applying ${m.name}${noTx ? ' (no transaction)' : ''} ... `);
    const started = Date.now();
    try {
      // The migration file supplies its own BEGIN/COMMIT when it wants one.
      psql(['-q', '-f', join(MIGRATIONS_DIR, m.name)]);
      const ms = Date.now() - started;
      psql(['-q', '-c',
        `INSERT INTO schema_migration (version, checksum, duration_ms)
         VALUES ('${m.version}', '${m.checksum}', ${ms})`]);
      console.log(`ok (${ms}ms)`);
    } catch (e) {
      console.log('FAILED');
      console.error(e.stderr?.toString() ?? e.message);
      return 1;
    }
  }
  return 0;
};

const cmdVerify = () => {
  if (!existsSync(VERIFY_DIR)) { console.log('no verification scripts'); return 0; }
  const files = readdirSync(VERIFY_DIR).filter((f) => f.endsWith('.verify.sql')).sort();
  if (files.length === 0) { console.log('no verification scripts'); return 0; }

  let failed = 0;
  for (const f of files) {
    process.stdout.write(`verifying ${f}\n`);
    try {
      const out = psql(['-f', join(VERIFY_DIR, f)]);
      for (const line of out.split('\n')) {
        if (/PASS|FAIL|INFO/.test(line)) console.log('   ' + line.replace(/^.*NOTICE:\s+/, ''));
      }
    } catch (e) {
      console.error(`   FAILED: ${(e.stderr?.toString() ?? e.message).split('\n')[0]}`);
      failed++;
    }
  }
  return failed === 0 ? 0 : 1;
};

const cmd = process.argv[2] ?? 'status';
const handlers = { status: cmdStatus, up: cmdUp, verify: cmdVerify };
if (!handlers[cmd]) {
  console.error(`usage: migrate.mjs <status|up|verify>`);
  process.exit(2);
}
process.exit(handlers[cmd]());
