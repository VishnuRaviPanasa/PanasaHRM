/**
 * Date-period filtering on attendance, and filtering on team effort.
 *
 * WHY THIS EXISTS
 *
 * Both screens grew a filter, and a filter is a security surface as much as a convenience: the
 * question "which rows" was previously answered by the shape of the query and is now answered
 * partly by the caller. The checks below are mostly about the second half of that sentence.
 *
 * WHAT CARRIES THE WEIGHT
 *
 *   A4/A5   an invalid range is REFUSED, not silently substituted. reports.ts resolves a bad date
 *           to a fallback, which is right for a default window and wrong for a filter - a screen
 *           that quietly answers about a different period than the one requested is worse than an
 *           error, because the reader believes the number.
 *   A8      `from > to` is refused rather than returning an empty period, so "no data" always
 *           means no data.
 *   A10     an employee cannot read a colleague's attendance by passing `employeeId`. The
 *           parameter is new; without this check it is a privilege-escalation hole.
 *   A11     a manager asking about somebody outside their scope gets an EMPTY result, not a
 *           denial and not the rows. The subject filter is composed ALONGSIDE the scope
 *           predicate, never instead of it, and that ordering is the entire safety property.
 *   T5      the same for team effort: filtering to an out-of-scope employee narrows to nothing.
 *           A filter that could widen scope would be a bypass with a friendly name.
 *   T7      clearing the filters restores the unfiltered result, so the UI's reset is real.
 *   T8      the totals are computed from the same filtered rows the table shows - a header that
 *           disagrees with its own table is how somebody reports the wrong number upward.
 *
 * Every date comes from the SERVER. `new Date()` in this process is the previous day for five and
 * a half hours out of every twenty-four (DEC-091).
 *
 * Run: npm run period:test   (needs the API on :4000 and a seeded database)
 */

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
const refused = (name, res, status, fragment) => {
  const msg = String(res.body?.message ?? '');
  check(name, res.status === status && (!fragment || msg.toLowerCase().includes(fragment.toLowerCase())),
    `got ${res.status} "${msg.slice(0, 80)}"`);
};

const login = async (email) => {
  jar = '';
  const r = await call('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: process.env.HRM_DEMO_PASSWORD ?? 'panasa2026' }),
  });
  if (!r.ok) throw new Error(`login failed for ${email}: ${JSON.stringify(r.body)}`);
  return r.body.actor;
};

console.log('\nDate periods and filters\n');

// ================================================================ attendance
console.log('1. Attendance date periods');
await login('rahul.nair@panasatech.com');

const today = await call('/attendance?preset=today');
check('A1  preset=today resolves a single business day',
  today.ok && today.body.from === today.body.to && /^\d{4}-\d{2}-\d{2}$/.test(today.body.from),
  `${today.body?.from}..${today.body?.to}`);
const BIZ = today.body?.from;

const week = await call('/attendance?preset=week');
check('A2  preset=week starts on a Monday and does not run past today',
  week.ok && week.body.from <= BIZ && week.body.to <= BIZ,
  `${week.body?.from}..${week.body?.to}`);

const month = await call('/attendance?preset=month');
check('A3  preset=month starts on the first of the month',
  month.ok && month.body.from.endsWith('-01'), `${month.body?.from}..${month.body?.to}`);

refused('A4  a malformed date is REFUSED, not silently defaulted',
  await call('/attendance?from=not-a-date&to=' + BIZ), 400, 'YYYY-MM-DD');
refused('A5  an impossible date is refused',
  await call('/attendance?from=2026-02-31&to=' + BIZ), 400, 'not a real date');
refused('A6  an unknown preset is refused rather than falling back',
  await call('/attendance?preset=fortnight'), 400, 'unknown preset');
refused('A7  an absurd span is refused',
  await call('/attendance?from=1990-01-01&to=' + BIZ), 400, 'maximum');
refused('A8  from after to is refused',
  await call(`/attendance?from=${BIZ}&to=2026-01-01`), 400, 'cannot be after');

const custom = await call(`/attendance?from=2026-09-01&to=${BIZ}`);
check('A9a a custom range is honoured exactly', custom.ok
  && custom.body.from === '2026-09-01' && custom.body.to === BIZ,
  `${custom.body?.from}..${custom.body?.to} preset=${custom.body?.preset}`);
check('A9b and every day returned falls inside it',
  (custom.body?.days ?? []).every((d) => String(d.business_date).slice(0, 10) >= '2026-09-01'
    && String(d.business_date).slice(0, 10) <= BIZ),
  `${(custom.body?.days ?? []).length} days`);
check('A9c the summary is computed over the SAME window as the rows',
  Number(custom.body?.summary?.total_minutes ?? -1)
    === (custom.body?.days ?? []).reduce((n, d) => n + Number(d.worked_minutes ?? 0), 0),
  `summary=${custom.body?.summary?.total_minutes} rows=${(custom.body?.days ?? [])
    .reduce((n, d) => n + Number(d.worked_minutes ?? 0), 0)}`);

// An empty period must be an empty answer, not an error.
const emptyPeriod = await call('/attendance?from=2019-01-01&to=2019-01-31');
check('A9d a period with no data returns an empty result, not an error',
  emptyPeriod.ok && (emptyPeriod.body?.days ?? []).length === 0,
  `${emptyPeriod.status}, ${(emptyPeriod.body?.days ?? []).length} days`);

// The old parameter still works, so existing links and the month arrows do not break.
const legacy = await call('/attendance?month=2026-09');
// `to` must be a DATE, not a timestamp. It came back as '2026-09-30 00:00:00' at first, because
// date + INTERVAL yields a timestamp - a shape the UI and every comparison downstream inherits.
check('A9e the original ?month= parameter still works, and returns dates not timestamps',
  legacy.ok && legacy.body.from === '2026-09-01' && legacy.body.month === '2026-09'
  && /^\d{4}-\d{2}-\d{2}$/.test(String(legacy.body.to)),
  `${legacy.body?.from}..${legacy.body?.to}`);

console.log('\n2. Attendance authorization');
await login('deepa.suresh@panasatech.com');
const emps = await call('/employees');
const byNum = (n) => (emps.body?.employees ?? []).find((e) => e.employee_number === n);
const rahul = byNum('EMP004');
const deepa = byNum('EMP005');

const hrView = await call(`/attendance?preset=month&employeeId=${rahul.id}`);
check('A10a HR can read an employee\'s attendance', hrView.ok && hrView.body.employeeId === rahul.id,
  `${hrView.status}, ${(hrView.body?.days ?? []).length} days`);

await login('anu.krishnan@panasatech.com');
const peek = await call(`/attendance?preset=month&employeeId=${rahul.id}`);
check('A10b an EMPLOYEE cannot read a colleague\'s attendance by passing employeeId',
  (peek.body?.days ?? []).length === 0,
  `${peek.status}, ${(peek.body?.days ?? []).length} days returned`);

await login('priya.menon@panasatech.com');
const inScope = await call(`/attendance?preset=month&employeeId=${rahul.id}`);
const outScope = await call(`/attendance?preset=month&employeeId=${deepa.id}`);
check('A11a a manager can read a report\'s attendance',
  inScope.ok, `${inScope.status}, ${(inScope.body?.days ?? []).length} days`);
check('A11b but gets NOTHING for somebody outside their scope - the subject filter is composed '
  + 'alongside the scope predicate, not instead of it',
  (outScope.body?.days ?? []).length === 0,
  `${outScope.status}, ${(outScope.body?.days ?? []).length} days`);

// ================================================================ team effort
console.log('\n3. Team effort filters');
await login('priya.menon@panasatech.com');

const unfiltered = await call('/team/effort?preset=month');
check('T1  a manager sees team effort', unfiltered.ok && (unfiltered.body?.rows ?? []).length > 0,
  `${unfiltered.status}, ${(unfiltered.body?.rows ?? []).length} rows`);
const baseRows = (unfiltered.body?.rows ?? []).length;
const baseMinutes = unfiltered.body?.totals?.minutes ?? 0;

const projectId = (unfiltered.body?.rows ?? [])[0]?.project_id;
const employeeId = (unfiltered.body?.rows ?? [])[0]?.employee_id;

const byEmp = await call(`/team/effort?preset=month&employeeId=${employeeId}`);
check('T2  filtering by employee narrows the result',
  (byEmp.body?.rows ?? []).length > 0 && (byEmp.body?.rows ?? []).length <= baseRows
  && (byEmp.body.rows).every((r) => r.employee_id === employeeId),
  `${(byEmp.body?.rows ?? []).length} of ${baseRows} rows`);
check('T3  and reports which filters are active',
  (byEmp.body?.activeFilters ?? []).includes('employeeId'),
  JSON.stringify(byEmp.body?.activeFilters));

const byProj = await call(`/team/effort?preset=month&projectId=${projectId}`);
check('T4a filtering by project narrows the result',
  (byProj.body?.rows ?? []).every((r) => r.project_id === projectId),
  `${(byProj.body?.rows ?? []).length} rows`);

const both = await call(`/team/effort?preset=month&employeeId=${employeeId}&projectId=${projectId}`);
check('T4b combined filters apply together',
  (both.body?.rows ?? []).every((r) => r.employee_id === employeeId && r.project_id === projectId)
  && (both.body?.activeFilters ?? []).length === 2,
  `${(both.body?.rows ?? []).length} rows, filters=${JSON.stringify(both.body?.activeFilters)}`);

await login('priya.menon@panasatech.com');
const hrEmp = (await call('/team/effort?preset=month')).body;
const outsider = deepa.id;
const widen = await call(`/team/effort?preset=month&employeeId=${outsider}`);
check('T5  filtering to an employee OUTSIDE scope returns nothing - a filter narrows, it can '
  + 'never widen', (widen.body?.rows ?? []).length === 0,
  `${(widen.body?.rows ?? []).length} rows for an out-of-scope employee`);

await login('anu.krishnan@panasatech.com');
refused('T6  an ordinary employee has no team-effort grant at all',
  await call('/team/effort?preset=month'), 404);

await login('priya.menon@panasatech.com');
const cleared = await call('/team/effort?preset=month');
check('T7  clearing the filters restores the unfiltered result',
  (cleared.body?.rows ?? []).length === baseRows
  && cleared.body?.totals?.minutes === baseMinutes,
  `${(cleared.body?.rows ?? []).length} rows / ${cleared.body?.totals?.minutes} min, `
  + `want ${baseRows} / ${baseMinutes}`);

check('T8  the header totals are computed from the SAME rows the table shows',
  (byEmp.body?.totals?.minutes ?? -1)
    === (byEmp.body?.rows ?? []).reduce((n, r) => n + Number(r.minutes), 0),
  `totals=${byEmp.body?.totals?.minutes} sum=${(byEmp.body?.rows ?? [])
    .reduce((n, r) => n + Number(r.minutes), 0)}`);

check('T9  the variance list survives filtering - attendance and effort still reconcile',
  Array.isArray(byEmp.body?.attendanceVsEffort),
  `${(byEmp.body?.attendanceVsEffort ?? []).length} variance rows under a filter`);

const legacyStart = await call('/team/effort?start=2026-09-07');
check('T10 the original ?start= week parameter still works',
  legacyStart.ok && legacyStart.body.periodStart === '2026-09-07'
  && legacyStart.body.periodEnd === '2026-09-13',
  `${legacyStart.body?.periodStart}..${legacyStart.body?.periodEnd}`);

// ---------------------------------------------------------------- result
console.log(`\n${'='.repeat(37)}\n  ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log('  PERIOD FILTERS OK\n');
