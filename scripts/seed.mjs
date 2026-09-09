#!/usr/bin/env node
/**
 * Demo seed runner.  node scripts/seed.mjs   (or: npm run db:seed)
 *
 * Loads infrastructure/db/seeds/demo.sql, computing the password hash here rather than storing
 * one in SQL. Uses only psql and Node's stdlib, for the same reason migrate.mjs does (DEC-013):
 * it has to work before `npm install` and during an incident.
 *
 * REFUSES a non-dev target, for the same reason db:verify does (DEC-024) - and more urgently,
 * because this script DELETEs the entire employee roster. Pointed at production it would be a
 * catastrophe rather than an inconvenience.
 */

import { execFileSync } from 'node:child_process';
import { scryptSync, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';

const SEED_FILE = 'infrastructure/db/seeds/demo.sql';

// TRACK B: ADR-0009 specifies argon2id with a breached-password blocklist. scrypt is used here
// because it is in Node's stdlib and needs no native module, which keeps the demo build
// reliable. This password is public demo credentials, not a secret.
const DEMO_PASSWORD = process.env.HRM_DEMO_PASSWORD ?? 'panasa2026';

const conn = {
  host: process.env.PGHOST ?? '127.0.0.1',
  port: process.env.PGPORT ?? process.env.HRM_PG_PORT ?? '55432',
  user: process.env.PGUSER ?? 'hrm',
  db: process.env.PGDATABASE ?? 'hrm',
};

const DEV = { hosts: ['127.0.0.1', 'localhost', '::1'], port: '55432' };
const OVERRIDE = 'HRM_SEED_ALLOW_NONDEV';

if (!(DEV.hosts.includes(conn.host) && String(conn.port) === DEV.port)
    && process.env[OVERRIDE] !== 'i-understand') {
  console.error(
    `REFUSED: this script DELETEs every employee, login, work log and leave ledger row, and\n` +
    `this target is not the dev stack.\n\n` +
    `  target  : ${conn.user}@${conn.host}:${conn.port}/${conn.db}\n` +
    `  expected: host 127.0.0.1|localhost, port ${DEV.port}\n\n` +
    `If you genuinely mean it:  ${OVERRIDE}=i-understand npm run db:seed`);
  process.exit(2);
}

if (!existsSync(SEED_FILE)) {
  console.error(`REFUSED: ${SEED_FILE} not found (run from the repo root)`);
  process.exit(2);
}

/** scrypt, stored as scrypt$N$r$p$salt$hash so the verifier needs no separate parameter store. */
const hashPassword = (plain) => {
  const N = 16384, r = 8, p = 1, keylen = 64;
  const salt = randomBytes(16);
  const dk = scryptSync(plain, salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', N, r, p, salt.toString('base64'), dk.toString('base64')].join('$');
};

const pwHash = hashPassword(DEMO_PASSWORD);

console.log(`seeding ${conn.user}@${conn.host}:${conn.port}/${conn.db}`);

try {
  const out = execFileSync('psql', [
    '-h', conn.host, '-p', String(conn.port), '-U', conn.user, '-d', conn.db,
    '-v', 'ON_ERROR_STOP=1',
    '-v', `pw_hash=${pwHash}`,
    '-q', '-f', SEED_FILE,
  ], {
    encoding: 'utf8',
    env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD ?? 'hrm_dev_only' },
    maxBuffer: 32 * 1024 * 1024,
  });
  console.log(out.trim().split('\n').filter(Boolean).slice(-1)[0] ?? 'done');
} catch (e) {
  console.error('SEED FAILED');
  console.error(e.stderr?.toString() ?? e.message);
  process.exit(1);
}

/*
 * ---------------------------------------------------------------------------
 * The payslip PDFs.
 *
 * A seeded payslip is only demonstrable if its PDF actually exists in MinIO. Without this step
 * the record is there, the figures are there, and opening the document 500s - which is worse than
 * having no seed data at all, because the product looks broken rather than empty.
 *
 * AND THE DIGEST HAS TO BE REWRITTEN. `employee_document_version.sha256_hex` is re-checked on
 * every download and the response is refused when it disagrees, so the placeholder the SQL writes
 * has to be replaced with the digest of the bytes actually uploaded. That refusal is a real
 * control (it catches substituted or corrupted content), so the seed satisfies it rather than
 * working around it.
 *
 * Best-effort: if MinIO is not running the rest of the seed still stands, and the reason is
 * printed rather than swallowed. Everything except the document download works without it.
 * ---------------------------------------------------------------------------
 */
try {
  const { Client } = await import('minio');
  const { createHash } = await import('node:crypto');

  // seed.mjs calls psql inline rather than through a helper, so these are local.
  const psql = (args) => execFileSync('psql', [
    '-h', conn.host, '-p', String(conn.port), '-U', conn.user, '-d', conn.db, ...args,
  ], { encoding: 'utf8', env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD ?? 'hrm_dev_only' } });
  // psql emits CRLF row separators on Windows, so strip the CR or every last field keeps one.
  const query = (sql) => psql(['-tAq', '-c', sql]).split(String.fromCharCode(13)).join('').trim();

  const bucket = process.env.HRM_DOC_BUCKET ?? 'hrm-documents';
  const minio = new Client({
    endPoint: process.env.HRM_MINIO_HOST ?? '127.0.0.1',
    port: Number(process.env.HRM_MINIO_PORT ?? 59000),
    useSSL: false,
    accessKey: process.env.HRM_MINIO_ACCESS_KEY ?? 'hrm_minio',
    secretKey: process.env.HRM_MINIO_SECRET_KEY ?? 'minio_dev_only',
  });

  if (!(await minio.bucketExists(bucket))) await minio.makeBucket(bucket);

  const keys = query(
    `SELECT v.id, v.object_key, e.full_name, e.employee_number, p.period_start,
            p.declared_net_minor
       FROM payslip p
       JOIN employee e ON e.id = p.employee_id
       JOIN employee_document d ON d.id = p.document_id
       JOIN employee_document_version v ON v.id = d.current_version_id
      WHERE v.object_key LIKE 'seed/%'`)
    .split('\n').filter(Boolean).map((l) => l.split('|'));

  let uploaded = 0;
  for (const [verId, key, name, number, period, netMinor] of keys) {
    const rupees = (Number(netMinor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 });
    /*
     * A minimal but structurally valid PDF. Hand-assembled rather than generated by a library:
     * adding a PDF dependency to seed demo data would need its own supply-chain justification
     * (CLAUDE.md), and a real payslip PDF comes from the payroll system anyway - this file stands
     * in for one, and says so on its face so nobody mistakes it for a genuine wage record.
     */
    const text = `ART HRM - SEEDED DEMO PAYSLIP (not a real wage record)`;
    const line2 = `${name} (${number})  period ${period}  net INR ${rupees}`;
    const content = `BT /F1 11 Tf 40 250 Td (${text}) Tj 0 -20 Td (${line2}) Tj ET`;
    const objs = [
      '<</Type/Catalog/Pages 2 0 R>>',
      '<</Type/Pages/Kids[3 0 R]/Count 1>>',
      '<</Type/Page/Parent 2 0 R/MediaBox[0 0 420 300]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>',
      `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
      '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [];
    for (let i = 0; i < objs.length; i += 1) {
      offsets.push(pdf.length);
      pdf += `${i + 1} 0 obj${objs[i]}endobj\n`;
    }
    const xref = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
    pdf += `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;

    const buf = Buffer.from(pdf, 'latin1');
    await minio.putObject(bucket, key, buf, buf.length, { 'Content-Type': 'application/pdf' });

    /*
     * The recorded digest must be the digest of what was actually stored.
     *
     * And writing it needs the immutability rail down: 0018 makes a version's object key, hash
     * and size immutable (check D9), so the first attempt was refused by
     * `fn_document_version_guard` - correctly. A hash can only be known after the bytes exist,
     * and the row has to be inserted before this step runs, so the seed does what it already does
     * six other times in demo.sql: the OWNER disables the rail explicitly, writes, and puts it
     * back. That is the residual power the migration headers concede an owner has, and it is
     * exactly why the application must never connect as the owner.
     */
    const sha = createHash('sha256').update(buf).digest('hex');
    psql(['-q', '-c',
      'ALTER TABLE employee_document_version DISABLE TRIGGER tg_dv_immutable;'
      + ` UPDATE employee_document_version SET sha256_hex = '${sha}', size_bytes = ${buf.length}`
      + ` WHERE id = '${verId}';`
      + ' ALTER TABLE employee_document_version ENABLE ALWAYS TRIGGER tg_dv_immutable;']);
    uploaded += 1;
  }
  console.log(`payslip PDFs uploaded to MinIO: ${uploaded}`);
} catch (e) {
  console.error(`payslip PDFs NOT uploaded: ${e.message}`);
  console.error('  the payslip records are seeded and correct; only the document download needs MinIO.');
}

console.log('\nDemo logins (password for all: ' + DEMO_PASSWORD + ')');
console.log('  vishnu.ravi@panasatech.com    employee  <- follow this one');
console.log('  priya.menon@panasatech.com    manager   <- approves');
console.log('  deepa.suresh@panasatech.com   hr_admin  <- HR dashboard');
console.log('  anu.krishnan@panasatech.com   employee');
console.log('  rahul.nair@panasatech.com     employee');
