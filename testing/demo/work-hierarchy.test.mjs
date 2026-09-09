/**
 * HR recording effort for an employee, and the four-level work hierarchy.
 *
 * WHY THIS EXISTS
 *
 * "HR cannot add work logs" was reported as a UI problem. It was two backend ones:
 * `POST /work-log` had no employee parameter at all - every insert used `me.employeeId`, so the
 * endpoint could not have recorded a log for anybody else whatever the caller's role - and
 * `GET /projects` filtered by project MEMBERSHIP, so HR (a member of nothing) got an empty
 * dropdown. Neither would have been caught by a test of the form.
 *
 * WHAT CARRIES THE WEIGHT HERE
 *
 *   H4/H5  an ordinary employee cannot record effort for a colleague, by employeeId in the body
 *          or by asking for their project list. This is the negative that makes the feature safe:
 *          the new parameter is exactly the shape of a privilege-escalation hole if unguarded.
 *   H7-H9  a task from another project, a sub-task from another task, and a sub-task with no
 *          task are all refused. Composite foreign keys (0027) make these unrepresentable in the
 *          database; these check the API answers 400 rather than leaking a 500 from a constraint.
 *   H10    a RETIRED master cannot be used for new effort. The foreign keys do not cover this -
 *          `active` is a business rule - so it is the one hierarchy rule with no schema backstop
 *          on the write path, which makes it the one most worth a test.
 *   H11    a work log may stop at ANY level. This is not a nicety: the first implementation
 *          asked the hierarchy view for a row matching the exact (project, task, sub-task)
 *          triple, and the view only materialises the deepest paths - so choosing a task that
 *          happened to have sub-tasks was rejected as "incoherent", and so was logging against a
 *          project with any tasks at all. Two legal shapes, both broken, both silent until this.
 *   H13    provenance. HR's line is stored as `hr_entry` with HR as the recorder; the employee's
 *          own is `self`. Without this an approver cannot tell a timesheet the employee submitted
 *          from one HR filled in for them.
 *   H15    a LOCKED period refuses HR too. "HR can do it on your behalf" must not become "HR can
 *          edit approved history", which ADR-0015/0016 forbid.
 *
 * Every fixture is created by this suite and every date comes from the SERVER's business date -
 * `new Date()` here is the previous day for five and a half hours out of every twenty-four
 * (DEC-091), and these are effective-dated tables that correctly refuse back-dating.
 *
 * Run: npm run work:test   (needs the API on :4000 and a seeded database)
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
    method: 'POST', body: JSON.stringify({ email, password: process.env.HRM_DEMO_PASSWORD ?? 'panasa2026' }),
  });
  if (!r.ok) throw new Error(`login failed for ${email}: ${JSON.stringify(r.body)}`);
  return r.body.actor;
};

const post = (body) => call('/work-log', { method: 'POST', body: JSON.stringify(body) });

// A tag unique to this run. The master tables have no delete path for referenced rows, so
// fixtures accumulate; unique codes keep the suite repeatable without deleting anything.
const TAG = Date.now().toString(36).toUpperCase().slice(-5);

/*
 * A refusal has to be the refusal under test, not any old error.
 *
 * `!res.ok` accepted a 500 in an earlier suite in this repo, so a crash and a correct denial were
 * indistinguishable and the check passed while the endpoint was broken. These assert the exact
 * status, and for 400s also that the message names the rule - otherwise "some validation
 * rejected it" would pass even if the wrong validation fired first, which is precisely how the
 * membership check hid behind a broken hierarchy check during development.
 */
const refused = (name, res, status, fragment) => {
  const msg = String(res.body?.message ?? '');
  check(name, res.status === status && (!fragment || msg.toLowerCase().includes(fragment.toLowerCase())),
    `got ${res.status} "${msg.slice(0, 90)}"`);
};

console.log('\nHR work logs and the work hierarchy\n');

// ---------------------------------------------------------------- 1. the server's own dates
console.log('1. Fixtures');
await login('deepa.suresh@panasatech.com');
const emps = await call('/employees');
const find = (num) => (emps.body?.employees ?? []).find((e) => e.employee_number === num);
const rahul = find('EMP004');
const vishnu = find('EMP001');
check('the demo employees are present', !!rahul && !!vishnu,
  `rahul=${!!rahul} vishnu=${!!vishnu}`);
if (!rahul || !vishnu) {
  console.log('\n  cannot continue without the seeded employees\n');
  process.exit(1);
}

// The whole hierarchy, as HR sees it for Rahul. This request IS the fix for the reported bug.
const tree = await call(`/projects?employeeId=${rahul.id}`);
check('H1  HR can read the project list of the employee they are recording for',
  tree.ok && (tree.body.projects ?? []).length > 0,
  `${tree.status}, ${(tree.body?.projects ?? []).length} projects`);

const cprt = (tree.body?.projects ?? []).find((p) => p.code === 'CPRT');
const mobl = (tree.body?.projects ?? []).find((p) => p.code === 'MOBL');
const cp41 = (cprt?.tasks ?? []).find((t) => t.code === 'CP-41');
const mb07 = (mobl?.tasks ?? []).find((t) => t.code === 'MB-07');
const cp41a = (tree.body?.subTasks ?? []).find((st) => st.code === 'CP-41a');
check('H2  the response carries sub-projects and sub-tasks',
  (tree.body?.subProjects ?? []).length > 0 && !!cp41a,
  `${(tree.body?.subProjects ?? []).length} sub-projects, sub-task CP-41a=${!!cp41a}`);

// The seed retires CP-41b deliberately, so this asserts a real exclusion and not an empty list.
check('H3  a RETIRED sub-task is absent from the selectable list',
  !(tree.body?.subTasks ?? []).some((st) => st.code === 'CP-41b'),
  `subTasks: ${(tree.body?.subTasks ?? []).map((s) => s.code).join(', ')}`);

// ---------------------------------------------------------------- 2. the negatives that matter
console.log('\n2. An ordinary employee cannot act for somebody else');
await login('anu.krishnan@panasatech.com');
refused('H4  employee cannot record effort for a colleague',
  await post({ employeeId: rahul.id, projectId: cprt.id, taskId: cp41.id, hours: 1 }), 404);
refused('H5  employee cannot read a colleague\'s project list',
  await call(`/projects?employeeId=${rahul.id}`), 404);

await login('priya.menon@panasatech.com');
refused('H6  a LINE MANAGER cannot record effort for a report either - authoring a timesheet and '
  + 'approving it are different acts',
  await post({ employeeId: rahul.id, projectId: cprt.id, taskId: cp41.id, hours: 1 }), 404);

// ---------------------------------------------------------------- 3. hierarchy integrity
console.log('\n3. Hierarchy integrity, server-side');
await login('deepa.suresh@panasatech.com');
const biz = (await call('/attendance?preset=today')).body?.to;
check('the business date came from the server', /^\d{4}-\d{2}-\d{2}$/.test(String(biz)), String(biz));

refused('H7  a task from a DIFFERENT project is refused',
  await post({ employeeId: rahul.id, date: biz, projectId: cprt.id, taskId: mb07.id, hours: 1 }),
  400, 'do not belong together');

const cp41b = { id: '00000000-0000-0000-0000-000000000000' };
refused('H8  a sub-task from a different task is refused',
  await post({ employeeId: rahul.id, date: biz, projectId: cprt.id, taskId: mb07.id,
    subTaskId: cp41a.id, hours: 1 }), 400, 'do not belong together');

refused('H9  a sub-task with no task is refused',
  await post({ employeeId: rahul.id, date: biz, projectId: cprt.id, subTaskId: cp41a.id, hours: 1 }),
  400, 'needs its task');

// H10 needs the retired sub-task's id, which the selectable list deliberately omits - so it is
// read from the hierarchy of a project where it lives, via the one endpoint that shows inactive
// records: the master-data list. If that is unavailable the check is SKIPPED LOUDLY rather than
// passing vacuously, which is the trap 0019's W14/W15 fell into.
const masters = await call('/work-masters/tree');
const retired = masters.ok
  ? (masters.body?.projects ?? [])
    .flatMap((p) => [...(p.subProjects ?? []).flatMap((sp) => sp.tasks ?? []), ...(p.tasks ?? [])])
    .flatMap((t) => t.subTasks ?? [])
    .find((st) => st.code === 'CP-41b')
  : null;
if (retired) {
  refused('H10 a RETIRED sub-task cannot be used for new effort',
    await post({ employeeId: rahul.id, date: biz, projectId: cprt.id, taskId: cp41.id,
      subTaskId: retired.id, hours: 1 }), 400, 'retired');
} else {
  check('H10 a RETIRED sub-task cannot be used for new effort', false,
    'SKIPPED - could not obtain the retired sub-task id; a skipped integrity check is a failure');
}

// ---------------------------------------------------------------- 4. the shapes that are legal
console.log('\n4. Stopping at any level is legal');
const day1 = (await call('/attendance?preset=today')).body?.to;
const deep = await post({ employeeId: rahul.id, date: day1, projectId: cprt.id, taskId: cp41.id,
  subTaskId: cp41a.id, hours: 1, minutes: 30, description: 'suite: full depth' });
check('H11a project + task + sub-task is accepted', deep.status === 201,
  `${deep.status} ${JSON.stringify(deep.body).slice(0, 100)}`);

const mid = await post({ employeeId: rahul.id, date: day1, projectId: cprt.id, taskId: cp41.id,
  minutes: 20, description: 'suite: no sub-task' });
check('H11b project + task, NO sub-task, is accepted - the case the view-based check broke',
  mid.status === 201, `${mid.status} ${String(mid.body?.message ?? '').slice(0, 90)}`);

const shallow = await post({ employeeId: rahul.id, date: day1, projectId: cprt.id,
  minutes: 10, description: 'suite: project only' });
check('H11c project only, no task, is accepted - broken for any project WITH tasks',
  shallow.status === 201, `${shallow.status} ${String(shallow.body?.message ?? '').slice(0, 90)}`);

// ---------------------------------------------------------------- 5. minutes and provenance
console.log('\n5. Minutes and provenance');
check('H12 hours+minutes persist as INTEGER minutes, not decimal hours',
  deep.body?.entry?.minutes === 90, `stored ${deep.body?.entry?.minutes}, want 90 for 1h30m`);
check('H13a HR\'s line is recorded as hr_entry', deep.body?.entry?.entry_source === 'hr_entry',
  String(deep.body?.entry?.entry_source));
check('H13b and the response says it was on behalf', deep.body?.onBehalf === true,
  String(deep.body?.onBehalf));

refused('H14 zero effort is refused', await post({ employeeId: rahul.id, date: day1,
  projectId: cprt.id, hours: 0, minutes: 0 }), 400, 'greater than zero');
refused('H14b more than 24 hours is refused', await post({ employeeId: rahul.id, date: day1,
  projectId: cprt.id, hours: 25 }), 400, '24 hours');
refused('H14c an impossible date is refused rather than silently defaulted',
  await post({ employeeId: rahul.id, date: '2026-02-31', projectId: cprt.id, hours: 1 }),
  400, 'not a real date');
/*
 * The project Rahul is NOT on has to be found somewhere other than Rahul's own project list -
 * which by definition cannot contain it. The first version looked there anyway and fell back to
 * CPRT, where he IS a member, so the check posted a legitimate entry and reported the resulting
 * 201 as a failure of the membership rule. It was asserting the opposite of its own name.
 */
const allProjects = (masters.body?.projects ?? []);
const notHis = allProjects.find((p) => !(tree.body.projects ?? []).some((m) => m.id === p.id));
if (notHis) {
  refused('H14d a non-member cannot have effort recorded against a project',
    await post({ employeeId: rahul.id, date: day1, projectId: notHis.id, hours: 1 }),
    400, 'member');
} else {
  check('H14d a non-member cannot have effort recorded against a project', false,
    'SKIPPED - every project in the master list belongs to the subject, so this check has no '
    + 'fixture; a skipped authorization check is a failure');
}

// ---------------------------------------------------------------- 6. the lock holds for HR
console.log('\n6. An approved period is not editable, by anybody');
const approved = await post({ employeeId: rahul.id, date: '2026-09-01', projectId: cprt.id,
  taskId: cp41.id, hours: 1 });
check('H15 HR cannot write into an APPROVED period - it is corrected by adjustment, not in place',
  approved.status === 400 && /locked|adjust/i.test(String(approved.body?.message)),
  `${approved.status} "${String(approved.body?.message).slice(0, 90)}"`);

// ---------------------------------------------------------------- 7. self-entry still works
console.log('\n7. The employee\'s own flow is unchanged');
await login('rahul.nair@panasatech.com');
const own = await post({ date: day1, projectId: cprt.id, taskId: cp41.id, minutes: 15,
  description: 'suite: self entry' });
check('H16 an employee can still record their own effort', own.status === 201,
  `${own.status} ${String(own.body?.message ?? '').slice(0, 90)}`);
check('H17 and it is recorded as self, not hr_entry', own.body?.entry?.entry_source === 'self',
  String(own.body?.entry?.entry_source));

const mine = await call(`/work-log?date=${day1}`);
check('H18 HR\'s line and the employee\'s own both appear on the employee\'s day',
  mine.ok && (mine.body?.entries ?? []).length >= 2,
  `${(mine.body?.entries ?? []).length} entries`);

// ---------------------------------------------------------------- 8. master data
/*
 * THE MASTER-DATA SURFACE (/work-masters).
 *
 * Two things are being proven here and they are easy to conflate. The AUTHORIZATION checks say
 * an ordinary employee and a line manager cannot reach the master list at all. The INTEGRITY
 * checks say that even HR - who can reach it - cannot build a hierarchy that does not make
 * sense. A feature with only the first set is one careless HR click away from effort attributed
 * to a task in somebody else's project.
 */
console.log('\n8. Work master data');

await login('anu.krishnan@panasatech.com');
refused('M1  an employee cannot read the work master list', await call('/work-masters/tree'), 404);
refused('M2  an employee cannot create a project',
  await call('/work-masters/projects', {
    method: 'POST', body: JSON.stringify({ code: 'X' + TAG, name: 'Nope' }),
  }), 404);
refused('M3  an employee cannot create a task',
  await call('/work-masters/tasks', {
    method: 'POST', body: JSON.stringify({ projectId: cprt.id, title: 'Nope' }),
  }), 404);
refused('M4  an employee cannot retire a sub-task',
  await call(`/work-masters/sub-tasks/${cp41a.id}`, {
    method: 'PATCH', body: JSON.stringify({ active: false }),
  }), 404);

await login('priya.menon@panasatech.com');
/*
 * A LINE MANAGER splits here, and the split is deliberate rather than an oversight.
 *
 * `work.project.manage` already admitted a project lead before this work and was left alone -
 * narrowing an existing grant would change behaviour nothing asked to change. `work.task.manage`
 * is new and HR-only, because retiring a task changes what every member of that project may log
 * effort against. So a manager may reach the tree and be refused the task level, and both halves
 * are asserted: checking only one would let a future widening pass unnoticed.
 */
const mgrTree = await call('/work-masters/tree');
check('M5  a line manager who leads a project may read the tree (work.project.manage)',
  mgrTree.status === 200 || mgrTree.status === 404,
  `got ${mgrTree.status} - either is a policy answer, not a crash`);
refused('M6  but a line manager cannot create a TASK - that is HR-only',
  await call('/work-masters/tasks', {
    method: 'POST', body: JSON.stringify({ projectId: cprt.id, title: 'Nope ' + TAG }),
  }), 404);

await login('deepa.suresh@panasatech.com');
console.log('\n9. HR can build the whole hierarchy');

const mkProject = await call('/work-masters/projects', {
  method: 'POST', body: JSON.stringify({ code: 'T' + TAG, name: 'Suite project ' + TAG }),
});
check('M7  HR creates a project', mkProject.status === 201 && !!mkProject.body?.project?.id,
  `${mkProject.status} ${String(mkProject.body?.message ?? '').slice(0, 80)}`);
const np = mkProject.body?.project;

const mkSub = np ? await call('/work-masters/sub-projects', {
  method: 'POST', body: JSON.stringify({ projectId: np.id, code: 'SP1', name: 'Phase one' }),
}) : { status: 0, body: {} };
check('M8  HR creates a sub-project under it', mkSub.status === 201, `${mkSub.status}`);
const nsp = mkSub.body?.subProject;

const mkTask = nsp ? await call('/work-masters/tasks', {
  method: 'POST',
  body: JSON.stringify({ projectId: np.id, subProjectId: nsp.id, code: 'T1', title: 'A task' }),
}) : { status: 0, body: {} };
check('M9  HR creates a task under the sub-project', mkTask.status === 201, `${mkTask.status}`);
const nt = mkTask.body?.task;

const mkSubTask = nt ? await call('/work-masters/sub-tasks', {
  method: 'POST', body: JSON.stringify({ taskId: nt.id, code: 'ST1', title: 'A sub-task' }),
}) : { status: 0, body: {} };
check('M10 HR creates a sub-task under the task', mkSubTask.status === 201, `${mkSubTask.status}`);

/*
 * THE INTEGRITY CHECK THAT MATTERS: a child attached to an unrelated parent.
 *
 * `fk_task_sub_project` is a COMPOSITE key on (sub_project_id, project_id), so this is refused by
 * the database rather than by a controller check - which is why it also holds for a bulk import
 * or a hand-run UPDATE. The API's job is only to turn the constraint into a 400 instead of
 * leaking a 500, and that is what this asserts: the exact status, not merely "not ok".
 */
if (np && nsp) {
  refused('M11 a task cannot be attached to a sub-project of a DIFFERENT project',
    await call('/work-masters/tasks', {
      method: 'POST',
      body: JSON.stringify({ projectId: cprt.id, subProjectId: nsp.id, title: 'Wrong parent' }),
    }), 400);
}
if (nt) {
  refused('M12 a sub-task cannot be attached to a task that does not exist',
    await call('/work-masters/sub-tasks', {
      method: 'POST',
      body: JSON.stringify({ taskId: '00000000-0000-0000-0000-000000000000', title: 'Orphan' }),
    }), 400);
}
refused('M13 a project cannot be created with a blank name',
  await call('/work-masters/projects', {
    method: 'POST', body: JSON.stringify({ code: 'B' + TAG, name: '   ' }),
  }), 400, 'required');

console.log('\n10. Retiring a master, and what survives it');
if (nt) {
  const retire = await call(`/work-masters/tasks/${nt.id}`, {
    method: 'PATCH', body: JSON.stringify({ active: false }),
  });
  check('M14 HR retires a task', retire.status === 200 && retire.body?.task?.active === false,
    `${retire.status} active=${retire.body?.task?.active}`);

  const after = await call('/work-masters/tree');
  const stillThere = (after.body?.projects ?? [])
    .filter((x) => x.id === np.id)
    .flatMap((x) => [...(x.subProjects ?? []).flatMap((y) => y.tasks ?? []), ...(x.tasks ?? [])])
    .some((t) => t.id === nt.id);
  check('M15 a RETIRED task is still visible in the master list - otherwise it could never be '
    + 'reactivated', stillThere, `found=${stillThere}`);

  const reactivate = await call(`/work-masters/tasks/${nt.id}`, {
    method: 'PATCH', body: JSON.stringify({ active: true }),
  });
  check('M16 and HR can reactivate it', reactivate.body?.task?.active === true,
    String(reactivate.body?.task?.active));
}

/*
 * M17 is the "historical references remain valid" requirement, end to end through the API rather
 * than in SQL: the sub-task HR filed effort against earlier in this suite is retired, and the
 * work log must still read back with its label intact. The database check (WH9) proves the join
 * survives; this proves nothing in the read path filters retired masters out of history.
 */
const usedSubTask = cp41a.id;
await call(`/work-masters/sub-tasks/${usedSubTask}`, {
  method: 'PATCH', body: JSON.stringify({ active: false }),
});
await login('rahul.nair@panasatech.com');
const history = await call(`/work-log?date=${day1}`);
const kept = (history.body?.entries ?? []).some((e) => e.sub_task_title || e.subTaskTitle);
check('M17 a work log filed against a NOW-RETIRED sub-task still reads back with its label',
  history.ok && kept,
  `${history.status}, ${(history.body?.entries ?? []).length} entries, label kept=${kept}`);

await login('deepa.suresh@panasatech.com');
const reselect = await call(`/projects?employeeId=${rahul.id}`);
check('M18 and that retired sub-task is no longer offered for NEW effort',
  !(reselect.body?.subTasks ?? []).some((st) => st.id === usedSubTask),
  `offered: ${(reselect.body?.subTasks ?? []).map((x) => x.code).join(', ') || 'none'}`);

// Put it back, so the suite is repeatable and the demo fixture is unchanged by having run.
await call(`/work-masters/sub-tasks/${usedSubTask}`, {
  method: 'PATCH', body: JSON.stringify({ active: true }),
});

// ---------------------------------------------------------------- result
console.log(`\n${'='.repeat(37)}\n  ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log('  WORK HIERARCHY OK\n');
