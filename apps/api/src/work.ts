import {
  BadRequestException, Body, Controller, Delete, Get, Module, NotFoundException, Param, Post,
  Query, Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthzDeniedError } from '@panasa/authz';
import { Authenticated, currentActor } from './auth';
import { Authz, authContext } from './authz';
import { Db } from './db';

/** Monday of the week containing a date. The timesheet period is Mon-Sun. */
const weekStart = (iso: string) => {
  const d = new Date(iso + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7;           // 0 = Monday
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
};
const addDays = (iso: string, n: number) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * A date the caller supplied, or a refusal.
 *
 * Deliberately NOT reports.ts's `isoDate(v, fallback)`, which substitutes the fallback for
 * anything it cannot parse. That is right for a report's default window and wrong here: a
 * filter that silently ignores `from=2026-13-45` and answers about a different period is worse
 * than an error, because the caller believes the number on screen. `?from=` empty means "not
 * supplied"; `?from=nonsense` means the request is wrong.
 */
const requiredIsoDate = (v: unknown, field: string): string | null => {
  const raw = typeof v === 'string' ? v.trim() : '';
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new BadRequestException(`${field} must be a date in YYYY-MM-DD form`);
  }
  // Reject 2026-02-31: the shape is right but the day does not exist, and Postgres would either
  // roll it forward or raise depending on the cast. Neither is a filter the caller meant.
  const [y, m, d] = raw.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw new BadRequestException(`${field} is not a real date`);
  }
  return raw;
};

/** The longest window the range filters will serve. Two years of days is already a big page. */
const MAX_RANGE_DAYS = 731;

@Controller()
export class WorkController {
  constructor(private readonly db: Db, private readonly authz: Authz) {}

  /**
   * Resolve a date-period filter: an explicit from/to, a named preset, or the default.
   *
   * The BUSINESS DATE comes from the database (`fn_business_date()`), never from the client and
   * never from the server clock. "This month" asked at 00:35 IST is the previous month in UTC,
   * which is the bug DEC-091 records - a test computed its own today and failed for five and a
   * half hours out of every twenty-four.
   */
  private async resolveRange(
    q: { from?: string; to?: string; preset?: string; month?: string },
  ): Promise<{ from: string; to: string; preset: string }> {
    const today = (await this.db.one(`SELECT fn_business_date()::text AS d`))!.d as string;

    const from = requiredIsoDate(q.from, 'from');
    const to = requiredIsoDate(q.to, 'to');

    // An explicit range wins over any preset, so a bookmarked URL keeps meaning what it said.
    if (from || to) {
      const f = from ?? to!;
      const t = to ?? from!;
      if (f > t) {
        throw new BadRequestException('The start date cannot be after the end date');
      }
      const span = (Date.parse(t) - Date.parse(f)) / 86400000 + 1;
      if (span > MAX_RANGE_DAYS) {
        throw new BadRequestException(`That period is ${Math.round(span)} days; the maximum is ${MAX_RANGE_DAYS}`);
      }
      return { from: f, to: t, preset: 'custom' };
    }

    // `month=YYYY-MM` is what this endpoint accepted before date periods existed. Kept so an
    // existing link, and the month arrows in the UI, still work.
    // The ::date cast before ::text is load-bearing: date + INTERVAL yields a TIMESTAMP, so
    // without it `to` came back as '2026-09-30 00:00:00' and every date comparison downstream
    // - in SQL, in the UI, in a test - was comparing a date against a timestamp string.
    if (q.month && /^\d{4}-\d{2}$/.test(q.month.trim())) {
      const start = `${q.month.trim()}-01`;
      const end = (await this.db.one(
        `SELECT ($1::date + INTERVAL '1 month' - INTERVAL '1 day')::date::text AS d`, [start]))!.d as string;
      return { from: start, to: end, preset: 'month' };
    }

    const preset = (q.preset ?? 'month').trim();
    const row = await this.db.one(
      `SELECT CASE $1
                WHEN 'today' THEN $2::date
                WHEN 'week'  THEN date_trunc('week', $2::date)::date
                WHEN 'month' THEN date_trunc('month', $2::date)::date
                ELSE date_trunc('month', $2::date)::date
              END::text AS f,
              CASE $1
                WHEN 'week'  THEN least($2::date, (date_trunc('week', $2::date) + INTERVAL '6 days')::date)
                ELSE $2::date
              END::text AS t`, [preset, today]);
    if (!['today', 'week', 'month'].includes(preset)) {
      throw new BadRequestException(`Unknown preset "${preset}" - use today, week, month, or from/to`);
    }
    return { from: row!.f as string, to: row!.t as string, preset };
  }

  /**
   * Authorise a work/attendance read about one subject and hand back the row filter to compose.
   *
   * Same split as reports.ts `gate`: `assertCan` asks whether this actor may read this resource
   * type at all, `scope` decides whose rows. The subject defaults to the caller because a
   * self-scoped policy is written around `isSelf` and cannot be satisfied by a ref with no
   * subject - the bug that made an employee's own attendance report 404.
   */
  private async gate(
    req: Request, action: 'attendance.day.read' | 'work.log.read' | 'work.team_effort.read',
    resource: 'attendance_day' | 'work_log' | 'project_effort',
    alias: string, firstParam: number, subject?: string | null, asOf?: string,
  ): Promise<{ sql: string; params: unknown[] } | null> {
    const ctx = authContext(req);
    const ref = {
      type: resource,
      asOf,
      subjectEmployeeId: subject ?? ctx.employeeId ?? undefined,
    };
    try {
      await this.authz.assertCan(ctx, action, ref);
    } catch (e) {
      if (e instanceof AuthzDeniedError) throw new NotFoundException('That is not available to you');
      throw e;
    }
    const predicate = this.authz.scope(ctx, action, ref);
    if (predicate.kind === 'none') return null;
    return predicate.render(alias, firstParam);
  }

  // ---------------------------------------------------------------- attendance
  /**
   * Attendance over a DATE PERIOD.
   *
   * Was `?month=YYYY-MM` and nothing else, hardcoded to a one-month window and to the caller's
   * own rows. Three things changed and each one matters on its own:
   *
   *   * the window is now any from/to, or a named preset (today / week / month), validated
   *     rather than silently defaulted - `from=2026-02-31` is refused, not rounded;
   *   * `employeeId` may name somebody else, so HR and a line manager can use the same screen;
   *   * authorization is REAL. The old handler was `@Authenticated()` with `me.employeeId`
   *     spliced into the SQL, which is self-scoping by accident of the query rather than by
   *     policy - it would have widened the moment anybody added a parameter. Now `assertCan`
   *     decides whether this actor reads attendance at all and `scope` decides whose rows, and
   *     the subject filter is composed ALONGSIDE the scope predicate, not instead of it: asking
   *     for an employee outside your scope returns nothing rather than their days.
   */
  @Get('attendance')
  @Authenticated()
  async attendance(
    @Req() req: Request,
    @Query('month') month?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('preset') preset?: string,
    @Query('employeeId') employeeId?: string,
  ) {
    const me = currentActor(req);
    const range = await this.resolveRange({ from, to, preset, month });
    const subject = (employeeId ?? '').trim() || me.employeeId;

    const scope = await this.gate(req, 'attendance.day.read', 'attendance_day', 'a', 4, subject, range.to);
    const empty = {
      ...range,
      month: range.from.slice(0, 7),
      employeeId: subject,
      days: [] as unknown[],
      summary: {
        present: 0, late: 0, wfh: 0, absent: 0, leave: 0, week_off: 0, total_minutes: 0,
      },
    };
    // `none` means the policy admits this actor to no rows. An empty period is a first-class
    // answer here, so the screen renders its empty state rather than an error.
    if (!scope) return empty;

    const where = `a.employee_id = $1 AND a.business_date BETWEEN $2::date AND $3::date
                     AND ${scope.sql}`;

    const days = await this.db.rows(
      `SELECT a.business_date, a.status, a.worked_minutes, a.first_in_at, a.last_out_at, a.note
         FROM attendance_day a
        WHERE ${where}
        ORDER BY a.business_date`, [subject, range.from, range.to, ...scope.params]);

    const summary = await this.db.one(
      `SELECT count(*) FILTER (WHERE a.status = 'present')  AS present,
              count(*) FILTER (WHERE a.status = 'late')     AS late,
              count(*) FILTER (WHERE a.status = 'wfh')      AS wfh,
              count(*) FILTER (WHERE a.status = 'absent')   AS absent,
              count(*) FILTER (WHERE a.status = 'leave')    AS leave,
              count(*) FILTER (WHERE a.status = 'week_off') AS week_off,
              coalesce(sum(a.worked_minutes), 0)::int       AS total_minutes
         FROM attendance_day a
        WHERE ${where}`, [subject, range.from, range.to, ...scope.params]);

    return { ...range, month: range.from.slice(0, 7), employeeId: subject, days, summary };
  }

  // ---------------------------------------------------------------- punches
  /** Today's punch state: whether they are checked in, and the day so far. */
  @Get('attendance/today')
  @Authenticated()
  async today(@Req() req: Request) {
    const me = currentActor(req);
    const [{ d: businessDate }] = await this.db.rows(`SELECT fn_business_date()::text AS d`);

    const punches = await this.db.rows(
      `SELECT p.id, p.punched_at, p.direction, p.accuracy_m, p.distance_m,
              p.location_verified, p.location_source, p.note, w.name AS location_name
         FROM attendance_punch p
         LEFT JOIN work_location w ON w.id = p.matched_location_id
        WHERE p.employee_id = $1 AND p.business_date = $2
        ORDER BY p.punched_at`, [me.employeeId, businessDate]);

    const day = await this.db.one(
      `SELECT status, first_in_at, last_out_at, worked_minutes, payable_day_fraction, note
         FROM attendance_day WHERE employee_id = $1 AND business_date = $2`,
      [me.employeeId, businessDate]);

    const last = punches[punches.length - 1];
    return {
      businessDate,
      punches,
      day,
      checkedIn: last?.direction === 'in',
      since: last?.direction === 'in' ? last.punched_at : null,
      nextDirection: last?.direction === 'in' ? 'out' : 'in',
      offices: await this.db.rows(
        `SELECT code, name, address, radius_m FROM work_location WHERE is_active ORDER BY code`),
    };
  }

  /**
   * Record a punch.
   *
   * Location is optional BY DESIGN. A refused permission records the punch with
   * location_source='denied' and location_verified=false rather than blocking it - forcing a
   * location grant to record attendance makes consent meaningless, and an employee on a device
   * without GPS could not work. See docs/privacy/data-inventory.md.
   */
  @Post('attendance/punch')
  @Authenticated()
  async punch(@Req() req: Request, @Body() body: {
    direction?: 'in' | 'out';
    latitude?: number | null; longitude?: number | null; accuracy?: number | null;
    locationSource?: string; note?: string;
  }) {
    const me = currentActor(req);
    const direction = body?.direction;
    if (direction !== 'in' && direction !== 'out') {
      throw new BadRequestException('direction must be in or out');
    }

    const hasFix =
      typeof body?.latitude === 'number' && Number.isFinite(body.latitude) &&
      typeof body?.longitude === 'number' && Number.isFinite(body.longitude);

    if (hasFix && (Math.abs(body!.latitude!) > 90 || Math.abs(body!.longitude!) > 180)) {
      throw new BadRequestException('Those coordinates are not on Earth');
    }

    const source = hasFix
      ? 'browser'
      : ['denied', 'unavailable'].includes(String(body?.locationSource))
        ? String(body!.locationSource)
        : 'unavailable';

    return this.db.tx(async (q) => {
      const [{ d: businessDate }] = await q(`SELECT fn_business_date()::text AS d`);

      // Punches must alternate. Two check-ins in a row is a mistake, and silently accepting it
      // produces a worked-minutes figure nobody can explain.
      const [last] = await q(
        `SELECT direction, punched_at FROM attendance_punch
          WHERE employee_id = $1 AND business_date = $2
          ORDER BY punched_at DESC LIMIT 1`, [me.employeeId, businessDate]);

      if (last?.direction === direction) {
        throw new BadRequestException(
          direction === 'in'
            ? 'You are already checked in. Check out first.'
            : 'You are not checked in, so there is nothing to check out of.');
      }
      if (!last && direction === 'out') {
        throw new BadRequestException('You have not checked in today.');
      }

      let matched: any = null;
      if (hasFix) {
        [matched] = await q(
          `SELECT location_id, code, name, distance_m, radius_m
             FROM fn_nearest_location($1, $2)`, [body!.latitude, body!.longitude]);
      }
      const verified = !!matched && matched.distance_m <= matched.radius_m;

      const [punch] = await q(
        `INSERT INTO attendance_punch (
           employee_id, business_date, direction, latitude, longitude, accuracy_m,
           matched_location_id, distance_m, location_verified, location_source, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id, punched_at, direction, distance_m, location_verified, location_source`,
        [me.employeeId, businessDate, direction,
         hasFix ? body!.latitude : null, hasFix ? body!.longitude : null,
         Number.isFinite(body?.accuracy as number) ? Math.round(body!.accuracy as number) : null,
         verified ? matched.location_id : null,
         matched?.distance_m ?? null, verified, source, body?.note ?? null]);

      // attendance_day is DERIVED, never written directly by a caller (ADR-0011).
      const [day] = await q(`SELECT * FROM fn_derive_attendance_day($1, $2)`,
                            [me.employeeId, businessDate]);

      return {
        punch,
        day: day ? {
          status: day.status, worked_minutes: day.worked_minutes,
          first_in_at: day.first_in_at, last_out_at: day.last_out_at,
        } : null,
        location: matched
          ? { name: matched.name, code: matched.code, distanceM: matched.distance_m,
              radiusM: matched.radius_m, verified }
          : null,
        locationSource: source,
      };
    });
  }

  // ---------------------------------------------------------------- projects
  /**
   * The work hierarchy this employee may log effort against.
   *
   * TWO CHANGES, and the first is why HR could not add a work log at all. The old query was
   * `WHERE pm.employee_id = $1` - project MEMBERSHIP - so an HR administrator, who is a member of
   * nothing, received an empty list and an empty project dropdown. The visible symptom was a form
   * that would not submit; the cause was here, not in the form. `employeeId` now names whose
   * projects to return, and HR asks about the employee they are recording for. Anyone without
   * `work.log.write_for` may only ask about themselves, so this is not a way to enumerate
   * somebody else's project memberships.
   *
   * Second: the response carries the two levels 0027 added. `projects[].tasks` keeps its original
   * shape and name so the existing work screen is unaffected, and `subProjects` / `subTasks`
   * arrive alongside as flat lists keyed by parent. Flat rather than nested because the UI
   * cascades by filtering on a parent id, and because a nested payload would have to repeat a
   * task once per level it appears under.
   *
   * Only SELECTABLE nodes are returned - `v_work_hierarchy.selectable` rolls up the whole path,
   * so a retired sub-project hides its tasks without each one having to be touched. This is a
   * convenience for the form, NOT the enforcement: `POST /work-log` re-checks the hierarchy
   * server-side, because a list endpoint that omits something is not a constraint.
   */
  @Get('projects')
  @Authenticated()
  async projects(@Req() req: Request, @Query('employeeId') employeeId?: string) {
    const me = currentActor(req);
    const asked = (employeeId ?? '').trim();
    let subject = me.employeeId;

    if (asked && asked !== me.employeeId) {
      const ctx = authContext(req);
      try {
        await this.authz.assertCan(ctx, 'work.log.write_for', {
          type: 'work_log', subjectEmployeeId: asked,
        });
      } catch (e) {
        if (e instanceof AuthzDeniedError) {
          throw new NotFoundException('That employee is not available to you');
        }
        throw e;
      }
      subject = asked;
    }

    const projects = await this.db.rows(
      `SELECT p.id, p.code, p.name, p.client_name, pm.role,
              (SELECT json_agg(json_build_object('id', t.id, 'code', t.code, 'title', t.title,
                                                 'subProjectId', t.sub_project_id)
                               ORDER BY t.code)
                 FROM task t
                WHERE t.project_id = p.id AND t.status <> 'done' AND t.active
                  AND (t.sub_project_id IS NULL
                       OR EXISTS (SELECT 1 FROM sub_project sp
                                   WHERE sp.id = t.sub_project_id AND sp.active))) AS tasks
         FROM project_member pm
         JOIN project p ON p.id = pm.project_id
        WHERE pm.employee_id = $1 AND p.status = 'active'
          AND pm.valid_period @> fn_business_date()
        ORDER BY p.name`, [subject]);

    const ids = projects.map((r: any) => r.id);
    if (ids.length === 0) {
      return { employeeId: subject, projects, subProjects: [], subTasks: [] };
    }

    const subProjects = await this.db.rows(
      `SELECT sp.id, sp.project_id, sp.code, sp.name
         FROM sub_project sp
        WHERE sp.project_id = ANY($1::uuid[]) AND sp.active
        ORDER BY sp.name`, [ids]);

    const subTasks = await this.db.rows(
      `SELECT st.id, st.task_id, st.code, st.title
         FROM sub_task st
         JOIN task t ON t.id = st.task_id
        WHERE t.project_id = ANY($1::uuid[]) AND st.active AND t.active
        ORDER BY st.code NULLS LAST, st.title`, [ids]);

    return { employeeId: subject, projects, subProjects, subTasks };
  }

  // ---------------------------------------------------------------- daily work log
  @Get('work-log')
  @Authenticated()
  async workLog(@Req() req: Request, @Query('date') date?: string) {
    const me = currentActor(req);
    const on = date ?? (await this.db.one(`SELECT fn_business_date()::text AS d`))!.d;

    /*
     * The full path, plus who recorded the line.
     *
     * Two omissions were found by test M17. The sub-task label was never selected, so effort
     * attributed to the deepest level of the hierarchy displayed as though it had stopped at the
     * task - and a work log filed against a sub-task that was later retired appeared to have
     * lost its attribution, when in fact the read had never asked for it. The sub-project is
     * reached THROUGH the task (it is a property of the task, not of the entry - see 0027), so
     * it costs one more join and no extra column on the row.
     *
     * `entry_source` and the recorder's name matter for a different reason: once HR can record
     * effort on somebody's behalf, an approver looking at a timesheet needs to see which lines
     * the employee entered themselves. Neither is inferable from the amounts.
     *
     * Every join is LEFT: task, sub-task and sub-project are all optional, and an INNER join on
     * any of them would silently drop the project-only entries that were the only shape
     * available before 0027.
     */
    const entries = await this.db.rows(
      `SELECT wle.id, wle.minutes, wle.description, wle.entry_source,
              p.code AS project_code, p.name AS project_name,
              sp.code AS sub_project_code, sp.name AS sub_project_name,
              t.code AS task_code, t.title AS task_title,
              st.code AS sub_task_code, st.title AS sub_task_title,
              rec.full_name AS entered_by_name
         FROM work_log wl
         JOIN work_log_entry wle ON wle.work_log_id = wl.id
         JOIN project p ON p.id = wle.project_id
         LEFT JOIN task t ON t.id = wle.task_id
         LEFT JOIN sub_project sp ON sp.id = t.sub_project_id
         LEFT JOIN sub_task st ON st.id = wle.sub_task_id
         LEFT JOIN employee rec ON rec.id = wle.entered_by_employee_id
        WHERE wl.employee_id = $1 AND wl.work_date = $2
        ORDER BY wle.created_at`, [me.employeeId, on]);

    const period = await this.db.one(
      `SELECT id, period_start, period_end, status FROM timesheet_period
        WHERE employee_id = $1 AND $2::date BETWEEN period_start AND period_end`,
      [me.employeeId, on]);

    return {
      date: on,
      entries,
      totalMinutes: entries.reduce((s, e) => s + Number(e.minutes), 0),
      period,
      locked: period?.status === 'submitted' || period?.status === 'approved',
    };
  }

  /**
   * Record effort - for yourself, or for somebody else if you are HR.
   *
   * WHY HR COULD NOT DO THIS. The handler took no employee parameter at all: every insert used
   * `me.employeeId`, so the endpoint was structurally incapable of recording a log for anybody
   * else, whatever the caller's role. Combined with `GET /projects` returning only the caller's
   * memberships - and HR being a member of nothing - HR saw an empty form that could not have
   * submitted anything even if they had filled it in. Two independent causes, both here.
   *
   * FOUR THINGS ARE CHECKED, and they are deliberately separate concerns:
   *
   *   1. AUTHORIZATION. Writing your own log is `work.log.write` (graph `self`); writing
   *      somebody else's is `work.log.write_for` (organisation, hr_admin only). The self path is
   *      untouched, so an employee's existing flow cannot have regressed by widening.
   *   2. THE HIERARCHY. The task must belong to the stated project and the sub-task to the
   *      stated task. Composite foreign keys (0027) already make an incoherent row impossible,
   *      but a foreign-key violation surfaces as a 500 - so this checks first and answers 400
   *      with something a person can act on. The FK remains the actual guarantee.
   *   3. LIFECYCLE. Every level on the path has to be `selectable` - an active project, and no
   *      retired sub-project, task or sub-task above it. This is NOT covered by the foreign keys
   *      and is the only thing standing between a retired master and a new work log.
   *   4. MEMBERSHIP, which HR does not get to skip. The subject must be a member of the project
   *      as of the work date. It used to be enforced only by the shape of the dropdown, which is
   *      no enforcement at all; now that HR can choose any employee, an explicit check is the
   *      difference between "HR records effort" and "HR invents an allocation".
   *
   * Provenance (0028) is recorded, not inferred: `entered_by_employee_id` is always the caller
   * and `entry_source` says whether that is the subject. The database refuses the combinations
   * that would lie about it.
   */
  @Post('work-log')
  @Authenticated()
  async addEntry(@Req() req: Request, @Body() body: {
    date?: string; employeeId?: string; projectId?: string; taskId?: string | null;
    subTaskId?: string | null; hours?: number; minutes?: number; description?: string;
  }) {
    const me = currentActor(req);
    const on = requiredIsoDate(body?.date, 'date')
      ?? (await this.db.one(`SELECT fn_business_date()::text AS d`))!.d;

    // ADR-0016: effort is INTEGER MINUTES. The UI offers hours+minutes; storage does not.
    const total = Math.round((Number(body?.hours ?? 0) * 60) + Number(body?.minutes ?? 0));
    if (!Number.isFinite(total) || total <= 0) throw new BadRequestException('Effort must be greater than zero');
    if (total > 1440) throw new BadRequestException('That is more than 24 hours');
    if (!body?.projectId) throw new BadRequestException('A project is required');

    const asked = (body?.employeeId ?? '').trim();
    const subject = asked || me.employeeId!;
    const onBehalf = subject !== me.employeeId;

    // 1. Authorization. Two different actions, because they are two different acts.
    const ctx = authContext(req);
    try {
      await this.authz.assertCan(ctx, onBehalf ? 'work.log.write_for' : 'work.log.write', {
        type: 'work_log', subjectEmployeeId: subject,
      });
    } catch (e) {
      if (e instanceof AuthzDeniedError) {
        throw new NotFoundException('That employee is not available to you');
      }
      throw e;
    }

    if (body?.subTaskId && !body?.taskId) {
      throw new BadRequestException('A sub-task needs its task selected as well');
    }

    /*
     * 2 + 3. The hierarchy and its lifecycle, checked LEVEL BY LEVEL.
     *
     * The first version asked `v_work_hierarchy` for a row matching the exact
     * (project, task, sub-task) triple. That was wrong, and the tests caught it immediately:
     * the view is task-centric and only materialises the DEEPEST paths, so a row with
     * `sub_task_id IS NULL` exists only for a task that has no sub-tasks at all. Selecting
     * CP-41 without a sub-task therefore matched nothing and was rejected as incoherent - as was
     * logging against a project as a whole whenever that project had any tasks. Both are legal
     * shapes (task and sub-task are optional), so the validation has to allow a caller to STOP
     * at any level rather than require a leaf.
     *
     * Hence explicit per-level flags. Each one is skipped when its level was not chosen, which
     * is what makes stopping early legal, and the LEFT JOINs carry the belonging conditions -
     * `t.project_id = p.id` and `st.task_id = t.id` - so a mismatched pair yields a NULL
     * row rather than a false positive.
     */
    const node = await this.db.one(
      `SELECT p.status = 'active'                                          AS project_ok,
              ($2::uuid IS NULL OR t.id IS NOT NULL)                      AS task_belongs,
              ($2::uuid IS NULL OR (t.active AND coalesce(sp.active, true))) AS task_ok,
              ($3::uuid IS NULL OR st.id IS NOT NULL)                     AS sub_task_belongs,
              ($3::uuid IS NULL OR st.active)                             AS sub_task_ok
         FROM project p
         LEFT JOIN task        t  ON t.id  = $2::uuid AND t.project_id = p.id
         LEFT JOIN sub_project sp ON sp.id = t.sub_project_id
         LEFT JOIN sub_task    st ON st.id = $3::uuid AND st.task_id   = t.id
        WHERE p.id = $1`,
      [body.projectId, body?.taskId || null, body?.subTaskId || null]);

    if (!node) throw new BadRequestException('No such project');
    if (!node.task_belongs || !node.sub_task_belongs) {
      throw new BadRequestException(
        'That project, task and sub-task do not belong together - pick the task from the project '
        + 'and the sub-task from the task');
    }
    if (!node.project_ok || !node.task_ok || !node.sub_task_ok) {
      throw new BadRequestException(
        'Part of that project, sub-project, task or sub-task has been retired and cannot be used '
        + 'for new work logs');
    }

    // 4. Membership, as of the work date - the project graph decays (0019), so "is a member" is
    // a question about a date, not about now.
    const member = await this.db.one(
      `SELECT 1 AS ok FROM project_member pm
        WHERE pm.project_id = $1 AND pm.employee_id = $2 AND pm.valid_period @> $3::date`,
      [body.projectId, subject, on]);
    if (!member) {
      throw new BadRequestException(
        onBehalf
          ? 'That employee was not a member of the project on that date'
          : 'You were not a member of that project on that date');
    }

    return this.db.tx(async (q) => {
      const [period] = await q(
        `SELECT id, status FROM timesheet_period
          WHERE employee_id = $1 AND $2::date BETWEEN period_start AND period_end`,
        [subject, on]);

      let periodId = period?.id;
      if (!periodId) {
        const start = weekStart(on);
        const [created] = await q(
          `INSERT INTO timesheet_period (employee_id, period_start, period_end, status)
           VALUES ($1, $2, $3, 'draft')
           ON CONFLICT (employee_id, period_start) DO UPDATE SET period_end = EXCLUDED.period_end
           RETURNING id, status`, [subject, start, addDays(start, 6)]);
        periodId = created.id;
      } else if (period.status === 'submitted' || period.status === 'approved') {
        // HR does not get past this either. A locked period is corrected by adjustment, never
        // by writing into it (ADR-0015/0016), and fn_work_log_period_lock enforces it
        // independently - it is ENABLE ALWAYS and has no bypass GUC.
        throw new BadRequestException(
          `This week's timesheet is ${period.status} and is locked. Corrections need an adjustment.`);
      }

      const [log] = await q(
        `INSERT INTO work_log (employee_id, work_date, timesheet_period_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (employee_id, work_date)
           DO UPDATE SET timesheet_period_id = coalesce(work_log.timesheet_period_id, EXCLUDED.timesheet_period_id)
         RETURNING id`, [subject, on, periodId]);

      const [entry] = await q(
        `INSERT INTO work_log_entry (work_log_id, project_id, task_id, sub_task_id, minutes,
                                     description, entered_by_employee_id, entry_source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, minutes, entry_source`,
        [log.id, body.projectId, body?.taskId || null, body?.subTaskId || null, total,
         body?.description ?? null, me.employeeId, onBehalf ? 'hr_entry' : 'self']);

      return { entry, employeeId: subject, onBehalf };
    });
  }

  @Delete('work-log/:id')
  @Authenticated()
  async removeEntry(@Req() req: Request, @Param('id') id: string) {
    const me = currentActor(req);
    const owned = await this.db.one(
      `SELECT wle.id FROM work_log_entry wle JOIN work_log wl ON wl.id = wle.work_log_id
        WHERE wle.id = $1 AND wl.employee_id = $2`, [id, me.employeeId]);
    if (!owned) throw new NotFoundException('No such entry');
    try {
      await this.db.rows(`DELETE FROM work_log_entry WHERE id = $1`, [id]);
    } catch (e: any) {
      if (e?.code === '23001') throw new BadRequestException(e.message);
      throw e;
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------- timesheet
  @Get('timesheet')
  @Authenticated()
  async timesheet(@Req() req: Request, @Query('start') start?: string) {
    const me = currentActor(req);
    const today = (await this.db.one(`SELECT fn_business_date()::text AS d`))!.d;
    const periodStart = start ?? weekStart(today);

    const period = await this.db.one(
      `SELECT tp.id, tp.period_start, tp.period_end, tp.status, tp.submitted_at, tp.decided_at,
              tp.return_note, m.full_name AS decided_by_name
         FROM timesheet_period tp LEFT JOIN employee m ON m.id = tp.decided_by
        WHERE tp.employee_id = $1 AND tp.period_start = $2`, [me.employeeId, periodStart]);

    const byDay = await this.db.rows(
      `SELECT wl.work_date, coalesce(sum(wle.minutes), 0)::int AS minutes
         FROM work_log wl LEFT JOIN work_log_entry wle ON wle.work_log_id = wl.id
        WHERE wl.employee_id = $1 AND wl.work_date BETWEEN $2::date AND $2::date + 6
        GROUP BY wl.work_date ORDER BY wl.work_date`, [me.employeeId, periodStart]);

    const byProject = await this.db.rows(
      `SELECT p.code, p.name, sum(wle.minutes)::int AS minutes
         FROM work_log wl JOIN work_log_entry wle ON wle.work_log_id = wl.id
         JOIN project p ON p.id = wle.project_id
        WHERE wl.employee_id = $1 AND wl.work_date BETWEEN $2::date AND $2::date + 6
        GROUP BY p.code, p.name ORDER BY 3 DESC`, [me.employeeId, periodStart]);

    return {
      periodStart, periodEnd: addDays(periodStart, 6), period, byDay, byProject,
      totalMinutes: byProject.reduce((s, r) => s + Number(r.minutes), 0),
    };
  }

  @Post('timesheet/submit')
  @Authenticated()
  async submit(@Req() req: Request, @Body() body: { start?: string }) {
    const me = currentActor(req);
    const today = (await this.db.one(`SELECT fn_business_date()::text AS d`))!.d;
    const periodStart = body?.start ?? weekStart(today);

    const total = await this.db.one(
      `SELECT coalesce(sum(wle.minutes), 0)::int AS minutes
         FROM work_log wl JOIN work_log_entry wle ON wle.work_log_id = wl.id
        WHERE wl.employee_id = $1 AND wl.work_date BETWEEN $2::date AND $2::date + 6`,
      [me.employeeId, periodStart]);
    if ((total?.minutes ?? 0) <= 0) throw new BadRequestException('There is nothing logged for this week');

    /*
     * SUBMISSION GOES THROUGH THE STATE MACHINE, not through a status UPDATE.
     *
     * The previous version wrote `status = 'submitted'` directly. That worked, but it left the
     * transition log empty - so there was no record of who submitted, no record of a
     * resubmission after a correction, and the no-self-approval CHECK on the log was never
     * exercised because nothing ever wrote to it. Inserting the transition is what makes the
     * FSM real rather than decorative (migration 0019).
     *
     * `from_status` is whatever the period is now: both `draft` and `returned` have a legal
     * `submit` move, and the log is what distinguishes a first submission from a resubmission.
     */
    const period = await this.db.one(
      `SELECT id, status FROM timesheet_period WHERE employee_id = $1 AND period_start = $2`,
      [me.employeeId, periodStart]);
    if (!period) throw new BadRequestException('There is no timesheet period for that week');
    if (period.status !== 'draft' && period.status !== 'returned') {
      throw new BadRequestException(
        `This week is ${String(period.status).replace('_', ' ')} and cannot be submitted again`);
    }

    await this.db.rows(
      `INSERT INTO timesheet_transition
         (timesheet_period_id, event_type, from_status, to_status,
          actor_employee_id, subject_employee_id)
       VALUES ($1, 'submit', $2, 'submitted', $3, $3)`,
      [period.id, period.status, me.employeeId]);

    const updated = await this.db.one(
      `SELECT id, status FROM timesheet_period WHERE id = $1`, [period.id]);

    return {
      period: updated,
      totalMinutes: total!.minutes,
      resubmitted: period.status === 'returned',
    };
  }

  // ---------------------------------------------------------------- manager views
  @Get('timesheet/approvals')
  @Authenticated('manager', 'hr_admin')
  async approvals(@Req() req: Request) {
    const me = currentActor(req);
    return {
      periods: await this.db.rows(
        `SELECT tp.id, e.full_name, e.employee_number, tp.period_start, tp.period_end,
                tp.submitted_at,
                (SELECT coalesce(sum(wle.minutes), 0)::int
                   FROM work_log wl JOIN work_log_entry wle ON wle.work_log_id = wl.id
                  WHERE wl.employee_id = tp.employee_id
                    AND wl.work_date BETWEEN tp.period_start AND tp.period_end) AS total_minutes
           FROM timesheet_period tp
           JOIN employee e ON e.id = tp.employee_id
           JOIN employment em ON em.employee_id = tp.employee_id
                             AND em.valid_period @> fn_business_date()
          WHERE tp.status = 'submitted' AND ($2 = 'hr_admin' OR em.manager_id = $1)
          ORDER BY tp.submitted_at`, [me.employeeId, me.role]),
    };
  }

  /**
   * Take a decision on a timesheet: start a review, approve, or return it for correction.
   *
   * RETROFITTED onto `AuthorizationService` (OR-19). This route previously carried
   * `@Authenticated('manager','hr_admin')` plus `if (me.role !== 'hr_admin' ...)` - a role
   * comparison outside `packages/authz`, which Must-Know Rule 1 forbids. The policy
   * `work.timesheet.approve` already expressed the intended rule (direct reports only, never
   * your own, break-glass excluded); it simply was not being consulted.
   *
   * The decision itself goes through the FSM, so the database enforces no-self-approval, the
   * legality of the move and the requirement that a return states a reason. The checks here are
   * for a good error message, not for safety.
   */
  @Post('timesheet/approvals/:id/decide')
  @Authenticated()
  async decideTimesheet(@Req() req: Request, @Param('id') id: string,
                        @Body() body: { decision?: 'approve' | 'return' | 'review'; note?: string }) {
    const me = currentActor(req);
    const decision = body?.decision;
    if (decision !== 'approve' && decision !== 'return' && decision !== 'review') {
      throw new BadRequestException('decision must be approve, return or review');
    }

    const row = await this.db.one(
      `SELECT tp.id, tp.employee_id, tp.status FROM timesheet_period tp WHERE tp.id = $1`, [id]);
    if (!row) throw new NotFoundException('No such timesheet');

    try {
      await this.authz.assertCan(authContext(req), 'work.timesheet.approve', {
        type: 'timesheet', id, subjectEmployeeId: row.employee_id,
      });
    } catch (e) {
      // 404, not 403: a 403 would confirm the timesheet exists (rbac-rules error semantics).
      if (e instanceof AuthzDeniedError) throw new NotFoundException('No such timesheet');
      throw e;
    }

    if (row.status !== 'submitted' && row.status !== 'under_review') {
      throw new BadRequestException(
        `This timesheet is ${String(row.status).replace('_', ' ')} and needs no decision`);
    }
    if (decision === 'return' && !body?.note?.trim()) {
      throw new BadRequestException('Returning a timesheet needs a note saying what to fix');
    }

    const event = decision === 'approve' ? 'approve'
      : decision === 'return' ? 'return' : 'start_review';
    const to = decision === 'approve' ? 'approved'
      : decision === 'return' ? 'returned' : 'under_review';

    if (event === 'start_review' && row.status !== 'submitted') {
      throw new BadRequestException('This timesheet is already under review');
    }

    await this.db.rows(
      `INSERT INTO timesheet_transition
         (timesheet_period_id, event_type, from_status, to_status,
          actor_employee_id, subject_employee_id, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, event, row.status, to, me.employeeId, row.employee_id, body?.note?.trim() || null]);

    const updated = await this.db.one(
      `SELECT id, status FROM timesheet_period WHERE id = $1`, [id]);
    return { period: updated };
  }

  /** The transition history for one timesheet - who moved it, when, and why. */
  @Get('timesheet/:id/history')
  @Authenticated()
  async timesheetHistory(@Req() req: Request, @Param('id') id: string) {
    const row = await this.db.one(
      `SELECT employee_id FROM timesheet_period WHERE id = $1`, [id]);
    if (!row) throw new NotFoundException('No such timesheet');

    try {
      await this.authz.assertCan(authContext(req), 'work.timesheet.read', {
        type: 'timesheet', id, subjectEmployeeId: row.employee_id,
      });
    } catch (e) {
      if (e instanceof AuthzDeniedError) throw new NotFoundException('No such timesheet');
      throw e;
    }

    return {
      history: await this.db.rows(
        `SELECT tt.event_type, tt.from_status, tt.to_status, tt.note, tt.created_at,
                a.full_name AS actor_name
           FROM timesheet_transition tt
           LEFT JOIN employee a ON a.id = tt.actor_employee_id
          WHERE tt.timesheet_period_id = $1
          ORDER BY tt.created_at`, [id]),
    };
  }

  /**
   * The closing slide: team effort by project.
   *
   * This is the number that comes from the WORK LOG, and it is deliberately not the same number
   * as attendance. `variance` shows where they disagree - flagged, never corrected (ADR-0015).
   */
  /**
   * Team effort, filtered.
   *
   * TWO PROBLEMS WERE FIXED HERE, and the second is the more serious.
   *
   * The visible one: the only filter was `?start=`, a fixed Monday-to-Sunday week. There was
   * no way to look at a month, a person, or a project.
   *
   * The invisible one: row scope was decided by `($3 = 'hr_admin' OR em.manager_id = $1)` -
   * a ROLE LITERAL COMPARED INSIDE SQL. That is Rule 1 (never decide authorization outside
   * packages/authz) and it was wrong in substance too, not just in placement: it hardcodes the
   * reporting graph as one level deep, so a manager saw their DIRECT reports and nobody below
   * them, which disagrees with every other reporting-scoped screen in the system. It also meant
   * a new role would silently get an empty screen instead of a denial. Now `assertCan`
   * decides admission and the composed scope predicate decides rows, exactly as reports.ts does.
   *
   * FILTERING NARROWS, IT NEVER WIDENS. Every filter is ANDed with the scope predicate, so
   * `?employeeId=` naming somebody outside the caller's scope returns nothing rather than
   * their effort. That ordering is the whole safety property of this endpoint.
   *
   * The variance figures are filtered by the same period and people, so attendance-versus-effort
   * keeps agreeing with the totals beside it (ADR-0015: the two domains reconcile, and neither
   * derives from the other).
   */
  @Get('team/effort')
  @Authenticated()
  async teamEffort(
    @Req() req: Request,
    @Query('start') start?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('preset') preset?: string,
    @Query('employeeId') employeeId?: string,
    @Query('projectId') projectId?: string,
    @Query('taskId') taskId?: string,
  ) {
    // `start` was a Monday and meant a seven-day window. Kept so existing links still work.
    const range = start && !from && !to && !preset
      ? { from: start, to: addDays(start, 6), preset: 'week' as string }
      : await this.resolveRange({ from, to, preset });

    const scope = await this.gate(req, 'work.team_effort.read', 'project_effort', 'wl', 3,
      undefined, range.to);

    const filters = {
      employeeId: (employeeId ?? '').trim() || null,
      projectId: (projectId ?? '').trim() || null,
      taskId: (taskId ?? '').trim() || null,
    };
    const active = Object.entries(filters).filter(([, v]) => v).map(([k]) => k);

    if (!scope) {
      return {
        ...range, periodStart: range.from, periodEnd: range.to, filters, activeFilters: active,
        rows: [], attendanceVsEffort: [], totals: { minutes: 0, people: 0, projects: 0 },
      };
    }

    // $1 from, $2 to, then the scope predicate's params, then the three optional filters.
    const base = [range.from, range.to, ...scope.params];
    const f = base.length;
    const args = [...base, filters.employeeId, filters.projectId, filters.taskId];
    const narrow =
      `AND ($${f + 1}::uuid IS NULL OR wl.employee_id = $${f + 1}::uuid)
       AND ($${f + 2}::uuid IS NULL OR wle.project_id = $${f + 2}::uuid)
       AND ($${f + 3}::uuid IS NULL OR wle.task_id    = $${f + 3}::uuid)`;

    const rows = await this.db.rows(
      `SELECT e.full_name, e.employee_number, e.id AS employee_id,
              p.id AS project_id, p.code AS project_code, p.name AS project_name,
              sum(wle.minutes)::int AS minutes,
              count(*) FILTER (WHERE wle.entry_source = 'hr_entry')::int AS hr_entered
         FROM work_log wl
         JOIN work_log_entry wle ON wle.work_log_id = wl.id
         JOIN project p ON p.id = wle.project_id
         JOIN employee e ON e.id = wl.employee_id
        WHERE wl.work_date BETWEEN $1::date AND $2::date
          AND ${scope.sql}
          ${narrow}
        GROUP BY e.full_name, e.employee_number, e.id, p.id, p.code, p.name
        ORDER BY e.full_name, 7 DESC`, args);

    /*
     * The variance list is scoped on `v` rather than `wl`, so the predicate is rendered a
     * SECOND time with the other alias. Reusing the first rendering would have compiled and
     * then filtered on a table this query does not join.
     */
    const vScope = await this.gate(req, 'work.team_effort.read', 'project_effort', 'v', 3,
      undefined, range.to);
    const vArgs = [range.from, range.to, ...(vScope?.params ?? []), filters.employeeId];
    const vf = 2 + (vScope?.params.length ?? 0);
    const attendanceVsEffort = vScope ? await this.db.rows(
      `SELECT v.full_name, v.business_date, v.attendance_status, v.attendance_minutes,
              v.logged_minutes, v.variance_flag
         FROM v_work_attendance_variance v
        WHERE v.business_date BETWEEN $1::date AND $2::date
          AND v.variance_flag IS NOT NULL
          AND ${vScope.sql}
          AND ($${vf + 1}::uuid IS NULL OR v.employee_id = $${vf + 1}::uuid)
        ORDER BY v.business_date, v.full_name LIMIT 24`, vArgs) : [];

    const totals = {
      minutes: (rows as any[]).reduce((n, r) => n + Number(r.minutes), 0),
      people: new Set((rows as any[]).map((r) => r.employee_id)).size,
      projects: new Set((rows as any[]).map((r) => r.project_id)).size,
    };

    return {
      ...range, periodStart: range.from, periodEnd: range.to, filters, activeFilters: active,
      rows, attendanceVsEffort, totals,
    };
  }
}

@Module({ controllers: [WorkController] })
export class WorkModule {}
