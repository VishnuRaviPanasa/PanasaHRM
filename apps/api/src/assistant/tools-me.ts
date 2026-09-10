/**
 * Domain 1: me. ADR-0020.
 *
 * The employee's own record. Every tool here still goes through `assertCan` and `scope()` rather
 * than trusting "it is about me" - because these same tools answer questions about a REPORT when
 * a manager asks, and the difference between the two is a scope predicate, not a code path.
 *
 * EXCLUDED HERE, and both are RESTRICTED in `data-inventory.md`:
 *   `employee.exit_reason` and `employment_event.reason`. Free text that may describe conduct,
 *   performance or health. Neither is selected below, and `exit_reason` is additionally
 *   registered RESTRICTED/hr_admin-only in the field registry, so the mask would drop it even if
 *   a future edit put it in a SELECT list.
 *
 * READ THROUGH THE RESOLVER, NOT THE CACHE (OR-15). `employee.status` is a cached column and
 * nothing calls `fn_refresh_due_employment_status()`, so a future-dated joining or exit never
 * materialises into it. `fn_employment_status_asof(employee, date)` is always correct and needs
 * no scheduler, so that is what these tools read.
 */

import { z } from 'zod';
import {
  defineTool, whoClause, zDate, zWho, SCHEMA_WHO, type ToolResult,
} from './catalog';

const ROW_CAP = 400;
const empty = (columns: readonly string[]): ToolResult => ({ columns, rows: [] });

// ---------------------------------------------------------------------------
// me_profile
// ---------------------------------------------------------------------------

/*
 * CONTACT DETAILS - the first SELF-ONLY tool, and the reason that class exists (DEC-143).
 *
 * "What is my phone number?" used to answer "nothing matched", which is the worst possible
 * wording: the number is on file, the asker can read it on their own profile screen, and the
 * assistant was reporting a MASKING decision as an ABSENCE. Two causes, both fixed here.
 * `me_profile` never selected these columns, and DEC-137's blanket `inList: true` would have
 * stripped them if it had, because personal phone, personal email, date of birth and home
 * address are all `neverInList` in the registry.
 *
 * WHY THIS IS NOT A WIDENING. ADR-0020 s1: a tool "can never reveal more than the equivalent
 * detail screen". The equivalent screen here is the asker's own profile, and
 * `profile-privacy.test.mjs` asserts they see their own date of birth on it. This tool reaches
 * exactly that far and no further: no argument names a person, the WHERE clause pins
 * `e.id` to the caller ON TOP OF `scope()` rather than instead of it (the DEC-120 trap), and the
 * controller drops any row that is not the caller's before masking it.
 *
 * WHAT IS DELIBERATELY LEFT OUT. `emergency_contact_*` is third-party data whose subject never
 * consented and has no notice mechanism, and `blood_group` is health data with no confirmed
 * purpose (OR-16) - both are open questions in `data-inventory.md`, and an open question is not
 * something to answer by shipping a tool that reads it.
 */
defineTool({
  name: 'me_contact_details',
  domain: 'me',
  selfOnly: true,
  description:
    'The ASKER OWN personal contact details on file: personal phone number, personal email, ' +
    'date of birth, and home address. Always about the asker themselves - it takes no ' +
    'arguments and cannot report on anybody else. Use for "what is my phone number", "what ' +
    'is my date of birth", "what address do you have for me", "what is my personal email".',
  examples: [
    'what is my phone number?',
    'what is my date of birth?',
    'what address do you have on file for me?',
    'what personal email is on my record?',
    'when is my birthday?',
  ],
  action: 'people.employee.read',
  resource: 'employee',
  args: z.object({}),
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async run(ctx): Promise<ToolResult> {
    const cols = ['personal_phone', 'personal_email', 'date_of_birth', 'address_line1',
      'address_line2', 'city', 'state_region', 'postal_code'] as const;

    // $1 is the caller, so the scope predicate starts at $2.
    const scope = ctx.scope('e', 2);
    if (!scope) return { columns: [...cols], rows: [] };

    // date_of_birth is cast to text in SQL. It is a DATE, and letting the driver hand back a
    // Date object would put a timezone on a date-only value - CLAUDE.md rule 5, and the same
    // drift DEC-091 found when four screens computed "today" in the browser.
    const rows = await ctx.db.rows(
      'SELECT e.id AS employee_id, e.personal_phone, e.personal_email, ' +
      'e.date_of_birth::text AS date_of_birth, e.address_line1, e.address_line2, ' +
      'e.city, e.state_region, e.postal_code ' +
      'FROM employee e WHERE e.id = $1 AND ' + scope.sql,
      [ctx.employeeId, ...scope.params],
    );
    return { columns: [...cols], rows };
  },
});

// ---------------------------------------------------------------------------
defineTool({
  name: 'me_profile',
  domain: 'me',
  description:
    'Somebody\'s current employment facts: department, designation, line manager, work location, ' +
    'employment type, joining date and employment status. Defaults to the asker. Use for "who is ' +
    'my manager", "what department am I in", "when did I join", "what is my designation".',
  examples: [
    'who is my manager?',
    'what department am I in?',
    'when did I join the company?',
    'what is my designation?',
    'what department is EMP006 in?',
  ],
  action: 'people.employee.read',
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
    const cols = ['employee_number', 'full_name', 'work_email', 'department', 'designation',
      'manager', 'work_location', 'employment_type', 'joined_on', 'status'] as const;
    const asOf = args.asOf ?? ctx.businessDate;
    const who = whoClause(args, 'e', 2, ctx.employeeId);
    const scope = ctx.scope('e', 2 + who.params.length);
    if (!scope) return empty(cols);

    // `employeeColumn('employee')` is `id`, so the predicate renders as `e.id = $n`.
    const rows = await ctx.db.rows(
      `SELECT e.id, e.employee_number, e.full_name, e.work_email, e.joined_on,
              d.name  AS department,
              g.name  AS designation,
              m.full_name AS manager,
              em.work_location, em.employment_type,
              em.valid_from AS assignment_since,
              fn_employment_status_asof(e.id, $1::date) AS status
         FROM employee e
         LEFT JOIN employment  em ON em.employee_id = e.id AND em.valid_period @> $1::date
         LEFT JOIN department  d  ON d.id = em.department_id
         LEFT JOIN designation g  ON g.id = em.designation_id
         LEFT JOIN employee    m  ON m.id = em.manager_id
        WHERE ${who.sql}
          AND ${scope.sql}
        ORDER BY e.employee_number
        LIMIT 50`,
      [asOf, ...who.params, ...scope.params]);

    return { columns: cols, rows };
  },
});

// ---------------------------------------------------------------------------
// me_employment_history
// ---------------------------------------------------------------------------

defineTool({
  name: 'me_employment_history',
  domain: 'me',
  description:
    'How somebody\'s position has changed over time - each department, designation and manager ' +
    'they have had, with the dates each applied. Use for "have I changed department", "when was ' +
    'I promoted", "who did I report to last year", "my job history".',
  examples: [
    'when did I change department?',
    'what is my job history?',
    'who did I report to last year?',
    'have I been promoted?',
  ],
  action: 'people.lifecycle.read',
  resource: 'employment',
  args: z.object({ ...zWho }),
  parameters: { type: 'object', properties: { ...SCHEMA_WHO }, additionalProperties: false },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['valid_from', 'valid_to', 'department', 'designation', 'manager',
      'employment_type', 'work_location'] as const;
    const who = whoClause(args, 'e', 1, ctx.employeeId);
    const scope = ctx.scope('em', 1 + who.params.length);
    if (!scope) return empty(cols);

    const rows = await ctx.db.rows(
      `SELECT em.employee_id, em.valid_from, em.valid_to,
              d.name AS department, g.name AS designation, m.full_name AS manager,
              em.employment_type, em.work_location
         FROM employment em
         JOIN employee e ON e.id = em.employee_id
         LEFT JOIN department  d ON d.id = em.department_id
         LEFT JOIN designation g ON g.id = em.designation_id
         LEFT JOIN employee    m ON m.id = em.manager_id
        WHERE ${who.sql}
          AND ${scope.sql}
        ORDER BY em.valid_from DESC
        LIMIT ${ROW_CAP}`,
      [...who.params, ...scope.params]);

    return { columns: cols, rows };
  },
});

// ---------------------------------------------------------------------------
// me_lifecycle
// ---------------------------------------------------------------------------

defineTool({
  name: 'me_lifecycle',
  domain: 'me',
  description:
    'Employment lifecycle milestones - joined, probation confirmed, resigned, exited - with the ' +
    'date each took effect. Use for "am I confirmed", "when does my probation end", "when was I ' +
    'confirmed". Does not include any reason text.',
  examples: [
    'am I confirmed?',
    'when does my probation end?',
    'when was I confirmed?',
    'what is my employment status?',
  ],
  // The lifecycle log is declared against the `employment` resource in actions.ts, not
  // `employee` - so the scope predicate keys on employee_id and the alias is the event row.
  action: 'people.lifecycle.read',
  resource: 'employment',
  args: z.object({ ...zWho }),
  parameters: { type: 'object', properties: { ...SCHEMA_WHO }, additionalProperties: false },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['employee_number', 'event_type', 'effective_on', 'from_status', 'to_status'] as const;
    const who = whoClause(args, 'e', 1, ctx.employeeId);
    const scope = ctx.scope('ev', 1 + who.params.length);
    if (!scope) return empty(cols);

    // `ev.reason` is RESTRICTED and is deliberately absent from this SELECT. So is
    // `ev.exit_type`, which combined with a date is a statement about how somebody left.
    const rows = await ctx.db.rows(
      `SELECT e.id AS employee_id, e.employee_number,
              ev.event_type, ev.effective_on, ev.from_status, ev.to_status
         FROM employment_event ev
         JOIN employee e ON e.id = ev.employee_id
        WHERE ${who.sql}
          AND ${scope.sql}
        ORDER BY ev.effective_on DESC, ev.recorded_at DESC
        LIMIT ${ROW_CAP}`,
      [...who.params, ...scope.params]);

    return { columns: cols, rows };
  },
});

// ---------------------------------------------------------------------------
// me_reporting_chain
// ---------------------------------------------------------------------------

defineTool({
  name: 'me_reporting_chain',
  relatedPeople: true,
  domain: 'me',
  description:
    'The line of management ABOVE somebody - their manager, their manager\'s manager, and so on ' +
    'to the top. Use for "who do I report to", "who is my skip level", "what is my reporting ' +
    'line". For the people BELOW a manager, use people_team_of instead.',
  examples: [
    'who do I report to?',
    'who is my manager\'s manager?',
    'what is my reporting line?',
    'who is above me?',
  ],
  action: 'people.employee.read',
  resource: 'employee',
  args: z.object({ ...zWho, asOf: zDate.optional() }),
  parameters: {
    type: 'object',
    properties: { ...SCHEMA_WHO, asOf: { type: 'string', description: 'As at this date.' } },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['level', 'employee_number', 'full_name', 'designation'] as const;
    const asOf = args.asOf ?? ctx.businessDate;
    const who = whoClause(args, 'e', 2, ctx.employeeId);
    const scope = ctx.scope('e', 2 + who.params.length);
    if (!scope) return empty(cols);

    /*
     * The starting employee is scoped; the chain ABOVE them is then walked without re-scoping,
     * and that is correct rather than an oversight. Everybody's own management line is already
     * visible to them - it is on the profile screen and in the directory - and re-applying the
     * reporting predicate would return only the part of your own chain that reports to you,
     * which is nobody. Depth is capped at 10 for the same reason 0014's resolver caps it: a
     * cycle must terminate the walk rather than hang it (DEC-088).
     */
    const rows = await ctx.db.rows(
      `WITH RECURSIVE start AS (
            SELECT e.id
              FROM employee e
             WHERE ${who.sql}
               AND ${scope.sql}
             ORDER BY e.employee_number
             LIMIT 1
       ),
       chain AS (
            SELECT em.manager_id AS id, 1 AS level
              FROM employment em
              JOIN start s ON s.id = em.employee_id
             WHERE em.valid_period @> $1::date AND em.manager_id IS NOT NULL
             UNION ALL
            SELECT em.manager_id, c.level + 1
              FROM chain c
              JOIN employment em ON em.employee_id = c.id AND em.valid_period @> $1::date
             WHERE em.manager_id IS NOT NULL AND c.level < 10
       )
       SELECT c.level, e.id AS employee_id, e.employee_number, e.full_name, g.name AS designation
         FROM chain c
         JOIN employee e ON e.id = c.id
         LEFT JOIN employment  em ON em.employee_id = e.id AND em.valid_period @> $1::date
         LEFT JOIN designation g  ON g.id = em.designation_id
        ORDER BY c.level`,
      [asOf, ...who.params, ...scope.params]);

    return { columns: cols, rows };
  },
});

// ---------------------------------------------------------------------------
// me_documents
// ---------------------------------------------------------------------------

defineTool({
  name: 'me_documents',
  domain: 'me',
  description:
    'Which documents are on file for somebody - the type, when it was issued, when it expires, ' +
    'and whether it has been scanned. METADATA ONLY: the assistant never returns document ' +
    'content and cannot open or send a file. Use for "what documents do you have for me", "does ' +
    'my ID expire soon", "have I submitted my education certificates".',
  examples: [
    'what documents do you have on file for me?',
    'is any of my paperwork expiring?',
    'have I submitted my ID proof?',
    'when does my address proof expire?',
  ],
  action: 'documents.document.list',
  resource: 'employee_document',
  args: z.object({ ...zWho }),
  parameters: { type: 'object', properties: { ...SCHEMA_WHO }, additionalProperties: false },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['document_type_name', 'title', 'issued_on', 'expires_on',
      'latest_scan_status', 'available'] as const;
    const who = whoClause(args, 'e', 1, ctx.employeeId);
    const scope = ctx.scope('doc', 1 + who.params.length);
    if (!scope) return empty(cols);

    /*
     * DEC-049 holds here without any code: `documentRows` has no manager branch, so a line
     * manager's predicate is self-only and this returns nothing for a report. That is the one
     * place the reporting graph is deliberately narrowed, and it is narrowed in the POLICY - so
     * the tool inherits it rather than restating it.
     *
     * RESTRICTED types are excluded outright rather than per-row: an offer letter, contract,
     * appraisal or disciplinary record is not something to surface in a chat panel, and OR-25
     * is still open on whether the subject may even read their own.
     */
    const rows = await ctx.db.rows(
      `SELECT doc.employee_id, e.employee_number, t.name AS document_type_name,
              t.data_class, doc.title, doc.issued_on, doc.expires_on,
              v.scan_status AS latest_scan_status,
              (doc.current_version_id IS NOT NULL) AS available
         FROM employee_document doc
         JOIN employee      e ON e.id = doc.employee_id
         JOIN document_type t ON t.code = doc.document_type_code
         LEFT JOIN employee_document_version v ON v.id = doc.current_version_id
        WHERE doc.withdrawn_at IS NULL
          AND t.data_class <> 'RESTRICTED'
          AND ${who.sql}
          AND ${scope.sql}
        ORDER BY doc.expires_on NULLS LAST, t.name
        LIMIT ${ROW_CAP}`,
      [...who.params, ...scope.params]);

    return { columns: cols, rows };
  },
});
