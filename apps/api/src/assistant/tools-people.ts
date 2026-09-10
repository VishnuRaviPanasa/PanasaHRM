/**
 * Domain: people, and the organisation structure that sits under it. ADR-0020.
 *
 * THE ACCESS QUESTION WAS ASKED FIRST, PER TOOL, and the answers are not uniform - which is the
 * reason they are written down here rather than assumed from the domain name.
 *
 *   `people.employee.list`  allow: employee, manager, hr_admin, hr_ops.  DENY: finance, auditor.
 *                           scope: () => ALLOW_ALL.
 *   `org.unit.read`         allow: ALL SIX ROLES.  scope: () => ALLOW_ALL.
 *   `org.team.read`         allow: ALL SIX ROLES.  scope: () => ALLOW_ALL.
 *
 * SO AN ORDINARY EMPLOYEE CAN READ THE WHOLE DIRECTORY AND THE WHOLE ORG CHART. That is not an
 * oversight to be tightened here; it is the accepted design, stated in `policies.ts` in terms:
 * "The org chart is PUBLIC_INTERNAL. Everybody needs to know who sits where to do their job, so
 * the ROW scope is open and the field mask is what withholds anything sensitive." The matrix
 * makes the same point by contrast - ADR-0005(a) makes reading a POLICY row a privilege and
 * names the tables it means, "the org chart is not among them".
 *
 * The line these tools sit on is therefore not "company data vs personal data". It is:
 *
 *   PUBLIC_INTERNAL structure  - who works here, which department, which team, who leads it.
 *                                Open rows, and the FIELD MASK is the control.
 *   The reporting graph        - leave, attendance, employment history, personal detail.
 *                                Narrow rows, and `scope()` is the control.
 *   Configuration              - policy rows, leave rules, thresholds. A privilege; HR only.
 *
 * Every tool below is in the first band. None of them can answer a question in the second: a
 * directory row carries no balance, no attendance day and no personal contact field, because the
 * mask drops what the registry does not mark PUBLIC and these SELECT lists never ask for it.
 *
 * TWO CONSTRAINTS DECIDED THE COLUMNS, and both bite silently rather than loudly:
 *
 *   1. The registry is DEFAULT-DENY per resource type. `team` registers `department_code` and
 *      not `department_name`, so these tools return the code - a joined name would be dropped by
 *      the mask and the column would simply vanish with no error anywhere (DEC-138).
 *   2. `org_team_members` IS NOT BUILT for the same reason. Its rows would be employees under
 *      resource `team`, and `employee_number` and `full_name` are not registered on `team`, so
 *      every row would mask down to `{}`. It needs a registry decision first, not a SELECT list.
 *
 * FIRST CONSUMER, SAID OUT LOUD. Nothing in `apps/api/src` uses `org.unit.read` or
 * `org.team.read` - there is no org-chart screen. ADR-0020 s1's usual guarantee ("a tool can
 * never reveal more than the equivalent detail screen") therefore has nothing to compare against
 * here: the action, its policy and its matrix cells exist and are tested, but this is the first
 * code to read through them. The compensating control is the field registry, which is why every
 * column below appears in it.
 */

import { z } from 'zod';
import {
  defineTool, whoClause, whoClauseAnyone, zDate, zWho, SCHEMA_WHO, type ToolResult,
} from './catalog';

const ROW_CAP = 400;
const empty = (columns: readonly string[]): ToolResult => ({ columns, rows: [] });

// ---------------------------------------------------------------------------
// people_directory_lookup
// ---------------------------------------------------------------------------

/*
 * The most-asked question with no tool behind it: "what is Priya's work email?"
 *
 * `subjectDefault: 'scope'` rather than 'asker' (DEC-144). Looking somebody up is inherently
 * about somebody else, and a question that names nobody - "who works here?" - is a directory
 * listing, not a question about the asker. `me_profile` is the tool for one's own record and
 * says so in its description, which is what keeps the two apart at selection time.
 *
 * The row filter is open BY POLICY, so what protects Priya here is the mask, not the WHERE
 * clause: `maskList` runs with `inList: true`, so her personal phone, personal email, date of
 * birth and home address are dropped even though HR could read them on a detail screen. Her work
 * email and department are PUBLIC and come back, which is the same thing the directory shows.
 */
defineTool({
  name: 'people_directory_lookup',
  domain: 'people',
  subjectDefault: 'scope',
  description:
    'THE EMPLOYEE DIRECTORY. With no arguments it lists everybody; with a name or number it ' +
    'looks that person up. Use for "list the employees", "who works here", "show me the staff ' +
    'directory", and for any question naming a colleague. Returns their work email, department, ' +
    'designation, ' +
    'line manager, work location, employment type, JOINING DATE, confirmation date and whether ' +
    'they are currently employed. Use when the question names a COLLEAGUE - including "when did ' +
    'X join" and "how long has X been here". For the asker own record use me_profile. Returns ' +
    'work facts only - never a personal phone number, home address or date of birth.',
  examples: [
    'list the employees',
    'who works here?',
    'what is Priya\'s work email?',
    'which department is Deepa in?',
    'when did Priya Menon join?',
    'what is the joining date of EMP006?',
    'how long has Anu been with the company?',
    'who is Anu\'s manager?',
    'where does Rahul work from?',
  ],
  action: 'people.employee.list',
  resource: 'employee',
  args: z.object({ ...zWho, asOf: zDate.optional() }),
  parameters: {
    type: 'object',
    properties: {
      ...SCHEMA_WHO,
      asOf: { type: 'string', description: 'Show the position as at this date. Defaults to today.' },
    },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    /*
     * `joined_on`, `confirmed_on` and `employment_type` are PUBLIC in the registry and were
     * simply not selected - so "when did Priya join?" got an honest "the records do not show
     * her joining date" from a directory that plainly knows it (DEC-149). The mask is
     * default-deny, which protects against returning too much and does nothing about returning
     * too little: a column left out of a SELECT list fails silently and looks like missing data.
     */
    const cols = ['employee_number', 'full_name', 'work_email', 'department', 'designation',
      'manager', 'work_location', 'employment_type', 'joined_on', 'confirmed_on',
      'status'] as const;

    const asOf = args.asOf ?? ctx.businessDate;
    const who = whoClauseAnyone(args, 'e', 2);
    const scope = ctx.scope('e', 2 + who.params.length);
    if (!scope) return empty(cols);

    const rows = await ctx.db.rows(
      'SELECT e.id AS employee_id, e.employee_number, e.full_name, e.work_email, ' +
      '       d.name AS department, g.name AS designation, m.full_name AS manager, ' +
      '       em.work_location, em.employment_type, e.joined_on, e.confirmed_on, ' +
      '       fn_employment_status_asof(e.id, $1::date) AS status ' +
      '  FROM employee e ' +
      '  LEFT JOIN employment  em ON em.employee_id = e.id AND em.valid_period @> $1::date ' +
      '  LEFT JOIN department  d  ON d.id = em.department_id ' +
      '  LEFT JOIN designation g  ON g.id = em.designation_id ' +
      '  LEFT JOIN employee    m  ON m.id = em.manager_id ' +
      ' WHERE ' + who.sql + ' AND ' + scope.sql +
      ' ORDER BY e.employee_number LIMIT ' + ROW_CAP,
      [asOf, ...who.params, ...scope.params],
    );
    return { columns: cols, rows };
  },
});

// ---------------------------------------------------------------------------
// people_department_roster
// ---------------------------------------------------------------------------

/*
 * "Who is in Engineering?" - the same public facts, selected by department instead of by person.
 *
 * Separate from `people_directory_lookup` rather than an argument on it, because the two are
 * different questions at selection time and a model given one tool with a person argument AND a
 * department argument reliably fills in the wrong one. The cost is a second entry in the
 * catalogue; the benefit is that "who is in Engineering" does not come back as one person.
 */
defineTool({
  name: 'people_department_roster',
  domain: 'people',
  subjectDefault: 'scope',
  description:
    'Everybody in a named DEPARTMENT, with their designation and line manager. Use for "who is ' +
    'in Engineering", "how many people are in Finance", "list the HR team". Work facts only - no ' +
    'personal contact details, and no leave or attendance information for anybody.',
  examples: [
    'who is in the Engineering department?',
    'list everybody in Finance',
    'how many people work in HR?',
    'who is in Priya\'s department?',
  ],
  action: 'people.employee.list',
  resource: 'employee',
  args: z.object({
    department: z.string().trim().min(1).max(80),
    asOf: zDate.optional(),
  }),
  parameters: {
    type: 'object',
    properties: {
      department: {
        type: 'string',
        description: 'Department name or code, e.g. "Engineering" or "ENG". Part of it is enough.',
      },
      asOf: { type: 'string', description: 'As at this date. Defaults to today.' },
    },
    required: ['department'],
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['employee_number', 'full_name', 'department', 'designation', 'manager',
      'work_location', 'joined_on', 'status'] as const;

    const asOf = args.asOf ?? ctx.businessDate;
    const scope = ctx.scope('e', 3);
    if (!scope) return empty(cols);

    const rows = await ctx.db.rows(
      'SELECT e.id AS employee_id, e.employee_number, e.full_name, ' +
      '       d.name AS department, g.name AS designation, m.full_name AS manager, ' +
      '       em.work_location, e.joined_on, ' +
      '       fn_employment_status_asof(e.id, $1::date) AS status ' +
      '  FROM employee e ' +
      '  JOIN employment  em ON em.employee_id = e.id AND em.valid_period @> $1::date ' +
      '  JOIN department  d  ON d.id = em.department_id ' +
      '  LEFT JOIN designation g ON g.id = em.designation_id ' +
      '  LEFT JOIN employee    m ON m.id = em.manager_id ' +
      ' WHERE (d.name ILIKE $2 OR d.code ILIKE $2) AND ' + scope.sql +
      ' ORDER BY e.employee_number LIMIT ' + ROW_CAP,
      [asOf, '%' + args.department + '%', ...scope.params],
    );

    /*
     * A FILTER THAT MATCHED NOTHING MUST SAY SO (DEC-158).
     *
     * "List the employees" reached this tool with `department: "employees"`, matched no
     * department, and returned zero rows - which the model reported as "there are no records of
     * employees". An empty result from a bogus filter is indistinguishable from an empty
     * organisation, and the same shape as the invented timesheet status in DEC-152.
     *
     * The department list comes from the SAME scoped query, so it discloses only departments of
     * people this caller may already see - no second action, no widening.
     */
    if (rows.length === 0) {
      const known = await ctx.db.rows<{ department: string }>(
        'SELECT DISTINCT d.name AS department ' +
        '  FROM employee e ' +
        '  JOIN employment em ON em.employee_id = e.id AND em.valid_period @> $1::date ' +
        '  JOIN department d ON d.id = em.department_id ' +
        ' WHERE ' + scope.sql +
        ' ORDER BY 1',
        [asOf, ...scope.params],
      );
      const names = known.map((r) => r.department).filter(Boolean);
      return {
        columns: cols,
        rows,
        note: names.length === 0
          ? 'No department matched "' + args.department + '", and no department is visible to you.'
          : 'No department matched "' + args.department + '". The departments you can see are: ' +
            names.join(', ') + '. To list everybody rather than one department, use the ' +
            'employee directory instead.',
      };
    }

    return { columns: cols, rows };
  },
});

// ---------------------------------------------------------------------------
// org_department_tree
// ---------------------------------------------------------------------------

/*
 * The department hierarchy AS OF A DATE, read from `department_period` rather than from
 * `department`, because the parent and the head are effective-dated and only the period table
 * knows what they were in March. `temporal-data-rules.md` is the reason this takes an `asOf` at
 * all: a question about a past reorganisation is a legitimate question, and a query against the
 * current row would answer it confidently and wrongly.
 *
 * `headcount` is a COUNT over employment as of the same date, so the tree and the numbers agree.
 * No k-suppression: a department headcount is organisation structure, not an aggregate that
 * crosses an individual boundary - it says how many people, never which people or anything about
 * them. `people_department_roster` is the tool that names them, and it is masked per employee.
 */
defineTool({
  name: 'org_department_tree',
  domain: 'people',
  subjectDefault: 'scope',
  description:
    'The company DEPARTMENT STRUCTURE as at a date: each department, its parent, its head and ' +
    'how many people are in it. Use for "what departments are there", "who heads Engineering", ' +
    '"which departments sit under Operations", "what did the structure look like in March".',
  examples: [
    'what departments does the company have?',
    'who is the head of Engineering?',
    'which departments report into Operations?',
    'how many people are in each department?',
    'what did the department structure look like on 2026-03-01?',
  ],
  action: 'org.unit.read',
  resource: 'department',
  args: z.object({ asOf: zDate.optional() }),
  parameters: {
    type: 'object',
    properties: {
      asOf: { type: 'string', description: 'The structure as at this date. Defaults to today.' },
    },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['code', 'name', 'parent_code', 'head_name', 'headcount'] as const;

    const asOf = args.asOf ?? ctx.businessDate;
    const scope = ctx.scope('d', 2);
    if (!scope) return empty(cols);

    const rows = await ctx.db.rows(
      'SELECT d.code, d.name, p.code AS parent_code, h.full_name AS head_name, ' +
      '       (SELECT count(*) FROM employment em ' +
      '         WHERE em.department_id = d.id AND em.valid_period @> $1::date)::int AS headcount ' +
      '  FROM department d ' +
      '  JOIN department_period dp ON dp.department_id = d.id AND dp.valid_period @> $1::date ' +
      '  LEFT JOIN department p ON p.id = dp.parent_department_id ' +
      '  LEFT JOIN employee   h ON h.id = dp.head_employee_id ' +
      ' WHERE ' + scope.sql +
      ' ORDER BY p.code NULLS FIRST, d.code LIMIT ' + ROW_CAP,
      [asOf, ...scope.params],
    );
    return { columns: cols, rows };
  },
});

// ---------------------------------------------------------------------------
// org_teams
// ---------------------------------------------------------------------------

/*
 * Teams as of a date, with their lead and how many people are in them.
 *
 * `department_code` and not `department_name`: the `team` resource registers the code and not the
 * name, and a column the registry does not know is DROPPED SILENTLY (DEC-138). Selecting the name
 * would produce a table with a missing column and no error to explain it.
 *
 * The membership COUNT is here; the membership LIST is not. `org_team_members` would return
 * employee rows under resource `team`, where `employee_number` and `full_name` are unregistered,
 * so every row would mask to `{}`. That tool needs a registry entry decided first.
 */
defineTool({
  name: 'org_teams',
  domain: 'people',
  subjectDefault: 'scope',
  description:
    'The TEAMS in the company as at a date: each team, the department it belongs to, who leads ' +
    'it and how many members it has. Use for "what teams are there", "who leads the Platform ' +
    'team", "which teams are in Engineering". For the people IN a department, use ' +
    'people_department_roster.',
  examples: [
    'what teams are there?',
    'who leads the Platform team?',
    'which teams sit in Engineering?',
    'how many people are on each team?',
  ],
  action: 'org.team.read',
  resource: 'team',
  args: z.object({
    nameQuery: z.string().trim().min(2).max(80).optional(),
    asOf: zDate.optional(),
  }),
  parameters: {
    type: 'object',
    properties: {
      nameQuery: {
        type: 'string',
        description: 'Part of a team name or code, when the question names one team.',
      },
      asOf: { type: 'string', description: 'As at this date. Defaults to today.' },
    },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['code', 'name', 'department_code', 'lead_name', 'member_count'] as const;

    const asOf = args.asOf ?? ctx.businessDate;
    const filter = args.nameQuery ? '(t.name ILIKE $2 OR t.code ILIKE $2)' : 'true';
    const params: unknown[] = [asOf];
    if (args.nameQuery) params.push('%' + args.nameQuery + '%');

    const scope = ctx.scope('t', params.length + 1);
    if (!scope) return empty(cols);

    const rows = await ctx.db.rows(
      'SELECT t.code, t.name, d.code AS department_code, l.full_name AS lead_name, ' +
      '       (SELECT count(*) FROM team_membership tm ' +
      '         WHERE tm.team_id = t.id AND tm.valid_period @> $1::date)::int AS member_count ' +
      '  FROM team t ' +
      '  JOIN team_period tp ON tp.team_id = t.id AND tp.valid_period @> $1::date ' +
      '  JOIN department  d  ON d.id = tp.department_id ' +
      '  LEFT JOIN employee l ON l.id = tp.lead_employee_id ' +
      ' WHERE t.archived_at IS NULL AND ' + filter + ' AND ' + scope.sql +
      ' ORDER BY d.code, t.code LIMIT ' + ROW_CAP,
      [...params, ...scope.params],
    );
    return { columns: cols, rows };
  },
});

// ---------------------------------------------------------------------------
// people_manager_of
// ---------------------------------------------------------------------------

/*
 * "Who is my manager?" - and the reason it needs its own tool is ROUTING, not permission.
 *
 * `me_profile` has carried a `manager` column all along and lists the question as an example,
 * but the router picks ONE domain and the selection step only sees that domain plus `cross`
 * (DEC-127). A question about a reporting line reads as a `people` question, and until DEC-145
 * the `people` domain had no tools at all, so it could never be routed to. Adding four tools
 * there made it routable - and every `me`-domain tool invisible to anything that landed on it.
 * "Who is my manager" then had to be answered by a directory LOOKUP, which needs a name it was
 * never given, and came back with nothing matched.
 *
 * The lesson is worth more than the tool: adding a domain silently changes what the router can
 * choose, so a question answerable in the `me` domain must ALSO be answerable in any domain it
 * plausibly routes to.
 *
 * Defaults to the asker (DEC-144). Naming somebody is allowed because the reporting LINE is
 * PUBLIC_INTERNAL - `people.employee.list` is scope ALLOW_ALL and `manager` is a PUBLIC field,
 * which is the same thing the directory already shows.
 */
defineTool({
  name: 'people_manager_of',
  domain: 'people',
  // The row is about the ASKER and names their MANAGER, so 'nobody else may appear' is the
  // wrong assertion for it - the same shape as me_reporting_chain (DEC-144).
  relatedPeople: true,
  description:
    'Who somebody REPORTS TO, with the manager work email and designation. Defaults to the ' +
    'asker, so "who is my manager" is answered without naming anybody. Use for "who is my ' +
    'manager", "who does Vishnu report to", "who is EMP006 line manager".',
  examples: [
    'who is my manager?',
    'who do I report to?',
    'who does Vishnu report to?',
    'who is Anu line manager?',
  ],
  action: 'people.employee.list',
  resource: 'employee',
  args: z.object({ ...zWho, asOf: zDate.optional() }),
  parameters: {
    type: 'object',
    properties: {
      ...SCHEMA_WHO,
      asOf: { type: 'string', description: 'As at this date. Defaults to today.' },
    },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['employee_number', 'full_name', 'manager', 'manager_employee_number',
      'manager_email', 'manager_designation', 'department'] as const;

    const asOf = args.asOf ?? ctx.businessDate;
    const who = whoClause(args, 'e', 2, ctx.employeeId);
    const scope = ctx.scope('e', 2 + who.params.length);
    if (!scope) return empty(cols);

    const rows = await ctx.db.rows(
      'SELECT e.id AS employee_id, e.employee_number, e.full_name, ' +
      '       m.full_name AS manager, m.employee_number AS manager_employee_number, ' +
      '       m.work_email AS manager_email, mg.name AS manager_designation, ' +
      '       d.name AS department ' +
      '  FROM employee e ' +
      '  LEFT JOIN employment em ON em.employee_id = e.id AND em.valid_period @> $1::date ' +
      '  LEFT JOIN department d ON d.id = em.department_id ' +
      '  LEFT JOIN employee   m ON m.id = em.manager_id ' +
      '  LEFT JOIN employment mem ON mem.employee_id = m.id AND mem.valid_period @> $1::date ' +
      '  LEFT JOIN designation mg ON mg.id = mem.designation_id ' +
      ' WHERE ' + who.sql + ' AND ' + scope.sql +
      ' ORDER BY e.employee_number LIMIT ' + ROW_CAP,
      [asOf, ...who.params, ...scope.params],
    );
    return { columns: cols, rows };
  },
});

// ---------------------------------------------------------------------------
// people_who_reports_to
// ---------------------------------------------------------------------------

/*
 * The other direction: "who reports to me?" - the first question a manager asks, and one the
 * catalogue could not answer at all.
 *
 * `subjectDefault: 'scope'` would be wrong here: the rows are the REPORTS, not the asker, so a
 * no-argument call means "my reports" and the subject defaulting applies to the MANAGER side of
 * the join rather than to the rows. That is expressed by defaulting `managerOf` to the caller
 * rather than by `whoClause`, and it is why this tool takes its own argument.
 *
 * Reporting lines are PUBLIC_INTERNAL, so an employee asking "who reports to Priya" gets an
 * answer - the same thing the org chart shows. What they do NOT get from it is any of those
 * people's leave, attendance or personal detail, because this returns directory columns only.
 */
defineTool({
  name: 'people_who_reports_to',
  domain: 'people',
  subjectDefault: 'scope',
  description:
    'The people who report to somebody - their direct reports. Defaults to the ASKER, so "who ' +
    'reports to me" and "who is on my team" need no name. Use also for "who reports to Priya". ' +
    'Returns directory facts only, never their leave or attendance.',
  examples: [
    'who reports to me?',
    'who is on my team?',
    'how many people report to me?',
    'who reports to Priya Menon?',
  ],
  action: 'people.employee.list',
  resource: 'employee',
  args: z.object({
    managerNumber: z.string().trim().min(1).max(32).optional(),
    managerName: z.string().trim().min(2).max(80).optional(),
    asOf: zDate.optional(),
  }),
  parameters: {
    type: 'object',
    properties: {
      managerNumber: {
        type: 'string',
        description: 'Employee number of the manager. Omit for the asker themselves.',
      },
      managerName: {
        type: 'string',
        description: 'Part of the manager name, when the question names one. Omit for the asker.',
      },
      asOf: { type: 'string', description: 'As at this date. Defaults to today.' },
    },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['employee_number', 'full_name', 'designation', 'department', 'work_email',
      'work_location', 'joined_on', 'status'] as const;

    const asOf = args.asOf ?? ctx.businessDate;

    /*
     * $1 asOf, $2 manager number, $3 manager name, $4 the caller. The scope predicate follows,
     * on the REPORT rows - never replaced by the manager filter, only narrowed by it.
     *
     * EVERY PLACEHOLDER IS REFERENCED ON EVERY PATH, deliberately. Building the WHERE clause
     * conditionally while passing a fixed parameter list is how this first shipped, and Postgres
     * answered `could not determine data type of parameter $2` - a 500, not an empty result, so
     * the tool was dead for everybody. The third line is the whole conditional: fall back to the
     * caller only when neither manager argument was given.
     */
    const params: unknown[] = [asOf, args.managerNumber ?? null, args.managerName ?? null,
      ctx.employeeId];
    const scope = ctx.scope('e', 5);
    if (!scope) return empty(cols);

    const managerFilter =
      '($2::text IS NULL OR upper(m.employee_number) = upper($2::text)) ' +
      "AND ($3::text IS NULL OR m.full_name ILIKE '%' || $3::text || '%') " +
      'AND ($2::text IS NOT NULL OR $3::text IS NOT NULL OR m.id = $4::uuid) ';

    const rows = await ctx.db.rows(
      'SELECT e.id AS employee_id, e.employee_number, e.full_name, ' +
      '       g.name AS designation, d.name AS department, e.work_email, ' +
      '       em.work_location, e.joined_on, ' +
      '       fn_employment_status_asof(e.id, $1::date) AS status ' +
      '  FROM employee e ' +
      '  JOIN employment em ON em.employee_id = e.id AND em.valid_period @> $1::date ' +
      '  JOIN employee   m  ON m.id = em.manager_id ' +
      '  LEFT JOIN department  d ON d.id = em.department_id ' +
      '  LEFT JOIN designation g ON g.id = em.designation_id ' +
      ' WHERE ' + managerFilter + ' AND ' + scope.sql +
      ' ORDER BY e.employee_number LIMIT ' + ROW_CAP,
      [...params, ...scope.params],
    );
    return { columns: cols, rows };
  },
});

// ---------------------------------------------------------------------------
// people_headcount
// ---------------------------------------------------------------------------

/*
 * "How many people work here?" - which had NO answer anywhere.
 *
 * DEC-155 forbade the model doing arithmetic, for good reason: it totalled 49h + 45h30 +
 * 36h30 as 106h. The cost of that rule is that it can no longer count rows either, so a
 * directory that lists five people could not answer "how many". A count question needs a tool
 * that counts, and this is it.
 *
 * NO k-SUPPRESSION, and the reasoning is the same one `org_department_tree` records: ADR-0017(d)
 * governs aggregates that cross an individual boundary, and a headcount says HOW MANY people
 * are in a unit - never which people, nor anything about them. `people_department_roster` is
 * the tool that names them, and it is masked per employee.
 *
 * AS OF A DATE, from `fn_employment_status_asof` rather than the cached `employee.status`
 * column - OR-15, and the same choice every other tool here makes: nothing refreshes the cache,
 * so a future-dated joiner or leaver never materialises into it.
 */
defineTool({
  name: 'people_headcount',
  domain: 'people',
  subjectDefault: 'scope',
  description:
    'HOW MANY people are employed, as at a date - the total, and the split by department or by ' +
    'designation. Use for "how many employees are there", "headcount", "how many people are in ' +
    'Engineering", "how big is the company". Counts only - it names nobody. To list the people ' +
    'themselves use the employee directory.',
  examples: [
    'how many employees are there?',
    'what is the headcount?',
    'how many people are in Engineering?',
    'headcount by department',
    'how big is the company?',
  ],
  action: 'people.employee.list',
  resource: 'employee',
  args: z.object({
    groupBy: z.enum(['total', 'department', 'designation']).optional(),
    asOf: zDate.optional(),
  }),
  parameters: {
    type: 'object',
    properties: {
      groupBy: {
        type: 'string',
        enum: ['total', 'department', 'designation'],
        description: 'How to break the count down. Defaults to department.',
      },
      asOf: { type: 'string', description: 'Headcount as at this date. Defaults to today.' },
    },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['grouping', 'headcount', 'headcount_total'] as const;

    const asOf = args.asOf ?? ctx.businessDate;
    const by = args.groupBy ?? 'department';
    const scope = ctx.scope('e', 2);
    if (!scope) return empty(cols);

    // A fixed set of three expressions, chosen by an enum the Zod schema already validated -
    // never a column name the model supplied.
    const groupExpr =
      by === 'total' ? "'All employees'"
        : by === 'designation' ? 'coalesce(g.name, ' + "'(no designation)'" + ')'
          : 'coalesce(d.name, ' + "'(no department)'" + ')';

    const rows = await ctx.db.rows(
      'SELECT ' + groupExpr + ' AS grouping, ' +
      '       count(*)::int AS headcount, ' +
      '       sum(count(*)) OVER ()::int AS headcount_total ' +
      '  FROM employee e ' +
      '  JOIN employment em ON em.employee_id = e.id AND em.valid_period @> $1::date ' +
      '  LEFT JOIN department  d ON d.id = em.department_id ' +
      '  LEFT JOIN designation g ON g.id = em.designation_id ' +
      " WHERE fn_employment_status_asof(e.id, $1::date) = 'active' " +
      '   AND ' + scope.sql +
      ' GROUP BY 1 ORDER BY 1 LIMIT ' + ROW_CAP,
      [asOf, ...scope.params],
    );

    const total = rows.length > 0 ? Number(rows[0]!.headcount_total ?? 0) : 0;
    return {
      columns: cols,
      rows,
      note: 'Active employees as at ' + asOf + ', grouped by ' + by + '. Total: ' + total + '. ' +
        'Counts only - this tool names nobody.',
    };
  },
});
