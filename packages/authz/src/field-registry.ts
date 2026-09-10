import type { AuthContext, DataClass, FieldRule, ResourceType, Role } from './types';

/**
 * The field registry, and it is DEFAULT-DENY.
 *
 * A field with no entry here is never serialized, for any role, in any response. That is not
 * strictness for its own sake - it is the specific control that stops the failure this codebase
 * already had:
 *
 *   `GET /employees/:id` was `SELECT e.*`. Migration 0014 added eleven personal columns to
 *   `employee` and every one of them immediately began serialising to any authenticated caller -
 *   date of birth, home address, emergency contact, exit reason. Nothing failed. No test broke.
 *   The disclosure arrived as a side effect of adding columns to a table.
 *
 * With a default-deny registry that is impossible: a new column is invisible until somebody
 * consciously classifies it. Being wrong then costs a missing field in a response, which is
 * loud, instead of a silent disclosure, which is not.
 *
 * Per-role DTOs were rejected by ADR-0005 for the same reason: they multiply combinatorially and
 * fail OPEN the moment one of them spreads the entity.
 */

const R = (
  cls: DataClass,
  roles: readonly Role[],
  self: boolean,
  neverInList = false,
): FieldRule => ({ cls, roles, self, neverInList });

/** Everyone authenticated may see it. */
const PUBLIC = (): FieldRule => R('PUBLIC_INTERNAL', ['employee', 'manager', 'hr_admin', 'hr_ops', 'finance', 'auditor'], true);
/** The subject, plus HR. */
const HR_AND_SELF = (cls: DataClass, neverInList = false): FieldRule =>
  R(cls, ['hr_admin', 'hr_ops'], true, neverInList);
/** The subject only - nobody else, whatever they hold. */
const SELF_ONLY = (cls: DataClass): FieldRule => R(cls, [], true, true);

/*
 * Pay. RESTRICTED, and the role list is hr_admin + finance ONLY - not hr_ops, who hold every
 * other HR field here. See the payroll policy: the salary register is need-to-know and `finance`
 * exists because payroll is a separate function.
 *
 * `neverInList` is deliberately NOT set on the amounts. It exists to stop bulk exfiltration
 * through a list endpoint, and a payroll register is the textbook target - but HR legitimately
 * needs that register, and an employee's own list is useless without the net figure. The control
 * against bulk reads here is the scope predicate plus an audit row per access, not field masking,
 * which would only have moved the same data one request away.
 */
const PAY = (): FieldRule => R('RESTRICTED', ['hr_admin', 'finance'], true);

/*
 * Organisation configuration. ADR-0005 amendment (a): these rows belong to NEITHER scope
 * graph, are denied by default, and are reachable only by an explicit administrative
 * permission - "a policy row is a historical derivation input and reading it is a privilege".
 * `self: false` because a configuration row is about nobody, so there is no subject to be.
 * The role list mirrors the config.policy.read cells in authz-matrix.yaml.
 */
const CONFIG = (): FieldRule => R('PUBLIC_INTERNAL', ['hr_admin', 'hr_ops', 'auditor'], false);

const REGISTRY: Partial<Record<ResourceType, Record<string, FieldRule>>> = {
  payslip: {
    id: PAY(),
    employee_id: PAY(),
    employee_number: PAY(),
    full_name: PAY(),
    // The period and the status are not amounts, but they are still pay data: "there is no
    // payslip for March" is information about somebody's employment and pay.
    period_start: PAY(),
    period_end: PAY(),
    pay_date: PAY(),
    status: PAY(),
    currency_code: PAY(),
    // Derived by fn_payslip_totals, in integer paise (Rule 4).
    gross_minor: PAY(),
    deductions_minor: PAY(),
    net_minor: PAY(),
    // What the PDF states. Kept distinct from net_minor on purpose - see migration 0024.
    declared_net_minor: PAY(),
    line_count: PAY(),
    reconciles: PAY(),
    has_document: PAY(),
    document_id: PAY(),
    note: PAY(),
    void_reason: PAY(),
    issued_at: PAY(),
    voided_at: PAY(),
    created_at: PAY(),
    source: PAY(),
  },

  employee: {
    // PUBLIC_INTERNAL - what a colleague needs to work with somebody.
    id: PUBLIC(),
    employee_number: PUBLIC(),
    full_name: PUBLIC(),
    work_email: PUBLIC(),
    department: PUBLIC(),
    designation: PUBLIC(),
    manager: PUBLIC(),
    // The manager side of a reporting-line answer (people_manager_of). The line itself is
    // PUBLIC_INTERNAL - it is on the org chart - so these carry the same class as `manager`.
    manager_employee_number: PUBLIC(),
    manager_email: PUBLIC(),
    manager_designation: PUBLIC(),
    work_location: PUBLIC(),
    employment_type: PUBLIC(),
    assignment_since: PUBLIC(),
    status: PUBLIC(),
    joined_on: PUBLIC(),
    confirmed_on: PUBLIC(),
    // Derived by the assistant's reporting-chain tool: distance up the management line, not a
    // stored column. Registered because the mask drops anything it does not know.
    level: PUBLIC(),

    /*
     * COUNTS, from people_headcount. Registered for the same reason `level` is - derived, and
     * dropped by the mask otherwise.
     *
     * They exist because DEC-155 forbids the model doing arithmetic, which removed its ability
     * to count rows for itself. "How many people work here" had no answer anywhere after that:
     * the directory could list five people and nothing could say "five".
     */
    grouping: PUBLIC(),
    headcount: PUBLIC(),
    headcount_total: PUBLIC(),
    joined_in_period: PUBLIC(),
    left_in_period: PUBLIC(),

    // PERSONAL - the subject and HR.
    personal_phone: HR_AND_SELF('PERSONAL', true),
    personal_email: HR_AND_SELF('PERSONAL', true),
    address_line1: HR_AND_SELF('PERSONAL', true),
    address_line2: HR_AND_SELF('PERSONAL', true),
    city: HR_AND_SELF('PERSONAL', true),
    state_region: HR_AND_SELF('PERSONAL', true),
    postal_code: HR_AND_SELF('PERSONAL', true),
    probation_end_on: HR_AND_SELF('PERSONAL'),
    resigned_on: HR_AND_SELF('PERSONAL'),
    notice_days: HR_AND_SELF('PERSONAL'),
    last_working_day: HR_AND_SELF('PERSONAL'),
    exited_on: HR_AND_SELF('PERSONAL'),
    exit_type: HR_AND_SELF('PERSONAL'),

    // SENSITIVE.
    date_of_birth: HR_AND_SELF('SENSITIVE', true),
    gender: HR_AND_SELF('SENSITIVE', true),

    // Third-party data: the contact never consented and has no relationship with us. Subject
    // only, and purpose-bound to an actual emergency (docs/privacy/data-inventory.md).
    emergency_contact_name: SELF_ONLY('PERSONAL'),
    emergency_contact_phone: SELF_ONLY('PERSONAL'),
    emergency_contact_relation: SELF_ONLY('PERSONAL'),

    // Health data with an unconfirmed purpose (OR-16). Subject only until HR confirms a use.
    blood_group: SELF_ONLY('SENSITIVE'),

    // RESTRICTED. Free text that may describe conduct, performance or health.
    exit_reason: R('RESTRICTED', ['hr_admin'], false, true),

    // NOTE: password_hash, token_hash and anything else credential-shaped appear NOWHERE in this
    // registry, so they can never be serialized by any role including the subject.
  },

  employee_document: {
    id: PUBLIC(),
    employee_id: PUBLIC(),
    document_type_code: PUBLIC(),
    document_type_name: PUBLIC(),
    data_class: PUBLIC(),
    title: PUBLIC(),
    issued_on: PUBLIC(),
    expires_on: PUBLIC(),
    issuing_authority: PUBLIC(),
    note: HR_AND_SELF('PERSONAL'),
    version_count: PUBLIC(),
    // Availability and the quarantine state of the LATEST version. These MUST be registered:
    // `maskRow` drops anything unregistered, so adding a column to the query without adding it
    // here makes it silently vanish from the response - which is the default-deny registry
    // working exactly as intended, and a trap for whoever adds the next field.
    available: PUBLIC(),
    current_version_no: PUBLIC(),
    latest_version_no: PUBLIC(),
    latest_scan_status: PUBLIC(),
    scan_status: PUBLIC(),
    size_bytes: PUBLIC(),
    content_type: PUBLIC(),
    original_name: HR_AND_SELF('PERSONAL'),
    uploaded_at: PUBLIC(),
    uploaded_by_name: PUBLIC(),
    withdrawn_at: PUBLIC(),
    withdrawn_reason: HR_AND_SELF('PERSONAL'),
    // NOT registered, therefore never serialized: bucket, object_key, sha256_hex. The storage
    // coordinates are an internal detail - handing them out invites a caller to try the object
    // store directly, and a presigned URL in a response body ends up in a log.
  },

  department: {
    id: PUBLIC(),
    code: PUBLIC(),
    name: PUBLIC(),
    description: PUBLIC(),
    parent_department_id: PUBLIC(),
    parent_code: PUBLIC(),
    head_employee_id: PUBLIC(),
    head_name: PUBLIC(),
    depth: PUBLIC(),
    headcount: PUBLIC(),
    valid_from: PUBLIC(),
    valid_to: PUBLIC(),

    // meta_capabilities: the subjects the assistant covers for the asker. No employee data.
    subject: PUBLIC(),
  },

  team: {
    id: PUBLIC(),
    code: PUBLIC(),
    name: PUBLIC(),
    description: PUBLIC(),
    department_id: PUBLIC(),
    department_code: PUBLIC(),
    lead_employee_id: PUBLIC(),
    lead_name: PUBLIC(),
    member_count: PUBLIC(),
    archived_at: PUBLIC(),
    valid_from: PUBLIC(),
    valid_to: PUBLIC(),
  },

  employment: {
    valid_from: PUBLIC(),
    valid_to: PUBLIC(),
    department: PUBLIC(),
    designation: PUBLIC(),
    manager: PUBLIC(),
    reason: HR_AND_SELF('PERSONAL'),
    employment_type: PUBLIC(),
    work_location: PUBLIC(),
    employee_number: PUBLIC(),

    // The LIFECYCLE LOG shares this resource type: actions.ts declares people.lifecycle.read
    // against `employment`, not against `employee`. Its columns therefore belong here, and
    // without them the default-deny mask blanks every lifecycle answer.
    event_type: PUBLIC(),
    effective_on: PUBLIC(),
    from_status: PUBLIC(),
    to_status: PUBLIC(),
    // NOT registered, deliberately: employment_event.exit_type and employment_event.reason.
    // A date plus an exit type is a statement about HOW somebody left, and the reason is
    // RESTRICTED free text about conduct, performance or health.
  },

  /*
   * ---------------------------------------------------------------------------------------
   * Registered for the assistant (ADR-0020), and NOT only for it.
   *
   * These four types were unregistered, which means `fieldMask` returned an EMPTY SET for them
   * and `maskRow` over a leave request or an attendance day produced `{}`. Nothing was broken,
   * because the endpoints that serve those screens build explicit column lists by hand instead
   * of masking - so the default-deny registry was not protecting them, it was simply absent.
   *
   * The assistant is the first caller that masks them, so this closes a real gap rather than
   * adding ceremony for one feature. It is also where the assistant's deliberate exclusions
   * become STRUCTURAL: a column that is not here cannot be returned by any tool, whatever the
   * tool's own SELECT list says.
   * ---------------------------------------------------------------------------------------
   */

  leave_balance: {
    employee_id: PUBLIC(),
    employee_number: PUBLIC(),
    full_name: PUBLIC(),
    leave_type_id: PUBLIC(),
    leave_code: PUBLIC(),
    leave_name: PUBLIC(),
    leave_year: PUBLIC(),
    is_paid: PUBLIC(),
    // The figures. PUBLIC in the registry sense means "any role the POLICY admits" - and
    // `leave.balance.read` admits an employee to themselves, a manager to their subtree and HR
    // to everyone. The row filter is what narrows this, not the mask; masking a balance figure
    // from someone the policy already let read the row would only be theatre.
    accrued: PUBLIC(),
    carried_in: PUBLIC(),
    adjusted: PUBLIC(),
    taken: PUBLIC(),
    pending: PUBLIC(),
    encashed: PUBLIC(),
    lapsed: PUBLIC(),
    available: PUBLIC(),

    /*
     * The HOLIDAY CALENDAR, returned by `leave_holidays`. It shares this resource type for the
     * same reason the attendance aggregates share `attendance_day`: the tool reuses
     * `leave.balance.read`, whose resource IS `leave_balance`, because the calendar has no
     * action of its own and ADR-0020 s1 forbids inventing one.
     *
     * They were MISSING, and the failure was silent in exactly the way DEC-138 predicted: the
     * tool returned five rows that the mask emptied to `{}`, so "what are the holidays" came
     * back as five blank records with no error anywhere (DEC-149). A holiday is company
     * calendar data, not personal data, so PUBLIC is the right classification.
     */
    holiday_on: PUBLIC(),
    holiday_name: PUBLIC(),
    is_optional: PUBLIC(),
  },

  leave_request: {
    id: PUBLIC(),
    employee_id: PUBLIC(),
    employee_number: PUBLIC(),
    full_name: PUBLIC(),
    leave_type_id: PUBLIC(),
    leave_code: PUBLIC(),
    leave_name: PUBLIC(),
    from_date: PUBLIC(),
    to_date: PUBLIC(),
    working_days: PUBLIC(),
    status: PUBLIC(),
    submitted_at: PUBLIC(),
    decided_at: PUBLIC(),
    decided_by_name: PUBLIC(),
    // The approver's note. Free text about somebody's absence, so it follows the same rule as
    // any other note column: the subject and HR, nobody in between.
    decision_note: HR_AND_SELF('PERSONAL'),

    /*
     * THE ONE THAT MATTERS HERE. `data-inventory.md` on `leave_request.reason`: "free text an
     * employee wrote and may reveal health or family circumstances - treat as SENSITIVE in any
     * export". An assistant answer IS an export: it is a bulk, machine-composed extract that
     * lands in a chat panel and gets copied.
     *
     * SELF_ONLY, so the author can read back what they wrote and nobody else reaches it through
     * this path. That is deliberately NARROWER than the /leave screen, where an approver sees
     * the reason because deciding without it is not possible. Being wrong in this direction
     * costs a missing field in a chat answer; being wrong in the other discloses why somebody
     * took three days off.
     */
    reason: SELF_ONLY('SENSITIVE'),
  },

  attendance_day: {
    employee_id: PUBLIC(),
    employee_number: PUBLIC(),
    full_name: PUBLIC(),
    business_date: PUBLIC(),
    status: PUBLIC(),
    first_in_at: PUBLIC(),
    last_out_at: PUBLIC(),
    worked_minutes: PUBLIC(),
    worked_time: PUBLIC(),
    payable_day_fraction: PUBLIC(),
    note: HR_AND_SELF('PERSONAL'),

    // Derived per-employee AGGREGATES over the same rows, produced by fn_attendance_summary and
    // fn_wfh_usage (migration 0020). They share this resource type because they are counts of
    // these rows, and the mask drops anything it does not know - so a summary tool would return
    // empty objects without them.
    present_days: PUBLIC(),
    late_days: PUBLIC(),
    wfh_days: PUBLIC(),
    absent_days: PUBLIC(),
    leave_days: PUBLIC(),
    week_off_days: PUBLIC(),
    holiday_days: PUBLIC(),
    expected_days: PUBLIC(),
    attendance_days: PUBLIC(),
    /*
     * present_days + wfh_days, computed by the assistant tools rather than by
     * fn_attendance_summary. Registered because the mask drops what it does not know, and
     * because DEC-150 is the reason it exists: `present_days` already INCLUDES late days and
     * `wfh_days` does NOT, so "how many days did I work" read off `present_days` is wrong by
     * exactly the number of days somebody worked from home.
     */
    days_worked: PUBLIC(),
    approved_days: PUBLIC(),
    disagreement: PUBLIC(),
  },

  /*
   * WORK. Three types registered together because they are read together, and because the
   * registry being ABSENT rather than restrictive was the whole finding of DEC-138: the work
   * screens build their column lists by hand, so nothing was protecting these tables - there was
   * simply no mask over them at all. The assistant is the first caller that masks them.
   *
   * `work_log.description` IS THE REASON THIS PASS MATTERS. ADR-0020 s6: "No narrative work-log
   * content reaches anyone but its author", which ADR-0017 states as its own rule. SELF_ONLY
   * makes that STRUCTURAL rather than a promise - it is dropped for every reader who is not the
   * subject, and `SELF_ONLY` also sets `neverInList`, so it survives only in a `selfOnly` tool
   * masked with `inList: false` (DEC-143). A manager reading a report's log sees minutes and
   * projects and no prose, and that is enforced here rather than by remembering to leave a
   * column out of a SELECT list.
   */
  work_log: {
    employee_id: PUBLIC(),
    employee_number: PUBLIC(),
    full_name: PUBLIC(),
    work_date: PUBLIC(),
    minutes: PUBLIC(),
    /*
     * The same duration, preformatted as "49h 00m" by the tool.
     *
     * DEC-153. Minutes are how the column is stored and hours are how people ask, and the
     * conversion is arithmetic - which DEC-150 already established belongs in SQL rather than
     * in a model that gets it wrong silently. It is also the format the attendance screen
     * already uses ("8h 15m"), so an answer and the screen beside it agree.
     */
    time_spent: PUBLIC(),
    entries: PUBLIC(),
    days_logged: PUBLIC(),

    // What the effort was against. Project and task names are work facts, not personal data.
    project_code: PUBLIC(),
    project_name: PUBLIC(),
    sub_project_code: PUBLIC(),
    sub_project_name: PUBLIC(),
    task_code: PUBLIC(),
    task_title: PUBLIC(),
    sub_task_code: PUBLIC(),
    sub_task_title: PUBLIC(),

    // Provenance, from migration 0028. Whether HR entered effort on your behalf is something
    // you and your manager may both see - it is an audit fact about the record, not content.
    entry_source: PUBLIC(),
    entered_by_name: PUBLIC(),
    hr_entered: PUBLIC(),

    // Free text the author wrote about their own day. Nobody else, whatever they hold.
    description: SELF_ONLY('PERSONAL'),
  },

  /*
   * TASKS, as the PERSON-shaped cut. `work.task.read` takes the REPORTING graph and scopes on
   * `assignee_employee_id`, which `graphs.ts` calls load-bearing rather than inconvenient: an
   * unassigned task has no subject, so the predicate excludes it BY CONSTRUCTION rather than by
   * a condition somebody has to remember. Unassigned work is a project-graph question and is not
   * answerable here - the tools say so in a note instead of quietly under-reporting.
   *
   * `description` IS DELIBERATELY ABSENT. A task description is project content rather than the
   * personal narrative `work_log.description` carries, so it is not the §6 case - but nothing
   * needs it to answer "what is assigned to me", and default-deny means an unregistered column
   * cannot be returned by a future SELECT list either. Registering it would be a decision to
   * take when a tool actually needs it.
   */
  task: {
    // The ASSIGNEE, aliased to `employee_id` by the tools so `maskList` can resolve the subject.
    employee_id: PUBLIC(),
    assignee_number: PUBLIC(),
    assignee_name: PUBLIC(),

    task_code: PUBLIC(),
    title: PUBLIC(),
    status: PUBLIC(),
    due_on: PUBLIC(),
    closed_at: PUBLIC(),
    // Computed by the tools from due_on against the business date, not stored.
    is_overdue: PUBLIC(),

    project_code: PUBLIC(),
    project_name: PUBLIC(),
    sub_project_code: PUBLIC(),
    sub_project_name: PUBLIC(),

    // Per-person counts, for the summary cut.
    open_tasks: PUBLIC(),
    overdue_tasks: PUBLIC(),
  },
  /*
   * Effort aggregated per person per project - the `/team/effort` screen's shape. Deliberately
   * carries NO description: a summary of somebody else's effort is minutes against a project,
   * and the moment prose appears in it the s6 rule above is being routed around.
   */
  project_effort: {
    employee_id: PUBLIC(),
    employee_number: PUBLIC(),
    full_name: PUBLIC(),
    project_id: PUBLIC(),
    project_code: PUBLIC(),
    project_name: PUBLIC(),
    minutes: PUBLIC(),
    time_spent: PUBLIC(),
    /*
     * That person TOTAL across every project in the period, repeated on each of their rows.
     *
     * DEC-155. The tool returns one row per person per project, and a question like "who
     * worked more" needs the per-person figure - which the model was computing itself, and
     * getting wrong. A window function costs nothing and removes the arithmetic entirely.
     */
    person_time: PUBLIC(),
    person_minutes: PUBLIC(),
    hr_entered: PUBLIC(),
  },

  /*
   * Timesheets. `return_note` is what a manager wrote when sending one back, so the SUBJECT must
   * be able to read it - a returned timesheet with no reason is unactionable - and it is
   * HR_AND_SELF rather than PUBLIC because it is a comment about somebody's submission.
   */
  timesheet: {
    employee_id: PUBLIC(),
    employee_number: PUBLIC(),
    full_name: PUBLIC(),
    period_start: PUBLIC(),
    period_end: PUBLIC(),
    status: PUBLIC(),
    submitted_at: PUBLIC(),
    decided_at: PUBLIC(),
    decided_by_name: PUBLIC(),
    logged_minutes: PUBLIC(),
    return_note: HR_AND_SELF('PERSONAL'),
  },
  /*
   * Organisation configuration, read by the assistant's two administrative tools
   * (leave_types_and_rules, attendance_policy). Everything here is CONFIG(), so the mask denies
   * it to employee, manager and finance even if a policy change ever admitted them to the row.
   *
   * `unconfirmed_fields` is deliberately absent. It is real and load-bearing - OR-01/DEC-020
   * badge several of these numbers as engineering defaults - but it is answered as a NOTE beside
   * the figures rather than as a column, because a reader who sees a grace period in a table and
   * an array of column names beside it will believe the number.
   */
  org_config: {
    // leave_type
    code: CONFIG(),
    name: CONFIG(),
    is_paid: CONFIG(),
    reduces_attendance: CONFIG(),
    unit: CONFIG(),
    requires_document_after_days: CONFIG(),
    is_statutory: CONFIG(),
    // attendance_policy
    valid_from: CONFIG(),
    valid_to: CONFIG(),
    grace_period_minutes: CONFIG(),
    half_day_min_minutes: CONFIG(),
    full_day_min_minutes: CONFIG(),
    standard_day_minutes: CONFIG(),
    ot_enabled: CONFIG(),
  },

  attendance_punch: {
    id: PUBLIC(),
    employee_id: PUBLIC(),
    employee_number: PUBLIC(),
    business_date: PUBLIC(),
    punched_at: PUBLIC(),
    direction: PUBLIC(),
    // Whether the punch matched a known office, and which - but never where the person was.
    location_verified: PUBLIC(),
    matched_location_name: PUBLIC(),
    note: HR_AND_SELF('PERSONAL'),

    /*
     * NOT REGISTERED, therefore unreachable by every role including the subject:
     * `latitude`, `longitude`, `accuracy_m`, `distance_m`.
     *
     * `data-inventory.md` calls the coordinates "the most sensitive thing here" and nulls them
     * at 12 months. A tool that returned a colleague's movements would be the single worst
     * failure this feature could have, and leaving the columns out of the registry means no
     * tool can return them even by writing them into its own SELECT list.
     */
  },
};

/**
 * The set of fields this actor may see on this resource.
 *
 * `inList` matters: `rbac-rules.md` requires that RESTRICTED fields never appear in a collection
 * response even for a role that could read them individually - a legitimate list request is how
 * bulk disclosure actually happens.
 */
export function fieldMask(
  ctx: AuthContext,
  type: ResourceType,
  opts: { isSubject: boolean; inList?: boolean },
): Set<string> {
  const table = REGISTRY[type];
  if (!table) return new Set();          // unregistered resource: nothing is visible

  const out = new Set<string>();
  for (const [field, rule] of Object.entries(table)) {
    if (opts.inList && rule.neverInList) continue;
    if (opts.isSubject && rule.self) { out.add(field); continue; }
    if (rule.roles.some((r) => ctx.roles.includes(r))) out.add(field);
  }
  return out;
}

/** Apply the mask to a row. Anything unregistered is dropped, not nulled. */
export function applyMask<T extends Record<string, unknown>>(
  row: T,
  allowed: Set<string>,
): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row)) if (allowed.has(k)) out[k] = row[k];
  return out as Partial<T>;
}

/** Fields present on a row that the registry does not know about. Used by the drift test. */
export function unregisteredFields(type: ResourceType, row: Record<string, unknown>): string[] {
  const table = REGISTRY[type] ?? {};
  return Object.keys(row).filter((k) => !(k in table));
}

export function registeredFields(type: ResourceType): string[] {
  return Object.keys(REGISTRY[type] ?? {});
}
