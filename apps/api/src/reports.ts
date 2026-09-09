import {
  BadRequestException, Controller, Get, Module, NotFoundException, Query, Req,
} from '@nestjs/common';
import { AuthzDeniedError, type Action, type ResourceType } from '@panasa/authz';
import type { Request } from 'express';
import { Authenticated } from './auth';
import { Authz, authContext } from './authz';
import { Db } from './db';

/**
 * HR reporting.
 *
 * THE ONE IDEA THIS MODULE IS BUILT ON: A REPORT IS NOT A NEW PERMISSION.
 *
 * It would have been easy to add `report.leave.read`, `report.attendance.read` and so on. That
 * is a trap. Two permission sets covering the same data drift apart, and the day they do, a
 * report shows what the detail view refuses - which is the worst possible direction for the
 * mistake to go. So each report REUSES the resource action it reports on: the leave report is
 * `leave.balance.read` applied to many rows. A report can therefore never reveal more than the
 * equivalent detail screen, and it inherits the policy that is already tested by 385 matrix
 * assertions rather than needing its own.
 *
 * AND THE SCOPE PREDICATE IS COMPOSED INTO THE QUERY, NOT APPLIED AFTER IT.
 *
 * `ai/context/rbac-rules.md` warns that filtering in application code "still leaks via counts,
 * pagination totals and timing". A report is nothing but counts and totals, so this is the
 * place that warning actually bites: a manager who cannot open E3's record but receives a
 * headcount including them has still learned something about E3.
 *
 * Every handler below therefore renders `scope()` into the SQL and lets the database aggregate
 * AFTER the filter. There is no point at which an unscoped total exists in this process.
 */

/*
 * Each report: which action authorises it, and which resource type the row scope keys on.
 *
 * There is deliberately no `column` here. An earlier version carried one and nothing read it -
 * the subject column comes from `employeeColumn(resource)` inside `packages/authz`, which is the
 * single place that knows it. A duplicate that looked authoritative and changed nothing is worse
 * than no field at all, because the next person to move a column would edit it and believe they
 * were done.
 */
const REPORTS = {
  headcount: { action: 'people.employee.list', resource: 'employee' },
  leave: { action: 'leave.balance.read', resource: 'leave_balance' },
  attendance: { action: 'attendance.day.read', resource: 'attendance_day' },
  wfh: { action: 'attendance.day.read', resource: 'attendance_day' },
  reconciliation: { action: 'work.log.read', resource: 'work_log' },
  timesheets: { action: 'work.timesheet.read', resource: 'timesheet' },
  documents: { action: 'documents.document.list', resource: 'employee_document' },
  tasks: { action: 'work.task.read', resource: 'task' },
} as const satisfies Record<string, { action: Action; resource: ResourceType }>;

type ReportName = keyof typeof REPORTS;

const isoDate = (v: unknown, fallback: string): string => {
  const s = typeof v === 'string' ? v.trim() : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : fallback;
};

@Controller('reports')
export class ReportsController {
  constructor(private readonly db: Db, private readonly authz: Authz) {}

  /**
   * Authorise a report and hand back the row filter to compose.
   *
   * Returns the rendered SQL and its parameters rather than a row set, precisely so the caller
   * cannot accidentally fetch-then-filter: there is nothing to filter, only a predicate to put
   * in a WHERE clause.
   */
  private async gate(
    req: Request, name: ReportName, alias: string, firstParam: number,
    opts: { asOf?: string } = {},
  ): Promise<{ sql: string; params: unknown[] } | null> {
    const spec = REPORTS[name];
    const ctx = authContext(req);
    const ref = {
      type: spec.resource,
      asOf: opts.asOf,
      /*
       * THE SUBJECT IS THE CALLER, and that is not a shortcut.
       *
       * A report is a COLLECTION request, so it has no single subject - but the policies for
       * self-scoped resources are written around `isSelf`, which cannot be satisfied by a ref
       * with no subject at all. Asking with no subject made an employee's own attendance report
       * return 404.
       *
       * The two questions are genuinely different and this is the split:
       *   `assertCan` answers MAY YOU READ THIS RESOURCE TYPE AT ALL - so it asks about the one
       *              subject every caller is certainly entitled to, themselves;
       *   `scope`    answers WHOSE ROWS - and that is where an employee narrows to self, a
       *              manager to their subtree, and HR to the organisation.
       *
       * Asking with the caller as subject therefore widens nothing: a role that cannot read its
       * OWN attendance is refused outright, and every role that can gets exactly the rows its
       * scope predicate admits. `finance` and `auditor`, which hold no attendance grant at all,
       * are still refused here.
       */
      subjectEmployeeId: ctx.employeeId ?? undefined,
      // Documents discriminate on classification; the report only ever aggregates the
      // non-restricted ones, so it asks with PERSONAL and gets HR-or-self.
      ...(spec.resource === 'employee_document' ? { dataClass: 'PERSONAL' as const } : {}),
    };

    try {
      await this.authz.assertCan(ctx, spec.action, ref);
    } catch (e) {
      if (e instanceof AuthzDeniedError) {
        // A report is a collection, so refusing it reveals no individual record's existence.
        throw new NotFoundException('That report is not available to you');
      }
      throw e;
    }

    const predicate = this.authz.scope(ctx, spec.action, ref);
    // `none` means the policy admits this actor to no rows at all. Returning null makes the
    // caller emit an empty report rather than an unfiltered one.
    if (predicate.kind === 'none') return null;
    return predicate.render(alias, firstParam);
  }

  private range(from?: string, to?: string): Promise<{ from: string; to: string }> {
    return this.db.one(`SELECT fn_business_date()::text AS d`).then((r) => {
      const today = r!.d as string;
      const monthStart = `${today.slice(0, 7)}-01`;
      return { from: isoDate(from, monthStart), to: isoDate(to, today) };
    });
  }

  // -------------------------------------------------------------------------
  /** What reports may this caller see at all? Drives the UI without guessing. */
  @Get()
  @Authenticated()
  async index(@Req() req: Request) {
    const ctx = authContext(req);
    const available: string[] = [];
    for (const [name, spec] of Object.entries(REPORTS)) {
      // Asked the same way as `gate`, or the index would advertise a report that then 404s.
      const ref = {
        type: spec.resource,
        subjectEmployeeId: ctx.employeeId ?? undefined,
        ...(spec.resource === 'employee_document' ? { dataClass: 'PERSONAL' as const } : {}),
      };
      if ((await this.authz.can(ctx, spec.action, ref)).allowed) available.push(name);
    }
    return { available };
  }

  // -------------------------------------------------------------------------
  @Get('headcount')
  @Authenticated()
  async headcount(@Req() req: Request,
                  @Query('from') from?: string, @Query('to') to?: string) {
    const { from: f, to: t } = await this.range(from, to);
    const scope = await this.gate(req, 'headcount', 'e', 3, { asOf: t });
    if (!scope) return { from: f, to: t, movement: [], summary: null };

    const movement = await this.db.rows(
      `SELECT e.employee_number, e.full_name, m.event_type, m.effective_on, m.exit_type,
              d.code AS department_code, g.name AS designation
         FROM fn_headcount_movement($1::date, $2::date) m
         JOIN employee e ON e.id = m.employee_id
         LEFT JOIN department d ON d.id = m.department_id
         LEFT JOIN designation g ON g.id = m.designation_id
        WHERE ${scope.sql}
        ORDER BY m.effective_on DESC, e.employee_number`,
      [f, t, ...scope.params]);

    // Aggregated AFTER the filter, in the same statement, so no unscoped total ever exists.
    const summary = await this.db.one(
      `SELECT count(*) FILTER (WHERE m.event_type = 'joined')::int   AS joiners,
              count(*) FILTER (WHERE m.event_type = 'exited')::int   AS leavers,
              count(*) FILTER (WHERE m.event_type = 'resigned')::int AS resignations,
              count(*) FILTER (WHERE m.event_type = 'promoted')::int AS promotions,
              count(*) FILTER (WHERE m.event_type = 'confirmed')::int AS confirmations
         FROM fn_headcount_movement($1::date, $2::date) m
         JOIN employee e ON e.id = m.employee_id
        WHERE ${scope.sql}`,
      [f, t, ...scope.params]);

    return { from: f, to: t, movement, summary };
  }

  // -------------------------------------------------------------------------
  @Get('leave')
  @Authenticated()
  async leave(@Req() req: Request, @Query('year') year?: string) {
    const y = Number(year) || new Date().getFullYear();
    if (y < 2000 || y > 2100) throw new BadRequestException('year is out of range');

    const scope = await this.gate(req, 'leave', 'l', 2);
    if (!scope) return { year: y, rows: [], byType: [] };

    const rows = await this.db.rows(
      `SELECT e.employee_number, e.full_name, l.leave_code, l.is_paid,
              l.accrued, l.taken, l.available
         FROM fn_leave_liability($1::int) l
         JOIN employee e ON e.id = l.employee_id
        WHERE ${scope.sql}
        ORDER BY e.employee_number, l.leave_code`,
      [y, ...scope.params]);

    // NUMERIC all the way out (Rule 4). Paid and unpaid are kept apart because summing them
    // would overstate the obligation by including LWP, which the company does not owe.
    const byType = await this.db.rows(
      `SELECT l.leave_code, l.is_paid,
              sum(l.available)::text AS outstanding,
              sum(l.taken)::text     AS taken
         FROM fn_leave_liability($1::int) l
         JOIN employee e ON e.id = l.employee_id
        WHERE ${scope.sql}
        GROUP BY l.leave_code, l.is_paid
        ORDER BY l.is_paid DESC, l.leave_code`,
      [y, ...scope.params]);

    return { year: y, rows, byType };
  }

  // -------------------------------------------------------------------------
  @Get('attendance')
  @Authenticated()
  async attendance(@Req() req: Request,
                   @Query('from') from?: string, @Query('to') to?: string) {
    const { from: f, to: t } = await this.range(from, to);
    const scope = await this.gate(req, 'attendance', 's', 3, { asOf: t });
    if (!scope) return { from: f, to: t, rows: [] };

    const rows = await this.db.rows(
      `SELECT e.employee_number, e.full_name, s.present_days, s.late_days, s.wfh_days,
              s.absent_days, s.leave_days, s.week_off_days, s.holiday_days,
              s.worked_minutes, s.expected_days
         FROM fn_attendance_summary($1::date, $2::date) s
         JOIN employee e ON e.id = s.employee_id
        WHERE ${scope.sql}
        ORDER BY e.employee_number`,
      [f, t, ...scope.params]);

    return { from: f, to: t, rows };
  }

  // -------------------------------------------------------------------------
  @Get('wfh')
  @Authenticated()
  async wfh(@Req() req: Request, @Query('from') from?: string, @Query('to') to?: string) {
    const { from: f, to: t } = await this.range(from, to);
    const scope = await this.gate(req, 'wfh', 'w', 3, { asOf: t });
    if (!scope) return { from: f, to: t, rows: [] };

    const rows = await this.db.rows(
      `SELECT e.employee_number, e.full_name,
              w.attendance_days, w.approved_days::text AS approved_days, w.disagreement
         FROM fn_wfh_usage($1::date, $2::date) w
         JOIN employee e ON e.id = w.employee_id
        WHERE ${scope.sql}
        ORDER BY abs(w.disagreement) DESC, e.employee_number`,
      [f, t, ...scope.params]);

    return {
      from: f, to: t, rows,
      // Said in the payload, not just in a doc comment, because a consumer needs to know these
      // are two independent sources rather than one number with a rounding error.
      note: 'WFH is both a leave type and an attendance status. Both are shown; a disagreement '
        + 'is an operational question, not a figure to average away.',
    };
  }

  // -------------------------------------------------------------------------
  /** ADR-0015. Reports the variance. Offers nothing that would change either side. */
  @Get('reconciliation')
  @Authenticated()
  async reconciliation(@Req() req: Request,
                       @Query('from') from?: string, @Query('to') to?: string) {
    const { from: f, to: t } = await this.range(from, to);
    const scope = await this.gate(req, 'reconciliation', 'v', 3, { asOf: t });
    if (!scope) return { from: f, to: t, rows: [], summary: null };

    const rows = await this.db.rows(
      `SELECT e.employee_number, e.full_name, v.business_date, v.attendance_status,
              v.attended_minutes, v.logged_minutes, v.variance_minutes, v.note
         FROM fn_attendance_vs_effort($1::date, $2::date) v
         JOIN employee e ON e.id = v.employee_id
        WHERE ${scope.sql} AND v.note IS NOT NULL
        ORDER BY v.business_date DESC, e.employee_number`,
      [f, t, ...scope.params]);

    const summary = await this.db.one(
      `SELECT count(*)::int AS flagged_days,
              sum(v.attended_minutes)::bigint AS attended_minutes,
              sum(v.logged_minutes)::bigint   AS logged_minutes
         FROM fn_attendance_vs_effort($1::date, $2::date) v
         JOIN employee e ON e.id = v.employee_id
        WHERE ${scope.sql}`,
      [f, t, ...scope.params]);

    return {
      from: f, to: t, rows, summary,
      principle: 'Work logs are not attendance (ADR-0015). A gap is a reconciliation finding, '
        + 'not a reason to change either dataset.',
    };
  }

  // -------------------------------------------------------------------------
  @Get('timesheets')
  @Authenticated()
  async timesheets(@Req() req: Request,
                   @Query('from') from?: string, @Query('to') to?: string) {
    const { from: f, to: t } = await this.range(from, to);
    const scope = await this.gate(req, 'timesheets', 'c', 3, { asOf: t });
    if (!scope) return { from: f, to: t, rows: [] };

    const rows = await this.db.rows(
      `SELECT e.employee_number, e.full_name, c.period_start, c.period_end,
              c.status, c.logged_minutes, c.days_waiting
         FROM fn_timesheet_compliance($1::date, $2::date) c
         JOIN employee e ON e.id = c.employee_id
        WHERE ${scope.sql}
        ORDER BY c.period_start DESC, e.employee_number`,
      [f, t, ...scope.params]);

    return { from: f, to: t, rows };
  }

  // -------------------------------------------------------------------------
  /** Counts only. Naming the document types would reveal who holds a medical certificate. */
  @Get('documents')
  @Authenticated()
  async documents(@Req() req: Request, @Query('within') within?: string) {
    const days = Math.min(Math.max(Number(within) || 60, 1), 365);
    const scope = await this.gate(req, 'documents', 'c', 2);
    if (!scope) return { withinDays: days, rows: [] };

    const rows = await this.db.rows(
      `SELECT e.employee_number, e.full_name, e.status,
              c.filed_types, c.pending_scan, c.expiring_soon, c.expired
         FROM fn_document_compliance($1::int) c
         JOIN employee e ON e.id = c.employee_id
        WHERE ${scope.sql}
        ORDER BY (c.expired > 0) DESC, (c.expiring_soon > 0) DESC,
                 c.filed_types ASC, e.employee_number`,
      [days, ...scope.params]);

    return { withinDays: days, rows };
  }

  // -------------------------------------------------------------------------
  /** Effort by project for one employee, or for the caller. Scope decides whose is reachable. */
  @Get('effort')
  @Authenticated()
  async effort(@Req() req: Request, @Query('from') from?: string,
               @Query('to') to?: string) {
    const { from: f, to: t } = await this.range(from, to);
    const scope = await this.gate(req, 'reconciliation', 'wl', 3, { asOf: t });
    if (!scope) return { from: f, to: t, byProject: [], byEmployee: [] };

    const byProject = await this.db.rows(
      `SELECT p.code, p.name, sum(wle.minutes)::bigint AS minutes,
              count(DISTINCT wl.employee_id)::int AS contributors
         FROM work_log wl
         JOIN work_log_entry wle ON wle.work_log_id = wl.id
         JOIN project p ON p.id = wle.project_id
        WHERE wl.work_date >= $1::date AND wl.work_date <= $2::date
          AND ${scope.sql}
        GROUP BY p.code, p.name
        ORDER BY minutes DESC`,
      [f, t, ...scope.params]);

    const byEmployee = await this.db.rows(
      `SELECT e.employee_number, e.full_name, sum(wle.minutes)::bigint AS minutes
         FROM work_log wl
         JOIN work_log_entry wle ON wle.work_log_id = wl.id
         JOIN employee e ON e.id = wl.employee_id
        WHERE wl.work_date >= $1::date AND wl.work_date <= $2::date
          AND ${scope.sql}
        GROUP BY e.employee_number, e.full_name
        ORDER BY minutes DESC`,
      [f, t, ...scope.params]);

    return { from: f, to: t, byProject, byEmployee };
  }
  // -------------------------------------------------------------------------
  /**
   * Tasks - the one report that needs BOTH scope graphs, and gets them without merging them.
   *
   * A task lives in a project and is assigned to a person, so it is the first resource that does
   * not fall cleanly on one side of ADR-0005's split. The answer is not a third graph (DEC-045:
   * merging them is how a project lead ends up reading a disciplinary file) but two cuts, each
   * answered by the graph that already governs its shape:
   *
   *   byAssignee - `work.task.read`, reporting graph, exactly like a work log;
   *   byProject  - `work.project.read`, membership graph, exactly like project effort.
   *
   * AND THE PROJECT CUT IS THE ONLY ONE THAT CAN SEE AN UNASSIGNED TASK. Every task in this
   * database has no assignee, so the assignee cut alone would have returned nothing to anybody
   * while nine real tasks sat in three projects. An unassigned task has no subject for a subtree
   * comparison, but it is not public either - it discloses that a project has work outstanding -
   * so membership is exactly the right gate for it.
   */
  @Get('tasks')
  @Authenticated()
  async tasks(@Req() req: Request, @Query('within') within?: string) {
    const days = Math.min(Math.max(Number(within) || 7, 1), 90);

    // The assignee cut authorises the report as a whole: every role that may read tasks at all
    // may read its own.
    const mine = await this.gate(req, 'tasks', 't', 2);

    const byAssignee = mine ? await this.db.rows(
      `SELECT e.employee_number, e.full_name,
              t.open_tasks, t.in_progress, t.blocked, t.done_tasks, t.cancelled_tasks,
              t.overdue, t.due_soon, t.no_due_date
         FROM fn_task_status($1::int) t
         JOIN employee e ON e.id = t.assignee_employee_id
        WHERE ${mine.sql}
          AND (t.open_tasks + t.in_progress + t.blocked
               + t.done_tasks + t.cancelled_tasks) > 0
        ORDER BY t.overdue DESC, t.due_soon DESC, e.employee_number`,
      [days, ...mine.params]) : [];

    /*
     * THE PROJECT CUT USES scope() WITHOUT assertCan, AND THAT IS SAFE FOR ONE SPECIFIC REASON.
     *
     * `work.project.read` admits an employee `when: isProjectMember`, which needs a projectId on
     * the ref - and a collection request has not got one, so `can` would deny every non-HR
     * caller and this cut would vanish for exactly the project members it exists to serve.
     *
     * Relying on `scope` alone is not a bypass, because DEC-040 gave `scope` its own fail-closed
     * precondition: an actor holding no role the policy names gets `DENY_ALL`, which renders as
     * literal `false`. So `finance` and `auditor` get no rows, an employee or manager gets their
     * own projects via the membership predicate, and HR gets ALLOW_ALL - each from the same
     * policy, without a role check here.
     */
    const ctx = authContext(req);
    const proj = this.authz.scope(ctx, 'work.project.read', { type: 'project' });
    const projScope = proj.kind === 'none' ? null : proj.render('p', 2);

    const byProject = projScope ? await this.db.rows(
      `SELECT p.code, p.name, p.client_name,
              t.total_tasks, t.unassigned, t.open_tasks, t.in_progress, t.blocked,
              t.done_tasks, t.cancelled_tasks, t.overdue, t.due_soon, t.assignees
         FROM fn_project_task_status($1::int) t
         JOIN project p ON p.id = t.project_id
        WHERE ${projScope.sql} AND t.total_tasks > 0
        ORDER BY t.overdue DESC, t.unassigned DESC, p.code`,
      [days, ...projScope.params]) : [];

    return {
      dueWithinDays: days,
      byAssignee,
      byProject,
      // Said in the payload because a reader who saw only the assignee cut would reasonably
      // conclude the unassigned tasks did not exist.
      note: 'Tasks are reported twice because they answer to two different scope graphs: by '
        + 'assignee through the reporting line, and by project through project membership. A task '
        + 'with nobody assigned appears only in the project view - it has no subject, so the '
        + 'reporting line cannot account for it.',
    };
  }
}

@Module({ controllers: [ReportsController] })
export class ReportsModule {}
