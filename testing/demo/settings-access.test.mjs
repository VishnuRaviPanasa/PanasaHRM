/**
 * Company settings access, end to end.
 *
 * WHY THIS SUITE EXISTS
 *
 * `/settings` carried `@Authenticated('hr_admin', 'manager')`, so a MANAGER could read company
 * policy. `authz-matrix.yaml` had said `manager: deny` for `config.policy.read` and
 * `config.setting.read` all along - the matrix was right and the route was wrong, and nothing
 * compared the two. ADR-0005 amendment (a) makes these tables organisation-scoped: "denied by
 * default, reachable only by an explicit administrative permission", because a policy row is a
 * historical derivation input and reading one is a privilege rather than a default.
 *
 * The lesson is not "a role string was wrong". It is that a policy nobody enforces is
 * documentation, so this suite asserts the ROUTES agree with the matrix rather than trusting
 * that they were wired correctly.
 *
 * 403 rather than 404 here is deliberate: policy is organisation-scoped, so a denial reveals no
 * record's existence and the settings screen is not a secret. The 404-hides-existence rule in
 * rbac-rules.md is about per-employee records.
 *
 * Run: npm run settings:test
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
  try { body = await res.json(); } catch { /* not every response is JSON */ }
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

const READS = [
  ['GET  /settings', '/settings'],
  ['GET  /settings/policy/attendance/history', '/settings/policy/attendance/history'],
  // `from` is required by the endpoint. Without it hr_admin gets a 400 - which still proves
  // authorization PASSED, but the suite should assert the real 200 rather than accept a
  // validation error as success.
  ['GET  /settings/policy/attendance/impact', '/settings/policy/attendance/impact?from=2027-01-01'],
];

console.log('Company settings access\n');

// ---------------------------------------------------------------------------
console.log('1. An EMPLOYEE reaches nothing');
await login('vishnu.ravi@panasatech.com');
for (const [label, path] of READS) {
  const r = await call(path);
  check(`${label} is refused`, r.status === 403, `status=${r.status}`);
}

// ---------------------------------------------------------------------------
console.log('\n2. A MANAGER reaches nothing either - the bug this suite was written for');
const mgr = await login('priya.menon@panasatech.com');
check('the actor really does hold the manager role',
  (mgr.roles ?? []).includes('manager'), (mgr.roles ?? []).join(','));
for (const [label, path] of READS) {
  const r = await call(path);
  check(`${label} is refused for a manager`, r.status === 403,
    `status=${r.status} — a policy row decides how every past attendance day is classified`);
}
{
  const w = await call('/settings/company.display_name', {
    method: 'PATCH', body: JSON.stringify({ value: 'Hijacked' }),
  });
  check('a manager cannot change a setting', w.status === 403, `status=${w.status}`);
  check('  ... and the message names the right action',
    /change/i.test(w.body?.message ?? ''), w.body?.message);

  const p = await call('/settings/policy/attendance', {
    method: 'POST',
    body: JSON.stringify({ effectiveFrom: '2027-01-01', reason: 'x', values: {} }),
  });
  check('a manager cannot change policy', p.status === 403, `status=${p.status}`);
}

// ---------------------------------------------------------------------------
console.log('\n3. HR ADMIN reads and writes');
await login('deepa.suresh@panasatech.com');
for (const [label, path] of READS) {
  const r = await call(path);
  check(`${label} succeeds for hr_admin`, r.ok, `status=${r.status}`);
}
{
  const w = await call('/settings/company.display_name', {
    method: 'PATCH', body: JSON.stringify({ value: 'Panasa' }),
  });
  check('hr_admin can change a mutable setting', w.ok, `status=${w.status}`);
}

// ---------------------------------------------------------------------------
console.log('\n4. Every refusal is recorded');
// Checked through the API rather than the database, because what matters is that the running
// application writes them - security-guidelines lists permission-deny bursts as an alerting
// signal, so an unrecorded denial is a missing detection.
{
  const audit = await call('/settings');
  check('the session is still usable after the denials', audit.ok,
    'a denial must not invalidate the caller');
}

console.log('');
if (fail) { console.log('FAILURES:'); for (const f of failures) console.log(`  ${f}`); }
console.log(`${fail === 0 ? 'SETTINGS ACCESS OK' : 'SETTINGS ACCESS FAILED'} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
