/**
 * The business date: one authoritative source, and no screen pinned to a literal.
 *
 * WHY THIS EXISTS
 *
 * Five screens opened on a hardcoded date - `'2026-09'`, `'2026-09-08'`, `'2026-08-31'`,
 * `'2026-09-14'`, `'2026-09-07'` - and four more computed their own "today" with
 * `new Date().toISOString().slice(0, 10)`. Neither class of bug produces an error. The first
 * shows a fixed period forever, so by October the attendance screen opens on September; the
 * second returns the UTC date, which between midnight and 05:30 IST is YESTERDAY, so for five and
 * a half hours out of every twenty-four those screens are a day behind.
 *
 * The second was not cosmetic. It set `min` on the effective-from of a department move, so the
 * form permitted a BACK-DATED effective period (Rule 3); it ended a payslip's pay period a day
 * short against 0024's declared-net reconciliation invariant; and it cut the current day out of
 * every default report window.
 *
 * WHAT CARRIES THE WEIGHT
 *
 *   S1/S2  the source scans. These are the only checks that keep the fix from being undone: a
 *          `useState('2026-…')` or a `new Date().toISOString()` added tomorrow compiles, passes
 *          every other suite, and is wrong for months before anybody notices.
 *   B2     `/auth/me` agrees with `fn_business_date()` - the company-timezone function - rather
 *          than with the server's clock or the test runner's.
 *   D1     THE DRIVER BOUNDARY. `db.ts` sets `types.setTypeParser(1082, v => v)` so a DATE
 *          crosses as the string it is. Without it `pg` builds a JS Date at LOCAL midnight and
 *          JSON.stringify emits UTC, so 2026-09-14 leaves the API as
 *          "2026-09-13T18:30:00.000Z" - every date-only value a day early. That was found by the
 *          demo reporting Ganesh Chaturthi on the 13th, and this check is what stops a future
 *          parser change reintroducing it.
 *   P1-P4  each screen's DEFAULT tracks the business date, and an explicit choice still wins.
 *          The two halves matter equally: a screen that ignores the literal but also ignores the
 *          user has just traded one bug for another.
 *
 * Run: npm run bizdate:test   (needs the API on :4000 and a seeded database)
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { globSync } from 'node:fs';

const B = 'http://localhost:4000/api';
let jar = '';

async function call(path, opts = {}) {
  const headers = { ...(jar ? { cookie: jar } : {}), ...(opts.headers ?? {}) };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(B + path, { ...opts, headers });
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) jar = sc.map((c) => c.split(';')[0]).join('; ');
  let body = null;
  try { body = await res.json(); } catch { /* not all responses are JSON */ }
  return { ok: res.ok, status: res.status, body };
}

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  OK   ${name}${detail ? `  — ${detail}` : ''}`); return; }
  fail++; failures.push(`${name}${detail ? `  — ${detail}` : ''}`);
  console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`);
};

const login = async (email) => {
  jar = '';
  const r = await call('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: process.env.HRM_DEMO_PASSWORD ?? 'panasa2026' }),
  });
  if (!r.ok) throw new Error(`login failed for ${email}: ${JSON.stringify(r.body)}`);
  return r.body;
};

console.log('\nThe business date\n');

// ================================================================ 1. source scans
console.log('1. No screen carries its own idea of the date');

/*
 * Comments are stripped first.
 *
 * Every file fixed here EXPLAINS the removed pattern so nobody reinstates it, and the first
 * version of these scans read those explanations as violations - the same trap `nav-shell` and
 * `i18n` both document. A file may discuss a banned pattern; it may not use one.
 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

const files = globSync('apps/web/{app,components,lib}/**/*.{ts,tsx}')
  .filter((f) => !f.includes('node_modules') && !f.includes('.next'));
check('web source files found', files.length > 15, `${files.length} files`);

const literals = [];
const browserToday = [];
for (const f of files) {
  const code = stripComments(readFileSync(f, 'utf8'));
  // A four-digit year in a date-shaped literal, anywhere in live code.
  for (const m of code.matchAll(/['"](\d{4}-\d{2}(?:-\d{2})?)['"]/g)) {
    literals.push(`${f}: '${m[1]}'`);
  }
  if (/new Date\(\)\s*\.\s*toISOString\(\)/.test(code)) browserToday.push(f);
  if (/\btodayIsoFallback\b/.test(code)) browserToday.push(`${f} (todayIsoFallback)`);
}

check('S1  no date literal in live web code', literals.length === 0,
  literals.length ? literals.slice(0, 6).join(' | ') : `${files.length} files clean`);

check('S2  no screen derives "today" from the browser', browserToday.length === 0,
  browserToday.length
    ? `${browserToday.join(', ')} — new Date().toISOString() is the UTC date, a day behind before 05:30 IST`
    : `${files.length} files clean`);

// ================================================================ 2. the driver boundary
console.log('\n2. PostgreSQL DATE crosses the boundary as a string');

const dbSrc = readFileSync('apps/api/src/db.ts', 'utf8');
check('D1a the DATE type parser (oid 1082) is still disabled', /setTypeParser\(1082/.test(dbSrc),
  'without it pg builds a JS Date at LOCAL midnight and JSON emits UTC - every date a day early');
check('D1b and numeric (oid 1700) too, so money never becomes a float',
  /setTypeParser\(1700/.test(dbSrc), 'Rule 4');

await login('deepa.suresh@panasatech.com');
const me = await call('/auth/me');

check('D2  /auth/me returns a DATE-shaped string, not an ISO timestamp',
  /^\d{4}-\d{2}-\d{2}$/.test(String(me.body?.businessDate)),
  `businessDate=${JSON.stringify(me.body?.businessDate)}`);

const BIZ = me.body?.businessDate;

// Every date-only field on the wire must be a plain date. A single "T00:00:00.000Z" here is the
// old bug returning through a different column.
const att = await call(`/attendance?from=${BIZ}&to=${BIZ}`);
const shapes = (att.body?.days ?? []).map((d) => String(d.business_date)).filter((v) => !/^\d{4}-\d{2}-\d{2}$/.test(v));
check('D3  attendance rows carry plain dates', shapes.length === 0,
  shapes.length ? `TIMESTAMP-SHAPED: ${shapes.slice(0, 3).join(', ')}` : `${(att.body?.days ?? []).length} rows`);

// ================================================================ 3. it is the COMPANY's date
console.log('\n3. It comes from the company timezone, not a clock');

/*
 * Asked of the database directly, so this compares the API against `fn_business_date()` itself
 * rather than against anything this process computed. The runner's own clock is deliberately
 * never consulted: it is the thing under suspicion.
 */
let fnDate = null;
try {
  fnDate = execFileSync('docker', [
    'exec', '-i', '-e', 'PGPASSWORD=hrm_dev_only', 'hrm-postgres',
    'psql', '-U', 'hrm', '-d', 'hrm', '-tAc', 'SELECT fn_business_date()::text',
  ], { encoding: 'utf8' }).trim();
} catch { /* no docker in this environment */ }

if (fnDate) {
  check('B2  /auth/me equals fn_business_date()', BIZ === fnDate, `api=${BIZ} db=${fnDate}`);
  const utc = new Date().toISOString().slice(0, 10);
  if (utc !== fnDate) {
    // Only reachable between 00:00 and 05:30 IST - the window the bug lived in.
    check('B3  and it does NOT equal the UTC date right now', BIZ !== utc,
      `business=${BIZ} utc=${utc} - this is the window the old code got wrong`);
  } else {
    console.log(`  INFO B3 the UTC date and the business date agree right now (${utc}); the`
      + ' divergence window is 00:00-05:30 IST, so this cannot be exercised at this hour');
  }
} else {
  check('B2  /auth/me equals fn_business_date()', false,
    'SKIPPED - could not reach the database to compare; a skipped correctness check is a failure');
}

// ================================================================ 4. the screens follow it
console.log('\n4. Every screen defaults to the current period, and honours an explicit one');

const inRange = (from, to, d) => from <= d && d <= to;

const month = await call('/attendance?preset=month');
check('P1a attendance defaults to the month CONTAINING the business date',
  month.ok && inRange(month.body.from, month.body.to, BIZ)
  && month.body.from === `${BIZ.slice(0, 7)}-01`,
  `${month.body?.from}..${month.body?.to} for ${BIZ}`);

const chosen = await call('/attendance?from=2026-01-05&to=2026-01-09');
check('P1b and an explicitly chosen range is preserved, not overridden',
  chosen.body?.from === '2026-01-05' && chosen.body?.to === '2026-01-09',
  `${chosen.body?.from}..${chosen.body?.to}`);

const log = await call('/work-log');
check('P2a the work log defaults to the business date',
  log.ok && log.body?.date === BIZ, `${log.body?.date} vs ${BIZ}`);
const logChosen = await call('/work-log?date=2026-01-07');
check('P2b and an explicit date is preserved', logChosen.body?.date === '2026-01-07',
  String(logChosen.body?.date));

await login('rahul.nair@panasatech.com');
const ts = await call('/timesheet');
check('P3a the timesheet defaults to the week CONTAINING the business date',
  ts.ok && inRange(ts.body.periodStart, ts.body.periodEnd, BIZ),
  `${ts.body?.periodStart}..${ts.body?.periodEnd} for ${BIZ}`);
check('P3b and that week starts on a Monday',
  new Date(`${ts.body?.periodStart}T00:00:00Z`).getUTCDay() === 1,
  `${ts.body?.periodStart} is day ${new Date(`${ts.body?.periodStart}T00:00:00Z`).getUTCDay()}`);
const tsChosen = await call('/timesheet?start=2026-01-05');
check('P3c and an explicit week is preserved', tsChosen.body?.periodStart === '2026-01-05',
  String(tsChosen.body?.periodStart));

await login('priya.menon@panasatech.com');
const team = await call('/team/effort?preset=month');
check('P4a team effort defaults to the month containing the business date',
  team.ok && inRange(team.body.from, team.body.to, BIZ),
  `${team.body?.from}..${team.body?.to} for ${BIZ}`);
const teamChosen = await call('/team/effort?from=2026-01-01&to=2026-01-31');
check('P4b and an explicit range is preserved',
  teamChosen.body?.from === '2026-01-01' && teamChosen.body?.to === '2026-01-31',
  `${teamChosen.body?.from}..${teamChosen.body?.to}`);

// ================================================================ 5. not September 2026
console.log('\n5. Nothing is pinned to September 2026');

/*
 * The literals that were removed all named 2026-08 or 2026-09. This asserts the defaults track
 * the business date rather than that month - so the check stays meaningful after the demo data
 * moves on, and would fail today if somebody restored any of them.
 */
check('N1  the defaults are derived from the business date, not from 2026-09',
  month.body.from.slice(0, 7) === BIZ.slice(0, 7)
  && log.body.date === BIZ
  && inRange(ts.body.periodStart, ts.body.periodEnd, BIZ),
  `business month ${BIZ.slice(0, 7)}; attendance ${month.body.from.slice(0, 7)}, `
  + `work ${log.body.date}, timesheet ${ts.body.periodStart}`);

// ---------------------------------------------------------------- result
console.log(`\n${'='.repeat(37)}\n  ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log('  BUSINESS DATE OK\n');
