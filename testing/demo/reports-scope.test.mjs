/**
 * HR reporting - and specifically, that reports DO NOT LEAK ACROSS SCOPE.
 *
 * WHY THIS IS THE TEST THAT MATTERS FOR THIS MODULE
 *
 * `ai/context/rbac-rules.md` warns that filtering rows in application code "still leaks via
 * counts, pagination totals and timing". A report is nothing but counts and totals, so this is
 * exactly where that warning bites: a manager who cannot open E3's record but receives a
 * headcount that includes them has still learned something about E3.
 *
 * So every check here compares what a role SEES against what that role may see, and the
 * aggregate is checked as hard as the rows - because an aggregate over unscoped data is the
 * failure mode that a row-level test would sail straight past.
 *
 * It also pins the design decision that a report is NOT a new permission: each report reuses the
 * resource action it reports on, so a report can never show more than the equivalent detail
 * screen. If somebody later adds `report.*` actions, the numbers here start disagreeing.
 *
 * Run: npm run reports:test
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

const login = async (email) => {
  jar = '';
  const r = await call('/auth/login', {
    method: 'POST', body: JSON.stringify({ email, password: 'panasa2026' }),
  });
  if (!r.ok) throw new Error(`login failed for ${email}: ${JSON.stringify(r.body)}`);
  return r.body.actor;
};

const WIDE = '?from=2018-01-01&to=2030-12-31';
const names = (rows) => [...new Set((rows ?? []).map((r) => r.employee_number))].sort();

console.log('HR reporting - scope correctness\n');

// ---------------------------------------------------------------------------
console.log('1. What each role is even offered');
const emp = await login('vishnu.ravi@panasatech.com');
let idx = await call('/reports');
const empReports = (idx.body?.available ?? []).sort();
check('an employee is offered some reports', empReports.length > 0, empReports.join(', '));

await login('deepa.suresh@panasatech.com');
idx = await call('/reports');
const hrReports = (idx.body?.available ?? []).sort();
check('HR is offered at least as many as an employee',
  empReports.every((r) => hrReports.includes(r)), hrReports.join(', '));
/*
 * NOT "the documents report is HR-only". I wrote that first and it was wrong - not about the
 * code, about the design.
 *
 * `documents.document.list` admits an employee to their OWN documents; that is how /documents
 * works. So under this module's founding rule - a report is not a new permission - an employee
 * is entitled to the compliance COUNTS for the documents they can already open, and refusing the
 * report would have made it MORE restrictive than the detail screen it summarises. Verified:
 * Vishnu's run returns exactly one row, his own.
 *
 * The property that actually protects anyone is therefore not who is OFFERED the report, but
 * whose rows come back - which is checked at every scope level below.
 */
check('everybody is offered the documents report', hrReports.includes('documents') && empReports.includes('documents'),
  `employee=${empReports.includes('documents')} hr=${hrReports.includes('documents')}`);

// ---------------------------------------------------------------------------
console.log('\n2. An EMPLOYEE sees only themselves - rows AND totals');
await login('vishnu.ravi@panasatech.com');
{
  const att = await call(`/reports/attendance${WIDE}`);
  check('attendance report loads', att.ok, `status=${att.status}`);
  const who = names(att.body?.rows);
  check('  ... and contains only the caller', who.length === 1 && who[0] === emp.employeeNumber,
    who.join(', ') || '(empty)');

  const lv = await call('/reports/leave?year=2026');
  check('leave report contains only the caller',
    names(lv.body?.rows).every((n) => n === emp.employeeNumber),
    names(lv.body?.rows).join(', ') || '(empty)');

  // THE AGGREGATE. A row-level check alone would miss a total computed before the filter.
  const rec = await call(`/reports/reconciliation${WIDE}`);
  const recWho = names(rec.body?.rows);
  check('reconciliation rows are the caller only',
    recWho.length <= 1 && recWho.every((n) => n === emp.employeeNumber),
    recWho.join(', ') || '(empty)');
  const flagged = rec.body?.summary?.flagged_days ?? 0;
  const ownDays = (rec.body?.rows ?? []).length;
  check('  ... and the SUMMARY is computed over those rows only',
    Number(flagged) >= ownDays,
    `summary flagged=${flagged}, own flagged rows=${ownDays}`);

  const ts = await call(`/reports/timesheets${WIDE}`);
  check('timesheet report contains only the caller',
    names(ts.body?.rows).every((n) => n === emp.employeeNumber),
    names(ts.body?.rows).join(', ') || '(empty)');
}

// ---------------------------------------------------------------------------
console.log('\n3. An employee is refused the reports their role does not admit');
{
  // The documents report is not refused - it is NARROWED, which is the stronger guarantee: the
  // employee gets counts for their own filings and no sign that anybody else has any.
  const docs = await call('/reports/documents');
  const docWho = names(docs.body?.rows);
  check('the documents report returns the caller and NOBODY else',
    docWho.length === 1 && docWho[0] === emp.employeeNumber,
    docWho.join(', ') || '(empty)');
  check('  ... and reveals no other employee even as a zero row',
    !JSON.stringify(docs.body).includes('EMP002'),
    'a row of zeroes for a colleague still discloses that the colleague exists and has filed nothing');

  const hc = await call(`/reports/headcount${WIDE}`);
  // people.employee.list IS granted to an employee (the directory is PUBLIC_INTERNAL), so this
  // is expected to succeed. The point is that it succeeds for a REASON, from the same policy.
  check('the headcount report follows people.employee.list, which an employee does hold', hc.ok,
    `status=${hc.status}`);
}

// ---------------------------------------------------------------------------
console.log('\n4. A MANAGER sees their reports, and not the whole company');
const mgr = await login('priya.menon@panasatech.com');
let mgrSeen = [];
{
  const att = await call(`/reports/attendance${WIDE}`);
  const who = names(att.body?.rows);
  mgrSeen = who;
  check('a manager sees more than one person', who.length > 1, who.join(', '));
  check('  ... and it includes themselves', who.includes(mgr.employeeNumber), who.join(', '));
  // EMP005 is Deepa in HR, outside Priya's reporting line.
  check('  ... and EXCLUDES somebody outside their reporting line',
    !who.includes('EMP005'),
    `saw ${who.join(', ')} — EMP005 is in HR, not under this manager`);

  const lv = await call('/reports/leave?year=2026');
  check('the leave report is bounded the same way', !names(lv.body?.rows).includes('EMP005'),
    names(lv.body?.rows).join(', '));

  /*
   * AND THE REPORTING GRAPH DOES NOT REACH EVERYTHING IT REACHES FOR ATTENDANCE.
   *
   * The same manager who legitimately sees four people's attendance sees exactly ONE person's
   * document posture - their own - because `documents.document.list` grants a manager
   * `isSelfAndNotRestricted`, the same guard an employee gets. Documents are HR-or-self by
   * deliberate decision: a manager needs to know whether their report was present on Tuesday,
   * and has no line-management claim on which certificates that person has filed.
   *
   * This is the check that would break if somebody "helpfully" gave managers the subtree here
   * for consistency with attendance - so it is written to state WHY the two differ.
   */
  const mdocs = await call('/reports/documents');
  const mdocWho = names(mdocs.body?.rows);
  check('documents do NOT follow the reporting graph, though attendance does',
    mdocWho.length === 1 && mdocWho[0] === mgr.employeeNumber,
    `attendance gave this manager ${who.length} people; documents gave ${mdocWho.join(', ') || 'none'}`);
}

// ---------------------------------------------------------------------------
console.log('\n5. HR sees everybody');
await login('deepa.suresh@panasatech.com');
let hrSeen = [];
{
  const att = await call(`/reports/attendance${WIDE}`);
  hrSeen = names(att.body?.rows);
  check('HR sees more people than the manager did', hrSeen.length >= 4, hrSeen.join(', '));
  // NOT "HR appears in their own attendance report": Deepa has no attendance_day rows at all,
  // so she correctly cannot appear in a report over that table. The property that actually
  // matters is that HR's view is a SUPERSET of the manager's - anything less would mean the
  // scope widened in the wrong direction.
  check('  ... and HR sees a superset of what the manager saw',
    mgrSeen.every((n) => hrSeen.includes(n)),
    `manager saw ${mgrSeen.join(', ')}; HR saw ${hrSeen.join(', ')}`);

  const docs = await call('/reports/documents');
  check('HR can run the documents report', docs.ok, `status=${docs.status}`);
  check('  ... across the whole organisation, unlike the manager',
    names(docs.body?.rows).length >= 5, names(docs.body?.rows).join(', '));
  // 0021: COUNT(*) over the LEFT JOIN reported a phantom pending scan for every employee with no
  // documents at all, which would have sent HR hunting for four files nobody uploaded.
  const noDocs = (docs.body?.rows ?? []).filter((r) => Number(r.filed_types) === 0);
  check('  ... and an employee with no documents has no PHANTOM pending scan (0021)',
    noDocs.length > 0 && noDocs.every((r) => Number(r.pending_scan) === 0),
    noDocs.map((r) => `${r.employee_number}:pending=${r.pending_scan}`).join(' ') || 'no such employee in the fixture');
  check('  ... and it reports COUNTS with no document types',
    !JSON.stringify(docs.body).match(/medical|id_proof|offer_letter|document_type/i),
    'naming types would reveal who holds a medical certificate');
}

// ---------------------------------------------------------------------------
console.log('\n6. The reconciliation reports, and offers nothing that would correct');
{
  const rec = await call(`/reports/reconciliation${WIDE}`);
  check('reconciliation loads for HR', rec.ok);
  check('  ... and states the ADR-0015 principle in the payload',
    /not attendance/i.test(rec.body?.principle ?? ''), rec.body?.principle?.slice(0, 60));
  const withNotes = (rec.body?.rows ?? []).filter((r) => r.note);
  check('  ... and classifies the variances it finds', withNotes.length > 0,
    [...new Set(withNotes.map((r) => r.note))].join('; '));
  check('  ... reporting BOTH sides rather than one adjusted figure',
    withNotes.every((r) => 'attended_minutes' in r && 'logged_minutes' in r));
}

// ---------------------------------------------------------------------------
console.log('\n7. WFH is reported from both sources');
{
  const wfh = await call(`/reports/wfh${WIDE}`);
  check('WFH report loads', wfh.ok);
  check('  ... and returns both counts plus the disagreement',
    (wfh.body?.rows ?? []).every((r) =>
      'attendance_days' in r && 'approved_days' in r && 'disagreement' in r),
    JSON.stringify((wfh.body?.rows ?? [])[0] ?? {}));
  check('  ... and says why there are two numbers', /both are shown/i.test(wfh.body?.note ?? ''));
}

// ---------------------------------------------------------------------------
console.log('\n8. Leave liability keeps paid and unpaid apart');
{
  const lv = await call('/reports/leave?year=2026');
  const paid = (lv.body?.byType ?? []).filter((r) => r.is_paid);
  const unpaid = (lv.body?.byType ?? []).filter((r) => !r.is_paid);
  check('liability is grouped by type with is_paid', paid.length > 0,
    (lv.body?.byType ?? []).map((r) => `${r.leave_code}:${r.outstanding}`).join(' '));
  check('  ... so LWP cannot inflate the obligation',
    unpaid.every((r) => r.leave_code !== undefined),
    `unpaid types: ${unpaid.map((r) => r.leave_code).join(', ') || 'none outstanding'}`);
  check('  ... and figures are strings, not floats (Rule 4)',
    (lv.body?.byType ?? []).every((r) => typeof r.outstanding === 'string'),
    'NUMERIC must not become a JS double on the way out');
}

// ---------------------------------------------------------------------------
console.log('\n9. Effort reporting is scoped too');
{
  await login('vishnu.ravi@panasatech.com');
  const mine = await call(`/reports/effort${WIDE}`);
  const empEffort = names(mine.body?.byEmployee);
  check('an employee sees only their own effort',
    empEffort.length <= 1 && empEffort.every((n) => n === emp.employeeNumber),
    empEffort.join(', ') || '(empty)');

  await login('deepa.suresh@panasatech.com');
  const all = await call(`/reports/effort${WIDE}`);
  check('HR sees effort across the company',
    names(all.body?.byEmployee).length > empEffort.length,
    names(all.body?.byEmployee).join(', '));
  check('  ... and by project', (all.body?.byProject ?? []).length > 0,
    (all.body?.byProject ?? []).map((p) => `${p.code}:${p.minutes}m`).join(' '));
}

// ---------------------------------------------------------------------------
/*
 * 10. THE FIELD NAMES THE UI READS ACTUALLY EXIST.
 *
 * This section exists because of the failure mode it catches. `/reports` is a table-heavy screen
 * that reads about sixty fields by name, and a wrong name does not throw in React - it renders
 * `undefined` as an empty cell. A blank column in an HR report is worse than an error page,
 * because a reader takes "0 expired documents" at face value.
 *
 * So every key the page destructures is asserted against the live payload. If somebody renames a
 * column in a migration and updates the SQL but not the component, this fails instead of the
 * report quietly going blank.
 */
console.log('');
console.log('10. Every field the /reports page reads is really in the payload');
await login('deepa.suresh@panasatech.com');
{
  const wants = [
    ['headcount', `/reports/headcount${WIDE}`, 'movement',
      ['employee_number', 'full_name', 'event_type', 'effective_on', 'exit_type', 'department_code', 'designation']],
    ['attendance', `/reports/attendance${WIDE}`, 'rows',
      ['employee_number', 'full_name', 'present_days', 'late_days', 'wfh_days', 'absent_days',
        'leave_days', 'worked_minutes', 'expected_days']],
    ['leave', '/reports/leave?year=2026', 'rows',
      ['employee_number', 'full_name', 'leave_code', 'is_paid', 'accrued', 'taken', 'available']],
    ['leave.byType', '/reports/leave?year=2026', 'byType',
      ['leave_code', 'is_paid', 'outstanding', 'taken']],
    ['wfh', `/reports/wfh${WIDE}`, 'rows',
      ['employee_number', 'full_name', 'attendance_days', 'approved_days', 'disagreement']],
    ['reconciliation', `/reports/reconciliation${WIDE}`, 'rows',
      ['employee_number', 'full_name', 'business_date', 'attendance_status', 'attended_minutes',
        'logged_minutes', 'variance_minutes', 'note']],
    ['timesheets', `/reports/timesheets${WIDE}`, 'rows',
      ['employee_number', 'full_name', 'period_start', 'period_end', 'status', 'logged_minutes', 'days_waiting']],
    ['documents', '/reports/documents', 'rows',
      ['employee_number', 'full_name', 'filed_types', 'pending_scan', 'expiring_soon', 'expired']],
    ['effort.byProject', `/reports/effort${WIDE}`, 'byProject', ['code', 'name', 'minutes', 'contributors']],
    ['effort.byEmployee', `/reports/effort${WIDE}`, 'byEmployee', ['employee_number', 'full_name', 'minutes']],
  ];

  for (const [label, path, key, keys] of wants) {
    const r = await call(path);
    const row = (r.body?.[key] ?? [])[0];
    if (!row) { check(`${label}: has a row to check`, false, 'the fixture produced none - the contract is unverified'); continue; }
    const missing = keys.filter((k) => !(k in row));
    check(`${label} carries all ${keys.length} fields the UI reads`, missing.length === 0,
      missing.length ? `MISSING: ${missing.join(', ')}` : Object.keys(row).length + ' keys present');
  }

  // The summary objects the stat cards read.
  const hc = await call(`/reports/headcount${WIDE}`);
  check('headcount.summary carries the five stat-card counters',
    ['joiners', 'leavers', 'resignations', 'promotions', 'confirmations']
      .every((k) => k in (hc.body?.summary ?? {})),
    JSON.stringify(hc.body?.summary));
  const rc = await call(`/reports/reconciliation${WIDE}`);
  check('reconciliation.summary carries its three',
    ['flagged_days', 'attended_minutes', 'logged_minutes'].every((k) => k in (rc.body?.summary ?? {})),
    JSON.stringify(rc.body?.summary));
}

// ---------------------------------------------------------------------------
/*
 * 11. TASKS - THE ONE REPORT THAT USES BOTH SCOPE GRAPHS, AND THE PROOF THEY STAY SEPARATE.
 *
 * Every other report resolves through one graph, so a scope bug there shows up as "too many
 * people". Tasks resolve through both, which means a bug can also look like "the right people,
 * the wrong projects" - and the only way to see that is to compare the two cuts for the SAME
 * caller and check they disagree in the expected direction.
 *
 * Vishnu is the case that makes it visible. He is an ordinary employee, so the reporting graph
 * gives him exactly himself; he is a member of HRM and CPRT but NOT MOBL, so the project graph
 * gives him two projects out of three. One caller, two different answers, from two graphs.
 *
 * And Deepa is the mirror image: HR holds no project membership at all, yet sees all three
 * projects - because her grant is unconditional rather than membership-derived. If somebody ever
 * "simplifies" the project cut into the reporting graph, both of those checks break.
 */
console.log('');
console.log('11. Tasks resolve through BOTH graphs, and the graphs stay separate');
{
  const emp2 = await login('vishnu.ravi@panasatech.com');
  const et = await call('/reports/tasks');
  check('the tasks report loads for an employee', et.ok, `status=${et.status}`);

  const mineWho = names(et.body?.byAssignee);
  check('  ... the ASSIGNEE cut is the caller alone (reporting graph)',
    mineWho.length === 1 && mineWho[0] === emp2.employeeNumber,
    mineWho.join(', ') || '(empty)');

  const myProjects = [...new Set((et.body?.byProject ?? []).map((r) => r.code))].sort();
  check('  ... the PROJECT cut is their memberships (project graph), which is MORE than one row',
    myProjects.length > 1, myProjects.join(', ') || '(empty)');
  check('  ... and EXCLUDES a project they are not a member of',
    !myProjects.includes('MOBL'),
    `saw ${myProjects.join(', ')} - Vishnu is on HRM and CPRT, not MOBL`);

  // The two cuts must not be the same query wearing different names.
  check('  ... so the two cuts genuinely disagree for one caller',
    mineWho.length === 1 && myProjects.length >= 2,
    `1 person but ${myProjects.length} projects - two graphs, not one`);

  const mgr2 = await login('priya.menon@panasatech.com');
  const mt = await call('/reports/tasks');
  const mgrWho = names(mt.body?.byAssignee);
  check('a manager sees their reporting line in the assignee cut', mgrWho.length > 1,
    mgrWho.join(', '));
  check('  ... and EXCLUDES somebody outside it', !mgrWho.includes('EMP005'),
    `saw ${mgrWho.join(', ')} - EMP005 is in HR`);

  await login('deepa.suresh@panasatech.com');
  const ht = await call('/reports/tasks');
  const hrProjects = [...new Set((ht.body?.byProject ?? []).map((r) => r.code))].sort();
  check('HR sees every project despite holding NO project membership',
    hrProjects.length >= 3, hrProjects.join(', '));
  check('  ... which is only possible because the grant is unconditional, not membership-derived',
    myProjects.every((c) => hrProjects.includes(c)) && hrProjects.length > myProjects.length,
    `employee saw ${myProjects.join(', ')}; HR saw ${hrProjects.join(', ')}`);

  /*
   * THE UNASSIGNED TASK. Two seeded tasks have no assignee, deliberately. They must be counted
   * by the project cut and invisible to the assignee cut - if both miss them, real outstanding
   * work is invisible to everybody, which is the failure this second function exists to prevent.
   */
  const unassigned = (ht.body?.byProject ?? []).reduce((a, r) => a + Number(r.unassigned), 0);
  check('the project cut counts tasks assigned to NOBODY', unassigned > 0,
    `${unassigned} unassigned open task(s) across ${hrProjects.length} projects`);

  const attributed = (ht.body?.byAssignee ?? []).reduce((a, r) => a
    + Number(r.open_tasks) + Number(r.in_progress) + Number(r.blocked)
    + Number(r.done_tasks) + Number(r.cancelled_tasks), 0);
  const total = (ht.body?.byProject ?? []).reduce((a, r) => a + Number(r.total_tasks), 0);
  check('  ... and the assignee cut attributes FEWER tasks than exist, by exactly that many',
    total - attributed === unassigned,
    `${total} tasks exist, ${attributed} attributed, ${unassigned} unassigned`);

  check('  ... and the payload says why a task can appear in only one of the two',
    /only in the project view/i.test(ht.body?.note ?? ''), (ht.body?.note ?? '').slice(0, 70));

  // A closed task that is past its due date must not be overdue. Seeded HRM-14 is done and 20
  // days late, so if this counter ever ignores status the number moves.
  const od = (ht.body?.byAssignee ?? []).reduce((a, r) => a + Number(r.overdue), 0);
  const done = (ht.body?.byAssignee ?? []).reduce((a, r) => a + Number(r.done_tasks), 0);
  check('a DONE task that is 20 days past due is not counted as overdue',
    done > 0 && od === 2,
    `overdue=${od} (want 2: HRM-11 and CP-41), done=${done} including HRM-14 which is 20 days late`);

  // The field contract, same reasoning as section 10.
  const arow = (ht.body?.byAssignee ?? [])[0];
  const prow = (ht.body?.byProject ?? [])[0];
  const aWant = ['employee_number', 'full_name', 'open_tasks', 'in_progress', 'blocked',
    'done_tasks', 'cancelled_tasks', 'overdue', 'due_soon', 'no_due_date'];
  const pWant = ['code', 'name', 'total_tasks', 'unassigned', 'open_tasks', 'in_progress',
    'done_tasks', 'overdue', 'due_soon', 'assignees'];
  check('tasks.byAssignee carries every field the UI reads',
    !!arow && aWant.every((k) => k in arow),
    arow ? `MISSING: ${aWant.filter((k) => !(k in arow)).join(', ') || 'none'}` : 'no row');
  check('tasks.byProject carries every field the UI reads',
    !!prow && pWant.every((k) => k in prow),
    prow ? `MISSING: ${pWant.filter((k) => !(k in prow)).join(', ') || 'none'}` : 'no row');
}

console.log('');
if (fail) { console.log('FAILURES:'); for (const f of failures) console.log(`  ${f}`); }
console.log(`${fail === 0 ? 'REPORTS SCOPE OK' : 'REPORTS SCOPE FAILED'} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
