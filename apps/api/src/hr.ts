import { Controller, Get, Module, NotFoundException, Param, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Authenticated, currentActor } from './auth';
import { Authz, authContext } from './authz';
import { Db } from './db';

const LEAVE_YEAR = 2026;

@Controller()
export class HrController {
  constructor(private readonly db: Db, private readonly authz: Authz) {}

  /** The landing screen. Shaped by role: an employee sees themselves, HR/managers see the org. */
  @Get('dashboard')
  @Authenticated()
  async dashboard(@Req() req: Request) {
    const me = currentActor(req);

    const isManager = me.role === 'manager' || me.role === 'hr_admin';

    // Org-wide headcount and presence is HR/manager information. An employee has no business
    // reason to know how many colleagues are absent today, so it is not SENT to them - not
    // merely hidden in the UI, which would leave it readable from the API.
    // TRACK B: this is the kind of decision ADR-0005's field mask should make centrally rather
    // than each endpoint deciding for itself.
    const [org] = isManager
      ? await this.db.rows(
          `SELECT
             (SELECT count(*) FROM employee WHERE status = 'active')                        AS headcount,
             (SELECT count(*) FROM attendance_day
               WHERE business_date = fn_business_date() AND status IN ('present','late'))   AS present_today,
             (SELECT count(*) FROM attendance_day
               WHERE business_date = fn_business_date() AND status = 'wfh')                 AS wfh_today,
             (SELECT count(*) FROM leave_request
               WHERE status = 'approved'
                 AND fn_business_date() BETWEEN from_date AND to_date)                      AS on_leave_today`)
      : [null];

    const pendingLeave = await this.db.one(
      `SELECT count(*)::int AS n
         FROM leave_request r
         JOIN employment em ON em.employee_id = r.employee_id
                           AND em.valid_period @> fn_business_date()
        WHERE r.status = 'pending' AND ($2 = 'hr_admin' OR em.manager_id = $1)`,
      [me.employeeId, me.role]);

    const pendingTimesheets = await this.db.one(
      `SELECT count(*)::int AS n
         FROM timesheet_period tp
         JOIN employment em ON em.employee_id = tp.employee_id
                           AND em.valid_period @> fn_business_date()
        WHERE tp.status = 'submitted' AND ($2 = 'hr_admin' OR em.manager_id = $1)`,
      [me.employeeId, me.role]);

    const myBalances = await this.db.rows(
      `SELECT lt.code, coalesce(a.available, 0) AS available
         FROM leave_type lt
         LEFT JOIN leave_account a ON a.leave_type_id = lt.id
                                  AND a.employee_id = $1 AND a.leave_year = $2
        WHERE lt.code IN ('CL','SL') ORDER BY lt.code`,
      [me.employeeId, LEAVE_YEAR]);

    const myAttendanceToday = await this.db.one(
      `SELECT status, worked_minutes, first_in_at
         FROM attendance_day WHERE employee_id = $1 AND business_date = fn_business_date()`,
      [me.employeeId]);

    const myOpenRequests = await this.db.rows(
      `SELECT r.id, lt.code AS type, r.from_date, r.to_date, r.working_days, r.status
         FROM leave_request r JOIN leave_type lt ON lt.id = r.leave_type_id
        WHERE r.employee_id = $1 AND r.status = 'pending' ORDER BY r.from_date`,
      [me.employeeId]);

    const myProjects = await this.db.rows(
      `SELECT p.code, p.name, pm.role
         FROM project_member pm JOIN project p ON p.id = pm.project_id
        WHERE pm.employee_id = $1 AND p.status = 'active' ORDER BY p.name`,
      [me.employeeId]);

    const todayEffort = await this.db.one(
      `SELECT coalesce(sum(wle.minutes), 0)::int AS minutes
         FROM work_log wl LEFT JOIN work_log_entry wle ON wle.work_log_id = wl.id
        WHERE wl.employee_id = $1 AND wl.work_date = fn_business_date()`,
      [me.employeeId]);

    const myMonth = await this.db.one(
      `SELECT count(*) FILTER (WHERE status IN ('present','late','wfh'))::int AS present,
              count(*) FILTER (WHERE status = 'late')::int                    AS late,
              count(*) FILTER (WHERE status = 'wfh')::int                     AS wfh,
              count(*) FILTER (WHERE status = 'absent')::int                  AS absent
         FROM attendance_day
        WHERE employee_id = $1
          AND business_date >= date_trunc('month', fn_business_date())`, [me.employeeId]);

    const myWeek = await this.db.one(
      `SELECT coalesce(sum(wle.minutes), 0)::int AS minutes
         FROM work_log wl
         JOIN work_log_entry wle ON wle.work_log_id = wl.id
        WHERE wl.employee_id = $1
          AND wl.work_date >= fn_business_date() - ((extract(isodow FROM fn_business_date()) - 1)::int)
          AND wl.work_date <= fn_business_date()`, [me.employeeId]);

    const upcomingHolidays = await this.db.rows(
      `SELECT holiday_on, name, is_optional FROM holiday
        WHERE holiday_on >= fn_business_date() ORDER BY holiday_on LIMIT 4`);

    const recentActivity = await this.db.rows(
      `SELECT * FROM (
         SELECT r.submitted_at AS at, e.full_name AS who,
                'applied for ' || r.working_days || ' day(s) ' || lt.code AS what
           FROM leave_request r JOIN employee e ON e.id = r.employee_id
           JOIN leave_type lt ON lt.id = r.leave_type_id
         UNION ALL
         SELECT r.decided_at, m.full_name,
                r.status || ' ' || e.full_name || '''s leave'
           FROM leave_request r JOIN employee e ON e.id = r.employee_id
           JOIN employee m ON m.id = r.decided_by WHERE r.decided_at IS NOT NULL
         UNION ALL
         SELECT tp.submitted_at, e.full_name, 'submitted a timesheet'
           FROM timesheet_period tp JOIN employee e ON e.id = tp.employee_id
          WHERE tp.submitted_at IS NOT NULL
       ) x WHERE at IS NOT NULL ORDER BY at DESC LIMIT 6`);

    return {
      actor: me,
      businessDate: (await this.db.one(`SELECT fn_business_date() AS d`))!.d,
      org,                       // null for an employee - see above
      isManager,
      pending: { leave: pendingLeave?.n ?? 0, timesheets: pendingTimesheets?.n ?? 0 },
      me: {
        balances: myBalances,
        attendanceToday: myAttendanceToday,
        openRequests: myOpenRequests,
        projects: myProjects,
        todayMinutes: todayEffort?.minutes ?? 0,
        month: myMonth,
        weekMinutes: myWeek?.minutes ?? 0,
      },
      upcomingHolidays,
      recentActivity,
    };
  }

  @Get('employees')
  @Authenticated()
  async employees(@Req() req: Request, @Query('q') q?: string) {
    /*
     * DOCUMENT COUNTS ARE INCLUDED ONLY IF THE POLICY SAYS SO.
     *
     * "How many documents does this person have" is not nothing - a count of MEDICAL
     * certificates is information about somebody's health even without the files. So the
     * decision is asked of `AuthorizationService` rather than written here as
     * `role === 'hr_admin'`, which is what Must-Know Rule 1 forbids.
     *
     * The ref carries no subject, so the documents policy resolves it the same way it resolves
     * any org-wide document listing: `isSelfAndNotRestricted` cannot be satisfied without a
     * subject, so an employee and a manager both get false, and hr_ops/hr_admin get true. The
     * answer falls out of the existing policy instead of needing a new rule.
     */
    const showDocumentCounts = (await this.authz.can(
      authContext(req), 'documents.document.list',
      { type: 'employee_document', dataClass: 'PERSONAL' })).allowed;

    /*
     * A SERVER-DRIVEN AFFORDANCE, like showDocumentCounts above it.
     *
     * The directory page has no business asking `hasRole(actor, 'hr_admin')` to decide whether to
     * show an Add button - that is an authorization decision outside packages/authz (Rule 1), and
     * it would drift from the endpoint the moment either changed. The policy is asked once, here,
     * and the answer travels with the data.
     */
    const canCreate = (await this.authz.can(
      authContext(req), 'people.employee.create', { type: 'employee' })).allowed;

    return {
      showDocumentCounts,
      canCreate,
      employees: await this.db.rows(
        `SELECT e.id, e.employee_number, e.full_name, e.work_email, e.joined_on, e.status,
                d.name AS department, g.name AS designation, m.full_name AS manager,
                CASE WHEN $2::boolean THEN (
                  SELECT count(*) FROM employee_document ed
                   WHERE ed.employee_id = e.id AND ed.withdrawn_at IS NULL)
                END AS document_count,
                CASE WHEN $2::boolean THEN (
                  SELECT count(*) FROM employee_document ed
                    JOIN employee_document_version ev ON ev.document_id = ed.id
                   WHERE ed.employee_id = e.id AND ed.withdrawn_at IS NULL
                     AND ed.current_version_id IS NULL AND ev.scan_status = 'pending')
                END AS pending_count,
                CASE WHEN $2::boolean THEN (
                  SELECT count(*) FROM employee_document ed
                   WHERE ed.employee_id = e.id AND ed.withdrawn_at IS NULL
                     AND ed.expires_on IS NOT NULL
                     AND ed.expires_on <= fn_business_date() + 60)
                END AS expiring_count
           FROM employee e
           LEFT JOIN employment em ON em.employee_id = e.id
                                  AND em.valid_period @> fn_business_date()
           LEFT JOIN department d ON d.id = em.department_id
           LEFT JOIN designation g ON g.id = em.designation_id
           LEFT JOIN employee m ON m.id = em.manager_id
          WHERE ($1::text IS NULL OR e.full_name ILIKE '%' || $1 || '%'
                                  OR e.employee_number ILIKE '%' || $1 || '%')
          ORDER BY e.employee_number`,
        [q?.trim() || null, showDocumentCounts]),
    };
  }

  /**
   * One employee's profile, including the effective-dated history.
   *
   * FIELD SELECTION IS AN ALLOWLIST, AND THAT IS NOT A STYLE PREFERENCE.
   *
   * This query used to be `SELECT e.*`. Migration 0014 added eleven personal columns to
   * `employee` - home address, personal email, emergency contact, blood group, exit reason -
   * and every one of them immediately began serialising to ANY authenticated caller, because
   * this route is `@Authenticated()` with no role restriction. Verified by logging in as a plain
   * employee and reading another employee's record: 35 fields came back, including their date of
   * birth, gender and personal phone.
   *
   * That is `ai/context/rbac-rules.md`'s field-mask requirement failing exactly the way it says
   * it fails - "a field with no entry in the field registry is never serialized" is the safe
   * direction precisely because `SELECT *` plus a new column is otherwise a silent disclosure.
   *
   * Until `packages/authz` provides the real central `fieldMask`, the mask here is an explicit
   * column list plus a SUBJECT check. Note what that check is NOT: it compares the caller to the
   * record's owner, not to a role, so it is not the inline role check Must-Know Rule 1 forbids.
   *
   * `hr_admin` deliberately does NOT get the personal block yet. HR legitimately needs it, but
   * granting it here would mean another inline role check, and default-deny is the direction to
   * fail in. It arrives with the real field mask.
   */
  @Get('employees/:id')
  @Authenticated()
  async employee(@Param('id') id: string, @Req() req: Request) {
    const me = currentActor(req);
    const isSelf = me.employeeId === id;

    const employee = await this.db.one(
      // PUBLIC_INTERNAL only. Everything a colleague has a working reason to see.
      `SELECT e.id, e.employee_number, e.full_name, e.work_email,
              e.joined_on, e.status, e.confirmed_on,
              d.name AS department, g.name AS designation, m.full_name AS manager,
              em.work_location, em.employment_type, em.valid_from AS assignment_since
         FROM employee e
         LEFT JOIN employment em ON em.employee_id = e.id
                                AND em.valid_period @> fn_business_date()
         LEFT JOIN department d ON d.id = em.department_id
         LEFT JOIN designation g ON g.id = em.designation_id
         LEFT JOIN employee m ON m.id = em.manager_id
        WHERE e.id = $1`, [id]);
    if (!employee) throw new NotFoundException('No such employee');

    /*
     * PERSONAL / SENSITIVE. Closes OR-18.
     *
     * This used to be `isSelf ? ... : null` - a deliberate default-deny taken when
     * `packages/authz` had no field mask, and recorded in DEC-036 as "revisit when fieldMask
     * ships". It has shipped, so the interim is replaced by the thing it was standing in for:
     * the POLICY decides who may ask, and the default-deny FIELD REGISTRY decides which columns
     * come back. HR is no longer worse off than a spreadsheet, and nothing here compares a role.
     *
     * `maskRow` is doing real work rather than rubber-stamping the query. The registry classes
     * `emergency_contact_*` and `blood_group` as SELF_ONLY, so HR gets the address and the date
     * of birth it needs and still does not get those: the emergency contact is THIRD-PARTY data
     * about somebody who never consented and has no relationship with this company, and the
     * blood group is health data with no stated purpose (DEC-035, OR-16). Widening the query
     * without widening the registry therefore changes nothing, which is the direction a mistake
     * should fail in.
     */
    const ctx = authContext(req);
    const mayReadPersonal = (await this.authz.can(ctx, 'people.employee.personal.read', {
      type: 'employee', id, subjectEmployeeId: id,
    })).allowed;

    const personalRow = mayReadPersonal
      ? await this.db.one(
          `SELECT e.date_of_birth, e.gender, e.personal_phone, e.personal_email,
                  e.address_line1, e.address_line2, e.city, e.state_region, e.postal_code,
                  e.emergency_contact_name, e.emergency_contact_phone,
                  e.emergency_contact_relation, e.blood_group,
                  e.probation_end_on, e.resigned_on, e.notice_days, e.last_working_day,
                  e.exited_on, e.exit_type
             FROM employee e WHERE e.id = $1`, [id])
      : null;

    const personal = personalRow
      ? this.authz.maskRow(ctx, 'employee', personalRow, { isSubject: isSelf })
      : null;

    // Reading somebody else's personal record is itself the disclosure, so it is recorded. The
    // policy attaches an `audit_read` obligation to exactly this action for hr_ops.
    if (personalRow && !isSelf) {
      await this.db.rows(
        `INSERT INTO audit_event (source, event_type, actor_kind, actor_user_id,
                                  actor_employee_id, actor_roles, subject_employee_id,
                                  subject_type, session_id, table_name, field_classes)
         VALUES ('application', 'people.employee.personal.read', 'user', $1, $2, $3, $4,
                 'employee', $5, 'employee', ARRAY['PERSONAL','SENSITIVE'])`,
        [me.userId, me.employeeId, me.roles, id, me.sessionId]).catch(() => undefined);
    }

    /*
     * The lifecycle log (migration 0014). An exit event's `reason` is RESTRICTED and may describe
     * conduct, performance or health - so it follows `people.lifecycle.read` rather than an id
     * comparison. That admits the subject and HR, and the ancestor deny-override still keeps an
     * HR admin out of their own chain of command.
     */
    const mayReadLifecycle = (await this.authz.can(ctx, 'people.lifecycle.read', {
      type: 'employee', id, subjectEmployeeId: id,
    })).allowed;

    const lifecycle = mayReadLifecycle
      ? await this.db.rows(
          `SELECT ee.event_type, ee.effective_on, ee.from_status, ee.to_status,
                  ee.last_working_day, ee.exit_type, ee.reason, ee.recorded_at
             FROM employment_event ee
            WHERE ee.employee_id = $1
            ORDER BY ee.effective_on DESC, ee.recorded_at DESC`, [id])
      : [];

    // THE point of effective dating: the whole assignment history, not just today's row.
    const history = await this.db.rows(
      `SELECT em.valid_from, em.valid_to, d.name AS department, g.name AS designation,
              m.full_name AS manager, em.reason
         FROM employment em
         LEFT JOIN department d ON d.id = em.department_id
         LEFT JOIN designation g ON g.id = em.designation_id
         LEFT JOIN employee m ON m.id = em.manager_id
        WHERE em.employee_id = $1 ORDER BY em.valid_from DESC`, [id]);

    const balances = await this.db.rows(
      `SELECT lt.code, coalesce(a.available, 0) AS available, coalesce(a.taken, 0) AS taken
         FROM leave_type lt
         LEFT JOIN leave_account a ON a.leave_type_id = lt.id
                                  AND a.employee_id = $1 AND a.leave_year = $2
        WHERE lt.archived_at IS NULL ORDER BY lt.display_order, lt.code`, [id, LEAVE_YEAR]);

    const attendance = await this.db.one(
      `SELECT count(*) FILTER (WHERE status IN ('present','late')) AS present,
              count(*) FILTER (WHERE status = 'wfh')               AS wfh,
              count(*) FILTER (WHERE status = 'late')              AS late,
              count(*) FILTER (WHERE status = 'absent')            AS absent
         FROM attendance_day
        WHERE employee_id = $1 AND business_date >= date_trunc('month', fn_business_date())`, [id]);

    const projects = await this.db.rows(
      `SELECT p.code, p.name, pm.role FROM project_member pm
         JOIN project p ON p.id = pm.project_id WHERE pm.employee_id = $1 ORDER BY p.name`, [id]);

    return {
      employee, history, balances, attendanceThisMonth: attendance, projects,
      isSelf, personal, lifecycle,
    };
  }
}

@Module({ controllers: [HrController] })
export class HrModule {}
