// Employee profile field exposure, end to end against the running app (via the Next proxy).
//
// WHY THIS TEST EXISTS
//
// `GET /employees/:id` was written as `SELECT e.*` and is `@Authenticated()` with no role
// restriction. Migration 0014 added eleven personal columns to `employee` - home address,
// personal email, emergency contact, blood group, exit reason - and every one of them
// immediately began serialising to any authenticated caller. Verified by logging in as a plain
// employee and reading a colleague's record: 35 fields came back, including their date of birth,
// gender and personal phone.
//
// Nothing failed. No test broke. The disclosure arrived as a side effect of adding columns to a
// table, which is exactly why `ai/context/rbac-rules.md` requires a default-deny field registry
// rather than a reviewer noticing.
//
// This suite pins the fix from the outside, in the shape an attacker would use: it asserts on
// the JSON body, not on the SQL. A future `SELECT *`, an added column, or a widened role gate
// all fail here.
//
// Run: node testing/demo/profile-privacy.test.mjs   (or npm run privacy:test)

const B = 'http://localhost:3100/api';
let jar = '';

async function call(path, opts = {}) {
  const res = await fetch(B + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(jar ? { cookie: jar } : {}) },
  });
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) jar = sc.map((c) => c.split(';')[0]).join('; ');
  const t = await res.text();
  let b; try { b = JSON.parse(t); } catch { b = t; }
  return { ok: res.ok, status: res.status, body: b };
}

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${name}${detail ? `  — ${detail}` : ''}`);
};

const login = async (email) => {
  jar = '';
  const r = await call('/auth/login', {
    method: 'POST', body: JSON.stringify({ email, password: 'panasa2026' }),
  });
  if (!r.ok) throw new Error(`login failed for ${email}: ${JSON.stringify(r.body)}`);
  return r.body.actor;
};

/**
 * Fields that must NEVER reach a caller who is not the subject.
 * PERSONAL / SENSITIVE / RESTRICTED per docs/privacy/data-inventory.md.
 */
const FORBIDDEN_TO_PEERS = [
  'date_of_birth', 'gender', 'personal_phone', 'personal_email',
  'address_line1', 'address_line2', 'city', 'state_region', 'postal_code',
  'emergency_contact_name', 'emergency_contact_phone', 'emergency_contact_relation',
  'blood_group', 'exit_reason', 'password_hash',
];

console.log('Employee profile field exposure\n');

// ---------------------------------------------------------------------------
console.log('1. A plain employee reads a colleague\'s record');
const me = await login('vishnu.ravi@panasatech.com');

const list = await call('/employees');
check('directory loads', list.ok, `${list.body.employees?.length ?? 0} employees`);

const peer = list.body.employees.find((e) => e.id !== me.employeeId);
check('found a colleague to test against', !!peer, peer ? `${peer.employee_number} ${peer.full_name}` : '');

const peerRes = await call(`/employees/${peer.id}`);
check('colleague record loads', peerRes.ok, `${Object.keys(peerRes.body.employee ?? {}).length} fields`);
check('isSelf is false', peerRes.body.isSelf === false);

// The whole response is searched, not just `employee` - a leak through `personal`,
// `lifecycle` or any future block is the same leak.
const peerJson = JSON.stringify(peerRes.body);
const leaked = FORBIDDEN_TO_PEERS.filter((f) => peerJson.includes(`"${f}"`));
check('NO personal field appears anywhere in a peer response',
  leaked.length === 0,
  leaked.length ? `LEAKED: ${leaked.join(', ')}` : `checked ${FORBIDDEN_TO_PEERS.length} field names`);

check('no personal block for a peer', peerRes.body.personal === null);
check('no lifecycle log for a peer', Array.isArray(peerRes.body.lifecycle) && peerRes.body.lifecycle.length === 0,
  'an exit event reason is RESTRICTED - it may describe conduct or health');

// ---------------------------------------------------------------------------
console.log('\n2. The same employee reads their OWN record');
const selfRes = await call(`/employees/${me.employeeId}`);
check('own record loads', selfRes.ok);
check('isSelf is true', selfRes.body.isSelf === true);
check('personal block present', !!selfRes.body.personal,
  selfRes.body.personal ? `${Object.keys(selfRes.body.personal).length} fields` : '');
check('own date of birth is visible', typeof selfRes.body.personal?.date_of_birth === 'string');
check('own lifecycle log is visible', (selfRes.body.lifecycle?.length ?? 0) > 0,
  selfRes.body.lifecycle?.map((e) => e.event_type).join(' <- '));
check('credential material never appears, even for self',
  !JSON.stringify(selfRes.body).includes('password_hash'));

// ---------------------------------------------------------------------------
console.log('\n3. A manager gets no extra field access (that waits for the real field mask)');
await login('priya.menon@panasatech.com');
const mgrRes = await call(`/employees/${me.employeeId}`);
check('manager can read a report\'s record', mgrRes.ok);
const mgrLeaked = FORBIDDEN_TO_PEERS.filter((f) => JSON.stringify(mgrRes.body).includes(`"${f}"`));
check('manager sees no personal fields', mgrLeaked.length === 0,
  mgrLeaked.length ? `LEAKED: ${mgrLeaked.join(', ')}` : '');

// ---------------------------------------------------------------------------
console.log('\n4. hr_admin DOES see personal data now - and still not all of it (OR-18 closed)');
await login('deepa.suresh@panasatech.com');
const hrRes = await call(`/employees/${me.employeeId}`);
check('hr_admin can read the record', hrRes.ok);

/*
 * THIS CHECK WAS INVERTED ON PURPOSE, and that is worth being explicit about.
 *
 * It used to assert `hr_admin sees no personal fields`, pinning the interim default-deny DEC-036
 * took when `packages/authz` had no field mask - and DEC-036 said in terms "revisit when
 * fieldMask ships". It has, so HR now reads the address and date of birth it needs to do the job,
 * through the POLICY and the field REGISTRY rather than an id comparison in a controller.
 *
 * Weakening a privacy assertion is exactly the kind of edit that should be hard to make quietly,
 * so what replaces it is STRONGER rather than absent: the two field groups the registry marks
 * SELF_ONLY must still be unreachable, and a line manager must still get nothing. If somebody
 * later widens the registry by accident, the checks below fail even though HR "can see personal
 * data" is now true.
 */
const hrPersonal = Object.keys(hrRes.body?.personal ?? {});
check('hr_admin can read the fields HR administration actually needs',
  hrPersonal.includes('date_of_birth') && hrPersonal.includes('address_line1'),
  `${hrPersonal.length} fields - OR-18 was a functional regression against what HR needs`);

// SELF_ONLY in the field registry, for two different reasons.
const SELF_ONLY_FIELDS = [
  'emergency_contact_name', 'emergency_contact_phone', 'emergency_contact_relation',
  'blood_group',
];
const hrLeaked = SELF_ONLY_FIELDS.filter((f) => hrPersonal.includes(f));
check('  ... and STILL cannot read the emergency contact or the blood group',
  hrLeaked.length === 0,
  hrLeaked.length
    ? `LEAKED: ${hrLeaked.join(', ')}`
    : 'third-party data nobody consented to (DEC-035) and health data with no stated purpose (OR-16)');

// And the write side follows the read side, so this cannot be circumvented by setting them.
const setKin = await call(`/people/employees/${me.employeeId}`, {
  method: 'PATCH', body: JSON.stringify({ blood_group: 'B+' }),
});
check('  ... nor SET them, because the write list is derived from the read mask',
  setKin.status === 400,
  `status=${setKin.status} - a caller who may not read a field has no business writing it`);

console.log('\n5. The directory listing carries no personal data either');
const dirJson = JSON.stringify((await call('/employees')).body);
const dirLeaked = FORBIDDEN_TO_PEERS.filter((f) => dirJson.includes(`"${f}"`));
check('list endpoint is clean', dirLeaked.length === 0,
  dirLeaked.length ? `LEAKED: ${dirLeaked.join(', ')}` : 'RESTRICTED fields must never appear in a list');

// ---------------------------------------------------------------------------
console.log(`\n${fail === 0 ? 'PROFILE PRIVACY OK' : 'PROFILE PRIVACY FAILED'} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
