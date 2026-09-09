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

@Controller()
export class WorkController {
  constructor(private readonly db: Db, private readonly authz: Authz) {}

  // ---------------------------------------------------------------- attendance
  @Get('attendance')
  @Authenticated()
  async attendance(@Req() req: Request, @Query('month') month?: string) {
    const me = currentActor(req);
    const from = (month ?? (await this.db.one(`SELECT to_char(fn_business_date(),'YYYY-MM') AS m`))!.m) + '-01';

    const days = await this.db.rows(
      `SELECT business_date, status, worked_minutes, first_in_at, last_out_at, note
         FROM attendance_day
        WHERE employee_id = $1
          AND business_date >= $2::date
          AND business_date < ($2::date + INTERVAL '1 month')
        ORDER BY business_date`, [me.employeeId, from]);

    const summary = await this.db.one(
      `SELECT count(*) FILTER (WHERE status = 'present')  AS present,
              count(*) FILTER (WHERE status = 'late')     AS late,
              count(*) FILTER (WHERE status = 'wfh')      AS wfh,
              count(*) FILTER (WHERE status = 'absent')   AS absent,
              count(*) FILTER (WHERE status = 'leave')    AS leave,
              count(*) FILTER (WHERE status = 'week_off') AS week_off,
              coalesce(sum(worked_minutes), 0)::int       AS total_minutes
         FROM attendance_day
        WHERE employee_id = $1 AND business_date >= $2::date
          AND business_date < ($2::date + INTERVAL '1 month')`, [me.employeeId, from]);

    return { month: from.slice(0, 7), days, summary };
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
  @Get('projects')
  @Authenticated()
  async projects(@Req() req: Request) {
    const me = currentActor(req);
    return {
      projects: await this.db.rows(
        `SELECT p.id, p.code, p.name, p.client_name, pm.role,
                (SELECT json_agg(json_build_object('id', t.id, 'code', t.code, 'title', t.title)
                                 ORDER BY t.code)
                   FROM task t WHERE t.project_id = p.id AND t.status <> 'done') AS tasks
           FROM project_member pm
           JOIN project p ON p.id = pm.project_id
          WHERE pm.employee_id = $1 AND p.status = 'active'
          ORDER BY p.name`, [me.employeeId]),
    };
  }

  // ---------------------------------------------------------------- daily work log
  @Get('work-log')
  @Authenticated()
  async workLog(@Req() req: Request, @Query('date') date?: string) {
    const me = currentActor(req);
    const on = date ?? (await this.db.one(`SELECT fn_business_date()::text AS d`))!.d;

    const entries = await this.db.rows(
      `SELECT wle.id, wle.minutes, wle.description,
              p.code AS project_code, p.name AS project_name,
              t.code AS task_code, t.title AS task_title
         FROM work_log wl
         JOIN work_log_entry wle ON wle.work_log_id = wl.id
         JOIN project p ON p.id = wle.project_id
         LEFT JOIN task t ON t.id = wle.task_id
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

  @Post('work-log')
  @Authenticated()
  async addEntry(@Req() req: Request, @Body() body: {
    date?: string; projectId?: string; taskId?: string | null;
    hours?: number; minutes?: number; description?: string;
  }) {
    const me = currentActor(req);
    const on = body?.date ?? (await this.db.one(`SELECT fn_business_date()::text AS d`))!.d;

    // ADR-0016: effort is INTEGER MINUTES. The UI offers hours+minutes; storage does not.
    const total = Math.round((Number(body?.hours ?? 0) * 60) + Number(body?.minutes ?? 0));
    if (!Number.isFinite(total) || total <= 0) throw new BadRequestException('Effort must be greater than zero');
    if (total > 1440) throw new BadRequestException('That is more than 24 hours');
    if (!body?.projectId) throw new BadRequestException('A project is required');

    return this.db.tx(async (q) => {
      const [period] = await q(
        `SELECT id, status FROM timesheet_period
          WHERE employee_id = $1 AND $2::date BETWEEN period_start AND period_end`,
        [me.employeeId, on]);

      let periodId = period?.id;
      if (!periodId) {
        const start = weekStart(on);
        const [created] = await q(
          `INSERT INTO timesheet_period (employee_id, period_start, period_end, status)
           VALUES ($1, $2, $3, 'draft')
           ON CONFLICT (employee_id, period_start) DO UPDATE SET period_end = EXCLUDED.period_end
           RETURNING id, status`, [me.employeeId, start, addDays(start, 6)]);
        periodId = created.id;
      } else if (period.status === 'submitted' || period.status === 'approved') {
        throw new BadRequestException(
          `This week's timesheet is ${period.status} and is locked. Corrections need an adjustment.`);
      }

      const [log] = await q(
        `INSERT INTO work_log (employee_id, work_date, timesheet_period_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (employee_id, work_date)
           DO UPDATE SET timesheet_period_id = coalesce(work_log.timesheet_period_id, EXCLUDED.timesheet_period_id)
         RETURNING id`, [me.employeeId, on, periodId]);

      const [entry] = await q(
        `INSERT INTO work_log_entry (work_log_id, project_id, task_id, minutes, description)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, minutes`,
        [log.id, body.projectId, body?.taskId || null, total, body?.description ?? null]);

      return { entry };
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
  @Get('team/effort')
  @Authenticated('manager', 'hr_admin')
  async teamEffort(@Req() req: Request, @Query('start') start?: string) {
    const me = currentActor(req);
    const today = (await this.db.one(`SELECT fn_business_date()::text AS d`))!.d;
    const periodStart = start ?? weekStart(today);

    const rows = await this.db.rows(
      `SELECT e.full_name, e.employee_number, p.code AS project_code, p.name AS project_name,
              sum(wle.minutes)::int AS minutes
         FROM work_log wl
         JOIN work_log_entry wle ON wle.work_log_id = wl.id
         JOIN project p ON p.id = wle.project_id
         JOIN employee e ON e.id = wl.employee_id
         JOIN employment em ON em.employee_id = e.id AND em.valid_period @> fn_business_date()
        WHERE wl.work_date BETWEEN $2::date AND $2::date + 6
          AND ($3 = 'hr_admin' OR em.manager_id = $1)
        GROUP BY e.full_name, e.employee_number, p.code, p.name
        ORDER BY e.full_name, 5 DESC`, [me.employeeId, periodStart, me.role]);

    const attendanceVsEffort = await this.db.rows(
      `SELECT v.full_name, v.business_date, v.attendance_status, v.attendance_minutes,
              v.logged_minutes, v.variance_flag
         FROM v_work_attendance_variance v
         JOIN employment em ON em.employee_id = v.employee_id
                           AND em.valid_period @> fn_business_date()
        WHERE v.business_date BETWEEN $2::date AND $2::date + 6
          AND v.variance_flag IS NOT NULL
          AND ($3 = 'hr_admin' OR em.manager_id = $1)
        ORDER BY v.business_date, v.full_name LIMIT 12`,
      [me.employeeId, periodStart, me.role]);

    return { periodStart, periodEnd: addDays(periodStart, 6), rows, attendanceVsEffort };
  }
}

@Module({ controllers: [WorkController] })
export class WorkModule {}
