/**
 * Domain 3: attendance. ADR-0020.
 *
 * THE EXCLUSION THAT MATTERS: `attendance_punch.latitude` and `.longitude` are absent from the
 * field registry, so no role reaches them - not a manager, not HR, not the subject.
 * `data-inventory.md` calls the coordinates "the most sensitive thing here" and nulls them at 12
 * months. A tool that could return where a colleague physically was would be the single worst
 * failure this feature could have, and the control is structural: the columns are unregistered,
 * so the mask drops them even if a future edit puts them in a SELECT list.
 *
 * `accuracy_m` and `distance_m` go with them. Distance-from-office is a location statement with
 * one subtraction undone.
 *
 * ADR-0015: attendance is PRESENCE and work logs are EFFORT. They are siblings that reconcile
 * and never derive from each other, so nothing here computes hours worked from a timesheet or
 * the other way round. The reconciliation tool in the cross domain FLAGS a divergence; it does
 * not resolve one.
 */

import { z } from 'zod';
import {
  defineTool, localDateTime, localTime, whoClause, whoClauseAnyone, zDate, zPeriod, zWho,
  SCHEMA_PERIOD, SCHEMA_WHO, type ToolResult,
} from './catalog';

const ROW_CAP = 500;
const empty = (columns: readonly string[]): ToolResult => ({ columns, rows: [] });

const STATUSES = ['present', 'late', 'half_day', 'absent', 'wfh', 'leave', 'holiday', 'week_off'] as const;

/** Default window for an unqualified attendance question: the current month to date. */
const monthStart = (businessDate: string): string => `${businessDate.slice(0, 7)}-01`;

// ---------------------------------------------------------------------------
// attendance_summary
// ---------------------------------------------------------------------------

defineTool({
  name: 'attendance_summary',
  domain: 'attendance',
  description:
    'Attendance TOTALS over a period - how many days present, late, working from home, absent, ' +
    'on leave, plus total minutes worked. Use for counting questions: "how many days was I ' +
    'late", "how many days did I work from home", "what is my attendance this month". For a ' +
    'day-by-day list use attendance_days instead.',
  examples: [
    'how many days was I late this month?',
    'what is my attendance record this year?',
    'how many days did I work from home?',
    'how many days has EMP006 been absent?',
    'summarise my team\'s attendance for September',
  ],
  action: 'attendance.day.read',
  resource: 'attendance_day',
  args: z.object({ ...zWho, ...zPeriod }),
  parameters: {
    type: 'object',
    properties: { ...SCHEMA_WHO, ...SCHEMA_PERIOD },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    /*
     * `days_worked` FIRST, because it is the answer to the question people actually ask.
     *
     * DEC-150. `fn_attendance_summary` counts `present_days` as status IN ('present','late'),
     * so LATE DAYS ARE ALREADY INSIDE IT and `late_days` is a subset, not an addition. `wfh`
     * is its own status and is NOT inside it. Reading `present_days` as "days I worked" is
     * therefore wrong by exactly the number of days worked from home - which is how "how many
     * days did I work this month" came back as 5 when the screen plainly showed 6.
     *
     * The arithmetic belongs here rather than in the model: three columns whose overlap is not
     * stated is a puzzle, and a model solving a puzzle silently gets it wrong silently.
     */
    const cols = ['employee_number', 'full_name', 'days_worked', 'present_days', 'late_days',
      'wfh_days', 'absent_days', 'leave_days', 'worked_time', 'worked_minutes',
      'expected_days'] as const;
    const from = args.from ?? monthStart(ctx.businessDate);
    const to = args.to ?? ctx.businessDate;
    const who = whoClause(args, 'e', 3, ctx.employeeId);
    const scope = ctx.scope('s', 3 + who.params.length);
    if (!scope) return empty(cols);

    // The function returns PER-EMPLOYEE rows and never aggregates across people - migration
    // 0020 is explicit that this is why a scope-correct report is buildable on it at all
    // (DEC-060). The predicate goes into the WHERE and Postgres filters before anything is read.
    const rows = await ctx.db.rows(
      `SELECT s.employee_id, e.employee_number, e.full_name,
              (s.present_days + s.wfh_days)::int AS days_worked,
              s.present_days, s.late_days, s.wfh_days, s.absent_days, s.leave_days,
              s.week_off_days, s.holiday_days, s.worked_minutes, s.expected_days,
              (s.worked_minutes / 60)::text || 'h ' ||
              lpad((s.worked_minutes % 60)::text, 2, '0') || 'm' AS worked_time
         FROM fn_attendance_summary($1::date, $2::date) s
         JOIN employee e ON e.id = s.employee_id
        WHERE ${who.sql}
          AND ${scope.sql}
        ORDER BY e.employee_number
        LIMIT ${ROW_CAP}`,
      [from, to, ...who.params, ...scope.params]);

    return {
      columns: cols,
      rows,
      note: `Period ${from} to ${to}. days_worked counts every day actually worked, ` +
        'including late arrivals and days worked from home. present_days already includes ' +
        'late days, so present_days and late_days must never be added together.',
    };
  },
});

// ---------------------------------------------------------------------------
// attendance_days
// ---------------------------------------------------------------------------

defineTool({
  name: 'attendance_days',
  domain: 'attendance',
  description:
    'Day-by-day attendance - the verdict for each date, with the CLOCK-IN and CLOCK-OUT time ' +
    'and minutes worked. This is the tool for any question about what time somebody came in or ' +
    'left, including "login time", "sign-in time", "punch in time" and "what time did I ' +
    'start". Use it when the question is about particular days rather than a total: "what time ' +
    'did I come in on Monday", "show my attendance last week", "which days was I marked ' +
    'absent".',
  examples: [
    'what time did I clock in yesterday?',
    'what is my login time on September 1?',
    'what time did I sign in on Monday?',
    'show my attendance for last week',
    'which days was I marked absent in August?',
    'what was my attendance on 2026-09-01?',
  ],
  action: 'attendance.day.read',
  resource: 'attendance_day',
  args: z.object({ ...zWho, ...zPeriod, status: z.enum(STATUSES).optional() }),
  parameters: {
    type: 'object',
    properties: {
      ...SCHEMA_WHO,
      ...SCHEMA_PERIOD,
      status: { type: 'string', enum: [...STATUSES], description: 'Only days with this verdict.' },
    },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['employee_number', 'business_date', 'status', 'first_in_at', 'last_out_at',
      'worked_minutes'] as const;
    const from = args.from ?? monthStart(ctx.businessDate);
    const to = args.to ?? ctx.businessDate;
    const who = whoClause(args, 'e', 4, ctx.employeeId);
    const scope = ctx.scope('ad', 4 + who.params.length);
    if (!scope) return empty(cols);

    const rows = await ctx.db.rows(
      `SELECT ad.employee_id, e.employee_number, e.full_name, ad.business_date, ad.status,
              ${localTime('ad.first_in_at')} AS first_in_at,
              ${localTime('ad.last_out_at')} AS last_out_at, ad.worked_minutes, ad.payable_day_fraction
         FROM attendance_day ad
         JOIN employee e ON e.id = ad.employee_id
        WHERE ad.business_date BETWEEN $1::date AND $2::date
          AND ($3::text IS NULL OR ad.status = $3)
          AND ${who.sql}
          AND ${scope.sql}
        ORDER BY ad.business_date DESC, e.employee_number
        LIMIT ${ROW_CAP}`,
      [from, to, args.status ?? null, ...who.params, ...scope.params]);

    return { columns: cols, rows };
  },
});

// ---------------------------------------------------------------------------
// attendance_late_days
// ---------------------------------------------------------------------------

defineTool({
  name: 'attendance_late_days',
  domain: 'attendance',
  description:
    'The specific days somebody arrived late, with the arrival time. Use when the question is ' +
    'about lateness in particular. Reports what the system recorded; it does not judge it, and ' +
    'there is no ranking of people by lateness.',
  examples: [
    'which days was I late?',
    'when did I come in late this month?',
    'show me late arrivals for my team in September',
  ],
  action: 'attendance.day.read',
  resource: 'attendance_day',
  args: z.object({ ...zWho, ...zPeriod }),
  parameters: {
    type: 'object',
    properties: { ...SCHEMA_WHO, ...SCHEMA_PERIOD },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['employee_number', 'business_date', 'first_in_at', 'worked_minutes'] as const;
    const from = args.from ?? monthStart(ctx.businessDate);
    const to = args.to ?? ctx.businessDate;
    const who = whoClause(args, 'e', 3, ctx.employeeId);
    const scope = ctx.scope('ad', 3 + who.params.length);
    if (!scope) return empty(cols);

    const rows = await ctx.db.rows(
      `SELECT ad.employee_id, e.employee_number, ad.business_date,
              ${localTime('ad.first_in_at')} AS first_in_at,
              ad.worked_minutes, ad.status
         FROM attendance_day ad
         JOIN employee e ON e.id = ad.employee_id
        WHERE ad.status = 'late'
          AND ad.business_date BETWEEN $1::date AND $2::date
          AND ${who.sql}
          AND ${scope.sql}
        ORDER BY ad.business_date DESC
        LIMIT ${ROW_CAP}`,
      [from, to, ...who.params, ...scope.params]);

    return { columns: cols, rows };
  },
});

// ---------------------------------------------------------------------------
// attendance_wfh_usage
// ---------------------------------------------------------------------------

defineTool({
  name: 'attendance_wfh_usage',
  domain: 'attendance',
  description:
    'Working-from-home usage over a period, and whether the days recorded as WFH agree with the ' +
    'days approved as WFH leave. A disagreement means the two records differ and somebody should ' +
    'look, not that anybody did anything wrong.',
  examples: [
    'how much have I worked from home this year?',
    'does my WFH match what was approved?',
    'show WFH usage for my team',
  ],
  action: 'attendance.day.read',
  resource: 'attendance_day',
  args: z.object({ ...zWho, ...zPeriod }),
  parameters: {
    type: 'object',
    properties: { ...SCHEMA_WHO, ...SCHEMA_PERIOD },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['employee_number', 'full_name', 'attendance_days', 'approved_days',
      'disagreement'] as const;
    const from = args.from ?? `${ctx.businessDate.slice(0, 4)}-01-01`;
    const to = args.to ?? ctx.businessDate;
    const who = whoClause(args, 'e', 3, ctx.employeeId);
    const scope = ctx.scope('w', 3 + who.params.length);
    if (!scope) return empty(cols);

    const rows = await ctx.db.rows(
      `SELECT w.employee_id, e.employee_number, e.full_name,
              w.attendance_days, w.approved_days, w.disagreement
         FROM fn_wfh_usage($1::date, $2::date) w
         JOIN employee e ON e.id = w.employee_id
        WHERE ${who.sql}
          AND ${scope.sql}
        ORDER BY e.employee_number
        LIMIT ${ROW_CAP}`,
      [from, to, ...who.params, ...scope.params]);

    return { columns: cols, rows, note: `Period ${from} to ${to}.` };
  },
});

// ---------------------------------------------------------------------------
// attendance_punches
// ---------------------------------------------------------------------------

defineTool({
  name: 'attendance_punches',
  domain: 'attendance',
  description:
    'The RAW individual punch events - every separate tap of clock-in and clock-out in a date ' +
    'range. Use ONLY when the question is about the punches themselves: "did my punch ' +
    'register", "how many times did I clock in and out". For what time somebody STARTED or ' +
    'FINISHED a day - login time, sign-in time, first in, last out - use attendance_days, ' +
    'which reports the times the system settled on. DOES NOT return any location coordinates - ' +
    'where somebody physically was is never disclosed, to anyone.',
  examples: [
    'what time did I punch in this morning?',
    'did my clock-out register yesterday?',
    'show my punches for last Friday',
  ],
  action: 'attendance.punch.read',
  resource: 'attendance_punch',
  args: z.object({ ...zWho, ...zPeriod }),
  parameters: {
    type: 'object',
    properties: { ...SCHEMA_WHO, ...SCHEMA_PERIOD },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['employee_number', 'business_date', 'punched_at', 'direction',
      'location_verified', 'matched_location_name'] as const;
    const from = args.from ?? ctx.businessDate;
    const to = args.to ?? ctx.businessDate;
    const who = whoClause(args, 'e', 3, ctx.employeeId);
    const scope = ctx.scope('p', 3 + who.params.length);
    if (!scope) return empty(cols);

    // latitude, longitude, accuracy_m and distance_m are NOT selected, and are additionally
    // unregistered in the field registry so the mask would drop them anyway. Two layers, because
    // this is the column whose disclosure would be least recoverable.
    const rows = await ctx.db.rows(
      `SELECT p.id, p.employee_id, e.employee_number, p.business_date, ${localDateTime('p.punched_at')} AS punched_at,
              p.direction, p.location_verified, wl.name AS matched_location_name
         FROM attendance_punch p
         JOIN employee e ON e.id = p.employee_id
         LEFT JOIN work_location wl ON wl.id = p.matched_location_id
        WHERE p.business_date BETWEEN $1::date AND $2::date
          AND ${who.sql}
          AND ${scope.sql}
        ORDER BY p.punched_at DESC
        LIMIT ${ROW_CAP}`,
      [from, to, ...who.params, ...scope.params]);

    return { columns: cols, rows };
  },
});

// ---------------------------------------------------------------------------
// attendance_missing_days
// ---------------------------------------------------------------------------

defineTool({
  name: 'attendance_missing_days',
  domain: 'attendance',
  description:
    'Working days in a period with NO attendance record at all and no approved leave - gaps ' +
    'somebody probably needs to explain or regularise. Excludes weekends and public holidays. ' +
    'Use for "did I miss punching in", "are there gaps in my attendance", "which days are ' +
    'unaccounted for".',
  examples: [
    'are there any gaps in my attendance?',
    'did I forget to punch in on any day?',
    'which days have no attendance recorded?',
  ],
  action: 'attendance.day.read',
  resource: 'attendance_day',
  args: z.object({ ...zWho, ...zPeriod }),
  parameters: {
    type: 'object',
    properties: { ...SCHEMA_WHO, ...SCHEMA_PERIOD },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['employee_number', 'full_name', 'business_date'] as const;
    const from = args.from ?? monthStart(ctx.businessDate);
    const to = args.to ?? ctx.businessDate;
    const who = whoClause(args, 'e', 3, ctx.employeeId);
    const scope = ctx.scope('ad', 3 + who.params.length);
    if (!scope) return empty(cols);

    /*
     * A gap is an ABSENCE OF ROWS, which cannot be scope-filtered directly - so the scoped set
     * of employees is established first, in a CTE that carries the predicate, and the calendar
     * is then crossed against THAT. Building the calendar first and filtering afterwards would
     * be the fetch-then-filter mistake, with the row count itself as the leak.
     *
     * `fn_is_working_day` already knows about weekends and non-optional holidays, so this does
     * not re-derive the calendar - which is how the two would come to disagree.
     */
    const rows = await ctx.db.rows(
      `WITH scoped AS (
            SELECT ad.employee_id
              FROM employee e
              JOIN LATERAL (SELECT e.id AS employee_id) ad ON true
             WHERE ${who.sql}
               AND ${scope.sql}
       ),
       cal AS (
            SELECT d::date AS business_date
              FROM generate_series($1::date, $2::date, INTERVAL '1 day') d
             WHERE fn_is_working_day(d::date)
       )
       SELECT s.employee_id, e.employee_number, e.full_name, c.business_date
         FROM scoped s
         CROSS JOIN cal c
         JOIN employee e ON e.id = s.employee_id
        WHERE NOT EXISTS (
                SELECT 1 FROM attendance_day a
                 WHERE a.employee_id = s.employee_id AND a.business_date = c.business_date)
          AND NOT EXISTS (
                SELECT 1 FROM leave_request r
                 WHERE r.employee_id = s.employee_id
                   AND r.status = 'approved'
                   AND c.business_date BETWEEN r.from_date AND r.to_date)
        ORDER BY c.business_date DESC, e.employee_number
        LIMIT ${ROW_CAP}`,
      [from, to, ...who.params, ...scope.params]);

    return { columns: cols, rows, note: `Working days between ${from} and ${to} with nothing recorded.` };
  },
});

// ---------------------------------------------------------------------------
// attendance_team_today
// ---------------------------------------------------------------------------

defineTool({
  name: 'attendance_team_today',
  subjectDefault: 'scope',
  domain: 'attendance',
  description:
    'Who is in, out, working from home or on leave TODAY (or on a given date), across everybody ' +
    'the asker can see. Use for "who is in the office today", "is anyone working from home", ' +
    '"who is around". An ordinary employee sees only themselves.',
  examples: [
    'who is in the office today?',
    'is anyone working from home today?',
    'who is around this afternoon?',
    'who was in on Monday?',
  ],
  action: 'attendance.day.read',
  resource: 'attendance_day',
  args: z.object({ onDate: zDate.optional() }),
  parameters: {
    type: 'object',
    properties: { onDate: { type: 'string', description: 'Date to check. Defaults to today.' } },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['employee_number', 'full_name', 'status', 'first_in_at', 'last_out_at'] as const;
    const on = args.onDate ?? ctx.businessDate;
    const scope = ctx.scope('ad', 2);
    if (!scope) return empty(cols);

    const rows = await ctx.db.rows(
      `SELECT ad.employee_id, e.employee_number, e.full_name, ad.status,
              ${localTime('ad.first_in_at')} AS first_in_at,
              ${localTime('ad.last_out_at')} AS last_out_at, ad.worked_minutes
         FROM attendance_day ad
         JOIN employee e ON e.id = ad.employee_id
        WHERE ad.business_date = $1::date
          AND ${scope.sql}
        ORDER BY ad.status, e.employee_number
        LIMIT ${ROW_CAP}`,
      [on, ...scope.params]);

    return { columns: cols, rows, note: `As at ${on}.` };
  },
});

// ---------------------------------------------------------------------------
// attendance_policy   -- HR-scoped, same reasoning as leave_types_and_rules (DEC-131)
// ---------------------------------------------------------------------------

defineTool({
  name: 'attendance_policy',
  subjectDefault: 'scope',
  domain: 'attendance',
  description:
    'The configured attendance RULES in force on a date - grace period, the minutes that make a ' +
    'half day or a full day, whether overtime is enabled. ADMINISTRATIVE: reading configuration ' +
    'is a privilege, so most people cannot use this. To answer whether a particular day was ' +
    'counted late, use attendance_days, which reports the verdict the system already reached.',
  examples: [
    'what is the grace period?',
    'how many minutes count as a half day?',
    'is overtime enabled?',
  ],
  action: 'config.policy.read',
  resource: 'org_config',
  args: z.object({ asOf: zDate.optional() }),
  parameters: {
    type: 'object',
    properties: { asOf: { type: 'string', description: 'Rules in force on this date.' } },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['valid_from', 'valid_to', 'grace_period_minutes', 'half_day_min_minutes',
      'full_day_min_minutes', 'standard_day_minutes', 'ot_enabled'] as const;
    const asOf = args.asOf ?? ctx.businessDate;
    const scope = ctx.scope('ap', 2);
    if (!scope) return empty(cols);

    const rows = await ctx.db.rows(
      `SELECT ap.valid_from, ap.valid_to, ap.grace_period_minutes, ap.half_day_min_minutes,
              ap.full_day_min_minutes, ap.standard_day_minutes, ap.ot_enabled,
              ap.unconfirmed_fields
         FROM attendance_policy ap
        WHERE ap.valid_period @> $1::date
          AND ${scope.sql}
        ORDER BY ap.valid_from DESC`,
      [asOf, ...scope.params]);

    // OR-01/DEC-020: several of these numbers are engineering defaults awaiting HR confirmation,
    // and the table says which. Presenting a badged value as settled policy is the specific
    // thing that must not happen, so the note travels with the answer.
    const unconfirmed = rows.some((r: any) => Array.isArray(r.unconfirmed_fields)
      && r.unconfirmed_fields.length > 0);

    return {
      columns: cols,
      rows,
      note: unconfirmed
        ? `In force on ${asOf}. Some of these values are engineering defaults awaiting HR ` +
          `confirmation and are not settled policy.`
        : `In force on ${asOf}.`,
    };
  },
});

// ---------------------------------------------------------------------------
// attendance_team_summary
// ---------------------------------------------------------------------------

/*
 * EVERYBODY the asker can see, over a PERIOD. The gap DEC-144 exposed rather than created.
 *
 * `attendance_summary` runs the identical query - `fn_attendance_summary` already returns one
 * row per employee and the scope predicate filters it - but since DEC-144 it defaults to the
 * ASKER when no name is given, which is right for "how many days was I late" and useless for
 * "attendance for all employees". Before DEC-144 the same question returned everyone and the
 * model narrated the first row as though it were the asker's, which was worse.
 *
 * `attendance_team_today` was the only multi-person attendance tool and it is a SINGLE DAY, so
 * an HR admin asking about the month had nothing to land on: today has no rows until somebody
 * punches in, and the personal tools answered about themselves.
 *
 * Access is unchanged and is not re-decided here: same action, same resource, same `scope()`.
 * An ordinary employee gets exactly one row - their own - because that is what the predicate
 * returns for them, which is also why this needs no separate permission.
 */
defineTool({
  name: 'attendance_team_summary',
  domain: 'attendance',
  subjectDefault: 'scope',
  description:
    'Attendance totals over a PERIOD for everybody the asker can see - present, late, from home, ' +
    'absent and on-leave days per person. Use for "attendance for all employees", "how did the ' +
    'team attend last month", "who was absent in September". For ONE person, or for the asker ' +
    'themselves, use attendance_summary. For a single day use attendance_team_today.',
  examples: [
    'attendance details of all employees',
    'show me attendance for everyone this month',
    'how did my team attend in August?',
    'who was absent last month?',
    'attendance summary for the whole company',
  ],
  action: 'attendance.day.read',
  resource: 'attendance_day',
  args: z.object({ ...zPeriod }),
  parameters: {
    type: 'object',
    properties: { ...SCHEMA_PERIOD },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['employee_number', 'full_name', 'days_worked', 'present_days', 'late_days',
      'wfh_days', 'absent_days', 'leave_days', 'worked_time', 'worked_minutes',
      'expected_days'] as const;

    const from = args.from ?? monthStart(ctx.businessDate);
    const to = args.to ?? ctx.businessDate;
    const scope = ctx.scope('s', 3);
    if (!scope) return empty(cols);

    const rows = await ctx.db.rows(
      'SELECT s.employee_id, e.employee_number, e.full_name, ' +
      '       (s.present_days + s.wfh_days)::int AS days_worked, ' +
      '       s.present_days, s.late_days, s.wfh_days, s.absent_days, s.leave_days, ' +
      '       s.week_off_days, s.holiday_days, s.worked_minutes, s.expected_days, ' +
      "       (s.worked_minutes / 60)::text || 'h ' || " +
      "       lpad((s.worked_minutes % 60)::text, 2, '0') || 'm' AS worked_time " +
      '  FROM fn_attendance_summary($1::date, $2::date) s ' +
      '  JOIN employee e ON e.id = s.employee_id ' +
      ' WHERE ' + scope.sql +
      ' ORDER BY e.employee_number LIMIT ' + ROW_CAP,
      [from, to, ...scope.params]);

    return {
      columns: cols,
      rows,
      note: 'Period ' + from + ' to ' + to + '. days_worked counts every day actually worked, ' +
        'including late arrivals and days worked from home. present_days already includes late ' +
        'days, so present_days and late_days must never be added together.',
    };
  },
});
