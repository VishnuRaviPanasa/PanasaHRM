#!/usr/bin/env node
/**
 * ADR-0006 acceptance evidence: N concurrent spend transactions against one leave account must
 * never overdraw.
 *
 *   node testing/db/concurrency/leave-overdraw.test.mjs
 *
 * WHY A SEPARATE HARNESS
 *   `db:verify` runs one psql process inside one rolled-back transaction, so it cannot express a
 *   race at all. Write skew is invisible to a single session by definition: two transactions each
 *   read a balance of 2, each insert -2, neither sees the other, and the inserts do not conflict.
 *   Proving it is prevented requires real concurrent connections.
 *
 * WHY A SCRATCH DATABASE
 *   `leave_ledger` is append-only, so the test cannot clean up after itself. It builds its own
 *   database from the migration chain, runs, and drops it.
 *
 * THE STARTING GUN
 *   Every worker sleeps until a shared wall-clock instant before opening its transaction, so the
 *   contention is real rather than an artefact of process start-up ordering.
 */

import { execFileSync, spawn } from 'node:child_process';

const PG = {
  host: process.env.PGHOST ?? '127.0.0.1',
  port: process.env.PGPORT ?? process.env.HRM_PG_PORT ?? '55432',
  user: process.env.PGUSER ?? 'hrm',
  pass: process.env.PGPASSWORD ?? 'hrm_dev_only',
};
const DB = 'hrm_conc_test';
const WORKERS = 20;

const env = { ...process.env, PGPASSWORD: PG.pass };
const base = (db) => ['-h', PG.host, '-p', String(PG.port), '-U', PG.user, '-d', db,
                      '-v', 'ON_ERROR_STOP=1'];

const psql = (db, sql) =>
  execFileSync('psql', [...base(db), '-tAq', '-c', sql], { encoding: 'utf8', env })
    .split(String.fromCharCode(13)).join('').trim();

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (detail) console.log(`      ${detail}`);
};

/** Fire N concurrent transactions, each attempting one ledger entry. Returns exit codes. */
const race = (sql, startAt) => Promise.all(
  Array.from({ length: WORKERS }, (_, i) => new Promise((resolve) => {
    const body = `
      SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM (TIMESTAMPTZ '${startAt}' - clock_timestamp()))));
      BEGIN;
      ${sql.replace(/\$WORKER/g, String(i))}
      COMMIT;`;
    const p = spawn('psql', [...base(DB), '-tAq', '-c', body], { env });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, err: err.trim() }));
  })),
);

const startGun = (msFromNow = 1500) =>
  psql(DB, `SELECT (clock_timestamp() + INTERVAL '${msFromNow} milliseconds')::text`);

// ---------------------------------------------------------------------------

console.log('\nBuilding scratch database ...');
try { psql('postgres', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); } catch {}
psql('postgres', `CREATE DATABASE ${DB} OWNER ${PG.user}`);
execFileSync('node', ['scripts/migrate.mjs', 'up'],
  { env: { ...env, PGDATABASE: DB }, stdio: 'ignore' });

const CL = psql(DB, `SELECT id FROM leave_type WHERE code = 'CL'`);
const EMP_A = '00000000-0000-0000-0000-00000000000a';
const EMP_B = '00000000-0000-0000-0000-00000000000b';
const EMP_C = '00000000-0000-0000-0000-00000000000c';
const EMP_D = '00000000-0000-0000-0000-00000000000d';
const YEAR = 2026;

const seed = (emp, days, year = YEAR) => psql(DB,
  `INSERT INTO leave_ledger (employee_id, leave_type_id, leave_year, entry_type, days, reason)
   VALUES ('${emp}', '${CL}', ${year}, 'accrual', ${days}, 'test seed')`);

const account = (emp, year = YEAR) => psql(DB,
  `SELECT coalesce((SELECT available::text FROM leave_account
      WHERE employee_id='${emp}' AND leave_type_id='${CL}' AND leave_year=${year}), 'NONE')`);

const holds = (emp, year = YEAR) => Number(psql(DB,
  `SELECT count(*) FROM leave_ledger
    WHERE employee_id='${emp}' AND leave_type_id='${CL}' AND leave_year=${year}
      AND entry_type='hold'`));

const HOLD = (emp, year) => `
  INSERT INTO leave_ledger (employee_id, leave_type_id, leave_year, entry_type, days, reason)
  VALUES ('${emp}', '${CL}', ${year}, 'hold', 2, 'concurrent worker $WORKER');`;

// --- A: 2 days available, 20 workers each want 2 days -----------------------
console.log(`\n=== A: contended account (2 days, ${WORKERS} x 2-day holds) ===`);
seed(EMP_A, 2);
let res = await race(HOLD(EMP_A, YEAR), startGun());
let ok = res.filter((r) => r.code === 0).length;
let overdrawErrors = res.filter((r) => /ck_leave_account_no_overdraw|23514/.test(r.err)).length;
check('A1 exactly one of 20 concurrent 2-day holds succeeded', ok === 1, `succeeded=${ok}`);
check('A2 the balance is exactly 0, never negative', account(EMP_A) === '0.00',
  `available=${account(EMP_A)}`);
check('A3 exactly one hold reached the ledger', holds(EMP_A) === 1, `holds=${holds(EMP_A)}`);
check('A4 the 19 failures were the overdraw CHECK, not deadlocks or crashes',
  overdrawErrors === WORKERS - 1, `overdraw errors=${overdrawErrors}/${WORKERS - 1}`);

// --- B: NO account row exists. FOR UPDATE on a missing row locks nothing. ----
console.log('\n=== B: first-ever request, no account row yet ===');
res = await race(HOLD(EMP_B, YEAR), startGun());
ok = res.filter((r) => r.code === 0).length;
check('B1 no worker overdrew a non-existent account', ok === 0, `succeeded=${ok}`);
// Every worker's transaction aborted on the CHECK, so the account row each of them inserted
// aborted with it. No phantom account is left behind by a failed spend - which is the correct
// outcome and a stronger one than "a row exists at zero".
check('B2 a wholly failed race leaves NO account row behind', account(EMP_B) === 'NONE',
  `available=${account(EMP_B)}`);
check('B3 no hold reached the ledger', holds(EMP_B) === 0, `holds=${holds(EMP_B)}`);

// --- C: new leave year. Same hole, different trigger date. -------------------
console.log('\n=== C: first request of a NEW leave year ===');
seed(EMP_C, 30, YEAR);                        // plenty in 2026
res = await race(HOLD(EMP_C, YEAR + 1), startGun());
ok = res.filter((r) => r.code === 0).length;
check('C1 a full 2026 balance does not fund a 2027 request', ok === 0, `succeeded=${ok}`);
check('C2 no phantom 2027 account is left behind', account(EMP_C, YEAR + 1) === 'NONE',
  `available=${account(EMP_C, YEAR + 1)}`);
check('C3 the 2026 balance is untouched', account(EMP_C, YEAR) === '30.00',
  `available=${account(EMP_C, YEAR)}`);

// --- D: control. The mechanism must not simply block everything. ------------
console.log('\n=== D: control - sufficient balance, all should succeed ===');
seed(EMP_D, 40);
res = await race(HOLD(EMP_D, YEAR), startGun());
ok = res.filter((r) => r.code === 0).length;
check(`D1 all ${WORKERS} holds succeeded when the balance covers them`, ok === WORKERS,
  `succeeded=${ok}`);
check('D2 the balance landed exactly at 0', account(EMP_D) === '0.00',
  `available=${account(EMP_D)}`);
check('D3 every hold is in the ledger', holds(EMP_D) === WORKERS, `holds=${holds(EMP_D)}`);

// --- E: the Rule 6 exception is mechanically enforced -----------------------
console.log('\n=== E: leave_account has exactly one writer (Must-Know Rule 6) ===');
let blocked = false;
try {
  psql(DB, `UPDATE leave_account SET accrued = accrued + 99 WHERE employee_id = '${EMP_A}'`);
} catch (e) { blocked = /Must-Know Rule 6|restrict_violation/.test(String(e.stderr ?? e)); }
check('E1 a direct UPDATE of leave_account is refused', blocked);

let ledgerImmutable = false;
try {
  psql(DB, `UPDATE leave_ledger SET days = 99 WHERE employee_id = '${EMP_A}'`);
} catch (e) { ledgerImmutable = /append-only|restrict_violation/.test(String(e.stderr ?? e)); }
check('E2 the ledger is append-only', ledgerImmutable);

// --- F: the balance reconciles to a pure fold of the ledger -----------------
console.log('\n=== F: the projection equals the ledger fold ===');
const drift = psql(DB, `
  SELECT coalesce(string_agg(x.employee_id::text, ', '), 'none') FROM (
    SELECT a.employee_id
      FROM leave_account a
      JOIN (SELECT employee_id, leave_type_id, leave_year,
                   sum(CASE WHEN entry_type IN ('accrual','carry_in','adjust') THEN days
                            WHEN entry_type = 'hold' THEN -days
                            WHEN entry_type = 'release' THEN days
                            WHEN entry_type IN ('encash','lapse') THEN -days
                            ELSE 0 END) AS folded
              FROM leave_ledger
             GROUP BY 1,2,3) l
        ON l.employee_id = a.employee_id AND l.leave_type_id = a.leave_type_id
       AND l.leave_year = a.leave_year
     WHERE a.available <> l.folded) x`);
check('F1 no account drifted from its ledger fold', drift === 'none', `drifted: ${drift}`);

console.log('\nDropping scratch database ...');
try { psql('postgres', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); } catch (e) {
  console.log('  WARNING: could not drop', DB);
}

console.log(`\n=====================================`);
console.log(`  ${pass} passed, ${fail} failed  (${WORKERS} concurrent workers)`);
console.log(`=====================================\n`);
process.exit(fail === 0 ? 0 : 1);
