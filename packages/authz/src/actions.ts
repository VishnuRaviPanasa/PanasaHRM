import type { ResourceType, ScopeGraph } from './types';

/**
 * The action catalogue.
 *
 * NAMING: `<module>.<resource>.<verb>`, all dots. `ai/context/rbac-rules.md` uses
 * `employee.compensation.read` while ADR-0016's amendment uses `work.effort_cost:read` - two
 * conventions for one thing. Dots win here because they are the majority form and because a
 * single separator makes the catalogue mechanically checkable. ADR-0016 is still `Proposed`, so
 * its §9 text should be amended rather than worked around (recorded as a DEC).
 *
 * WHAT IS DELIBERATELY ABSENT: no action names compensation, bank details or government IDs.
 * `rbac-rules.md` writes policy for those, but no such table exists. Defining actions for
 * resources that do not exist would be exactly the fabricated standard CLAUDE.md warns about -
 * the next session would treat it as authoritative. They arrive with their tables, and the
 * default-deny field registry keeps them invisible until they are consciously classified.
 */
export const ACTIONS = {
  // ---- identity -----------------------------------------------------------
  'identity.session.read':        { resource: 'identity',       graph: 'self' },
  'identity.role.grant':          { resource: 'identity',       graph: 'organisation' },
  'identity.role.revoke':         { resource: 'identity',       graph: 'organisation' },
  'identity.link.create':         { resource: 'identity',       graph: 'organisation' },
  'identity.session.revoke':      { resource: 'identity',       graph: 'organisation' },
  'identity.account.create':      { resource: 'identity',       graph: 'organisation' },
  'identity.account.reissue':     { resource: 'identity',       graph: 'organisation' },

  // ---- onboarding ---------------------------------------------------------
  'onboarding.annexure.read':     { resource: 'salary_annexure', graph: 'organisation' },
  'onboarding.annexure.write':    { resource: 'salary_annexure', graph: 'organisation' },
  'onboarding.annexure.approve_finance':
    { resource: 'salary_annexure', graph: 'organisation' },
  'onboarding.annexure.approve_delivery':
    { resource: 'salary_annexure', graph: 'organisation' },
  'onboarding.offer.manage':      { resource: 'salary_annexure', graph: 'organisation' },

  // ---- people -------------------------------------------------------------
  'people.employee.read':         { resource: 'employee',       graph: 'reporting' },
  'people.employee.list':         { resource: 'employee',       graph: 'reporting' },
  'people.employee.create':       { resource: 'employee',       graph: 'organisation' },
  'people.employee.update':       { resource: 'employee',       graph: 'reporting' },
  'people.employee.personal.read': { resource: 'employee',      graph: 'reporting' },
  'people.lifecycle.read':        { resource: 'employment',     graph: 'reporting' },
  'people.lifecycle.transition':  { resource: 'employment',     graph: 'organisation' },
  'people.assignment.change':     { resource: 'employment',     graph: 'organisation' },

  // ---- leave --------------------------------------------------------------
  'leave.balance.read':           { resource: 'leave_balance',  graph: 'reporting' },
  'leave.request.read':           { resource: 'leave_request',  graph: 'reporting' },
  'leave.request.create':         { resource: 'leave_request',  graph: 'self' },
  'leave.request.cancel':         { resource: 'leave_request',  graph: 'self' },
  'leave.request.approve':        { resource: 'leave_request',  graph: 'reporting' },

  // ---- attendance ---------------------------------------------------------
  'attendance.day.read':          { resource: 'attendance_day', graph: 'reporting' },
  'attendance.punch.create':      { resource: 'attendance_punch', graph: 'self' },
  'attendance.punch.read':        { resource: 'attendance_punch', graph: 'reporting' },

  /*
   * ---- payroll ------------------------------------------------------------
   *
   * Two actions, not five. `manage` covers create, edit, attach, issue and void, because the
   * database already refuses the moves that matter - the FSM transition table decides what is
   * legal, `ck_payslip_no_self_issue` decides who may act, and an issued payslip is frozen. A
   * separate `void` permission would suggest voiding is somebody else's job, which it is not:
   * whoever draws a payslip is who corrects it.
   *
   * The graph is `self` rather than `reporting`, and that is the substantive decision: a payslip
   * is NOT visible up the reporting line. See the policy in policies.ts for why.
   */
  'payroll.payslip.read':         { resource: 'payslip',        graph: 'self' },
  'payroll.payslip.manage':       { resource: 'payslip',        graph: 'organisation' },

  // ---- work ---------------------------------------------------------------
  // The cross-graph split. `rbac-rules.md` says work resources resolve through project
  // membership, and gives "M1 (no role on P1) -> P1 effort report = deny" as a required negative
  // case. But a line manager approving their own report's timesheet is a REPORTING-graph act.
  // One undifferentiated action could not satisfy both, so the concern is split three ways.
  'work.log.read':                { resource: 'work_log',       graph: 'reporting' },
  /*
   * A TASK IS THE FIRST RESOURCE THAT ANSWERS TO BOTH GRAPHS, and it still does not get a third.
   *
   * A task lives in a project AND is assigned to a person, so it looks like the case DEC-045
   * warns about - the merge that lets a project lead read a disciplinary file. It is not, because
   * "tasks by assignee" and "tasks by project" are two different questions and each already has
   * a graph: this action is the PERSON-shaped one and takes the reporting graph, exactly like a
   * work log, while the project-shaped cut reuses `work.project.read` and its membership graph.
   *
   * A task with no assignee is therefore unreachable through THIS action by construction - there
   * is no subject to compare against a subtree - which is correct rather than a gap.
   */
  'work.task.read':               { resource: 'task',           graph: 'reporting' },
  'work.log.write':               { resource: 'work_log',       graph: 'self' },
  /*
   * HR RECORDING EFFORT FOR SOMEBODY ELSE, which `work.log.write` cannot express.
   *
   * That action is graph `self`, so hr_admin's cell reads `conditional` and resolves to "HR may
   * write HR's own work log" - correct, and the reason HR could not enter a work log for an
   * employee at all. Widening it was not an option: `self` is what stops an employee writing
   * into a colleague's timesheet, and every cell in that row depends on it.
   *
   * So this is a separate action on the ORGANISATION graph. Effort recorded through it carries
   * `entry_source = 'hr_entry'` and the recorder's id (migration 0028), so an approver can always
   * see that HR filled the line in rather than the employee. The database refuses the incoherent
   * combinations independently of this action - `hr_entry` naming the subject themselves is a
   * trigger violation - so the policy and the schema each stop a different half of the problem.
   */
  'work.log.write_for':           { resource: 'work_log',       graph: 'organisation' },
  'work.timesheet.read':          { resource: 'timesheet',      graph: 'reporting' },
  'work.timesheet.submit':        { resource: 'timesheet',      graph: 'self' },
  /** Line-manager act: approving the timesheet of somebody who reports to you. */
  'work.timesheet.approve':       { resource: 'timesheet',      graph: 'reporting' },
  /** Reporting-graph act: effort of MY reports, aggregated. Does not widen to their projects. */
  'work.team_effort.read':        { resource: 'project_effort', graph: 'reporting' },
  /** PROJECT-graph act: effort on a project. Requires membership, not a reporting line. */
  'work.project_effort.read':     { resource: 'project_effort', graph: 'project' },
  'work.project.read':            { resource: 'project',        graph: 'project' },
  'work.project.manage':          { resource: 'project',        graph: 'organisation' },
  /*
   * The task and sub-task master list. HR-only, deliberately narrower than
   * `work.project.manage` - which also admits a project lead, and keeps doing so for the project
   * and sub-project levels. Retiring a task changes what every member of that project may log
   * effort against, so it is an HR master-data act rather than a project-management one. If a
   * lead needs it later that is a policy change with its own matrix row and its own tests, not a
   * quiet widening of this one.
   */
  'work.task.manage':             { resource: 'task',           graph: 'organisation' },

  // ---- documents ----------------------------------------------------------
  // Documents are governed by the REPORTING graph for row scope but, unusually, a line manager
  // gets nothing: a manager has no business reading a report's Aadhaar, bank proof or medical
  // certificate. Document handling is an HR function. That is a narrowing of the graph, not an
  // exception to it - the graph decides WHICH rows are reachable, the policy decides who reaches.
  'documents.document.list':      { resource: 'employee_document', graph: 'reporting' },
  'documents.document.read':      { resource: 'employee_document', graph: 'reporting' },
  /** The content, not the metadata. Every call is audited - this is a Tier 1 disclosure. */
  'documents.document.download':  { resource: 'employee_document', graph: 'reporting' },
  'documents.document.upload':    { resource: 'employee_document', graph: 'reporting' },
  'documents.document.withdraw':  { resource: 'employee_document', graph: 'organisation' },
  /** Advancing the quarantine verdict. A scanner or an administrator, never the uploader. */
  'documents.document.scan':      { resource: 'employee_document', graph: 'organisation' },

  // ---- organization -------------------------------------------------------
  // NOTE the difference from `config.*`. ADR-0005 amendment (a) makes reading a POLICY row a
  // privilege, and names the tables it means: org_setting, attendance_policy, employment_policy,
  // leave_type, leave_policy, audit_event. The org CHART is not among them - it is
  // PUBLIC_INTERNAL structure, like the employee directory. So the row scope is open and the
  // field mask does the work, exactly as for `people.employee.read`.
  'org.unit.read':                { resource: 'department',     graph: 'organisation' },
  /*
   * A DESIGNATION IS NOT AN ORG UNIT, so it does not ride on `org.unit.manage`.
   *
   * That action's own note explains itself as being about REORGANISING - re-parenting a
   * department, which is why a department head must not hold it. A designation is a job-title
   * catalogue: nothing nests, nothing has a head, and the risk is different in kind. Retiring one
   * closes it to NEW assignments organisation-wide (DEC-044) while every historical `employment`
   * row keeps pointing at it, so the blast radius is every future hire rather than one subtree.
   *
   * Stretching `org.unit.manage` to cover it would have been free today and wrong the first time
   * somebody wanted to delegate one without the other.
   */
  'org.designation.manage':       { resource: 'designation',    graph: 'organisation' },

  'org.unit.manage':              { resource: 'department',     graph: 'organisation' },
  'org.team.read':                { resource: 'team',           graph: 'organisation' },
  'org.team.manage':              { resource: 'team',           graph: 'organisation' },
  // Deliberately HR-only. Team membership is not a scope graph (see 0017), so there is no
  // principled way to let "the team's lead" manage it without inventing a third graph - which
  // ADR-0005 would need to sanction.
  'org.team.member.manage':       { resource: 'team',           graph: 'organisation' },

  // ---- configuration ------------------------------------------------------
  // ADR-0005 amendment (a): a policy row is a historical derivation input, and reading one is a
  // privilege. Note this governs EXPOSING a policy row through an endpoint. The leave engine
  // deriving an entitlement from `leave_policy` inside a use case is not an actor reading a row,
  // so it is not an authorization subject and needs no action here.
  'config.policy.read':           { resource: 'org_config',     graph: 'organisation' },
  'config.policy.write':          { resource: 'org_config',     graph: 'organisation' },
  'config.setting.read':          { resource: 'org_config',     graph: 'organisation' },
  'config.setting.write':         { resource: 'org_config',     graph: 'organisation' },

  // ---- audit --------------------------------------------------------------
  'audit.event.read':             { resource: 'audit_event',    graph: 'organisation' },
} as const satisfies Record<string, { resource: ResourceType; graph: ScopeGraph }>;

export type Action = keyof typeof ACTIONS;

export const ALL_ACTIONS = Object.keys(ACTIONS) as Action[];

export function actionMeta(action: Action): { resource: ResourceType; graph: ScopeGraph } {
  return ACTIONS[action];
}

/** Every action name must follow `<module>.<resource>.<verb>` with dots only. */
export function malformedActionNames(): string[] {
  return ALL_ACTIONS.filter((a) => !/^[a-z][a-z_]*(\.[a-z][a-z_]*){2,}$/.test(a));
}
