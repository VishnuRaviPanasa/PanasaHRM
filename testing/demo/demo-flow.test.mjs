// End-to-end smoke test of the manager demo story, against the running API.
import { execFileSync } from 'node:child_process';

// Re-seed first. The flow submits and approves a timesheet, so a second run would hit its own
// approved period and be refused - which is the period lock working, not a bug. An acceptance
// test has to start from a known state.
console.log('reseeding demo data ...');
execFileSync('node', ['scripts/seed.mjs'], { stdio: ['ignore', 'ignore', 'inherit'] });

const B = 'http://localhost:4000/api';
const jars = {};

async function call(who, path, opts = {}) {
  const res = await fetch(B + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(jars[who] ? { cookie: jars[who] } : {}) },
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length) jars[who] = setCookie.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

const login = (who, email) =>
  call(who, '/auth/login', { method: 'POST', body: JSON.stringify({ email, password: 'panasa2026' }) });

const h = (m) => (m / 60).toFixed(1) + 'h';
let failures = 0;
const expect = (label, actual, wanted) => {
  const ok = String(actual) === String(wanted);
  if (!ok) failures++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}: ${actual}${ok ? '' : `  (expected ${wanted})`}`);
};

await login('v', 'vishnu.ravi@panasatech.com');
await login('p', 'priya.menon@panasatech.com');

console.log('\nSTEP 8  Vishnu logs today\'s work against two projects');
const { projects } = await call('v', '/projects');
const hrm = projects.find((p) => p.code === 'HRM');
const cprt = projects.find((p) => p.code === 'CPRT');
console.log(`  projects visible: ${projects.map((p) => p.code + '(' + p.role + ')').join(', ')}`);

await call('v', '/work-log', {
  method: 'POST',
  body: JSON.stringify({
    projectId: hrm.id, taskId: hrm.tasks[0].id, hours: 4, minutes: 30,
    description: 'Implemented leave approval workflow',
  }),
});
await call('v', '/work-log', {
  method: 'POST',
  body: JSON.stringify({ projectId: cprt.id, hours: 2, description: 'API integration' }),
});
const today = await call('v', '/work-log');
expect('today total minutes', today.totalMinutes, 390);
console.log(`  ${today.entries.length} entries: ${today.entries.map((e) => e.project_code + ' ' + h(e.minutes)).join(', ')}`);

console.log('\nSTEP 9  The weekly timesheet');
let ts = await call('v', '/timesheet');
console.log(`  week ${ts.periodStart} to ${ts.periodEnd}  status=${ts.period.status}  total=${h(ts.totalMinutes)}`);
console.log(`  by project: ${ts.byProject.map((p) => p.code + ' ' + h(p.minutes)).join(', ')}`);

console.log('\nSTEP 10  Submit');
const sub = await call('v', '/timesheet/submit', { method: 'POST', body: JSON.stringify({}) });
expect('submitted status', sub.period.status, 'submitted');

console.log('\nSTEP 11  A submitted period is LOCKED at the database');
try {
  await call('v', '/work-log', {
    method: 'POST',
    body: JSON.stringify({ projectId: hrm.id, hours: 1, description: 'sneaking one in' }),
  });
  console.log('  FAIL a locked period accepted a new entry');
  failures++;
} catch (e) {
  console.log(`  OK   refused: ${String(e.message).split('->')[1]?.trim().slice(0, 110)}`);
}

console.log('\nSTEP 12  Priya approves the timesheet');
const q = await call('p', '/timesheet/approvals');
console.log(`  queue: ${q.periods.map((p) => p.full_name + ' ' + h(p.total_minutes)).join(', ')}`);
const mine = q.periods.find((p) => p.employee_number === 'EMP001');
expect('Vishnu in the queue', !!mine, 'true');
const dec = await call('p', `/timesheet/approvals/${mine.id}/decide`, {
  method: 'POST', body: JSON.stringify({ decision: 'approve' }),
});
expect('timesheet status', dec.period.status, 'approved');

console.log('\nSTEP 13  Manager dashboard - team effort by project');
const eff = await call('p', '/team/effort');
console.log(`  week ${eff.periodStart} to ${eff.periodEnd}`);
const byPerson = {};
for (const r of eff.rows) {
  byPerson[r.full_name] ??= [];
  byPerson[r.full_name].push(`${r.project_name} ${h(r.minutes)}`);
}
for (const [name, list] of Object.entries(byPerson)) console.log(`  ${name.padEnd(14)} ${list.join(' | ')}`);

console.log('\n  Attendance vs work effort - FLAGGED, never corrected (ADR-0015):');
for (const v of eff.attendanceVsEffort.slice(0, 4)) {
  console.log(`  ${v.full_name.padEnd(14)} ${v.business_date}  attendance=${v.attendance_status}` +
              `  logged=${h(v.logged_minutes)}  ->  ${v.variance_flag}`);
}

console.log('\nSTEP 14  Attendance view');
const att = await call('v', '/attendance');
console.log(`  ${att.month}: present=${att.summary.present} late=${att.summary.late} wfh=${att.summary.wfh} ` +
            `absent=${att.summary.absent} week_off=${att.summary.week_off} total=${h(att.summary.total_minutes)}`);
console.log('  ' + att.days.slice(0, 5).map((d) => `${d.business_date} ${d.status}`).join(' | '));

console.log('\nSTEP 15  Employee profile with effective-dated history');
const { employees } = await call('v', '/employees');
const priya = employees.find((e) => e.employee_number === 'EMP002');
const prof = await call('v', `/employees/${priya.id}`);
console.log(`  ${prof.employee.full_name} - ${prof.employee.designation}, ${prof.employee.department}`);
console.log('  assignment history:');
for (const r of prof.history) {
  console.log(`    ${r.valid_from} to ${r.valid_to ?? 'open'}  ${r.designation}  (${r.reason})`);
}
expect('history has two periods', prof.history.length, 2);

console.log(`\n${failures === 0 ? 'ALL DEMO STEPS PASSED' : failures + ' STEP(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
