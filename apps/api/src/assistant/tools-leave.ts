/**
 * Domain 2: leave. ADR-0020.
 *
 * Every tool here reuses `leave.balance.read` or `leave.request.read`, whose row filter is
 * `reportingRows`: HR sees everyone, a manager sees themselves plus their subtree, an employee
 * sees themselves, and `finance`/`auditor` see nothing because they hold no leave grant and
 * `scope()` fails closed for an actor holding no role the policy names.
 *
 * TWO EXCLUSIONS THAT ARE NOT NEGOTIABLE HERE:
 *
 *   `leave_request.reason` is SELF_ONLY in the field registry. `data-inventory.md`: "free text an
 *   employee wrote and may reveal health or family circumstances - treat as SENSITIVE in any
 *   export". An assistant answer IS an export. The author reads back their own; nobody else
 *   reaches it through this path, and that is deliberately narrower than the /leave screen where
 *   an approver needs it to decide.
 *
 *   ENTITLEMENT IS ANSWERED FROM THE BALANCE, NEVER FROM THE POLICY TABLE (DEC-131). "How many
 *   casual leaves am I entitled to" looks like a `leave_policy` lookup and must not become one:
 *   ADR-0005(a) makes a policy row organisation-scoped because "a policy row is a historical
 *   derivation input and reading it is a privilege", and DEC-053 is the proof - settings let a
 *   MANAGER read company policy while the matrix said deny. `leave_balance.accrued` is the
 *   entitlement, it is self-scoped, and every employee may already see their own.
 */

import { z } from 'zod';
import {
  defineTool, localDateTime, suppressBelowK, whoClause, whoClauseAnyone, zDate, zPeriod, zWho,
  SCHEMA_PERIOD, SCHEMA_WHO, type ToolCtx, type ToolResult,
} from './catalog';

const ROW_CAP = 500;

/** The leave year a question defaults to: the one the business date falls in. */
const yearOf = (businessDate: string): number => Number(businessDate.slice(0, 4));

const empty = (columns: readonly string[], note?: string): ToolResult =>
  note === undefined ? { columns, rows: [] } : { columns, rows: [], note };

// ---------------------------------------------------------------------------
// leave_balance
// ---------------------------------------------------------------------------

const balanceCols = [
  'employee_number', 'full_name', 'leave_code', 'leave_name', 'leave_year',
  'accrued', 'carried_in', 'adjusted', 'taken', 'pending', 'available',
] as const;

defineTool({
  name: 'leave_balance',
  domain: 'leave',
  description:
    'Leave balance by leave type - how much was accrued, taken, is pending approval, and is ' +
    'still available. THIS IS ALSO HOW ENTITLEMENT QUESTIONS ARE ANSWERED: "accrued" is what the ' +
    'person is entitled to for the year. Use it for any question about how much leave somebody ' +
    'has, is entitled to, has used, or has left. Defaults to the asker and the current leave year.',
  examples: [
    'how much casual leave do I have left?',
    'how many CLs am I entitled to this year?',
    'what is my sick leave balance?',
    'how much leave has EMP006 taken?',
    'do I have any leave left',
  ],
  action: 'leave.balance.read',
  resource: 'leave_balance',
  args: z.object({ ...zWho, leaveYear: z.number().int().min(2000).max(2100).optional() }),
  parameters: {
    type: 'object',
    properties: {
      ...SCHEMA_WHO,
      leaveYear: { type: 'integer', description: 'Leave year. Defaults to the current one.' },
    },
    additionalProperties: false,
  },
  async run(ctx: ToolCtx, args): Promise<ToolResult> {
    const year = args.leaveYear ?? yearOf(ctx.businessDate);
    const who = whoClause(args, 'e', 2, ctx.employeeId);
    const scope = ctx.scope('a', 2 + who.params.length);
    if (!scope) return empty(balanceCols);

    const rows = await ctx.db.rows(
      `SELECT a.employee_id, e.employee_number, e.full_name,
              lt.code AS leave_code, lt.name AS leave_name, lt.is_paid,
              a.leave_year, a.accrued, a.carried_in, a.adjusted, a.taken, a.pending,
              a.encashed, a.lapsed, a.available
         FROM leave_account a
         JOIN employee   e  ON e.id = a.employee_id
         JOIN leave_type lt ON lt.id = a.leave_type_id
        WHERE a.leave_year = $1
          AND ${who.sql}
          AND ${scope.sql}
        ORDER BY e.employee_number, lt.display_order, lt.code
        LIMIT ${ROW_CAP}`,
      [year, ...who.params, ...scope.params]);

    return { columns: balanceCols, rows };
  },
});

// ---------------------------------------------------------------------------
// leave_balance_team
// ---------------------------------------------------------------------------

defineTool({
  name: 'leave_balance_team',
  subjectDefault: 'scope',
  domain: 'leave',
  description:
    'Leave balances for everybody the asker can see - their team if they are a manager, the ' +
    'whole organisation for HR - for one leave type or all of them. Use when the question is ' +
    'about a GROUP rather than one person. Returns nothing for an ordinary employee, who can ' +
    'only see their own.',
  examples: [
    'show me my team\'s leave balances',
    'who on my team has the most casual leave left?',
    'leave balances for everyone',
    'which of my reports still have sick leave?',
  ],
  action: 'leave.balance.read',
  resource: 'leave_balance',
  args: z.object({
    leaveCode: z.string().trim().min(1).max(16).optional(),
    leaveYear: z.number().int().min(2000).max(2100).optional(),
  }),
  parameters: {
    type: 'object',
    properties: {
      leaveCode: { type: 'string', description: 'Leave type code such as CL, SL, EL. Omit for all types.' },
      leaveYear: { type: 'integer', description: 'Leave year. Defaults to the current one.' },
    },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const year = args.leaveYear ?? yearOf(ctx.businessDate);
    const scope = ctx.scope('a', 3);
    if (!scope) return empty(balanceCols);

    const rows = await ctx.db.rows(
      `SELECT a.employee_id, e.employee_number, e.full_name,
              lt.code AS leave_code, lt.name AS leave_name,
              a.leave_year, a.accrued, a.carried_in, a.adjusted, a.taken, a.pending, a.available
         FROM leave_account a
         JOIN employee   e  ON e.id = a.employee_id
         JOIN leave_type lt ON lt.id = a.leave_type_id
        WHERE a.leave_year = $1
          AND ($2::text IS NULL OR upper(lt.code) = upper($2))
          AND ${scope.sql}
        ORDER BY e.employee_number, lt.display_order
        LIMIT ${ROW_CAP}`,
      [year, args.leaveCode ?? null, ...scope.params]);

    return { columns: balanceCols, rows };
  },
});

// ---------------------------------------------------------------------------
// leave_requests
// ---------------------------------------------------------------------------

const requestCols = [
  'employee_number', 'full_name', 'leave_code', 'from_date', 'to_date',
  'working_days', 'status', 'submitted_at', 'decided_at',
] as const;

const STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'cancelled'] as const;

defineTool({
  name: 'leave_requests',
  domain: 'leave',
  description:
    'Leave REQUESTS - the applications themselves, with their dates and approval status. Use for ' +
    'questions about applying, approval, rejection or cancellation, as opposed to how much leave ' +
    'remains (use leave_balance for that). Filterable by status, leave type, date range and ' +
    'person. Does NOT return the reason somebody gave: that is treated as sensitive.',
  examples: [
    'what leave have I applied for?',
    'has my leave been approved?',
    'show me rejected leave requests this year',
    'what leave did EMP006 apply for in August?',
    'list my team\'s leave applications',
  ],
  action: 'leave.request.read',
  resource: 'leave_request',
  args: z.object({
    ...zWho,
    ...zPeriod,
    status: z.enum(STATUSES).optional(),
    leaveCode: z.string().trim().min(1).max(16).optional(),
  }),
  parameters: {
    type: 'object',
    properties: {
      ...SCHEMA_WHO,
      ...SCHEMA_PERIOD,
      status: { type: 'string', enum: [...STATUSES], description: 'Filter by approval status.' },
      leaveCode: { type: 'string', description: 'Leave type code such as CL, SL, EL.' },
    },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const from = args.from ?? `${yearOf(ctx.businessDate)}-01-01`;
    const to = args.to ?? `${yearOf(ctx.businessDate)}-12-31`;
    const who = whoClause(args, 'e', 5, ctx.employeeId);
    const scope = ctx.scope('r', 5 + who.params.length);
    if (!scope) return empty(requestCols);

    const rows = await ctx.db.rows(
      `SELECT r.id, r.employee_id, e.employee_number, e.full_name,
              lt.code AS leave_code, lt.name AS leave_name,
              r.from_date, r.to_date, r.working_days, r.status,
              ${localDateTime('r.submitted_at')} AS submitted_at,
                ${localDateTime('r.decided_at')} AS decided_at, r.reason, r.decision_note,
              d.full_name AS decided_by_name
         FROM leave_request r
         JOIN employee   e  ON e.id = r.employee_id
         JOIN leave_type lt ON lt.id = r.leave_type_id
         LEFT JOIN app_user au ON au.id = r.decided_by
         LEFT JOIN employee d  ON d.id = au.employee_id
        WHERE r.from_date <= $2::date AND r.to_date >= $1::date
          AND ($3::text IS NULL OR r.status = $3)
          AND ($4::text IS NULL OR upper(lt.code) = upper($4))
          AND ${who.sql}
          AND ${scope.sql}
        ORDER BY r.from_date DESC, e.employee_number
        LIMIT ${ROW_CAP}`,
      [from, to, args.status ?? null, args.leaveCode ?? null, ...who.params, ...scope.params]);

    return { columns: requestCols, rows };
  },
});

// ---------------------------------------------------------------------------
// leave_request_status
// ---------------------------------------------------------------------------

defineTool({
  name: 'leave_request_status',
  domain: 'leave',
  description:
    'What happened to the leave request covering a particular DATE - approved, still waiting, ' +
    'rejected - and when it was decided. Use when the question is about one specific day or a ' +
    'short span rather than a list.',
  examples: [
    'was my leave on 14 August approved?',
    'what happened to my leave request for next Monday?',
    'is my leave for 2026-09-14 confirmed?',
  ],
  action: 'leave.request.read',
  resource: 'leave_request',
  args: z.object({ ...zWho, onDate: zDate }),
  parameters: {
    type: 'object',
    properties: {
      ...SCHEMA_WHO,
      onDate: { type: 'string', description: 'The date in question, YYYY-MM-DD.' },
    },
    required: ['onDate'],
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['employee_number', 'leave_code', 'from_date', 'to_date', 'status',
      'submitted_at', 'decided_at', 'decided_by_name'] as const;
    const who = whoClause(args, 'e', 2, ctx.employeeId);
    const scope = ctx.scope('r', 2 + who.params.length);
    if (!scope) return empty(cols);

    const rows = await ctx.db.rows(
      `SELECT r.id, r.employee_id, e.employee_number, e.full_name, lt.code AS leave_code,
              r.from_date, r.to_date, r.working_days, r.status, ${localDateTime('r.submitted_at')} AS submitted_at,
                ${localDateTime('r.decided_at')} AS decided_at,
              r.decision_note, d.full_name AS decided_by_name
         FROM leave_request r
         JOIN employee   e  ON e.id = r.employee_id
         JOIN leave_type lt ON lt.id = r.leave_type_id
         LEFT JOIN app_user au ON au.id = r.decided_by
         LEFT JOIN employee d  ON d.id = au.employee_id
        WHERE $1::date BETWEEN r.from_date AND r.to_date
          AND ${who.sql}
          AND ${scope.sql}
        ORDER BY r.submitted_at DESC NULLS LAST
        LIMIT 50`,
      [args.onDate, ...who.params, ...scope.params]);

    return { columns: cols, rows };
  },
});

// ---------------------------------------------------------------------------
// leave_ledger
// ---------------------------------------------------------------------------

defineTool({
  name: 'leave_ledger',
  domain: 'leave',
  description:
    'The individual entries behind a leave balance - accruals, carry-forward, holds, deductions, ' +
    'adjustments, lapses. Use to explain WHY a balance is what it is, or why it changed. The ' +
    'balance itself is derived from these, so this is the audit trail for it.',
  examples: [
    'why did my leave balance change?',
    'where did my casual leave go?',
    'show me my leave accruals this year',
    'explain my sick leave balance',
  ],
  action: 'leave.balance.read',
  resource: 'leave_balance',
  args: z.object({
    ...zWho,
    leaveCode: z.string().trim().min(1).max(16).optional(),
    leaveYear: z.number().int().min(2000).max(2100).optional(),
  }),
  parameters: {
    type: 'object',
    properties: {
      ...SCHEMA_WHO,
      leaveCode: { type: 'string', description: 'Leave type code such as CL, SL, EL.' },
      leaveYear: { type: 'integer', description: 'Leave year. Defaults to the current one.' },
    },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['employee_number', 'leave_code', 'entry_type', 'days', 'created_at'] as const;
    const year = args.leaveYear ?? yearOf(ctx.businessDate);
    const who = whoClause(args, 'e', 3, ctx.employeeId);
    const scope = ctx.scope('l', 3 + who.params.length);
    if (!scope) return empty(cols);

    // `l.reason` is deliberately NOT selected. A ledger reason can restate a leave reason, and
    // the field registry treats that as SENSITIVE - so selecting it here would route around the
    // mask rather than through it.
    const rows = await ctx.db.rows(
      `SELECT l.employee_id, e.employee_number, e.full_name, lt.code AS leave_code,
              l.entry_type, l.days, ${localDateTime('l.created_at')} AS created_at, l.leave_year
         FROM leave_ledger l
         JOIN employee   e  ON e.id = l.employee_id
         JOIN leave_type lt ON lt.id = l.leave_type_id
        WHERE l.leave_year = $1
          AND ($2::text IS NULL OR upper(lt.code) = upper($2))
          AND ${who.sql}
          AND ${scope.sql}
        ORDER BY l.created_at DESC
        LIMIT ${ROW_CAP}`,
      [year, args.leaveCode ?? null, ...who.params, ...scope.params]);

    return { columns: cols, rows };
  },
});

// ---------------------------------------------------------------------------
// leave_who_is_off
// ---------------------------------------------------------------------------

defineTool({
  name: 'leave_who_is_off',
  subjectDefault: 'scope',
  domain: 'leave',
  description:
    'Who has APPROVED leave overlapping a date range - the team absence calendar. Use for ' +
    'planning questions about who is away, on holiday or unavailable. Only shows people the ' +
    'asker can already see, so an ordinary employee sees only themselves.',
  examples: [
    'who is off next week?',
    'is anyone on my team on leave tomorrow?',
    'who is away between 1 and 5 October?',
    'is EMP006 on leave this week?',
  ],
  action: 'leave.request.read',
  resource: 'leave_request',
  args: z.object({ ...zPeriod, ...zWho }),
  parameters: {
    type: 'object',
    properties: { ...SCHEMA_PERIOD, ...SCHEMA_WHO },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['employee_number', 'full_name', 'leave_code', 'from_date', 'to_date',
      'working_days'] as const;
    const from = args.from ?? ctx.businessDate;
    // Default window is a week, because "who is off" without a range means "around now".
    const to = args.to ?? null;
    const who = whoClauseAnyone(args, 'e', 3);
    const scope = ctx.scope('r', 3 + who.params.length);
    if (!scope) return empty(cols);

    const rows = await ctx.db.rows(
      `SELECT r.employee_id, e.employee_number, e.full_name, lt.code AS leave_code,
              r.from_date, r.to_date, r.working_days, r.status
         FROM leave_request r
         JOIN employee   e  ON e.id = r.employee_id
         JOIN leave_type lt ON lt.id = r.leave_type_id
        WHERE r.status = 'approved'
          AND r.from_date <= COALESCE($2::date, $1::date + 7)
          AND r.to_date   >= $1::date
          AND ${who.sql}
          AND ${scope.sql}
        ORDER BY r.from_date, e.employee_number
        LIMIT ${ROW_CAP}`,
      [from, to, ...who.params, ...scope.params]);

    return {
      columns: cols,
      rows,
      note: args.to ? undefined : `Showing the seven days from ${from}.`,
    };
  },
});

// ---------------------------------------------------------------------------
// leave_pending_approvals -- NOT BUILT IN WAVE 1. See DEC-136.
// ---------------------------------------------------------------------------
//
// "What is waiting for me to approve?" is an obvious tool and it is deliberately absent, because
// building it correctly needs a decision rather than a query, and the trap generalises to every
// approve-shaped tool anybody adds later.
//
// THE OFFER PROBE IS INVERTED FOR THIS ACTION. `permittedTools` asks `assertCan` with THE CALLER
// as the subject - DEC-061, which is what makes a collection read work at all, since a policy
// written around `isSelf` cannot be satisfied by a ref with no subject. But
// `leave.request.approve` carries `isSelf` as a DENY-OVERRIDE ("nobody approves their own leave,
// and it must not be possible to acquire that by also holding hr_admin"). So the probe asks the
// one question this policy is guaranteed to refuse, and the tool was silently never offered - to
// a manager either. It looked like a filter working; it was a probe asking the wrong thing.
//
// AND THE SCOPE PREDICATE IS ALSO WRONG FOR THIS PURPOSE. `reportingRows(..., maxDepth: 1)`
// renders as "self OR direct reports". Composing that would put the manager's OWN submitted
// requests into their approval queue - the very thing the deny-override exists to prevent.
// Rendering the override into the SQL by hand (`AND r.employee_id <> $me`) would work and is
// what the endpoint would have to do, but a deny-override re-implemented in a query is a second
// copy of an authorization rule, which is the thing ADR-0005 exists to prevent.
//
// Correct fixes, none of which is a five-minute change: probe with a real direct report rather
// than with self; or give `scope()` an approver-shaped predicate that excludes the actor. Both
// are authorization changes and belong in their own slice with their own matrix cells.
//
// Nothing is lost operationally: /leave already shows a manager their approval queue, and the
// assistant is read-only, so it could never have approved anything anyway.

// ---------------------------------------------------------------------------
// leave_liability  (aggregate - k=5)
// ---------------------------------------------------------------------------

defineTool({
  name: 'leave_liability',
  subjectDefault: 'scope',
  domain: 'leave',
  description:
    'Total outstanding leave across people, by leave type - the organisation\'s accrued leave ' +
    'liability. An AGGREGATE, so it is suppressed when it would cover fewer than five people. ' +
    'Use for questions about total or overall leave exposure, not about one person.',
  examples: [
    'what is our total leave liability?',
    'how much unused leave is outstanding overall?',
    'total accrued leave by type',
  ],
  action: 'leave.balance.read',
  resource: 'leave_balance',
  args: z.object({ leaveYear: z.number().int().min(2000).max(2100).optional() }),
  parameters: {
    type: 'object',
    properties: { leaveYear: { type: 'integer', description: 'Leave year. Defaults to current.' } },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['leave_code', 'leave_name', 'people', 'accrued', 'taken', 'available'] as const;
    const year = args.leaveYear ?? yearOf(ctx.businessDate);
    const scope = ctx.scope('a', 2);
    if (!scope) return empty(cols);

    // The predicate is composed INTO the statement and Postgres aggregates AFTER it, so no
    // unscoped total ever exists in this process (DEC-060).
    const rows = await ctx.db.rows<{ leave_code: string; people: string }>(
      `SELECT lt.code AS leave_code, lt.name AS leave_name,
              count(DISTINCT a.employee_id)  AS people,
              sum(a.accrued)                 AS accrued,
              sum(a.taken)                   AS taken,
              sum(a.available)               AS available
         FROM leave_account a
         JOIN leave_type lt ON lt.id = a.leave_type_id
        WHERE a.leave_year = $1
          AND ${scope.sql}
        GROUP BY lt.code, lt.name, lt.display_order
        ORDER BY lt.display_order`,
      [year, ...scope.params]);

    const people = await ctx.db.one<{ n: string }>(
      `SELECT count(DISTINCT a.employee_id) AS n FROM leave_account a
        WHERE a.leave_year = $1 AND ${scope.sql}`,
      [year, ...scope.params]);

    return suppressBelowK(rows, Number(people?.n ?? 0), cols);
  },
});

// ---------------------------------------------------------------------------
// leave_usage_trend
// ---------------------------------------------------------------------------

defineTool({
  name: 'leave_usage_trend',
  domain: 'leave',
  description:
    'Leave taken per MONTH over a period, so a pattern is visible. Use for questions about when ' +
    'leave is usually taken, busy months, or a trend over time. For one person by default.',
  examples: [
    'which months do I take the most leave?',
    'show my leave usage by month',
    'when did I take leave this year?',
  ],
  /*
   * Keyed on the LEAVE DATE, not on when the ledger row was written. A 'take' entry's
   * created_at is when the deduction was recorded - a request approved in July for October
   * would land in July and the answer to "which months do I take leave" would be wrong in
   * exactly the way nobody checks. leave_request.from_date is when the person was actually off.
   */
  action: 'leave.request.read',
  resource: 'leave_request',
  args: z.object({ ...zWho, ...zPeriod }),
  parameters: {
    type: 'object',
    properties: { ...SCHEMA_WHO, ...SCHEMA_PERIOD },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['month', 'leave_code', 'days'] as const;
    const from = args.from ?? `${yearOf(ctx.businessDate)}-01-01`;
    const to = args.to ?? `${yearOf(ctx.businessDate)}-12-31`;
    const who = whoClause(args, 'e', 3, ctx.employeeId);
    const scope = ctx.scope('r', 3 + who.params.length);
    if (!scope) return empty(cols);

    const rows = await ctx.db.rows(
      `SELECT to_char(r.from_date, 'YYYY-MM') AS month,
              lt.code                         AS leave_code,
              sum(r.working_days)             AS days
         FROM leave_request r
         JOIN employee   e  ON e.id = r.employee_id
         JOIN leave_type lt ON lt.id = r.leave_type_id
        WHERE r.status = 'approved'
          AND r.from_date >= $1::date
          AND r.from_date <= $2::date
          AND ${who.sql}
          AND ${scope.sql}
        GROUP BY 1, 2
        ORDER BY 1, 2
        LIMIT ${ROW_CAP}`,
      [from, to, ...who.params, ...scope.params]);

    return { columns: cols, rows };
  },
});

// ---------------------------------------------------------------------------
// leave_holidays
// ---------------------------------------------------------------------------

defineTool({
  name: 'leave_holidays',
  subjectDefault: 'scope',
  domain: 'leave',
  description:
    'The company holiday calendar - public holidays and optional holidays, with their dates. ' +
    'Contains no personal data. Use for "when is the next holiday", "is X a holiday", "list the ' +
    'holidays". An OPTIONAL holiday counts as leave unless the employee elects it.',
  examples: [
    'when is the next public holiday?',
    'what holidays are coming up?',
    'is 2 October a holiday?',
    'list this year\'s holidays',
  ],
  /*
   * The calendar is not ABOUT anybody, so no row filter applies and `ctx.scope` is deliberately
   * not composed below - there is no subject column to filter on. It still travels behind
   * `leave.balance.read` rather than being treated as free, so the gate runs and the tool is
   * offered only to actors who hold a leave grant at all.
   *
   * The cost, stated rather than discovered: `finance` and `auditor` cannot ask for the holiday
   * calendar. They hold no leave grant. Giving it its own action would be the alternative, and
   * ADR-0020 is explicit that a tool needing a new action is a new feature, not a tool.
   */
  action: 'leave.balance.read',
  resource: 'leave_balance',
  args: z.object({ ...zPeriod, includeOptional: z.boolean().optional() }),
  parameters: {
    type: 'object',
    properties: {
      ...SCHEMA_PERIOD,
      includeOptional: { type: 'boolean', description: 'Include optional holidays. Default true.' },
    },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    // `holiday_name`, not `name`: a bare `name` on a resource type shared with leave balances
    // would be ambiguous to every future reader of the registry.
    const cols = ['holiday_on', 'holiday_name', 'is_optional'] as const;
    const from = args.from ?? ctx.businessDate;
    const to = args.to ?? `${yearOf(ctx.businessDate)}-12-31`;

    const rows = await ctx.db.rows(
      `SELECT h.holiday_on, h.name AS holiday_name, h.is_optional
         FROM holiday h
        WHERE h.holiday_on BETWEEN $1::date AND $2::date
          AND ($3::boolean OR NOT h.is_optional)
        ORDER BY h.holiday_on
        LIMIT ${ROW_CAP}`,
      [from, to, args.includeOptional ?? true]);

    return { columns: cols, rows, note: `Holidays from ${from} to ${to}.` };
  },
});

// ---------------------------------------------------------------------------
// leave_types_and_rules   -- HR-scoped. See DEC-131.
// ---------------------------------------------------------------------------

defineTool({
  name: 'leave_types_and_rules',
  subjectDefault: 'scope',
  domain: 'leave',
  description:
    'The leave TYPE CATALOGUE and its configured rules - which types are paid, which reduce ' +
    'attendance, which need a document after so many days. ADMINISTRATIVE: this reads ' +
    'configuration, which is a privilege, so most people cannot use it. DO NOT use it to answer ' +
    'how much leave somebody is entitled to - use leave_balance, whose "accrued" column is the ' +
    'entitlement and which every employee may read for themselves.',
  examples: [
    'what leave types are configured?',
    'is compensatory off paid?',
    'which leave types need a medical certificate?',
  ],
  action: 'config.policy.read',
  resource: 'org_config',
  args: z.object({}),
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async run(ctx): Promise<ToolResult> {
    const cols = ['code', 'name', 'is_paid', 'reduces_attendance', 'unit',
      'requires_document_after_days', 'is_statutory'] as const;
    // Organisation-scoped: `scope()` returns ALLOW_ALL only for an actor holding the
    // administrative permission, and DENY_ALL otherwise (ADR-0005 amendment (a)).
    const scope = ctx.scope('lt', 1);
    if (!scope) return empty(cols);

    const rows = await ctx.db.rows(
      `SELECT lt.code, lt.name, lt.is_paid, lt.reduces_attendance, lt.unit,
              lt.requires_document_after_days, lt.is_statutory
         FROM leave_type lt
        WHERE lt.archived_at IS NULL
          AND ${scope.sql}
        ORDER BY lt.display_order, lt.code`,
      scope.params);

    return { columns: cols, rows };
  },
});

// ---------------------------------------------------------------------------
// leave_taken_by_person
// ---------------------------------------------------------------------------

/*
 * "Who took leave?" - and it must read the LEDGER, not `leave_request`.
 *
 * THE TWO ARE NOT THE SAME QUESTION. `leave_who_is_off` and `leave_requests` both read
 * `leave_request`, which records an APPLICATION and its approval. The ledger records what was
 * actually consumed, and CLAUDE.md rule 6 is the reason the two can diverge at all: a balance
 * is derived from ledger entries, so leave granted by HR, adjusted, or migrated in has a
 * `take` entry and no request behind it. Asking "who took leave" through the request table
 * answers a narrower question than it sounds like, and answers it silently.
 *
 * In the seeded database that difference is total: `leave_request` has ZERO rows while the
 * ledger holds four days for EMP001 and two for EMP003, which is why the question returned
 * "nothing matched" from a system that plainly had the data.
 *
 * DAYS, NEVER MONEY. `days` is `numeric` and stays that way - encashment VALUE is money and
 * is out of the catalogue entirely (ADR-0020 s6).
 */
defineTool({
  name: 'leave_taken_by_person',
  domain: 'leave',
  subjectDefault: 'scope',
  description:
    'Leave actually TAKEN, per person, for everybody the asker can see - from the leave ledger, ' +
    'so it includes leave recorded by HR as well as leave applied for. Use for "who took leave", ' +
    '"how much leave has the team used", "who has taken casual leave this year". Reports DAYS. ' +
    'For one person use leave_ledger; for who is AWAY on a date use leave_who_is_off.',
  examples: [
    'who took leave?',
    'how much leave has each person taken this year?',
    'who has used casual leave?',
    'leave taken by the team in 2026',
  ],
  action: 'leave.balance.read',
  resource: 'leave_balance',
  args: z.object({
    leaveYear: z.number().int().min(2000).max(2100).optional(),
    leaveCode: z.string().trim().min(1).max(16).optional(),
  }),
  parameters: {
    type: 'object',
    properties: {
      leaveYear: { type: 'integer', description: 'Leave year. Defaults to the current one.' },
      leaveCode: { type: 'string', description: 'Leave type code, e.g. CL or SL. Optional.' },
    },
    additionalProperties: false,
  },
  async run(ctx: ToolCtx, args): Promise<ToolResult> {
    const cols = ['employee_number', 'full_name', 'leave_code', 'leave_name', 'taken'] as const;
    const year = args.leaveYear ?? Number(ctx.businessDate.slice(0, 4));
    const scope = ctx.scope('l', 3);
    if (!scope) return { columns: cols, rows: [] };

    const rows = await ctx.db.rows(
      'SELECT l.employee_id, e.employee_number, e.full_name, ' +
      '       lt.code AS leave_code, lt.name AS leave_name, ' +
      '       sum(l.days)::numeric AS taken ' +
      '  FROM leave_ledger l ' +
      '  JOIN employee   e  ON e.id = l.employee_id ' +
      '  JOIN leave_type lt ON lt.id = l.leave_type_id ' +
      " WHERE l.entry_type = 'take' AND l.leave_year = $1 " +
      '   AND ($2::text IS NULL OR upper(lt.code) = upper($2)) ' +
      '   AND ' + scope.sql +
      ' GROUP BY l.employee_id, e.employee_number, e.full_name, lt.code, lt.name, lt.display_order ' +
      ' ORDER BY e.employee_number, lt.display_order LIMIT ' + ROW_CAP,
      [year, args.leaveCode ?? null, ...scope.params]);

    return {
      columns: cols,
      rows,
      note: 'Leave year ' + year + ', taken to date. Read from the ledger, so it includes leave recorded by HR as well as leave applied for.',
    };
  },
});
