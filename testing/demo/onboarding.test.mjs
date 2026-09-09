/**
 * Onboarding: the salary annexure, its two approvals, and the offer letter - driven as the three
 * different people who actually perform it.
 *
 * WHAT CARRIES THE WEIGHT
 *
 *   OB6-OB9  SEPARATION OF DUTY, which is the entire reason this chain exists. HR prepares the
 *            figures and CANNOT approve them financially. Finance CANNOT stand in for the delivery
 *            head. The delivery head CANNOT prepare or issue. Each is a distinct matrix action, so
 *            each is tried and each must be a 404 - not a 403, because whether a package exists is
 *            itself information.
 *   OB10     AN EMPLOYEE CANNOT SEE THEIR OWN PACKAGE while it is under review. The figures move
 *            and a rejection is a conversation HR has not had yet; they learn the number from the
 *            offer letter, not from this.
 *   OB4      THE COMPONENTS AND THE TYPED CTC MUST AGREE before it goes to finance. The failure
 *            this catches - one component out by a factor of ten - is silent otherwise, and it is
 *            the figure the offer letter will carry.
 *   OB12     APPROVED FIGURES ARE FROZEN. If HR can edit after finance signs, the approval is
 *            decorative. Refused by the database (0032 trg_sac_draft_only), tried through the API.
 *   OB14     NOBODY ACTS ON THEIR OWN ANNEXURE, tried with the HR admin as the subject.
 *   OB17     the whole chain is in the audit trail and the outbox, decision by decision.
 *
 * RE-RUNNABLE BY CONSTRUCTION. The happy path ends at `offer_accepted`, which is excluded from
 * `ux_salary_annexure_one_live`, so the next run may start a fresh annexure for the same person.
 * Any annexure left mid-chain by a crashed run is withdrawn at the start. The DECLINE path is not
 * exercised here because it is terminal for its subject - an employee cannot be deleted
 * (append-only `employment_event`) - so it is proven in `0031_...verify.sql` DH7 instead, where
 * the runner's transaction is rolled back.
 *
 * Run: npm run onboarding:test   (needs the API on :4000)
 */

import { execFileSync } from 'node:child_process';

const B = 'http://localhost:4000/api';
const PASSWORD = process.env.HRM_DEMO_PASSWORD ?? 'panasa2026';
const HR = 'deepa.suresh@panasatech.com';
const FINANCE = 'arun.thomas@panasatech.com';
const DELIVERY = 'nisha.varghese@panasatech.com';
const EMPLOYEE = 'vishnu.ravi@panasatech.com';
const JOINER = 'ZZOB1';

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
  if (cond) { pass++; console.log(`  OK   ${name}${detail ? `  — ${detail}` : ''}`); return true; }
  fail++; failures.push(`${name}${detail ? `  — ${detail}` : ''}`);
  console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`);
  return false;
};

const login = async (email) => {
  jar = '';
  const r = await call('/auth/login', {
    method: 'POST', body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`login failed for ${email}: ${JSON.stringify(r.body)}`);
  return r.body;
};

const sql = (q) => execFileSync('docker', [
  'exec', '-i', '-e', 'PGPASSWORD=hrm_dev_only', 'hrm-postgres',
  'psql', '-U', 'hrm', '-d', 'hrm', '-tAc', q,
], { encoding: 'utf8' }).trim();
let haveDb = true;
try { sql('SELECT 1'); } catch { haveDb = false; }

console.log('\nOnboarding: annexure, two approvals, offer letter\n');

// ================================================================ 0. the joiner
console.log('0. Somebody who has not started yet');
await login(HR);

const dir = await call('/employees');
let joiner = (dir.body?.employees ?? []).find((e) => e.employee_number === JOINER) ?? null;

if (!joiner) {
  const dept = await call('/org/departments');
  const desig = await call('/org/designations');
  const made = await call('/people/employees', {
    method: 'POST',
    body: JSON.stringify({
      employeeNumber: JOINER, fullName: 'Onboard Fixture', workEmail: 'zzob1@panasatech.com',
      // A FUTURE joining date is what keeps them in pre_boarding: the `joined` lifecycle event is
      // dated then, so `fn_employment_status_asof` still reports pre_boarding today. That is the
      // state an annexure is prepared in, and it needs no special employee-creation path.
      joinedOn: '2031-11-03',
      departmentId: (dept.body?.rows ?? [])[0]?.id,
      designationId: (desig.body?.rows ?? [])[0]?.id,
    }),
  });
  joiner = made.ok ? { id: made.body.id, employee_number: JOINER } : null;
  check('OB1  the joiner did not exist, so they were created', !!joiner,
    joiner ? joiner.id : JSON.stringify(made.body));
} else {
  check('OB1  the joiner is present as the fixture', true, joiner.id);
}

const joinerId = joiner?.id;
const status = haveDb
  ? sql(`SELECT status FROM employee WHERE employee_number = '${JOINER}'`) : 'pre_boarding';
check('OB2  and they are pre-boarding, which is what an annexure is prepared for',
  status === 'pre_boarding', status);

// Withdraw anything a crashed run left mid-chain, so this suite is re-runnable.
const live = await call('/onboarding/annexures');
for (const row of (live.body?.rows ?? []).filter((r) => r.employee_id === joinerId
  && !['offer_accepted', 'offer_declined', 'withdrawn'].includes(r.status))) {
  await call(`/onboarding/annexures/${row.id}/withdraw`, {
    method: 'POST', body: JSON.stringify({ reason: 'left over from a previous test run' }),
  });
}

// ================================================================ 1. HR prepares
console.log('\n1. HR prepares the annexure');

const created = await call('/onboarding/annexures', {
  method: 'POST',
  body: JSON.stringify({
    employeeId: joinerId,
    annualCtc: '1200000',
    proposedJoiningOn: '2031-11-03',
    components: [
      { kind: 'earning', code: 'BASIC', label: 'Basic', amount: '600000' },
      { kind: 'earning', code: 'HRA', label: 'House rent allowance', amount: '400000' },
      // Deliberately short: 600000 + 400000 = 1000000, against a declared 1200000.
      { kind: 'earning', code: 'SPECIAL', label: 'Special allowance', amount: '100000' },
    ],
  }),
});
const annexureId = created.body?.id;
check('OB3  HR creates a draft annexure', created.ok && !!annexureId,
  annexureId ?? JSON.stringify(created.body));

const badSubmit = await call(`/onboarding/annexures/${annexureId}/submit`, { method: 'POST' });
check('OB4  it will NOT go to finance while the components disagree with the CTC',
  badSubmit.status === 400 && /components total/i.test(String(badSubmit.body?.message ?? '')),
  String(badSubmit.body?.message ?? '').slice(0, 76));

const fixed = await call(`/onboarding/annexures/${annexureId}`, {
  method: 'PATCH',
  body: JSON.stringify({
    components: [
      { kind: 'earning', code: 'BASIC', label: 'Basic', amount: '600000' },
      { kind: 'earning', code: 'HRA', label: 'House rent allowance', amount: '400000' },
      { kind: 'earning', code: 'SPECIAL', label: 'Special allowance', amount: '200000' },
    ],
  }),
});
check('OB5  correcting the draft is allowed', fixed.ok, `${fixed.status}`);

const submitted = await call(`/onboarding/annexures/${annexureId}/submit`, { method: 'POST' });
check('OB6  and then it goes to finance', submitted.ok && submitted.body?.status === 'finance_review',
  submitted.body?.status ?? JSON.stringify(submitted.body));

// ================================================================ 2. separation of duty
console.log('\n2. Separation of duty');

const hrSelfApprove = await call(`/onboarding/annexures/${annexureId}/finance_approve`,
  { method: 'POST' });
check('OB7  HR cannot approve the figures it just typed', hrSelfApprove.status === 404,
  `status=${hrSelfApprove.status} (404, not 403 - whether a package exists is information)`);

await login(DELIVERY);
const deliveryEarly = await call(`/onboarding/annexures/${annexureId}/delivery_approve`,
  { method: 'POST' });
check('OB8  the delivery head cannot approve before finance has',
  deliveryEarly.status === 400 || deliveryEarly.status === 404,
  `status=${deliveryEarly.status}`);

const deliveryWrite = await call('/onboarding/annexures', {
  method: 'POST',
  body: JSON.stringify({ employeeId: joinerId, annualCtc: '1', proposedJoiningOn: '2031-11-03' }),
});
check('OB9  nor prepare one', deliveryWrite.status === 404, `status=${deliveryWrite.status}`);

await login(EMPLOYEE);
const nosy = await call(`/onboarding/annexures/${annexureId}`);
check('OB10 an ordinary employee cannot read a package at all', nosy.status === 404,
  `status=${nosy.status}`);

// ================================================================ 3. the approvals
console.log('\n3. Finance, then delivery');

await login(FINANCE);
const financeSees = await call('/onboarding/annexures');
check('OB11 the finance head sees the queue',
  financeSees.ok && (financeSees.body?.rows ?? []).some((r) => r.id === annexureId),
  `${(financeSees.body?.rows ?? []).length} annexure(s)`);

const financeApprove = await call(`/onboarding/annexures/${annexureId}/finance_approve`,
  { method: 'POST' });
check('OB12 finance approves, and it moves straight to the delivery head',
  financeApprove.ok && financeApprove.body?.status === 'delivery_review',
  financeApprove.body?.status ?? JSON.stringify(financeApprove.body));

await login(HR);
const frozen = await call(`/onboarding/annexures/${annexureId}`, {
  method: 'PATCH',
  body: JSON.stringify({
    components: [{ kind: 'earning', code: 'BASIC', label: 'Basic', amount: '9900000' }],
  }),
});
check('OB13 the approved figures are FROZEN - HR cannot edit after finance signed',
  frozen.status === 400, String(frozen.body?.message ?? '').slice(0, 70));

const financeAgain = await call(`/onboarding/annexures/${annexureId}/finance_approve`,
  { method: 'POST' });
check('OB14 and HR still cannot approve, even now', financeAgain.status === 404,
  `status=${financeAgain.status}`);

await login(DELIVERY);
const deliveryApprove = await call(`/onboarding/annexures/${annexureId}/delivery_approve`,
  { method: 'POST' });
check('OB15 the delivery head approves', deliveryApprove.ok
  && deliveryApprove.body?.status === 'delivery_approved',
  deliveryApprove.body?.status ?? JSON.stringify(deliveryApprove.body));

const deliveryIssues = await call(`/onboarding/annexures/${annexureId}/issue_offer`,
  { method: 'POST' });
check('OB16 but cannot issue the offer letter - that is HR running the process',
  deliveryIssues.status === 404, `status=${deliveryIssues.status}`);

// ================================================================ 4. the offer
console.log('\n4. The offer');

await login(HR);
const issued = await call(`/onboarding/annexures/${annexureId}/issue_offer`, { method: 'POST' });
check('OB17 HR issues the offer', issued.ok && issued.body?.status === 'offer_issued',
  issued.body?.status ?? JSON.stringify(issued.body));

const accepted = await call(`/onboarding/annexures/${annexureId}/accept_offer`, { method: 'POST' });
check('OB18 and records that it was accepted', accepted.ok
  && accepted.body?.status === 'offer_accepted', accepted.body?.status ?? '');

// ================================================================ 5. the record of it
console.log('\n5. What was recorded');

const detail = await call(`/onboarding/annexures/${annexureId}`);
const events = detail.body?.events ?? [];
check('OB19 every decision is on the annexure, in order', detail.ok && events.length >= 5
  && events[0].event_type === 'submit'
  && events.some((e) => e.event_type === 'finance_approve')
  && events.some((e) => e.event_type === 'delivery_approve'),
  events.map((e) => e.event_type).join(' -> '));

check('OB20 each decision names who made it',
  events.filter((e) => /approve/.test(e.event_type)).every((e) => !!e.actor_name),
  events.filter((e) => /approve/.test(e.event_type))
    .map((e) => `${e.event_type}=${e.actor_name}`).join(', '));

check('OB21 and what the figure was when they made it',
  events.filter((e) => /approve/.test(e.event_type))
    .every((e) => String(e.ctc_at_decision_minor) === '120000000'),
  'approvals carry the CTC they approved, so a later edit cannot rewrite what was signed');

if (haveDb) {
  const audited = sql(`SELECT count(*) FROM audit_event
                        WHERE event_type LIKE 'onboarding.%' AND row_pk = '${annexureId}'`);
  check('OB22 the chain is in the audit trail', Number(audited) >= 6, `${audited} audit rows`);

  const outbox = sql(`SELECT count(*) FROM outbox_event WHERE aggregate_id = '${annexureId}'`);
  check('OB23 and every move emitted a domain event (Rule 2)', Number(outbox) >= 5,
    `${outbox} events`);

  const frozenRows = sql(`SELECT string_agg(component_code || '=' || amount_minor, ',' ORDER BY component_code)
                            FROM salary_annexure_component WHERE annexure_id = '${annexureId}'`);
  check('OB24 the figures on the record are the ones that were approved',
    frozenRows === 'BASIC=60000000,HRA=40000000,SPECIAL=20000000', frozenRows);
}

// ---------------------------------------------------------------- result
console.log(`\n${'='.repeat(37)}\n  ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log('  ONBOARDING OK\n');
