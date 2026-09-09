/**
 * The HR masters: department, designation and employee.
 *
 * WHAT THESE THREE HAVE IN COMMON is that a CRUD generator would get all of them wrong.
 *
 *   A department RENAME is an edit; a department MOVE is a new effective-dated period, because
 *   last quarter's report must keep resolving to last quarter's parent (Rule 3).
 *   A designation is RETIRED with a date, never deleted and never flagged, because historical
 *   employment rows keep pointing at it while new assignments must be refused (DEC-044).
 *   An employee TRANSFER is not an edit either - same close-and-open, same reason.
 *
 * So the checks below are mostly about what the masters REFUSE, and about history surviving a
 * change. A suite that only proved "the row saved" would pass against an implementation that
 * overwrote the past.
 *
 * Run: npm run masters:test    (needs the API on :4000)
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

// A tag unique to this run, so the fixtures never collide with an earlier one and the suite is
// repeatable without deleting anything - which these tables do not permit anyway.
const TAG = Date.now().toString(36).toUpperCase().slice(-5);

/*
 * THE BUSINESS DATE COMES FROM THE SERVER, NEVER FROM THIS PROCESS'S CLOCK.
 *
 * The first version used `new Date().toISOString().slice(0, 10)`, and the suite failed at 00:35
 * IST - because that is 19:05 UTC the PREVIOUS day, so every "today" it sent was yesterday in
 * business terms and the effective-dated rails correctly refused it as back-dating.
 *
 * This is the exact mistake `fn_business_date()` exists to prevent, and the domain glossary calls
 * out by name: "the IST offset makes UTC truncation wrong before 05:30". A client that computes
 * its own today is wrong for five and a half hours out of every twenty-four, which is precisely
 * the window nobody tests in.
 */
let today = null;
const plus = (n) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

console.log('HR masters - department, designation, employee\n');

// ---------------------------------------------------------------------------
console.log('1. The DEPARTMENT master');
const hr = await login('deepa.suresh@panasatech.com');
today = (await call('/attendance/today')).body?.businessDate;
check('the business date came from the server, not from this test process', /^\d{4}-\d{2}-\d{2}$/.test(today ?? ''),
  `${today} - the IST offset makes UTC truncation wrong before 05:30`);

let rootId = null; let childId = null; let otherRootId = null;
{
  const list = await call('/org/departments');
  check('HR can read the department master', list.ok, `${(list.body?.rows ?? []).length} departments`);
  check('  ... resolved as of a date, with headcount rolled up the tree',
    (list.body?.rows ?? []).some((r) => Number(r.subtree_headcount) > Number(r.direct_headcount)),
    (list.body?.rows ?? []).map((r) => `${r.code}:${r.direct_headcount}/${r.subtree_headcount}`).join(' '));

  const a = await call('/org/departments', {
    method: 'POST',
    body: JSON.stringify({ code: `T${TAG}A`, name: `Test Root ${TAG}` }),
  });
  check('HR creates a department', a.ok, `status=${a.status} ${JSON.stringify(a.body ?? {}).slice(0, 80)}`);
  rootId = a.body?.id;

  const b = await call('/org/departments', {
    method: 'POST',
    body: JSON.stringify({ code: `T${TAG}B`, name: `Test Child ${TAG}`, parentId: rootId }),
  });
  check('  ... and a child under it', b.ok, `status=${b.status}`);
  childId = b.body?.id;

  const c = await call('/org/departments', {
    method: 'POST',
    body: JSON.stringify({ code: `T${TAG}C`, name: `Test Other ${TAG}` }),
  });
  otherRootId = c.body?.id;

  const dup = await call('/org/departments', {
    method: 'POST', body: JSON.stringify({ code: `T${TAG}A`, name: 'Duplicate' }),
  });
  check('a duplicate code is refused with a sentence, not a 500',
    dup.status === 400 && /already exists/i.test(String(dup.body?.message ?? '')),
    `status=${dup.status} ${String(dup.body?.message ?? '').slice(0, 60)}`);

  const bad = await call('/org/departments', {
    method: 'POST', body: JSON.stringify({ code: 'x', name: 'Bad' }),
  });
  check('a malformed code is refused', bad.status === 400,
    String(bad.body?.message ?? '').slice(0, 60));
}

// ---------------------------------------------------------------------------
console.log('\n2. Renaming is an EDIT; moving is a NEW PERIOD');
{
  const ren = await call(`/org/departments/${rootId}`, {
    method: 'PATCH', body: JSON.stringify({ name: `Renamed Root ${TAG}` }),
  });
  check('a department can be renamed in place - identity is mutable (DEC-043)', ren.ok,
    `status=${ren.status} ${ren.body?.name ?? ''}`);

  const noReason = await call(`/org/departments/${childId}/reparent`, {
    method: 'POST', body: JSON.stringify({ parentId: otherRootId, effectiveFrom: plus(2) }),
  });
  check('re-parenting without a reason is refused', noReason.status === 400,
    'a reorganisation with no reason is unexplainable later');

  const move = await call(`/org/departments/${childId}/reparent`, {
    method: 'POST',
    body: JSON.stringify({
      parentId: otherRootId, effectiveFrom: plus(2), reason: 'masters test reorganisation',
    }),
  });
  check('HR re-parents a department, effective in two days', move.ok,
    `status=${move.status} ${String(move.body?.message ?? '').slice(0, 70)}`);

  // THE PROPERTY THAT MATTERS. Today still resolves to the OLD parent.
  const todayView = await call('/org/departments');
  const tomorrowView = await call(`/org/departments?asOf=${plus(2)}`);
  const nowParent = (todayView.body?.rows ?? []).find((r) => r.code === `T${TAG}B`)?.parent_code;
  const thenParent = (tomorrowView.body?.rows ?? []).find((r) => r.code === `T${TAG}B`)?.parent_code;
  check('  ... and TODAY still resolves to the old parent', nowParent === `T${TAG}A`,
    `today=${nowParent} (want T${TAG}A) - history is not overwritten`);
  check('  ... while the effective date resolves to the new one', thenParent === `T${TAG}C`,
    `then=${thenParent} (want T${TAG}C)`);

  const back = await call(`/org/departments/${childId}/reparent`, {
    method: 'POST',
    body: JSON.stringify({ parentId: rootId, effectiveFrom: plus(-30), reason: 'back-dated attempt' }),
  });
  check('a BACK-DATED move is refused (DEC-029)', back.status === 400,
    String(back.body?.message ?? '').slice(0, 70));
}

// ---------------------------------------------------------------------------
console.log('\n3. A department cannot be moved inside its own subtree (0026)');
{
  // Put the child back under the root first so there is a subtree to violate.
  await call(`/org/departments/${childId}/reparent`, {
    method: 'POST',
    body: JSON.stringify({ parentId: rootId, effectiveFrom: plus(3), reason: 'restore for cycle test' }),
  });

  const cycle = await call(`/org/departments/${rootId}/reparent`, {
    method: 'POST',
    body: JSON.stringify({ parentId: childId, effectiveFrom: plus(4), reason: 'attempt a cycle' }),
  });
  check('moving a department under its own child is refused', cycle.status === 400,
    String(cycle.body?.message ?? '').slice(0, 80));
  check('  ... and the message names the offending department',
    /subtree/i.test(String(cycle.body?.message ?? '')),
    'a cycle would silently understate every headcount rollup above it');

  const self = await call(`/org/departments/${rootId}/reparent`, {
    method: 'POST',
    body: JSON.stringify({ parentId: rootId, effectiveFrom: plus(4), reason: 'self parent' }),
  });
  check('a department cannot be its own parent', self.status === 400,
    String(self.body?.message ?? '').slice(0, 50));
}

// ---------------------------------------------------------------------------
console.log('\n4. The DESIGNATION master - retired with a DATE, never deleted');
let desigId = null;
{
  const list = await call('/org/designations');
  check('HR can read the designation master', list.ok,
    (list.body?.rows ?? []).map((r) => `${r.code}(${r.holders})`).join(' '));
  check('  ... and it reports how many people hold each one',
    (list.body?.rows ?? []).some((r) => Number(r.holders) > 0),
    'retiring a title 40 people hold is a different act from retiring an empty one');

  const made = await call('/org/designations', {
    method: 'POST',
    body: JSON.stringify({ code: `T${TAG}D`, name: `Test Designation ${TAG}`, grade: 3 }),
  });
  check('HR creates a designation', made.ok, `status=${made.status}`);
  desigId = made.body?.id;

  const badGrade = await call('/org/designations', {
    method: 'POST', body: JSON.stringify({ code: `T${TAG}E`, name: 'Bad grade', grade: 99 }),
  });
  check('an out-of-range grade is refused', badGrade.status === 400,
    String(badGrade.body?.message ?? '').slice(0, 50));

  const retire = await call(`/org/designations/${desigId}/retire`, {
    method: 'POST', body: JSON.stringify({}),
  });
  check('HR retires it', retire.ok, `status=${retire.status} holders=${retire.body?.holders}`);

  const after = await call('/org/designations');
  const row = (after.body?.rows ?? []).find((r) => r.id === desigId);
  check('  ... and it is still THERE, marked retired with a date',
    !!row && row.retired === true && !!row.retired_on,
    `retired=${row?.retired} retired_on=${row?.retired_on} - history keeps pointing at it`);

  const back = await call(`/org/designations/${desigId}/retire`, {
    method: 'POST', body: JSON.stringify({ reinstate: true }),
  });
  check('  ... and retiring the wrong one can be undone', back.ok,
    'the alternative would be creating a duplicate title');
}

// ---------------------------------------------------------------------------
console.log('\n5. The EMPLOYEE master');
let newEmpId = null;
{
  const depts = await call('/org/departments');
  const desigs = await call('/org/designations');
  const dept = (depts.body?.rows ?? []).find((r) => r.code === 'ENG');
  const desig = (desigs.body?.rows ?? []).find((r) => r.code === 'ENGR');

  const made = await call('/people/employees', {
    method: 'POST',
    body: JSON.stringify({
      employeeNumber: `T${TAG}`,
      fullName: `Test Person ${TAG}`,
      workEmail: `test-${TAG.toLowerCase()}@panasatech.com`,
      joinedOn: plus(-10),
      departmentId: dept.id,
      designationId: desig.id,
    }),
  });
  check('HR creates an employee', made.ok,
    `status=${made.status} ${JSON.stringify(made.body ?? {}).slice(0, 70)}`);
  newEmpId = made.body?.id;

  const detail = await call(`/employees/${newEmpId}`);
  check('  ... who appears with a department, designation and joining date',
    detail.ok && detail.body?.employee?.department === 'Engineering',
    `${detail.body?.employee?.department} / ${detail.body?.employee?.designation}`);
  check('  ... and is ACTIVE, because the joining event was recorded',
    detail.body?.employee?.status === 'active',
    `status=${detail.body?.employee?.status} - the lifecycle log is what moves it off pre_boarding`);
  check('  ... with the joining event in the lifecycle history',
    (detail.body?.lifecycle ?? []).some((e) => e.event_type === 'joined'),
    (detail.body?.lifecycle ?? []).map((e) => e.event_type).join(', ') || '(none)');

  const dupNum = await call('/people/employees', {
    method: 'POST',
    body: JSON.stringify({
      employeeNumber: `T${TAG}`, fullName: 'Clash', workEmail: `clash-${TAG}@panasatech.com`,
      joinedOn: today, departmentId: dept.id, designationId: desig.id,
    }),
  });
  check('a duplicate employee number is refused with a sentence',
    dupNum.status === 400 && /already in use/i.test(String(dupNum.body?.message ?? '')),
    String(dupNum.body?.message ?? '').slice(0, 60));

  global.__dept = dept; global.__desig = desig;
}

// ---------------------------------------------------------------------------
console.log('\n6. A TRANSFER is a new period, and the old one survives');
{
  const depts = await call('/org/departments');
  const hrDept = (depts.body?.rows ?? []).find((r) => r.code === 'HR');
  const desigs = await call('/org/designations');
  const senior = (desigs.body?.rows ?? []).find((r) => r.code === 'SE');

  const noReason = await call(`/people/employees/${newEmpId}/assignment`, {
    method: 'POST', body: JSON.stringify({ departmentId: hrDept.id, effectiveFrom: today }),
  });
  check('a transfer without a reason is refused', noReason.status === 400);

  const noop = await call(`/people/employees/${newEmpId}/assignment`, {
    method: 'POST',
    body: JSON.stringify({ effectiveFrom: today, reason: 'nothing actually changes' }),
  });
  check('a transfer that changes nothing is refused', noop.status === 400,
    'it would clutter the history with a move that never happened');

  const moved = await call(`/people/employees/${newEmpId}/assignment`, {
    method: 'POST',
    body: JSON.stringify({
      departmentId: hrDept.id, designationId: senior.id,
      effectiveFrom: today, reason: 'promoted and transferred by the masters test',
    }),
  });
  check('HR transfers and promotes in one assignment change', moved.ok,
    `status=${moved.status} ${String(moved.body?.message ?? '').slice(0, 60)}`);

  const detail = await call(`/employees/${newEmpId}`);
  check('  ... the current assignment is the new one',
    detail.body?.employee?.department === 'Human Resources'
    && detail.body?.employee?.designation === 'Senior Engineer',
    `${detail.body?.employee?.department} / ${detail.body?.employee?.designation}`);
  /*
   * `history`, not `assignments` - the key this test first guessed at. It failed for the right
   * reason and the data was correct all along, which is the good version of that mistake: the
   * assertion was wrong rather than the behaviour.
   */
  const hist = detail.body?.history ?? [];
  check('  ... and the PREVIOUS assignment is still in the history, not overwritten',
    hist.length >= 2 && hist.some((a) => a.department === 'Engineering'),
    hist.map((a) => `${a.department}/${a.designation}@${String(a.valid_from).slice(0, 10)}`).join(' | '));
  check('  ... with the old period CLOSED on the effective date rather than deleted',
    hist.some((a) => a.department === 'Engineering' && String(a.valid_to ?? '').slice(0, 10) === today),
    hist.map((a) => `${String(a.valid_from).slice(0, 10)}..${String(a.valid_to ?? 'open').slice(0, 10)}`).join(' | '));
  check('  ... and the reason travels with it, so the move is explainable later',
    hist.some((a) => /promoted and transferred/.test(a.reason ?? '')),
    hist.map((a) => a.reason).filter(Boolean).join(' | '));
}

// ---------------------------------------------------------------------------
console.log('\n7. FORBIDDEN: an employee cannot administer the organisation');
{
  await login('vishnu.ravi@panasatech.com');

  const depts = await call('/org/departments');
  check('reading the department master: refused', !depts.ok, `status=${depts.status}`);

  const mk = await call('/org/departments', {
    method: 'POST', body: JSON.stringify({ code: `X${TAG}`, name: 'Mine now' }),
  });
  check('creating a department: refused', !mk.ok, `status=${mk.status}`);

  const desig = await call('/org/designations', {
    method: 'POST', body: JSON.stringify({ code: `Y${TAG}`, name: 'CEO', grade: 20 }),
  });
  check('creating a designation: refused', !desig.ok, `status=${desig.status}`);

  const emp = await call('/people/employees', {
    method: 'POST',
    body: JSON.stringify({
      employeeNumber: `Z${TAG}`, fullName: 'Ghost', workEmail: `ghost-${TAG}@panasatech.com`,
      joinedOn: today, departmentId: global.__dept.id, designationId: global.__desig.id,
    }),
  });
  check('creating an employee: refused', !emp.ok, `status=${emp.status}`);

  const promote = await call(`/people/employees/${newEmpId}/assignment`, {
    method: 'POST',
    body: JSON.stringify({ designationId: global.__desig.id, effectiveFrom: today, reason: 'me' }),
  });
  check('changing somebody else\'s assignment: refused', !promote.ok, `status=${promote.status}`);
}

// ---------------------------------------------------------------------------
console.log('\n8. FORBIDDEN: nobody changes their OWN assignment - not even HR');
{
  const me = await login('deepa.suresh@panasatech.com');
  const list = await call('/employees');
  const self = (list.body?.rows ?? list.body?.employees ?? [])
    .find((e) => e.employee_number === me.employeeNumber);

  const selfPromote = await call(`/people/employees/${self.id}/assignment`, {
    method: 'POST',
    body: JSON.stringify({
      designationId: global.__desig.id, effectiveFrom: today, reason: 'promoting myself',
    }),
  });
  check('an HR admin cannot change their own assignment', !selfPromote.ok,
    `status=${selfPromote.status} - the policy carries isSelf as a DENY-override`);

  // ... but they can still edit their own details, which is a different act.
  const selfEdit = await call(`/people/employees/${self.id}`, {
    method: 'PATCH', body: JSON.stringify({ personal_phone: '+91 90000 00001' }),
  });
  check('  ... but can still edit their own personal details', selfEdit.ok,
    `status=${selfEdit.status} - editing yourself and promoting yourself are different acts`);
}

// ---------------------------------------------------------------------------
console.log('\n9. What may be WRITTEN follows what may be READ');
{
  await login('deepa.suresh@panasatech.com');
  const addr = await call(`/people/employees/${newEmpId}`, {
    method: 'PATCH', body: JSON.stringify({ address_line1: '4 Test Lane', city: 'Kochi' }),
  });
  check('HR can set an address on somebody else', addr.ok, `status=${addr.status}`);

  // SELF_ONLY in the field registry: third-party data (DEC-035) and health data (OR-16).
  const blood = await call(`/people/employees/${newEmpId}`, {
    method: 'PATCH', body: JSON.stringify({ blood_group: 'O+' }),
  });
  check('HR cannot set somebody else\'s blood group', blood.status === 400,
    String(blood.body?.message ?? '').slice(0, 80));

  const kin = await call(`/people/employees/${newEmpId}`, {
    method: 'PATCH', body: JSON.stringify({ emergency_contact_name: 'Someone' }),
  });
  check('  ... nor their emergency contact', kin.status === 400,
    'third-party data about somebody who never consented');

  const emp2 = await login('vishnu.ravi@panasatech.com');
  const list = await call('/employees');
  const mine = (list.body?.rows ?? list.body?.employees ?? [])
    .find((e) => e.employee_number === emp2.employeeNumber);
  const own = await call(`/people/employees/${mine.id}`, {
    method: 'PATCH', body: JSON.stringify({ blood_group: 'O+', emergency_contact_name: 'Asha' }),
  });
  check('  ... but the employee can set both on themselves', own.ok,
    `status=${own.status} - the write list is derived from the read mask, so it narrows with the caller`);
}

// ---------------------------------------------------------------------------
console.log('\n10. OR-18: HR can now see personal data, and still not all of it');
{
  await login('deepa.suresh@panasatech.com');
  const list = await call('/employees');
  const v = (list.body?.rows ?? list.body?.employees ?? [])
    .find((e) => e.employee_number === 'EMP001');
  const asHr = await call(`/employees/${v.id}`);
  const keys = Object.keys(asHr.body?.personal ?? {});
  check('HR can read an employee\'s address and date of birth (OR-18 closed)',
    keys.includes('date_of_birth') && keys.includes('address_line1'),
    `${keys.length} fields`);
  check('  ... and STILL cannot read the emergency contact or blood group',
    !keys.includes('emergency_contact_name') && !keys.includes('blood_group'),
    'SELF_ONLY in the registry - third-party data and health data (DEC-035, OR-16)');

  await login('priya.menon@panasatech.com');
  const asMgr = await call(`/employees/${v.id}`);
  check('  ... and a line manager reads none of it', !asMgr.body?.personal,
    'rbac-rules: a manager sees attendance for their subtree, not personal detail');
}

console.log('');
if (fail) { console.log('FAILURES:'); for (const f of failures) console.log(`  ${f}`); }
console.log(`${fail === 0 ? 'MASTERS OK' : 'MASTERS FAILED'} (${pass} passed, ${fail} failed)`);
process.exitCode = fail === 0 ? 0 : 1;
