import { ALL_ACTIONS, type Action } from './actions';
import {
  ALLOW_ALL, DENY_ALL, either, projectMembership, reportingScope, selfOnly,
} from './graphs';
import {
  always, definePolicy, isAncestorOfActor, isBreakGlassActor, isDirectReport, isInSubtree,
  isNotRestricted, isProjectLead, isProjectMember, isSelf, isSelfAndNotRestricted, type Policy,
} from './policy';
import type { AuthContext, ResourceRef, ScopePredicate } from './types';

/**
 * The policy set.
 *
 * Read this file to answer "who can do X". That is the whole justification for ADR-0005's
 * central service: the question has one place to look, rather than needing every controller read
 * to answer it.
 *
 * Two shapes recur:
 *
 *   REPORTING resources - self, then manager over their subtree, then HR. The manager's reach is
 *   `subtree` for operational data (attendance, leave, work) and `direct report` for anything
 *   more personal, per `rbac-rules.md`'s deliberate asymmetry.
 *
 *   ORGANISATION resources - denied unless the actor holds the administrative permission.
 *   ADR-0005 amendment (a): there is no implicit "everyone can read configuration"; a policy row
 *   is a historical derivation input and reading it is a privilege.
 */

const today = () => new Date().toISOString().slice(0, 10);

/** Standard row filter for a reporting-graph resource. */
function reportingRows(
  ctx: AuthContext,
  ref: ResourceRef,
  opts: { maxDepth?: number | undefined } = {},
): ScopePredicate {
  const type = ref.type;
  const asOf = ref.asOf ?? today();

  // HR sees the organisation. This is the one place a role widens to everything, and it is why
  // `audit_read` obligations hang off HR rules.
  if (ctx.roles.includes('hr_admin') || ctx.roles.includes('hr_ops')) return ALLOW_ALL;

  const mine = selfOnly(type, ctx.employeeId);
  if (!ctx.roles.includes('manager')) return mine;

  return either(
    mine,
    reportingScope(type, ctx.employeeId, asOf, {
      includeSelf: false,
      maxDepth: opts.maxDepth,
    }),
  );
}

/**
 * Row filter for documents. Like reportingRows but WITHOUT the manager branch - a line manager
 * reaches no document rows at all (see the documents policy block for why).
 */
function documentRows(ctx: AuthContext, ref: ResourceRef): ScopePredicate {
  if (ctx.roles.includes('hr_admin') || ctx.roles.includes('hr_ops')) return ALLOW_ALL;
  return selfOnly(ref.type, ctx.employeeId);
}

/** Organisation-scoped: deny-all unless the actor holds the administrative permission. */
function orgRows(ctx: AuthContext, adminRoles: readonly string[]): ScopePredicate {
  return adminRoles.some((r) => (ctx.roles as readonly string[]).includes(r))
    ? ALLOW_ALL
    : DENY_ALL;
}

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

definePolicy({
  action: 'identity.session.read',
  allow: [
    { role: 'employee', when: isSelf },
    { role: 'manager', when: isSelf },
    { role: 'hr_admin', when: isSelf },
  ],
  scope: (ctx) => selfOnly('identity', ctx.employeeId),
});

// Granting and revoking privilege is HR-admin only, and a break-glass account may not do it.
// A break-glass credential exists to restore access during an outage; letting it hand out roles
// would make it a privilege-escalation primitive that bypasses conditional access by design.
for (const action of ['identity.role.grant', 'identity.role.revoke', 'identity.link.create',
  'identity.session.revoke'] as const) {
  definePolicy({
    action,
    denyOverrides: [isBreakGlassActor],
    allow: [{ role: 'hr_admin', when: always, obligations: [{ kind: 'audit_read', purpose: 'identity_admin' }] }],
    scope: (ctx) => orgRows(ctx, ['hr_admin']),
  });
}

// ---------------------------------------------------------------------------
// people
// ---------------------------------------------------------------------------

definePolicy({
  action: 'people.employee.read',
  allow: [
    { role: 'employee', when: always },   // the directory is PUBLIC_INTERNAL; the FIELD MASK
    { role: 'manager', when: always },    // is what keeps personal data out of it, not the row
    { role: 'hr_admin', when: always },   // filter. Two different concerns (ADR-0005).
    { role: 'hr_ops', when: always },
  ],
  scope: () => ALLOW_ALL,
});

definePolicy({
  action: 'people.employee.list',
  allow: [
    { role: 'employee', when: always },
    { role: 'manager', when: always },
    { role: 'hr_admin', when: always },
    { role: 'hr_ops', when: always },
  ],
  scope: () => ALLOW_ALL,
});

/**
 * Personal detail - address, date of birth, emergency contact. The narrow one.
 *
 * `isAncestorOfActor` is a deny-override so that an HR admin who also reports to somebody cannot
 * read their own manager's personal file. Managers get DIRECT REPORTS ONLY, never the subtree:
 * `rbac-rules.md`'s asymmetry, and the reason `people.employee.personal.read` is a separate
 * action from `people.employee.read` rather than a field on it.
 */
definePolicy({
  action: 'people.employee.personal.read',
  denyOverrides: [isAncestorOfActor, isBreakGlassActor],
  allow: [
    { role: 'employee', when: isSelf },
    { role: 'manager', when: isSelf },
    { role: 'hr_admin', when: isSelf },
    { role: 'hr_ops', when: isSelf },
    {
      role: 'hr_ops',
      when: always,
      obligations: [{ kind: 'audit_read', purpose: 'hr_administration' }],
    },
    {
      role: 'hr_admin',
      when: always,
      obligations: [{ kind: 'audit_read', purpose: 'hr_administration' }],
    },
  ],
  scope: (ctx, ref) => reportingRows(ctx, ref, { maxDepth: 1 }),
});

definePolicy({
  action: 'people.employee.create',
  allow: [{ role: 'hr_admin', when: always }, { role: 'hr_ops', when: always }],
  scope: (ctx) => orgRows(ctx, ['hr_admin', 'hr_ops']),
});

definePolicy({
  action: 'people.employee.update',
  denyOverrides: [isAncestorOfActor],
  allow: [
    { role: 'employee', when: isSelf },
    { role: 'manager', when: isSelf },
    { role: 'hr_admin', when: isSelf },
    { role: 'hr_ops', when: always },
    { role: 'hr_admin', when: always },
  ],
  scope: (ctx, ref) => reportingRows(ctx, ref, { maxDepth: 1 }),
});

definePolicy({
  action: 'people.lifecycle.read',
  denyOverrides: [isAncestorOfActor],
  allow: [
    { role: 'employee', when: isSelf },
    { role: 'manager', when: isSelf },
    { role: 'hr_admin', when: isSelf },
    { role: 'manager', when: isDirectReport },
    { role: 'hr_ops', when: always },
    { role: 'hr_admin', when: always },
  ],
  scope: (ctx, ref) => reportingRows(ctx, ref, { maxDepth: 1 }),
});

// A lifecycle transition or an assignment change is an HR act, not a manager's. A promotion
// recorded by the promoting manager has no independent check anywhere.
for (const action of ['people.lifecycle.transition', 'people.assignment.change'] as const) {
  definePolicy({
    action,
    denyOverrides: [isSelf, isBreakGlassActor],   // nobody transitions their own employment
    allow: [{ role: 'hr_admin', when: always }, { role: 'hr_ops', when: always }],
    scope: (ctx) => orgRows(ctx, ['hr_admin', 'hr_ops']),
  });
}

// ---------------------------------------------------------------------------
// leave
// ---------------------------------------------------------------------------

definePolicy({
  action: 'leave.balance.read',
  allow: [
    { role: 'employee', when: isSelf },
    { role: 'manager', when: isSelf },
    { role: 'hr_admin', when: isSelf },
    { role: 'manager', when: isInSubtree },
    { role: 'hr_ops', when: always },
    { role: 'hr_admin', when: always },
  ],
  scope: (ctx, ref) => reportingRows(ctx, ref),
});

definePolicy({
  action: 'leave.request.read',
  allow: [
    { role: 'employee', when: isSelf },
    { role: 'manager', when: isSelf },
    { role: 'hr_admin', when: isSelf },
    { role: 'manager', when: isInSubtree },
    { role: 'hr_ops', when: always },
    { role: 'hr_admin', when: always },
  ],
  scope: (ctx, ref) => reportingRows(ctx, ref),
});

for (const action of ['leave.request.create', 'leave.request.cancel'] as const) {
  definePolicy({
    action,
    allow: [
      { role: 'employee', when: isSelf },
      { role: 'manager', when: isSelf },
      { role: 'hr_admin', when: isSelf },
    ],
    scope: (ctx) => selfOnly('leave_request', ctx.employeeId),
  });
}

/**
 * Approval. `isSelf` is a DENY-OVERRIDE: nobody approves their own leave, and it must not be
 * possible to acquire that by also holding hr_admin. The database carries the same rule as a
 * CHECK (rbac-rules "structural integrity" item 1) - this is the second layer, not the only one.
 */
definePolicy({
  action: 'leave.request.approve',
  denyOverrides: [isSelf, isBreakGlassActor],
  allow: [
    { role: 'manager', when: isDirectReport },
    { role: 'hr_admin', when: always },
    { role: 'hr_ops', when: always },
  ],
  scope: (ctx, ref) => reportingRows(ctx, ref, { maxDepth: 1 }),
});

// ---------------------------------------------------------------------------
// attendance
// ---------------------------------------------------------------------------

definePolicy({
  action: 'attendance.day.read',
  allow: [
    { role: 'employee', when: isSelf },
    { role: 'manager', when: isSelf },
    { role: 'hr_admin', when: isSelf },
    { role: 'manager', when: isInSubtree },   // whole subtree: operational data
    { role: 'hr_ops', when: always },
    { role: 'hr_admin', when: always },
  ],
  scope: (ctx, ref) => reportingRows(ctx, ref),
});

definePolicy({
  action: 'attendance.punch.read',
  allow: [
    { role: 'employee', when: isSelf },
    { role: 'manager', when: isSelf },
    { role: 'hr_admin', when: isSelf },
    { role: 'manager', when: isInSubtree },
    { role: 'hr_ops', when: always },
    { role: 'hr_admin', when: always },
  ],
  scope: (ctx, ref) => reportingRows(ctx, ref),
});

definePolicy({
  action: 'attendance.punch.create',
  allow: [
    { role: 'employee', when: isSelf },
    { role: 'manager', when: isSelf },
    { role: 'hr_admin', when: isSelf },
  ],
  scope: (ctx) => selfOnly('attendance_punch', ctx.employeeId),
});

// ---------------------------------------------------------------------------
// work
// ---------------------------------------------------------------------------

/*
 * ===========================================================================
 * PAYROLL - and this is where the compensation deny-override finally lands.
 * ===========================================================================
 *
 * DEC-041 scoped `is_ancestor_of_actor` to personal detail, lifecycle and employee.update, and
 * left a review note: "Revisit when compensation tables land". They have landed.
 *
 * `rbac-rules.md` states the requirement with a worked example that is specifically about pay:
 *
 *     denyOverrides: [ isAncestorOfActor ]     // never your own manager's compensation
 *
 *   "Deny-overrides are what make *a manager who is also an HR admin still cannot see their own
 *    manager's salary* TRUE, rather than accidentally true."
 *
 * So it is a deny-override here and not an omission from the allow list, because allow lists are
 * additive: without it, the `hr_admin` grant re-opens what the `employee` grant never offered.
 * `isAncestorOfActor` returns false when the subject IS the actor, so an HR admin still reads
 * their OWN payslip - the override removes their chain of command, not themselves.
 *
 * A LINE MANAGER GETS NOTHING, and this is the one place the reporting graph does not apply.
 *
 * Everywhere else a manager reads their subtree's operational data. Pay is not operational data:
 * a manager needs to know whether somebody was at work, not what they were paid, and DEC-049
 * already denied managers documents on the same reasoning. `rbac-rules.md` does permit
 * compensation for DIRECT reports - "a manager sees attendance for their whole subtree but
 * compensation only for depth 1" - but that sentence is about `employee.compensation.read`, the
 * salary STRUCTURE, which is a different action that does not exist yet. A payslip is the actual
 * disbursement, including recoveries and tax, and nothing in the requirements asks a line manager
 * to see it. Narrow is the reversible direction.
 *
 * hr_ops IS ALSO DENIED, which is a departure from every other HR resource. hr_ops does
 * day-to-day HR administration; the salary register is need-to-know, and `finance` exists as a
 * role precisely because payroll is a separate function. DEC-041 made HR unconditional for
 * LEAVE, ATTENDANCE and WORK on the grounds that those are "ordinary HR processing". Pay is not.
 *
 * `auditor` is denied the read as well. An auditor's legitimate need is the audit trail, and
 * `fn_audit_payslip` records the period and status of every access WITHOUT any amount - so the
 * trail answers "who looked at whose payslip" without becoming a second salary register.
 */
definePolicy({
  action: 'payroll.payslip.read',
  denyOverrides: [isBreakGlassActor, isAncestorOfActor],
  allow: [
    // The subject, always. A wage slip is something the person paid is entitled to see, and this
    // is the grant that makes the employee-facing screen possible at all.
    { role: 'employee', when: isSelf },
    { role: 'manager', when: isSelf },
    { role: 'hr_admin', when: isSelf },
    { role: 'finance', when: isSelf },
    { role: 'hr_admin', when: always },
    { role: 'finance', when: always },
  ],
  scope: (ctx, ref) =>
    ctx.roles.includes('hr_admin') || ctx.roles.includes('finance')
      ? ALLOW_ALL
      : selfOnly(ref.type, ctx.employeeId),
});

/*
 * Managing a payslip is an HR act on the ORGANISATION, never a self-service one.
 *
 * `isSelf` is deliberately absent: an employee - including an HR admin acting on their own
 * record - cannot create, edit, attach to, issue or void their own payslip. The database says the
 * same thing independently through `ck_payslip_no_self_issue`, and it says it for acts this
 * policy cannot see, such as a migration or an admin script. Two layers, because a service-layer
 * check gets bypassed by the next code path.
 *
 * The ancestor override applies here too. If HR may not READ their own manager's payslip, letting
 * them WRITE one would be incoherent - they would be entering figures they are not allowed to
 * look at. The operational consequence is real and is recorded as an open risk rather than
 * quietly designed around: somebody has to be able to pay the person the payroll administrator
 * reports to, and who that is is a segregation-of-duties question for a human.
 */
definePolicy({
  action: 'payroll.payslip.manage',
  denyOverrides: [isBreakGlassActor, isAncestorOfActor],
  allow: [
    { role: 'hr_admin', when: always },
  ],
  scope: (ctx) => (ctx.roles.includes('hr_admin') ? ALLOW_ALL : DENY_ALL),
});

definePolicy({
  action: 'work.log.read',
  allow: [
    { role: 'employee', when: isSelf },
    { role: 'manager', when: isSelf },
    { role: 'hr_admin', when: isSelf },
    { role: 'manager', when: isInSubtree },
    { role: 'hr_ops', when: always },
    { role: 'hr_admin', when: always },
  ],
  scope: (ctx, ref) => reportingRows(ctx, ref),
});

/*
 * Deliberately IDENTICAL to `work.log.read` above, not merely similar.
 *
 * Both answer "what is this person doing", both are keyed on an employee, and both are ordinary
 * HR/line-management processing rather than personal data - so DEC-041 applies and HR reads them
 * unconditionally. Writing the same shape twice is the point: if a task ever needs a different
 * rule from a work log, that will be a decision somebody makes on purpose, in one place, rather
 * than a divergence that appeared because two policies drifted.
 */
definePolicy({
  action: 'work.task.read',
  allow: [
    { role: 'employee', when: isSelf },
    { role: 'manager', when: isSelf },
    { role: 'hr_admin', when: isSelf },
    { role: 'manager', when: isInSubtree },
    { role: 'hr_ops', when: always },
    { role: 'hr_admin', when: always },
  ],
  scope: (ctx, ref) => reportingRows(ctx, ref),
});

definePolicy({
  action: 'work.log.write',
  allow: [
    { role: 'employee', when: isSelf },
    { role: 'manager', when: isSelf },
    { role: 'hr_admin', when: isSelf },
  ],
  scope: (ctx) => selfOnly('work_log', ctx.employeeId),
});

definePolicy({
  action: 'work.timesheet.read',
  allow: [
    { role: 'employee', when: isSelf },
    { role: 'manager', when: isSelf },
    { role: 'hr_admin', when: isSelf },
    { role: 'manager', when: isInSubtree },
    { role: 'hr_ops', when: always },
    { role: 'hr_admin', when: always },
  ],
  scope: (ctx, ref) => reportingRows(ctx, ref),
});

definePolicy({
  action: 'work.timesheet.submit',
  allow: [
    { role: 'employee', when: isSelf },
    { role: 'manager', when: isSelf },
    { role: 'hr_admin', when: isSelf },
  ],
  scope: (ctx) => selfOnly('timesheet', ctx.employeeId),
});

/** Line-manager act, reporting graph. Direct reports only, and never your own. */
definePolicy({
  action: 'work.timesheet.approve',
  denyOverrides: [isSelf, isBreakGlassActor],
  allow: [
    { role: 'manager', when: isDirectReport },
    { role: 'hr_admin', when: always },
  ],
  scope: (ctx, ref) => reportingRows(ctx, ref, { maxDepth: 1 }),
});

/** Reporting graph: effort of MY reports. Does not widen to their projects. */
definePolicy({
  action: 'work.team_effort.read',
  allow: [
    { role: 'manager', when: always },
    { role: 'hr_admin', when: always },
    { role: 'hr_ops', when: always },
  ],
  scope: (ctx, ref) => reportingRows(ctx, ref),
});

/**
 * PROJECT graph: effort on a project. Requires membership.
 *
 * This is `rbac-rules.md`'s required negative case "M1 (no role on P1) -> P1 effort report =
 * deny". A reporting line over somebody does NOT confer a view of the projects they work on, and
 * membership of a project does NOT confer a view of the members' HR records. The two graphs meet
 * nowhere.
 */
definePolicy({
  action: 'work.project_effort.read',
  allow: [
    { role: 'employee', when: isProjectLead },
    { role: 'manager', when: isProjectLead },
    { role: 'hr_admin', when: always },
  ],
  scope: (ctx, ref) =>
    ctx.roles.includes('hr_admin')
      ? ALLOW_ALL
      : projectMembership(ref.type, ctx.employeeId,
        { roles: ['lead', 'project_manager'], asOf: ref.asOf ?? today() }),
});

definePolicy({
  action: 'work.project.read',
  allow: [
    { role: 'employee', when: isProjectMember },
    { role: 'manager', when: isProjectMember },
    { role: 'hr_admin', when: always },
    { role: 'hr_ops', when: always },
  ],
  scope: (ctx, ref) =>
    ctx.roles.includes('hr_admin') || ctx.roles.includes('hr_ops')
      ? ALLOW_ALL
      : projectMembership(ref.type, ctx.employeeId, { asOf: ref.asOf ?? today() }),
});

definePolicy({
  action: 'work.project.manage',
  allow: [
    { role: 'hr_admin', when: always },
    { role: 'manager', when: isProjectLead },
  ],
  scope: (ctx, ref) =>
    ctx.roles.includes('hr_admin')
      ? ALLOW_ALL
      : projectMembership(ref.type, ctx.employeeId,
        { roles: ['lead', 'project_manager'], asOf: ref.asOf ?? today() }),
});

// ---------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------
/*
 * The unusual shape here, and why: A LINE MANAGER GETS NOTHING.
 *
 * Everywhere else a manager reads their subtree's operational data. A manager has no business
 * reading a report's Aadhaar, bank proof or medical certificate - document handling is an HR
 * function, and the manager's legitimate interest (is this person at work, did they take leave)
 * is served by attendance and leave, which they already have.
 *
 * That is a NARROWING of the reporting graph, not an exception to it: the graph still decides
 * which rows are reachable at all; the policy decides who reaches them.
 *
 * RESTRICTED types - offer letter, contract, appraisal, disciplinary - are hr_admin only, and
 * NOT visible to the subject either. That is deliberate and worth stating plainly: an employee
 * cannot pull their own appraisal or disciplinary record through this API. Whether they SHOULD be
 * able to is an HR and legal question, not an engineering one, so the narrow answer is the one
 * that ships (recorded as OR-25).
 */
for (const action of ['documents.document.list', 'documents.document.read'] as const) {
  definePolicy({
    action,
    denyOverrides: [isBreakGlassActor],
    allow: [
      { role: 'employee', when: isSelfAndNotRestricted },
      { role: 'manager', when: isSelfAndNotRestricted },
      { role: 'hr_ops', when: isNotRestricted },
      { role: 'hr_admin', when: always },
    ],
    scope: (ctx, ref) => documentRows(ctx, ref),
  });
}

// The content. Every call is audited because a document read IS the disclosure - unlike most
// reads, where the disclosure is the field values a mask already governs.
definePolicy({
  action: 'documents.document.download',
  denyOverrides: [isBreakGlassActor],
  allow: [
    { role: 'employee', when: isSelfAndNotRestricted,
      obligations: [{ kind: 'audit_read', purpose: 'self_service' }] },
    { role: 'manager', when: isSelfAndNotRestricted,
      obligations: [{ kind: 'audit_read', purpose: 'self_service' }] },
    { role: 'hr_ops', when: isNotRestricted,
      obligations: [{ kind: 'audit_read', purpose: 'hr_administration' }] },
    { role: 'hr_admin', when: always,
      obligations: [{ kind: 'audit_read', purpose: 'hr_administration' }] },
  ],
  scope: (ctx, ref) => documentRows(ctx, ref),
});

// An employee may upload the types marked self_uploadable; HR may upload anything. A RESTRICTED
// type is never self-uploadable, so the same guard covers it.
definePolicy({
  action: 'documents.document.upload',
  denyOverrides: [isBreakGlassActor],
  allow: [
    { role: 'employee', when: isSelfAndNotRestricted },
    { role: 'manager', when: isSelfAndNotRestricted },
    { role: 'hr_ops', when: always },
    { role: 'hr_admin', when: always },
  ],
  scope: (ctx, ref) => documentRows(ctx, ref),
});

// Withdrawing and scanning are administrative. An employee must not be able to withdraw a
// document HR relies on, and the uploader must never be the one who declares their own upload
// clean - that would make the quarantine gate self-certifying.
for (const action of ['documents.document.withdraw', 'documents.document.scan'] as const) {
  definePolicy({
    action,
    denyOverrides: [isBreakGlassActor],
    allow: [
      { role: 'hr_admin', when: always },
      { role: 'hr_ops', when: always },
    ],
    scope: (ctx) => orgRows(ctx, ['hr_admin', 'hr_ops']),
  });
}

// ---------------------------------------------------------------------------
// organization
// ---------------------------------------------------------------------------

// The org chart is PUBLIC_INTERNAL. Everybody needs to know who sits where to do their job, so
// the ROW scope is open and the field mask is what withholds anything sensitive - the same
// division of labour as people.employee.read.
for (const action of ['org.unit.read', 'org.team.read'] as const) {
  definePolicy({
    action,
    allow: [
      { role: 'employee', when: always },
      { role: 'manager', when: always },
      { role: 'hr_admin', when: always },
      { role: 'hr_ops', when: always },
      { role: 'finance', when: always },
      { role: 'auditor', when: always },
    ],
    scope: () => ALLOW_ALL,
  });
}

// Reorganising is an HR act. A department head re-parenting their own department would have no
// independent check anywhere, which is the same reasoning that keeps lifecycle transitions out
// of a manager's hands.
/*
 * The designation catalogue. HR only, and deliberately identical in shape to `org.unit.manage`
 * rather than merged with it - see the note on the action for why the two are kept apart.
 */
definePolicy({
  action: 'org.designation.manage',
  denyOverrides: [isBreakGlassActor],
  allow: [
    { role: 'hr_admin', when: always },
    { role: 'hr_ops', when: always },
  ],
  scope: (ctx) => orgRows(ctx, ['hr_admin', 'hr_ops']),
});

for (const action of ['org.unit.manage', 'org.team.manage', 'org.team.member.manage'] as const) {
  definePolicy({
    action,
    denyOverrides: [isBreakGlassActor],
    allow: [
      { role: 'hr_admin', when: always },
      { role: 'hr_ops', when: always },
    ],
    scope: (ctx) => orgRows(ctx, ['hr_admin', 'hr_ops']),
  });
}

// ---------------------------------------------------------------------------
// configuration - organisation-scoped, denied by default
// ---------------------------------------------------------------------------

definePolicy({
  action: 'config.policy.read',
  allow: [
    { role: 'hr_admin', when: always },
    { role: 'hr_ops', when: always },
    { role: 'auditor', when: always, obligations: [{ kind: 'audit_read', purpose: 'audit' }] },
  ],
  scope: (ctx) => orgRows(ctx, ['hr_admin', 'hr_ops', 'auditor']),
});

definePolicy({
  action: 'config.setting.read',
  allow: [
    { role: 'hr_admin', when: always },
    { role: 'hr_ops', when: always },
    { role: 'auditor', when: always },
  ],
  scope: (ctx) => orgRows(ctx, ['hr_admin', 'hr_ops', 'auditor']),
});

// Writing policy changes what every historical date resolves to for everyone. hr_admin only.
for (const action of ['config.policy.write', 'config.setting.write'] as const) {
  definePolicy({
    action,
    denyOverrides: [isBreakGlassActor],
    allow: [{ role: 'hr_admin', when: always }],
    scope: (ctx) => orgRows(ctx, ['hr_admin']),
  });
}

definePolicy({
  action: 'audit.event.read',
  allow: [
    { role: 'auditor', when: always },
    { role: 'hr_admin', when: always, obligations: [{ kind: 'audit_read', purpose: 'audit' }] },
  ],
  scope: (ctx) => orgRows(ctx, ['auditor', 'hr_admin']),
});

// ---------------------------------------------------------------------------
// Coverage assertion
// ---------------------------------------------------------------------------

/**
 * Every action in the catalogue must have a policy. Called by the boot assertion, so an action
 * added without a policy stops the application starting rather than being denied mysteriously at
 * runtime by the `no_policy` default.
 */
export function actionsWithoutPolicy(registered: readonly Action[]): Action[] {
  const have = new Set(registered);
  return ALL_ACTIONS.filter((a) => !have.has(a));
}

export type { Policy };
