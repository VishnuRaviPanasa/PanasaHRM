/**
 * Domain: work. ADR-0020.
 *
 * THE ACCESS QUESTION, PER ACTION, CHECKED BEFORE ANY OF THIS WAS WRITTEN. The work actions are
 * the least uniform in the system, and two of them answer to DIFFERENT SCOPE GRAPHS - which is
 * the whole reason ADR-0020 §2 talks about "two orthogonal scope graphs" rather than one.
 *
 *   `work.log.read`          graph REPORTING. employee: conditional (self), manager: conditional
 *                            (subtree), hr_admin/hr_ops: allow. finance/auditor: DENY.
 *   `work.timesheet.read`    graph REPORTING. same shape.
 *   `work.team_effort.read`  graph REPORTING. **employee: DENY.** manager/hr_admin/hr_ops: allow.
 *   `work.project_effort.read` graph PROJECT - membership, not a reporting line. Not used here.
 *
 * SO THE ROLE DIFFERENCE IS ALREADY IN THE ACTIONS, and these tools add nothing to it. An
 * employee is never OFFERED `work_team_effort`, because `permittedTools` asks `assertCan` and the
 * policy says deny; a manager is, and `scope()` narrows the rows to their own subtree. Nothing
 * here inspects a role, and nothing here needs to.
 *
 * TASKS ARE THE PERSON-SHAPED CUT. `work.task.read` also takes the REPORTING graph, scoped on
 * `assignee_employee_id` - so an UNASSIGNED task has no subject and is excluded by construction
 * (DEC-152). The task tools say that in a note rather than under-reporting silently.
 *
 * WHY NO PROJECT-GRAPH TOOL YET. `work.project.read` and `work.project_effort.read` resolve
 * through PROJECT MEMBERSHIP, so "who is on ATLAS" - including unassigned work - is a different
 * question from "who reports to me", and a tool over it must not be built by analogy with the
 * reporting ones. `project` is also still unregistered, so a tool over it would mask to `{}`
 * today. Named in the backlog, and not guessed at here.
 *
 * NARRATIVE CONTENT. `work_log.description` is SELF_ONLY in the registry, which makes ADR-0020
 * §6's rule structural: it appears in `work_my_log`, which is `selfOnly` and therefore masked
 * with `inList: false`, and it is not in the SELECT list of any other tool. A manager reading a
 * report's effort sees minutes and projects. That is enforced twice, on purpose.
 *
 * NO ORDERING BY EFFORT. §6 again: "no tool ranks, scores or orders people". `work_team_effort`
 * orders by NAME and then by project code - never by minutes - so the result cannot be read as a
 * league table. The `/team/effort` screen sorts by minutes within one person, which is a
 * different thing, and the assistant does not copy it.
 */

import { z } from 'zod';
import {
  defineTool, localDateTime, whoClause, zDate, zPeriod, zWho,
  SCHEMA_PERIOD, SCHEMA_WHO, type ToolResult,
} from './catalog';

const ROW_CAP = 500;
const empty = (columns: readonly string[]): ToolResult => ({ columns, rows: [] });

/** First of the month containing `iso`. The default window for an unqualified work question. */
const monthStart = (iso: string): string => `${iso.slice(0, 7)}-01`;

// ---------------------------------------------------------------------------
// work_my_log
// ---------------------------------------------------------------------------

/*
 * The author's own log, WITH the descriptions they wrote.
 *
 * `selfOnly: true` is what makes the description readable at all: `SELF_ONLY` in the registry
 * also sets `neverInList`, so a list-masked answer drops it even for the subject, and only a
 * self-only tool masks with `inList: false` (DEC-143). It takes no person argument, so it cannot
 * be aimed at a colleague, which is the property that makes the relaxation safe.
 */
defineTool({
  name: 'work_my_log',
  domain: 'work',
  selfOnly: true,
  description:
    'The asker OWN work log: what they logged effort against, with their own notes, day by day. ' +
    'Use for "what did I work on yesterday", "show my log for last week", "what have I logged ' +
    'today". Always about the asker - it takes no person argument.',
  examples: [
    'what did I log today?',
    'show my work log for last week',
    'what did I work on yesterday?',
    'what have I been logging effort against?',
  ],
  action: 'work.log.read',
  resource: 'work_log',
  args: z.object({ ...zPeriod }),
  parameters: { type: 'object', properties: { ...SCHEMA_PERIOD }, additionalProperties: false },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['work_date', 'project_code', 'project_name', 'task_title', 'time_spent',
      'minutes', 'description', 'entry_source'] as const;

    const from = args.from ?? monthStart(ctx.businessDate);
    const to = args.to ?? ctx.businessDate;
    const scope = ctx.scope('wl', 4);
    if (!scope) return empty(cols);

    const rows = await ctx.db.rows(
      'SELECT wl.employee_id, wl.work_date, p.code AS project_code, p.name AS project_name, ' +
      '       t.title AS task_title, wle.minutes, ' +
      "       (wle.minutes / 60)::text || 'h ' || " +
      "       lpad((wle.minutes % 60)::text, 2, '0') || 'm' AS time_spent, " +
      '       wle.description, wle.entry_source ' +
      '  FROM work_log wl ' +
      '  JOIN work_log_entry wle ON wle.work_log_id = wl.id ' +
      '  JOIN project p ON p.id = wle.project_id ' +
      '  LEFT JOIN task t ON t.id = wle.task_id ' +
      ' WHERE wl.employee_id = $1 AND wl.work_date BETWEEN $2::date AND $3::date ' +
      '   AND ' + scope.sql +
      ' ORDER BY wl.work_date DESC, p.code LIMIT ' + ROW_CAP,
      [ctx.employeeId, from, to, ...scope.params],
    );
    return { columns: cols, rows, note: `Period ${from} to ${to}.` };
  },
});

// ---------------------------------------------------------------------------
// work_effort_summary
// ---------------------------------------------------------------------------

/*
 * Minutes by project for ONE person - the asker by default, or somebody they may see.
 *
 * `whoClause` rather than `whoClauseAnyone`, so "how much time did I put on ATLAS" means the
 * asker (DEC-144). A manager naming a report gets that report, because the scope predicate
 * admits them; naming anybody else returns nothing and the controller says so (DEC-142).
 *
 * No `description` column. This tool can be pointed at another person, so the s6 narrative rule
 * applies to it, and the registry would drop the column anyway.
 */
defineTool({
  name: 'work_effort_summary',
  domain: 'work',
  description:
    'How somebody effort split across PROJECTS over a period, in minutes. Defaults to the asker. ' +
    'Use for "how much time did I spend on ATLAS", "where did my hours go last month", "how much ' +
    'has Vishnu logged on this project". Reports minutes against projects, never the notes ' +
    'somebody wrote.',
  examples: [
    'how much time did I spend on ATLAS this month?',
    'where did my hours go last month?',
    'how many hours have I logged this week?',
    'how much effort has Vishnu put on ATLAS?',
  ],
  action: 'work.log.read',
  resource: 'work_log',
  args: z.object({ ...zWho, ...zPeriod }),
  parameters: {
    type: 'object',
    properties: { ...SCHEMA_WHO, ...SCHEMA_PERIOD },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['employee_number', 'full_name', 'project_code', 'project_name', 'time_spent',
      'minutes', 'days_logged'] as const;

    const from = args.from ?? monthStart(ctx.businessDate);
    const to = args.to ?? ctx.businessDate;
    const who = whoClause(args, 'e', 3, ctx.employeeId);
    const scope = ctx.scope('wl', 3 + who.params.length);
    if (!scope) return empty(cols);

    const rows = await ctx.db.rows(
      'SELECT wl.employee_id, e.employee_number, e.full_name, ' +
      '       p.code AS project_code, p.name AS project_name, ' +
      '       sum(wle.minutes)::int AS minutes, ' +
      "       (sum(wle.minutes) / 60)::int::text || 'h ' || " +
      "       lpad(((sum(wle.minutes) % 60))::int::text, 2, '0') || 'm' AS time_spent, " +
      '       count(DISTINCT wl.work_date)::int AS days_logged ' +
      '  FROM work_log wl ' +
      '  JOIN work_log_entry wle ON wle.work_log_id = wl.id ' +
      '  JOIN project  p ON p.id = wle.project_id ' +
      '  JOIN employee e ON e.id = wl.employee_id ' +
      ' WHERE wl.work_date BETWEEN $1::date AND $2::date ' +
      '   AND ' + who.sql + ' AND ' + scope.sql +
      ' GROUP BY wl.employee_id, e.employee_number, e.full_name, p.code, p.name ' +
      ' ORDER BY e.employee_number, p.code LIMIT ' + ROW_CAP,
      [from, to, ...who.params, ...scope.params],
    );
    return { columns: cols, rows, note: `Period ${from} to ${to}.` };
  },
});

// ---------------------------------------------------------------------------
// work_team_effort
// ---------------------------------------------------------------------------

/*
 * The manager's question: how did my team's effort split, per person, per project.
 *
 * A DIFFERENT ACTION from the two above, and that is the point. `work.team_effort.read` is DENY
 * for `employee`, so an ordinary employee is never offered this tool - the role difference lives
 * in the policy, not in a branch here. It mirrors `/team/effort`, which is the screen ADR-0020 §1
 * requires a tool to sit beside.
 *
 * ORDERED BY NAME, NEVER BY MINUTES. §6 forbids a tool that ranks or orders people, and "top by
 * hours logged" is a league table whatever it is called. Sorting alphabetically is the difference
 * between reporting effort and scoring people.
 */
defineTool({
  name: 'work_team_effort',
  domain: 'work',
  subjectDefault: 'scope',
  description:
    'Effort per PERSON per PROJECT across everybody the asker can see, over a period, in ' +
    'minutes. For a manager this is their team; for HR it is the organisation. Use for "team ' +
    'effort by person", "how did the team split their time", "how much has each person logged". ' +
    'Listed alphabetically - it does not rank people. Ordinary employees cannot use this.',
  examples: [
    'team effort by person',
    'how did my team split their time this month?',
    'how much has each person logged against ATLAS?',
    'effort by person last week',
  ],
  action: 'work.team_effort.read',
  resource: 'project_effort',
  args: z.object({ ...zPeriod, projectQuery: z.string().trim().min(1).max(80).optional() }),
  parameters: {
    type: 'object',
    properties: {
      ...SCHEMA_PERIOD,
      projectQuery: { type: 'string', description: 'Project name or code, to narrow to one project.' },
    },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['employee_number', 'full_name', 'person_time', 'project_code', 'project_name',
      'time_spent', 'minutes', 'hr_entered'] as const;

    const from = args.from ?? monthStart(ctx.businessDate);
    const to = args.to ?? ctx.businessDate;
    const params: unknown[] = [from, to, args.projectQuery ? `%${args.projectQuery}%` : null];
    const scope = ctx.scope('wl', 4);
    if (!scope) return empty(cols);

    const rows = await ctx.db.rows(
      'SELECT wl.employee_id, e.employee_number, e.full_name, ' +
      '       p.code AS project_code, p.name AS project_name, ' +
      '       sum(wle.minutes)::int AS minutes, ' +
      "       (sum(wle.minutes) / 60)::int::text || 'h ' || " +
      "       lpad(((sum(wle.minutes) % 60))::int::text, 2, '0') || 'm' AS time_spent, " +
      "       count(*) FILTER (WHERE wle.entry_source = 'hr_entry')::int AS hr_entered, " +
      // That person TOTAL across every project, repeated on each of their rows. A window
      // function runs AFTER the GROUP BY, so this sums the per-project sums - exactly the
      // figure "who worked more" wants, and exactly the addition the model was getting wrong.
      "       sum(sum(wle.minutes)) OVER (PARTITION BY wl.employee_id)::int AS person_minutes, " +
      /*
       * CAST TO int BEFORE DIVIDING. `sum(sum(...)) OVER (...)` is NUMERIC, so `/ 60` is
       * decimal division and `::int` ROUNDS it: 2730 minutes came out as 46h 30m instead of
       * 45h 30m, one hour more than the projects beneath it added up to. `time_spent` above is
       * safe only because plain `sum(int)` is bigint and divides as integers - which is exactly
       * the kind of difference that does not announce itself.
       */
      "       ((sum(sum(wle.minutes)) OVER (PARTITION BY wl.employee_id))::int / 60)::text " +
      "         || 'h ' " +
      "         || lpad((((sum(sum(wle.minutes)) OVER (PARTITION BY wl.employee_id))::int " +
      "            % 60))::text, 2, '0') || 'm' AS person_time " +
      '  FROM work_log wl ' +
      '  JOIN work_log_entry wle ON wle.work_log_id = wl.id ' +
      '  JOIN project  p ON p.id = wle.project_id ' +
      '  JOIN employee e ON e.id = wl.employee_id ' +
      ' WHERE wl.work_date BETWEEN $1::date AND $2::date ' +
      '   AND ($3::text IS NULL OR p.name ILIKE $3 OR p.code ILIKE $3) ' +
      '   AND ' + scope.sql +
      ' GROUP BY wl.employee_id, e.employee_number, e.full_name, p.code, p.name ' +
      ' ORDER BY e.full_name, p.code LIMIT ' + ROW_CAP,
      [...params, ...scope.params],
    );
    /*
     * The overall total, STATED rather than left to be added up (DEC-155).
     *
     * Computed here, in integer minutes, from the rows this tool just produced - so it is the
     * true total of what was found, and it is arithmetic our code does rather than arithmetic a
     * model attempts. `minutes` is PUBLIC on this resource, so masking cannot remove its input.
     */
    const totalMinutes = rows.reduce((n, r) => n + Number(r.minutes ?? 0), 0);
    const people = new Set(rows.map((r) => r.employee_id)).size;
    const hhmm = Math.floor(totalMinutes / 60) + 'h ' +
      String(totalMinutes % 60).padStart(2, '0') + 'm';

    return {
      columns: cols,
      rows,
      note: `Period ${from} to ${to}. Listed by name, not by hours. `
        + 'person_time is that person total across all projects; time_spent is one project. '
        + `Total across all ${people} people shown: ${hhmm}.`,
    };
  },
});

// ---------------------------------------------------------------------------
// timesheet_status
// ---------------------------------------------------------------------------

defineTool({
  name: 'timesheet_status',
  domain: 'work',
  description:
    'Timesheet periods and where each one stands - open, submitted, approved or returned, when ' +
    'it was submitted, who decided it, and the note if it was sent back. Defaults to the asker. ' +
    'Use for "is my timesheet submitted", "was my timesheet approved", "why was it returned".',
  examples: [
    'is my timesheet submitted?',
    'was last week\'s timesheet approved?',
    'why was my timesheet returned?',
    'when did I submit my timesheet?',
  ],
  action: 'work.timesheet.read',
  resource: 'timesheet',
  args: z.object({ ...zWho, ...zPeriod }),
  parameters: {
    type: 'object',
    properties: { ...SCHEMA_WHO, ...SCHEMA_PERIOD },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['employee_number', 'full_name', 'period_start', 'period_end', 'status',
      'submitted_at', 'decided_at', 'decided_by_name', 'return_note'] as const;

    const from = args.from ?? monthStart(ctx.businessDate);
    const to = args.to ?? ctx.businessDate;
    const who = whoClause(args, 'e', 3, ctx.employeeId);
    const scope = ctx.scope('tp', 3 + who.params.length);
    if (!scope) return empty(cols);

    const rows = await ctx.db.rows(
      'SELECT tp.employee_id, e.employee_number, e.full_name, ' +
      '       tp.period_start, tp.period_end, tp.status, ' +
      '       ' + localDateTime('tp.submitted_at') + ' AS submitted_at, ' +
      '       ' + localDateTime('tp.decided_at') + ' AS decided_at, ' +
      '       m.full_name AS decided_by_name, tp.return_note ' +
      '  FROM timesheet_period tp ' +
      '  JOIN employee e ON e.id = tp.employee_id ' +
      '  LEFT JOIN employee m ON m.id = tp.decided_by ' +
      ' WHERE tp.period_start <= $2::date AND tp.period_end >= $1::date ' +
      '   AND ' + who.sql + ' AND ' + scope.sql +
      ' ORDER BY tp.period_start DESC, e.employee_number LIMIT ' + ROW_CAP,
      [from, to, ...who.params, ...scope.params],
    );
    return { columns: cols, rows, note: `Periods overlapping ${from} to ${to}.` };
  },
});

// ---------------------------------------------------------------------------
// timesheet_team_status
// ---------------------------------------------------------------------------

/*
 * "Who has not submitted?" - the same action and the same scope predicate as the tool above,
 * differing only in the SUBJECT DEFAULT. It is a separate tool rather than an argument because
 * DEC-144 made "no name given" mean the asker, and a manager asking about their team is asking a
 * different question from a manager asking about themselves.
 *
 * NOT built on `work.timesheet.approve`. That action carries `isSelf` as a DENY-OVERRIDE, so the
 * probe `permittedTools` makes - assertCan with the caller as subject - is guaranteed to fail and
 * the tool would be silently offered to nobody. That is DEC-136, found the hard way.
 */
defineTool({
  name: 'timesheet_team_status',
  domain: 'work',
  subjectDefault: 'scope',
  description:
    'Timesheet status for everybody the asker can see - who has submitted, who has not, what is ' +
    'waiting on a decision. For a manager this is their team; for HR the organisation. Use for ' +
    '"whose timesheets are pending", "who has not submitted", "team timesheet status".',
  examples: [
    'whose timesheets are pending?',
    'who has not submitted their timesheet?',
    'team timesheet status for last week',
    'which timesheets are waiting on me?',
  ],
  action: 'work.timesheet.read',
  resource: 'timesheet',
  args: z.object({ ...zPeriod, status: z.string().trim().min(1).max(24).optional() }),
  parameters: {
    type: 'object',
    properties: {
      ...SCHEMA_PERIOD,
      status: {
        type: 'string',
        // Naming the real values matters: a model asked about "pending" timesheets invented that
        // status, matched nothing, and the turn reported an empty result as a fact (DEC-152).
        description:
          'Narrow to one status. The only values are draft, submitted, under_review, approved ' +
          'and returned. There is no "pending" status - unsubmitted work is draft, and work ' +
          'awaiting a decision is submitted or under_review.',
      },
    },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['employee_number', 'full_name', 'period_start', 'period_end', 'status',
      'submitted_at', 'decided_by_name'] as const;

    const from = args.from ?? monthStart(ctx.businessDate);
    const to = args.to ?? ctx.businessDate;
    const scope = ctx.scope('tp', 4);
    if (!scope) return empty(cols);

    const rows = await ctx.db.rows(
      'SELECT tp.employee_id, e.employee_number, e.full_name, ' +
      '       tp.period_start, tp.period_end, tp.status, ' +
      '       ' + localDateTime('tp.submitted_at') + ' AS submitted_at, ' +
      '       m.full_name AS decided_by_name ' +
      '  FROM timesheet_period tp ' +
      '  JOIN employee e ON e.id = tp.employee_id ' +
      '  LEFT JOIN employee m ON m.id = tp.decided_by ' +
      ' WHERE tp.period_start <= $2::date AND tp.period_end >= $1::date ' +
      '   AND ($3::text IS NULL OR tp.status = $3) ' +
      '   AND ' + scope.sql +
      ' ORDER BY tp.status, e.employee_number LIMIT ' + ROW_CAP,
      [from, to, args.status ?? null, ...scope.params],
    );
    return { columns: cols, rows, note: `Periods overlapping ${from} to ${to}.` };
  },
});

// ---------------------------------------------------------------------------
// work_my_tasks
// ---------------------------------------------------------------------------

/*
 * TASKS ARE THE PERSON-SHAPED CUT, and that decides everything about these two tools.
 *
 * `work.task.read` takes the REPORTING graph and scopes on `assignee_employee_id`. `graphs.ts`
 * is explicit that the nullability is load-bearing: an unassigned task has no subject, so the
 * predicate excludes it BY CONSTRUCTION. Two of the nine seeded tasks are unassigned and are
 * therefore invisible here - correct, and stated in a note rather than left as a quiet
 * undercount, because "nobody has pending tasks" and "nobody I can see has been ASSIGNED a
 * pending task" are different answers.
 *
 * The project-shaped cut - "what is open on ATLAS", including unassigned work - is
 * `work.project.read` and its MEMBERSHIP graph. Not built by analogy with these; `project` is
 * still unregistered and membership is not a reporting line.
 */
defineTool({
  name: 'work_my_tasks',
  domain: 'work',
  description:
    'Tasks ASSIGNED to somebody, with project, status and due date. Defaults to the asker, so ' +
    '"what is assigned to me" needs no name. Use for "what am I working on", "what tasks do I ' +
    'have", "what is Vishnu working on", "am I overdue on anything". Only tasks that have an ' +
    'assignee - unassigned work is not reported here.',
  examples: [
    'what tasks do I have?',
    'what am I working on?',
    'do I have anything overdue?',
    'what is Vishnu working on?',
  ],
  action: 'work.task.read',
  resource: 'task',
  args: z.object({
    ...zWho,
    openOnly: z.boolean().optional(),
  }),
  parameters: {
    type: 'object',
    properties: {
      ...SCHEMA_WHO,
      openOnly: {
        type: 'boolean',
        description: 'Only tasks still to do (open, in progress, blocked). Defaults to true.',
      },
    },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['assignee_number', 'assignee_name', 'task_code', 'title', 'status',
      'project_code', 'due_on', 'is_overdue'] as const;

    const openOnly = args.openOnly !== false;
    const who = whoClause(args, 'e', 2, ctx.employeeId);
    const scope = ctx.scope('t', 2 + who.params.length);
    if (!scope) return empty(cols);

    const rows = await ctx.db.rows(
      'SELECT t.assignee_employee_id AS employee_id, e.employee_number AS assignee_number, ' +
      '       e.full_name AS assignee_name, t.code AS task_code, t.title, t.status, ' +
      '       p.code AS project_code, p.name AS project_name, t.due_on, ' +
      '       (t.due_on IS NOT NULL AND t.due_on < $1::date ' +
      "        AND t.status NOT IN ('done','cancelled')) AS is_overdue " +
      '  FROM task t ' +
      '  JOIN employee e ON e.id = t.assignee_employee_id ' +
      '  JOIN project  p ON p.id = t.project_id ' +
      ' WHERE ' + who.sql + ' AND ' + scope.sql +
      (openOnly ? " AND t.status IN ('open','in_progress','blocked') " : ' ') +
      ' ORDER BY t.due_on NULLS LAST, p.code, t.code LIMIT ' + ROW_CAP,
      [ctx.businessDate, ...who.params, ...scope.params],
    );

    return {
      columns: cols,
      rows,
      note: openOnly
        ? 'Tasks still to do. Only tasks that have an assignee are included - unassigned work ' +
          'is not visible through this lookup.'
        : 'Only tasks that have an assignee are included - unassigned work is not visible ' +
          'through this lookup.',
    };
  },
});

// ---------------------------------------------------------------------------
// work_open_tasks
// ---------------------------------------------------------------------------

/*
 * "Does anybody have pending tasks?" - the question that returned "nothing matched" because no
 * task tool existed at all and the model reached for `timesheet_team_status` with an invented
 * status of "pending" (DEC-152).
 *
 * `subjectDefault: 'scope'`: a question naming nobody is about everybody in reach. An employee
 * gets their own tasks because that is what the reporting predicate returns for them - the role
 * difference is the policy, not a branch here.
 *
 * ONE ROW PER PERSON, not a ranking. §6 forbids a tool that orders people, and "who has the most
 * open tasks" is a league table however it is phrased, so this is alphabetical by employee
 * number and the counts are reported rather than sorted on.
 */
defineTool({
  name: 'work_open_tasks',
  domain: 'work',
  subjectDefault: 'scope',
  description:
    'Who has outstanding TASKS, across everybody the asker can see: how many are still to do ' +
    'and how many are overdue, per person. Use for "does anybody have pending tasks", "what is ' +
    'outstanding", "is anything overdue", "who has open tasks". Listed by employee number, not ' +
    'ranked. Only tasks that have an assignee are counted.',
  examples: [
    'does anybody have pending tasks?',
    'is anything overdue?',
    'who has open tasks?',
    'what work is outstanding on the team?',
  ],
  action: 'work.task.read',
  resource: 'task',
  args: z.object({ overdueOnly: z.boolean().optional() }),
  parameters: {
    type: 'object',
    properties: {
      overdueOnly: {
        type: 'boolean',
        description: 'Count only tasks already past their due date. Defaults to false.',
      },
    },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['assignee_number', 'assignee_name', 'open_tasks', 'overdue_tasks'] as const;

    const scope = ctx.scope('t', 2);
    if (!scope) return empty(cols);

    const rows = await ctx.db.rows(
      'SELECT t.assignee_employee_id AS employee_id, e.employee_number AS assignee_number, ' +
      '       e.full_name AS assignee_name, ' +
      '       count(*)::int AS open_tasks, ' +
      '       count(*) FILTER (WHERE t.due_on IS NOT NULL AND t.due_on < $1::date)::int ' +
      '         AS overdue_tasks ' +
      '  FROM task t ' +
      '  JOIN employee e ON e.id = t.assignee_employee_id ' +
      " WHERE t.status IN ('open','in_progress','blocked') " +
      '   AND ' + scope.sql +
      (args.overdueOnly
        ? ' AND t.due_on IS NOT NULL AND t.due_on < $1::date '
        : ' ') +
      ' GROUP BY t.assignee_employee_id, e.employee_number, e.full_name ' +
      ' ORDER BY e.employee_number LIMIT ' + ROW_CAP,
      [ctx.businessDate, ...scope.params],
    );

    return {
      columns: cols,
      rows,
      note: 'Counts of tasks still to do, as at ' + ctx.businessDate + '. Only tasks that have ' +
        'an assignee are counted: unassigned work is a project question and is not visible here. ' +
        'Listed by employee number, not ranked.',
    };
  },
});
