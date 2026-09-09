/**
 * Account provisioning, end to end against the running API.
 *
 * WHAT CARRIES THE WEIGHT
 *
 *   AC4-6  AUTHORIZATION. Only hr_admin may provision, and a denial is a 404 rather than a 403,
 *          so the existence of somebody's account is not readable by probing. An employee and a
 *          manager are both tried, because `manager` is the role most likely to be widened by
 *          accident later.
 *   AC9    THE CODE IS NOT RECOVERABLE. Only its SHA-256 was stored, so no endpoint - not even
 *          for the HR admin who issued it - can read it back. That is what makes "single use"
 *          true rather than aspirational, and it is checked against the response body AND the
 *          stored row.
 *   AC13-14 A CODE CANNOT BE ISSUED FOR AN ACCOUNT THAT ALREADY HAS A PASSWORD. This is the
 *          account-takeover case: without it, whoever can call the endpoint mints a code for the
 *          HR Manager's live account and sets its password. Tried at the API and again straight
 *          at the database, so the guarantee does not rest on the controller checking first.
 *          **AC13 caught a real bug**: the controller guarded on `password_set_at`, which is
 *          nullable and which the seed never populates, so every seeded account read as
 *          un-activated. The credential is the fact; the timestamp is a convenience.
 *   AC15   THE FAILURE MESSAGE IS IDENTICAL for unknown, spent and malformed codes. A distinct
 *          "expired" message confirms a code was real, which is a probing oracle.
 *   AC20   ROLES ARE ACTUALLY GRANTED. `fn_user_roles` reads the effective-dated `user_role`
 *          table, not `app_user.role` - an account provisioned without a grant authenticates
 *          successfully and can then do nothing, which looks like a permissions mystery for a day.
 *   AC31   NO CREDENTIAL EVER CROSSES THE WIRE - asserted against every response body in the run.
 *
 * ON THE FIXTURE, AND WHY IT IS PERMANENT.
 *
 * The first version created a throwaway employee and deleted it afterwards. It cannot be deleted:
 * `employment_event` is append-only (`fn_block_mutation` refuses DELETE) and holds a foreign key
 * to `employee`, so **creating an employee is irreversible by design** - which is Rule 3 working,
 * not an obstacle to route around. `audit_event` and `outbox_event` refuse deletion on the same
 * principle, and neither holds a foreign key, precisely so the record outlives the row.
 *
 * So the fixture is EMP006 Meera Nair - a permanent demo employee who has not been given a login
 * yet, which is exactly the state this feature exists for and a state the demo could not
 * previously show. The name is not invented: `meera.nair@panasatech.com` and `EMP006` are already
 * the placeholder values in the employee form, listed among `i18n:test`'s documented exemptions.
 * The suite creates the employee only if absent, and resets **only the account** either side of
 * the run, so it always leaves EMP006 exactly as it found them: present, and unable to sign in.
 *
 * Run: npm run accounts:test   (needs the API on :4000)
 */

import { execFileSync } from 'node:child_process';

const B = 'http://localhost:4000/api';
const PASSWORD = process.env.HRM_DEMO_PASSWORD ?? 'panasa2026';
const EMP_NO = 'EMP006';
const EMAIL = 'meera.nair@panasatech.com';
const CHOSEN = 'correct-horse-battery-staple-77';

let jar = '';
const seenBodies = [];

async function call(path, opts = {}) {
  const headers = { ...(jar ? { cookie: jar } : {}), ...(opts.headers ?? {}) };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(B + path, { ...opts, headers });
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) jar = sc.map((c) => c.split(';')[0]).join('; ');
  let body = null;
  try { body = await res.json(); } catch { /* not all responses are JSON */ }
  if (body) seenBodies.push(JSON.stringify(body));
  return { ok: res.ok, status: res.status, body };
}

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  OK   ${name}${detail ? `  — ${detail}` : ''}`); return true; }
  fail++; failures.push(`${name}${detail ? `  — ${detail}` : ''}`);
  console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`);
  return false;
};

const login = async (email, password = PASSWORD) => {
  jar = '';
  const r = await call('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  if (!r.ok) throw new Error(`login failed for ${email}: ${JSON.stringify(r.body)}`);
  return r.body;
};

/** Straight to the database, for the checks that must not trust the controller. */
const sql = (q) => execFileSync('docker', [
  'exec', '-i', '-e', 'PGPASSWORD=hrm_dev_only', 'hrm-postgres',
  'psql', '-U', 'hrm', '-d', 'hrm', '-tAc', q,
], { encoding: 'utf8' }).trim();

let haveDb = true;
try { sql('SELECT 1'); } catch { haveDb = false; }

/**
 * Put EMP006 back to "exists, cannot sign in".
 *
 * Deletes the ACCOUNT and nothing else. The employee stays (it cannot go - see the header), and
 * the audit trail and the outbox stay because both refuse deletion by design. `user_role` needs
 * its history trigger stood down, the same way `infrastructure/db/seeds/demo.sql` does it,
 * because role grants are effective-dated and Rule 3 refuses a DELETE.
 */
const resetAccount = () => {
  if (!haveDb) return true;
  try {
    sql(`DO $$
         DECLARE v_e UUID; v_u UUID;
         BEGIN
           SELECT id INTO v_e FROM employee WHERE employee_number = '${EMP_NO}';
           IF v_e IS NULL THEN RETURN; END IF;
           SELECT id INTO v_u FROM app_user WHERE employee_id = v_e;
           IF v_u IS NULL THEN RETURN; END IF;
           DELETE FROM user_activation WHERE user_id = v_u;
           ALTER TABLE user_role DISABLE TRIGGER tg_user_role_immutable_history;
           DELETE FROM user_role WHERE user_id = v_u;
           ALTER TABLE user_role ENABLE ALWAYS TRIGGER tg_user_role_immutable_history;
           DELETE FROM session WHERE user_id = v_u;
           DELETE FROM app_user WHERE id = v_u;
         END $$;`);
    return true;
  } catch (e) {
    console.log(`  WARN could not reset ${EMP_NO}: ${String(e.message).slice(0, 220)}`);
    return false;
  }
};

console.log('\nAccount provisioning\n');
resetAccount();   // in case a previous run died part-way through

// ================================================================ 1. an employee with no login
console.log('1. An employee who cannot sign in');
await login('deepa.suresh@panasatech.com');

const dir = await call('/employees');
let empId = (dir.body?.employees ?? []).find((e) => e.employee_number === EMP_NO)?.id ?? null;

if (!empId) {
  const dept = await call('/org/departments');
  const desig = await call('/org/designations');
  const made = await call('/people/employees', {
    method: 'POST',
    body: JSON.stringify({
      employeeNumber: EMP_NO, fullName: 'Meera Nair', workEmail: EMAIL, joinedOn: '2026-09-01',
      departmentId: (dept.body?.rows ?? [])[0]?.id,
      designationId: (desig.body?.rows ?? [])[0]?.id,
    }),
  });
  empId = made.body?.id ?? null;
  check(`AC1  ${EMP_NO} did not exist, so it was created`, made.ok && !!empId,
    made.ok ? empId : JSON.stringify(made.body));
} else {
  check(`AC1  ${EMP_NO} is present as the fixture employee`, true, empId);
}

const before = await call(`/identity/accounts/by-employee/${empId}`);
check('AC2  and that employee has NO login at all', before.ok && before.body?.hasAccount === false,
  `hasAccount=${before.body?.hasAccount}`);

/*
 * AC2b: THE OFFERED ROLES COME FROM THE API AND MATCH THE DATABASE.
 *
 * The Create login screen offered three roles for hours after migration 0031 widened
 * `ck_app_user_role` to seven, because the endpoint kept a hardcoded list that the migration did
 * not touch - reported as "only 3 roles are there, how can I create a finance head?". Comparing
 * the offer against the CHECK constraint is what makes that drift impossible to repeat: whichever
 * one changes next, this fails.
 */
if (haveDb) {
  const inDb = sql(`SELECT string_agg(DISTINCT m[1], ',' ORDER BY m[1])
                      FROM pg_constraint c,
                           LATERAL regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') AS m
                     WHERE c.conname = 'ck_app_user_role'`);
  const offered = [...(before.body?.grantable ?? [])].sort().join(',');
  check('AC2b every role the DATABASE accepts is offered on screen, and no more',
    offered === inDb, `api=[${offered}] db=[${inDb}]`);
}

const cannotSignIn = await fetch(`${B}/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: CHOSEN }),
});
check('AC3  which was the whole bug: HR could create somebody who can never sign in',
  cannotSignIn.status === 401, `status=${cannotSignIn.status}`);

// ================================================================ 2. only HR may provision
console.log('\n2. Only HR may hand out access');

await login('vishnu.ravi@panasatech.com');
const asEmployee = await call('/identity/accounts', {
  method: 'POST', body: JSON.stringify({ employeeId: empId, role: 'employee' }),
});
check('AC4  an ordinary employee cannot create an account', asEmployee.status === 404,
  `status=${asEmployee.status} (404, not 403 - existence must not be probeable)`);

await login('priya.menon@panasatech.com');
const asManager = await call('/identity/accounts', {
  method: 'POST', body: JSON.stringify({ employeeId: empId, role: 'hr_admin' }),
});
check('AC5  nor can a manager - including asking for hr_admin', asManager.status === 404,
  `status=${asManager.status}`);

const asManagerRead = await call(`/identity/accounts/by-employee/${empId}`);
check('AC6  nor can a manager even READ the account state', asManagerRead.status === 404,
  `status=${asManagerRead.status}`);

// ================================================================ 3. provisioning
console.log('\n3. HR provisions the login');
await login('deepa.suresh@panasatech.com');

const created = await call('/identity/accounts', {
  method: 'POST', body: JSON.stringify({ employeeId: empId, role: 'employee' }),
});
const code = created.body?.activationCode;
const userId = created.body?.userId;
check('AC7  HR creates the account and receives an activation code', created.ok && !!code,
  code ? `${String(code)} (${String(code).replace(/-/g, '').length} chars)`
    : JSON.stringify(created.body));

check('AC8  the code is transcribable - no look-alikes, grouped for reading aloud',
  typeof code === 'string' && /^[23456789ABCDEFGHJKMNPQRSTVWXYZ-]+$/.test(code)
  && !/[01ILOU]/.test(code) && code.includes('-'), String(code));

const state = await call(`/identity/accounts/by-employee/${empId}`);
const stateJson = JSON.stringify(state.body ?? {});
check('AC9  the code is NOT recoverable from any endpoint, even for the issuer',
  state.ok && state.body?.hasAccount === true && state.body?.activated === false
  && !stateJson.includes(String(code).replace(/-/g, ''))
  && !Object.keys(state.body ?? {}).some((k) => /code|token|secret|password/i.test(k)),
  `keys: ${Object.keys(state.body ?? {}).join(', ')}`);

check('AC10 the state reports a live code with an expiry', !!state.body?.liveActivationExpiresAt
  && Number(state.body?.activationsIssued) === 1,
  `issued=${state.body?.activationsIssued} expires=${String(state.body?.liveActivationExpiresAt).slice(0, 10)}`);

const dupe = await call('/identity/accounts', {
  method: 'POST', body: JSON.stringify({ employeeId: empId, role: 'employee' }),
});
check('AC11 provisioning the same employee twice is refused, and says what to do instead',
  dupe.status === 400 && /reissue/i.test(String(dupe.body?.message ?? '')),
  `${dupe.status}: ${String(dupe.body?.message ?? '').slice(0, 68)}`);

/*
 * AC12 USED TO ASSERT THE OPPOSITE. When provisioning shipped, `ck_app_user_role` permitted three
 * roles and a fourth was correctly refused; migration 0031 widened the column to seven and the
 * endpoint's list was not updated with it, so the Create login screen went on offering three. The
 * check now pins the CURRENT rule - every granted role can also be provisioned - and an invented
 * one is still refused, which is the part that must not regress.
 */
const wideRole = await call('/identity/accounts', {
  method: 'POST', body: JSON.stringify({ employeeId: empId, role: 'finance' }),
});
check('AC12 any of the seven roles can be provisioned, including finance',
  wideRole.status === 400 && /already has a login/i.test(String(wideRole.body?.message ?? '')),
  'refused only because this employee already has one - not because finance is disallowed');

const inventedRole = await call('/identity/accounts', {
  method: 'POST', body: JSON.stringify({ employeeId: empId, role: 'chief_wizard' }),
});
check('AC12b but an invented role is still refused', inventedRole.status === 400
  && /Role must be one of/.test(String(inventedRole.body?.message ?? '')),
  String(inventedRole.body?.message ?? '').slice(0, 66));

// ================================================================ 4. not a reset by the back door
console.log('\n4. Issuing a code is not a password reset');

const hrUser = haveDb
  ? sql(`SELECT id FROM app_user WHERE email = 'deepa.suresh@panasatech.com'`) : '';
if (haveDb && hrUser) {
  const viaApi = await call(`/identity/accounts/${hrUser}/activation`, { method: 'POST' });
  check('AC13 HR cannot mint an activation code for an account that already has a password',
    viaApi.status === 400 && /reset/i.test(String(viaApi.body?.message ?? '')),
    `${viaApi.status}: ${String(viaApi.body?.message ?? '').slice(0, 68)}`);

  let dbRefused = false;
  try {
    sql(`INSERT INTO user_activation (user_id, token_hash, issued_by_user_id, expires_at)
         VALUES ('${hrUser}', repeat('9', 64), '${hrUser}', now() + INTERVAL '1 day')`);
  } catch { dbRefused = true; }
  check('AC14 and the DATABASE refuses it too, so the rail is not the controller remembering',
    dbRefused, '0029 trg_user_activation_requires_no_credential');
} else {
  check('AC13 HR cannot mint a code for an account with a password', false, 'no docker - skipped');
  check('AC14 and the database refuses it too', false, 'no docker - skipped');
}

// ================================================================ 5. redemption
console.log('\n5. The employee activates, and only they know the password');

const messages = new Set();
for (const [label, bad] of [
  ['an unknown code', 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ'],
  ['a malformed code', 'ZZZZZ'],
]) {
  const r = await call('/identity/activate', {
    method: 'POST', body: JSON.stringify({ code: bad, password: CHOSEN }),
  });
  messages.add(String(r.body?.message ?? ''));
  check(`AC15a ${label} is refused`, r.status === 400);
}
check('AC15 every rejection gives the SAME message, so nothing confirms a code was real',
  messages.size === 1, [...messages][0]?.slice(0, 62));

const weak = await call('/identity/activate', {
  method: 'POST', body: JSON.stringify({ code, password: 'short' }),
});
check('AC16a a password under the NIST length floor is refused',
  weak.status === 400 && /12 characters/.test(String(weak.body?.message ?? '')),
  String(weak.body?.message ?? '').slice(0, 56));

const named = await call('/identity/activate', {
  method: 'POST', body: JSON.stringify({ code, password: 'meera-nair-rules-ok' }),
});
check('AC16b a password containing the account holder\'s own name is refused',
  named.status === 400, String(named.body?.message ?? '').slice(0, 56));

const lower = await call('/identity/activate', {
  method: 'POST', body: JSON.stringify({ code: String(code).toLowerCase(), password: CHOSEN }),
});
check('AC17 the code is accepted lowercase and re-grouped - somebody will retype it by hand',
  lower.ok && lower.body?.ok === true, JSON.stringify(lower.body));

const reuse = await call('/identity/activate', {
  method: 'POST', body: JSON.stringify({ code, password: `${CHOSEN}-again` }),
});
check('AC18 the code cannot be spent twice', reuse.status === 400,
  `${reuse.status}: ${String(reuse.body?.message ?? '').slice(0, 52)}`);

// ================================================================ 6. it actually works
console.log('\n6. The new employee can sign in, with the right roles');

jar = '';
const realLogin = await call('/auth/login', {
  method: 'POST', body: JSON.stringify({ email: EMAIL, password: CHOSEN }),
});
check('AC19 the employee signs in with the password THEY chose', realLogin.ok
  && realLogin.body?.actor?.employeeNumber === EMP_NO,
  `${realLogin.status} ${realLogin.body?.actor?.employeeNumber ?? ''}`);

check('AC20 and holds a real role, from the effective-dated grant table',
  (realLogin.body?.actor?.roles ?? []).includes('employee'),
  `roles=${JSON.stringify(realLogin.body?.actor?.roles ?? [])}`);

const meDash = await call('/dashboard');
check('AC21 and the application answers them - the account is genuinely usable',
  meDash.ok && !!meDash.body?.me, `${meDash.status}`);

if (haveDb) {
  const stored = sql(`SELECT password_algo || '|' || left(password_hash, 7)
                        FROM app_user WHERE email = '${EMAIL}'`);
  check('AC22 the credential is a scrypt digest, in the format the login path verifies',
    stored === 'scrypt|scrypt$', stored);

  const raw = sql(`SELECT count(*) FROM user_activation a JOIN app_user u ON u.id = a.user_id
                    WHERE u.email = '${EMAIL}' AND a.token_hash !~ '^[0-9a-f]{64}$'`);
  check('AC23 no activation row holds anything but a SHA-256 digest', raw === '0', raw);

  const spent = sql(`SELECT consumed_reason FROM user_activation a
                       JOIN app_user u ON u.id = a.user_id WHERE u.email = '${EMAIL}'`);
  check('AC24 the activation is recorded as redeemed', spent === 'redeemed', spent);

  const audited = sql(`SELECT string_agg(DISTINCT event_type, ',' ORDER BY event_type)
                         FROM audit_event
                        WHERE event_type LIKE 'identity.account%' AND row_pk = '${userId}'`);
  check('AC25 both the creation and the activation are in the audit trail',
    audited === 'identity.account.activated,identity.account.created', audited);

  const events = sql(`SELECT count(*) FROM outbox_event WHERE aggregate_id = '${userId}'`);
  check('AC26 and both emitted a domain event through the outbox (Rule 2)',
    Number(events) === 2, `${events} events`);
}

// ================================================================ 7. reissue
console.log('\n7. Reissue, for the code that got lost');
await login('deepa.suresh@panasatech.com');

const afterActivation = await call(`/identity/accounts/${userId}/activation`, { method: 'POST' });
check('AC27 reissue is refused once the account HAS a password - that would be a reset',
  afterActivation.status === 400 && /reset/i.test(String(afterActivation.body?.message ?? '')),
  `${afterActivation.status}: ${String(afterActivation.body?.message ?? '').slice(0, 56)}`);

if (haveDb) {
  // Put the account back to un-activated, so reissue is exercised on the state it is for.
  sql(`UPDATE app_user SET password_hash = NULL, password_algo = NULL, password_set_at = NULL
        WHERE email = '${EMAIL}'`);

  const first = await call(`/identity/accounts/${userId}/activation`, { method: 'POST' });
  const second = await call(`/identity/accounts/${userId}/activation`, { method: 'POST' });
  check('AC28 reissue mints a NEW code, twice over, without tripping the one-live index',
    first.ok && second.ok && first.body?.activationCode !== second.body?.activationCode,
    `${first.status}/${second.status}`);

  const stale = await call('/identity/activate', {
    method: 'POST',
    body: JSON.stringify({ code: first.body?.activationCode, password: CHOSEN }),
  });
  check('AC29 the SUPERSEDED code no longer works - only the newest one does',
    stale.status === 400, `${stale.status}`);

  const live = sql(`SELECT count(*) FROM user_activation a JOIN app_user u ON u.id = a.user_id
                     WHERE u.email = '${EMAIL}' AND a.consumed_at IS NULL`);
  check('AC30 exactly ONE live code exists after two reissues', live === '1', `${live} live`);
}

// ================================================================ 7b. multiple roles
console.log('\n7b. Roles are a set, not a slot');

/*
 * WHAT CARRIES THE WEIGHT HERE IS AC38: an HR admin must not be able to grant themselves a role.
 *
 * `finance` is the role that approves salary annexures, and `ck_sae_no_self_approval` only stops
 * somebody approving their OWN package - it does nothing about an HR admin awarding themselves
 * `finance` and then approving every annexure they prepared for other people. That is the
 * separation of duty the onboarding chain is built on, undone in two clicks, so the refusal is
 * asserted rather than assumed.
 */
await login('deepa.suresh@panasatech.com');

// A fresh account to experiment on: EMP006's, provisioned above and reset at the end.
const rolesTarget = haveDb
  ? sql(`SELECT u.id FROM app_user u JOIN employee e ON e.id = u.employee_id
          WHERE e.employee_number = 'EMP002'`) : '';

/**
 * Put EMP002 back to {employee, manager} BEFORE the run as well as after.
 *
 * The teardown at the end is not enough on its own: a run that dies part-way leaves a live
 * `finance` grant, and the next run's AC35 is then correctly refused as a duplicate - a stale
 * fixture reported as a product failure. Same lesson as the EMP006 reset at the top of this file.
 */
const resetPriyaRoles = () => {
  if (!haveDb) return;
  sql(`DO $$
       DECLARE v_u UUID;
       BEGIN
         SELECT u.id INTO v_u FROM app_user u JOIN employee e ON e.id = u.employee_id
          WHERE e.employee_number = 'EMP002';
         IF v_u IS NULL THEN RETURN; END IF;
         ALTER TABLE user_role DISABLE TRIGGER tg_user_role_immutable_history;
         DELETE FROM user_role WHERE user_id = v_u AND role NOT IN ('employee', 'manager');
         UPDATE user_role SET valid_to = NULL WHERE user_id = v_u AND role = 'manager';
         ALTER TABLE user_role ENABLE ALWAYS TRIGGER tg_user_role_immutable_history;
       END $$;`);
};
resetPriyaRoles();

if (haveDb && rolesTarget) {
  const before = await call(`/identity/accounts/by-employee/${
    sql(`SELECT id FROM employee WHERE employee_number = 'EMP002'`)}`);
  check('AC34 an account reports every role it holds, with the grant behind each',
    (before.body?.roles ?? []).includes('manager')
    && (before.body?.grants ?? []).some((g) => g.role === 'manager' && g.in_force),
    (before.body?.roles ?? []).join(', '));

  const granted = await call(`/identity/accounts/${rolesTarget}/roles`, {
    method: 'POST', body: JSON.stringify({ role: 'finance', reason: 'covering for the quarter' }),
  });
  check('AC35 HR grants a SECOND role, additively', granted.ok, `${granted.status}`);

  const after = await call(`/identity/accounts/by-employee/${
    sql(`SELECT id FROM employee WHERE employee_number = 'EMP002'`)}`);
  check('AC36 and the account now holds both - nothing was replaced',
    (after.body?.roles ?? []).includes('manager') && (after.body?.roles ?? []).includes('finance'),
    (after.body?.roles ?? []).join(', '));

  const dupe = await call(`/identity/accounts/${rolesTarget}/roles`, {
    method: 'POST', body: JSON.stringify({ role: 'finance' }),
  });
  check('AC37 granting the same role twice is refused', dupe.status === 400,
    String(dupe.body?.message ?? '').slice(0, 52));

  // THE ESCALATION. HR granting themselves the role that approves salary annexures.
  const myUser = sql(`SELECT id FROM app_user WHERE email = 'deepa.suresh@panasatech.com'`);
  const selfGrant = await call(`/identity/accounts/${myUser}/roles`, {
    method: 'POST', body: JSON.stringify({ role: 'finance' }),
  });
  check('AC38 HR CANNOT grant themselves a role - that would undo separation of duty',
    selfGrant.status === 400 && /yourself/i.test(String(selfGrant.body?.message ?? '')),
    String(selfGrant.body?.message ?? '').slice(0, 60));

  const noReason = await call(`/identity/accounts/${rolesTarget}/roles/finance/revoke`,
    { method: 'POST', body: JSON.stringify({}) });
  check('AC39 revoking without a reason is refused', noReason.status === 400,
    String(noReason.body?.message ?? '').slice(0, 48));

  const revoked = await call(`/identity/accounts/${rolesTarget}/roles/finance/revoke`, {
    method: 'POST', body: JSON.stringify({ reason: 'the quarter ended' }),
  });
  check('AC40 revoking closes the period', revoked.ok, `${revoked.status}`);

  /*
   * AC41: A ROLE CANNOT BE HELD FOR ZERO DAYS, so a grant made today ends TOMORROW.
   *
   * `ck_user_role_not_empty` refuses `[today, today)`. The first version of this suite assumed
   * revocation was always immediate and failed with a 500, which is the model telling the truth:
   * a grant is a period, and the ordinary case - revoking something granted weeks ago - IS
   * immediate, because `valid_to = today` on a half-open period excludes today. Both are asserted,
   * rather than the awkward one being smoothed over.
   */
  check('AC41 a grant made TODAY is closed from tomorrow, and says so',
    revoked.body?.deferred === true && !!revoked.body?.endsOn,
    `ends ${revoked.body?.endsOn} - a role held for zero days is not a period`);

  const afterRevoke = await call(`/identity/accounts/by-employee/${
    sql(`SELECT id FROM employee WHERE employee_number = 'EMP002'`)}`);
  check('AC42 the grant is in the record with an end date, not erased',
    (afterRevoke.body?.grants ?? []).some((g) => g.role === 'finance' && !!g.valid_to),
    '"who could have approved this in March" is answerable because nothing is deleted');

  // ... and the ordinary case: revoking a grant made BEFORE today takes effect at once. The seed
  // granted `manager` on Priya's joining date, so it is the realistic shape.
  const oldGrant = await call(`/identity/accounts/${rolesTarget}/roles/manager/revoke`, {
    method: 'POST', body: JSON.stringify({ reason: 'checking immediate revocation' }),
  });
  check('AC42b revoking a grant made BEFORE today takes effect immediately',
    oldGrant.ok && oldGrant.body?.deferred === false, `ends ${oldGrant.body?.endsOn}`);

  const afterOld = await call(`/identity/accounts/by-employee/${
    sql(`SELECT id FROM employee WHERE employee_number = 'EMP002'`)}`);
  check('AC42c and the role is gone from what they hold today',
    !(afterOld.body?.roles ?? []).includes('manager'),
    (afterOld.body?.roles ?? []).join(', '));

  if (haveDb) {
    const rows = sql(`SELECT count(*) FROM user_role ur JOIN app_user u ON u.id = ur.user_id
                       JOIN employee e ON e.id = u.employee_id
                      WHERE e.employee_number = 'EMP002' AND ur.role = 'finance'`);
    check('AC43 nothing was deleted - Rule 3 permits closing a period, never removing it',
      rows === '1', `${rows} finance grant row(s) retained`);
  }

  const baseRole = await call(`/identity/accounts/${rolesTarget}/roles/employee/revoke`, {
    method: 'POST', body: JSON.stringify({ reason: 'trying to strip the base role' }),
  });
  check('AC44 the `employee` role cannot be removed', baseRole.status === 400,
    String(baseRole.body?.message ?? '').slice(0, 52));

  const lastHr = await call(`/identity/accounts/${myUser}/roles/hr_admin/revoke`, {
    method: 'POST', body: JSON.stringify({ reason: 'locking everyone out' }),
  });
  check('AC45 the LAST hr_admin cannot be revoked - nobody could grant it back',
    lastHr.status === 400 && /last HR/i.test(String(lastHr.body?.message ?? '')),
    String(lastHr.body?.message ?? '').slice(0, 58));

  /*
   * PUT EMP002 BACK. This suite genuinely changed a seeded person's privileges, and other suites
   * assume Priya is a manager - `reports:test` and `work:test` both read through the reporting
   * graph she anchors. The API cannot undo it (Rule 3: a closed period stays closed), so the
   * teardown goes round it the same way the seed does, with the history trigger stood down. That
   * is a deliberate, narrow use of owner privilege in a test, not a hole in the rail.
   */
  resetPriyaRoles();

  const finalRoles = sql(`SELECT fn_user_roles(u.id)::text FROM app_user u
                            JOIN employee e ON e.id = u.employee_id
                           WHERE e.employee_number = 'EMP002'`);
  check('AC46 the fixture is left holding exactly the roles it started with',
    finalRoles === '{employee,manager}', finalRoles);
}

// ================================================================ 8. nothing leaked
console.log('\n8. Nothing sensitive crossed the wire, and the fixture is as we found it');

check('AC31 no response body in this run contained a password or a hash',
  !seenBodies.some((b) => b.includes(CHOSEN) || b.includes('scrypt$') || /"password_hash"/.test(b)),
  `${seenBodies.length} response bodies inspected`);

const wasReset = resetAccount();
if (haveDb) {
  const left = sql(`SELECT (SELECT count(*) FROM employee WHERE employee_number = '${EMP_NO}')
                           || '/' ||
                           (SELECT count(*) FROM app_user u JOIN employee e ON e.id = u.employee_id
                             WHERE e.employee_number = '${EMP_NO}')`);
  check('AC32 the fixture is left exactly as found: the employee remains, the login is gone',
    wasReset && left === '1/0', `employee/login = ${left}`);

  /*
   * AC33: the employee could NOT have been deleted even if this suite wanted to, and that is the
   * point rather than a limitation. `employment_event` is append-only and holds a foreign key to
   * `employee`, so creating a person is irreversible - Rule 3 working. Asserted rather than left
   * in a comment, because the first version of this suite tried to delete the row and spent a
   * while looking for a bug that was a guarantee.
   */
  let deleteRefused = false;
  try {
    sql(`DELETE FROM employment_event
          WHERE employee_id = (SELECT id FROM employee WHERE employee_number = '${EMP_NO}')`);
  } catch { deleteRefused = true; }
  check('AC33 and an employee record cannot be erased at all - append-only, by design',
    deleteRefused, 'fn_block_mutation on employment_event');
}

console.log(`\n${'='.repeat(37)}\n  ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log('  ACCOUNTS OK\n');
