/**
 * The authorization matrix suite - the highest-value tests in the repo.
 *
 * ADR-0005: `authz-matrix.yaml` enumerates (role x action) and CI generates a test per cell
 * asserting BOTH directions. Both directions is the whole point. A one-directional suite catches
 * under-permitting, which users report loudly, and misses over-permitting, which they never do.
 *
 * The `deny` cells are therefore the load-bearing ones: each asserts the role is refused for
 * EVERY candidate target, not merely for one convenient one.
 *
 * The fixture is `ai/context/rbac-rules.md`'s, and it exists to pin named threats rather than to
 * be representative:
 *
 *   CEO - DeptHeadA - M1 - {E1, E2}          HR_ADMIN, HR_OPS, FINANCE, AUDITOR, BREAK_GLASS
 *       - DeptHeadB - M2 - {E3}              T1  was M1's report, terminated
 *                                            X1  transferred M1 -> M2
 *   P1: lead M2, contributors {E1, E3}
 *   P2: lead M1, contributor E3
 *
 * The graph is a FAKE. That is deliberate: this suite tests the POLICY, and the real graph
 * resolvers are tested against PostgreSQL by testing/db/0014_employment_lifecycle.verify.sql
 * (temporal decay, depth distinction, cycle guard). Mixing the two would make a policy failure
 * and a SQL failure indistinguishable.
 *
 * Run: npm run authz:test
 */

import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import {
  ALL_ACTIONS, AuthorizationService, AuthzDeniedError, malformedActionNames, policyFor,
  registeredActions, actionsWithoutPolicy, assertPolicyCoverage,
} from '../../packages/authz/dist/index.js';

const matrix = load(readFileSync('packages/authz/authz-matrix.yaml', 'utf8'));

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail ? `  — ${detail}` : ''}`);
};

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const TRANSFER_DATE = '2026-03-01';
const TERMINATION_DATE = '2026-02-01';

// manager -> direct reports, as of a date
const REPORTS = (asOf) => ({
  CEO: ['DeptHeadA', 'DeptHeadB'],
  DeptHeadA: ['M1'],
  DeptHeadB: ['M2'],
  // T1 was M1's report until termination; X1 until the transfer.
  M1: ['E1', 'E2',
    ...(asOf < TERMINATION_DATE ? ['T1'] : []),
    ...(asOf < TRANSFER_DATE ? ['X1'] : [])],
  M2: ['E3', ...(asOf >= TRANSFER_DATE ? ['X1'] : [])],
});

function subtreeOf(manager, asOf) {
  const map = REPORTS(asOf);
  const out = new Set();
  const walk = (m, depth) => {
    if (depth > 10) return;
    for (const r of map[m] ?? []) { if (!out.has(r)) { out.add(r); walk(r, depth + 1); } }
  };
  walk(manager, 1);
  return out;
}

const PROJECTS = {
  P1: { lead: 'M2', members: ['M2', 'E1', 'E3'] },
  P2: { lead: 'M1', members: ['M1', 'E3'] },
};

const graph = {
  async isDirectReport(mgr, emp, asOf) {
    return (REPORTS(asOf)[mgr] ?? []).includes(emp);
  },
  async isInSubtree(mgr, emp, asOf) {
    return subtreeOf(mgr, asOf).has(emp);
  },
  async isProjectMember(emp, projectId, roles) {
    const p = PROJECTS[projectId];
    if (!p) return false;
    if (roles?.length) return roles.some((r) => (r === 'lead' || r === 'project_manager') && p.lead === emp);
    return p.members.includes(emp);
  },
};

const authz = new AuthorizationService(graph);

const ACTORS = {
  E1:               { employeeId: 'E1', roles: ['employee'] },
  E2:               { employeeId: 'E2', roles: ['employee'] },
  E3:               { employeeId: 'E3', roles: ['employee'] },
  M1:               { employeeId: 'M1', roles: ['employee', 'manager'] },
  M2:               { employeeId: 'M2', roles: ['employee', 'manager'] },
  DeptHeadA:        { employeeId: 'DeptHeadA', roles: ['employee', 'manager'] },
  M1_also_hr_admin: { employeeId: 'M1', roles: ['employee', 'manager', 'hr_admin'] },
  HR_ADMIN:         { employeeId: 'HRA', roles: ['employee', 'hr_admin'] },
  HR_OPS:           { employeeId: 'HRO', roles: ['employee', 'hr_ops'] },
  FINANCE:          { employeeId: 'FIN', roles: ['employee', 'finance'] },
  AUDITOR:          { employeeId: 'AUD', roles: ['employee', 'auditor'] },
  BREAK_GLASS:      { employeeId: null, roles: ['hr_admin'], isBreakGlass: true },
};

const ctxOf = (name) => {
  const a = ACTORS[name];
  if (!a) throw new Error(`no such fixture actor: ${name}`);
  return {
    userId: `u-${name}`,
    employeeId: a.employeeId,
    roles: a.roles,
    isBreakGlass: a.isBreakGlass ?? false,
  };
};

/** A context holding exactly one role, for the per-cell matrix sweep. */
const soleRoleCtx = (role, employeeId = 'M1') => ({
  userId: `u-${role}`, employeeId, roles: [role], isBreakGlass: false,
});

// ---------------------------------------------------------------------------
// 1. Structural checks
// ---------------------------------------------------------------------------
console.log('1. Structure');

check('every action name is <module>.<resource>.<verb>', malformedActionNames().length === 0,
  malformedActionNames().join(', '));

check('every catalogued action has a policy', actionsWithoutPolicy(registeredActions()).length === 0,
  actionsWithoutPolicy(registeredActions()).join(', '));

const matrixActions = Object.keys(matrix.actions);
const missingFromMatrix = ALL_ACTIONS.filter((a) => !matrixActions.includes(a));
const extraInMatrix = matrixActions.filter((a) => !ALL_ACTIONS.includes(a));
check('every action has a matrix entry', missingFromMatrix.length === 0,
  missingFromMatrix.join(', '));
check('the matrix names no action that does not exist', extraInMatrix.length === 0,
  extraInMatrix.join(', '));

check('boot assertion passes for the full catalogue', (() => {
  try { assertPolicyCoverage(ALL_ACTIONS); return true; } catch { return false; }
})());

check('boot assertion REFUSES an unknown action', (() => {
  try { assertPolicyCoverage([...ALL_ACTIONS, 'made.up.action']); return false; }
  catch { return true; }
})(), 'a route annotated with a bogus action must stop the app booting');

console.log(`   ${matrixActions.length} actions, ${matrix.roles.length} roles`);

// ---------------------------------------------------------------------------
// 2. The (role x action) sweep - both directions
// ---------------------------------------------------------------------------
console.log('\n2. Matrix sweep (both directions per cell)');

/** Candidate targets covering every shape a policy might key on. */
function candidates(actorEmployeeId) {
  return [
    { label: 'self', ref: { subjectEmployeeId: actorEmployeeId } },
    { label: 'direct report', ref: { subjectEmployeeId: 'E1' } },
    { label: 'deep subtree', ref: { subjectEmployeeId: 'E2' } },
    { label: 'unrelated', ref: { subjectEmployeeId: 'E3' } },
    { label: 'ancestor', ref: { subjectEmployeeId: 'DeptHeadA' } },
    { label: 'own project', ref: { projectId: 'P2', subjectEmployeeId: 'E3' } },
    { label: 'other project', ref: { projectId: 'P1', subjectEmployeeId: 'E1' } },
    // Document candidates. `dataClass` is ignored by every non-document policy, but the document
    // policies discriminate on it - and an ABSENT dataClass is treated as RESTRICTED, so without
    // these every document cell would read as deny and the sweep would prove nothing.
    { label: 'own personal doc', ref: { subjectEmployeeId: actorEmployeeId, dataClass: 'PERSONAL' } },
    { label: 'own restricted doc', ref: { subjectEmployeeId: actorEmployeeId, dataClass: 'RESTRICTED' } },
    { label: "another's personal doc", ref: { subjectEmployeeId: 'E3', dataClass: 'PERSONAL' } },
    { label: "another's restricted doc", ref: { subjectEmployeeId: 'E3', dataClass: 'RESTRICTED' } },
  ];
}

let cells = 0;
for (const [action, spec] of Object.entries(matrix.actions)) {
  const resource = policyFor(action) ? undefined : null;
  if (resource === null) continue;   // already reported above

  for (const role of matrix.roles) {
    const expected = spec.cells?.[role];
    if (!expected) { check(`${action} / ${role} has a cell`, false); continue; }
    cells++;

    // M1 is used as the actor body so the reporting fixture is meaningful for `manager`.
    const ctx = soleRoleCtx(role, 'M1');
    const results = [];
    for (const c of candidates('M1')) {
      const ref = { type: 'employee', ...c.ref, asOf: '2026-09-08' };
      // eslint-disable-next-line no-await-in-loop
      const d = await authz.can(ctx, action, ref);
      results.push({ label: c.label, allowed: d.allowed, reason: d.reason });
    }
    const allowedCount = results.filter((r) => r.allowed).length;
    const deniedCount = results.length - allowedCount;

    if (expected === 'deny') {
      check(`${action} / ${role} = deny`, allowedCount === 0,
        `ALLOWED for: ${results.filter((r) => r.allowed).map((r) => r.label).join(', ')}`);
    } else if (expected === 'allow') {
      check(`${action} / ${role} = allow`, allowedCount > 0,
        `denied for every candidate (reasons: ${[...new Set(results.map((r) => r.reason))].join(', ')})`);
    } else if (expected === 'conditional') {
      check(`${action} / ${role} = conditional (some allow)`, allowedCount > 0,
        `denied for every candidate (${[...new Set(results.map((r) => r.reason))].join(', ')})`);
      check(`${action} / ${role} = conditional (some deny)`, deniedCount > 0,
        'allowed for EVERY candidate - the condition is not narrowing anything');
    } else {
      check(`${action} / ${role} has a valid cell value`, false, `got "${expected}"`);
    }
  }
}
console.log(`   ${cells} cells asserted in both directions`);

// ---------------------------------------------------------------------------
// 3. The named negative cases
// ---------------------------------------------------------------------------
console.log('\n3. Named threat cases');

const AS_OF = {
  after_termination: '2026-06-01',
  after_transfer: '2026-06-01',
  before_transfer: '2026-01-15',
};

for (const nc of matrix.negative_cases) {
  const ctx = ctxOf(nc.actor);
  const ref = {
    type: nc.target_project ? 'project_effort' : 'employee',
    subjectEmployeeId: nc.target ? (ACTORS[nc.target]?.employeeId ?? nc.target) : undefined,
    projectId: nc.target_project,
    asOf: nc.as_of ? AS_OF[nc.as_of] : '2026-09-08',
  };

  const d = await authz.can(ctx, nc.action, ref);
  const want = nc.expect === 'allow';
  check(`[${nc.id}] ${nc.actor} -> ${nc.action} = ${nc.expect}`, d.allowed === want,
    `got ${d.allowed ? 'ALLOW' : 'DENY'} (${d.reason}) — pins: ${String(nc.pins).trim().slice(0, 90)}`);

  // The 404-not-403 requirement, where the case states it.
  if (nc.expect_status === 404) {
    let status = null;
    try {
      await authz.assertCan(ctx, nc.action, ref);
    } catch (e) {
      if (e instanceof AuthzDeniedError) status = e.httpStatus;
    }
    check(`[${nc.id}] hides existence with 404, not 403`, status === 404,
      `got ${status} — a 403 confirms the record exists, which is itself a disclosure`);
  }
}

// ---------------------------------------------------------------------------
// 4. scope() must produce a composable SQL predicate, never a post-fetch filter
// ---------------------------------------------------------------------------
console.log('\n4. scope() predicates');

{
  const emp = authz.scope(soleRoleCtx('employee', 'E1'), 'work.log.read', { type: 'work_log', asOf: '2026-09-08' });
  const r = emp.render('w', 1);
  check('an employee scope is restricted, not open', emp.kind === 'restricted', `kind=${emp.kind}`);
  check('the predicate references the alias and a placeholder',
    r.sql.includes('w.employee_id') && r.sql.includes('$1'), r.sql);
  check('the actor id travels as a parameter, never inlined',
    r.params.includes('E1') && !r.sql.includes('E1'), r.sql);

  const hr = authz.scope(soleRoleCtx('hr_admin', 'HRA'), 'work.log.read', { type: 'work_log' });
  check('hr_admin scope is unrestricted', hr.kind === 'all', `kind=${hr.kind}`);

  const fin = authz.scope(soleRoleCtx('finance', 'FIN'), 'work.log.read', { type: 'work_log' });
  check('a role with no grant gets deny-all', fin.kind === 'none', `kind=${fin.kind}`);
  check('deny-all renders as literal false, so a careless caller still gets nothing',
    fin.render('w', 1).sql === 'false');

  const unknown = authz.scope(soleRoleCtx('employee', 'E1'), 'no.such.action', { type: 'work_log' });
  check('an unregistered action scopes to deny-all', unknown.kind === 'none');

  // Placeholder numbering must be offsettable, or composing into a real query corrupts params.
  const mgr = authz.scope(soleRoleCtx('manager', 'M1'), 'attendance.day.read', { type: 'attendance_day', asOf: '2026-09-08' });
  const off = mgr.render('a', 5);
  check('placeholders honour the starting index', off.sql.includes('$5') && !off.sql.includes('$1'), off.sql);
  check('param count matches the highest placeholder',
    off.params.length === [...off.sql.matchAll(/\$(\d+)/g)].reduce((m, x) => Math.max(m, +x[1] - 4), 0),
    `${off.params.length} params for ${off.sql}`);
}

// ---------------------------------------------------------------------------
// 5. fieldMask is default-deny
// ---------------------------------------------------------------------------
console.log('\n5. fieldMask (default-deny)');

{
  const self = authz.fields(soleRoleCtx('employee', 'E1'), 'employee', { isSubject: true });
  const peer = authz.fields(soleRoleCtx('employee', 'E1'), 'employee', { isSubject: false });
  const hr = authz.fields(soleRoleCtx('hr_admin', 'HRA'), 'employee', { isSubject: false });

  check('the subject sees their own date of birth', self.has('date_of_birth'));
  check('a peer does NOT see date of birth', !peer.has('date_of_birth'));
  check('a peer does NOT see the home address', !peer.has('address_line1'));
  check('a peer DOES see work email', peer.has('work_email'));
  check('hr_ops/hr_admin see personal fields', hr.has('address_line1'));
  check('emergency contact is subject-only, even for hr_admin', !hr.has('emergency_contact_name'));
  check('exit_reason is RESTRICTED - not even the subject', !self.has('exit_reason'));
  check('credential material is unregistered, so invisible to everyone',
    !self.has('password_hash') && !hr.has('password_hash'));

  // An unregistered column must be DROPPED, which is what stops SELECT * being a disclosure.
  const masked = authz.maskRow(soleRoleCtx('employee', 'E1'), 'employee',
    { id: 'E1', full_name: 'A', newly_added_column: 'secret', password_hash: 'x' },
    { isSubject: true });
  check('an unregistered column is dropped, not returned', !('newly_added_column' in masked),
    JSON.stringify(masked));
  check('password_hash is dropped even for the subject', !('password_hash' in masked));

  // RESTRICTED / neverInList must not appear in a collection even for a role that can read it.
  const inList = authz.fields(soleRoleCtx('hr_admin', 'HRA'), 'employee', { isSubject: false, inList: true });
  check('personal fields are absent from LIST responses', !inList.has('date_of_birth'),
    'a legitimate list request is how bulk disclosure actually happens');
  check('exit_reason is absent from LIST responses', !inList.has('exit_reason'));

  const unknownType = authz.fields(soleRoleCtx('hr_admin', 'HRA'), 'leave_request', { isSubject: false });
  check('an unregistered RESOURCE yields no fields at all', unknownType.size === 0);
}

// ---------------------------------------------------------------------------
console.log('');
if (fail) {
  console.log('FAILURES:');
  for (const f of failures) console.log(`  FAIL  ${f}`);
}
console.log(`${fail === 0 ? 'AUTHZ MATRIX OK' : 'AUTHZ MATRIX FAILED'} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
