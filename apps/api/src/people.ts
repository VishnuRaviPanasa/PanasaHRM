import {
  BadRequestException, Body, Controller, Module, NotFoundException, Param, Patch, Post, Req,
} from '@nestjs/common';
import { AuthzDeniedError, type Action } from '@panasa/authz';
import type { Request } from 'express';
import { Authenticated, currentActor } from './auth';
import { Authz, authContext } from './authz';
import { Db } from './db';

/**
 * The employee master: creating people, editing their details, and moving them.
 *
 * THREE ENDPOINTS BECAUSE THERE ARE THREE DIFFERENT ACTS, not because REST wanted them.
 *
 *   create      `people.employee.create`   - HR only
 *   update      `people.employee.update`   - the subject OR HR, never up your own chain
 *   assignment  `people.assignment.change` - HR only, and NEVER on yourself
 *
 * The last one is the interesting one. Its policy carries `isSelf` as a DENY-OVERRIDE - "nobody
 * transitions their own employment" - so an HR admin cannot promote themselves or move themselves
 * into another department, whatever else they hold. That is not a rule this file invents or could
 * forget; it is in `packages/authz` and asserted by the matrix.
 *
 * MOVING SOMEBODY IS NOT AN EDIT (Must-Know Rule 3). A transfer, a promotion and a manager change
 * are all the same mechanical act: close the employment period in force and open a new one. Last
 * quarter's report keeps resolving to last quarter's department, which is the entire reason the
 * table is effective-dated. `ex_employment_no_overlap` refuses anything else, so the endpoint
 * cannot get this wrong even by accident.
 *
 * WHAT MAY BE WRITTEN IS DERIVED FROM WHAT MAY BE READ. `update` runs every incoming field through
 * the field registry's mask and refuses any the caller cannot see. A caller who is not allowed to
 * READ somebody's blood group has no business setting it, and deriving the write list from the
 * read list means the two can never drift - rather than maintaining a second allowlist that
 * somebody will eventually widen on its own.
 */

const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);

const isoDate = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

const clientIp = (req: Request): string | null => {
  const raw = (req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
  return raw && raw !== '::1' ? raw : null;
};

/** The columns `update` will consider. Anything not here is not writable by anybody. */
const EDITABLE = [
  'full_name', 'work_email',
  'date_of_birth', 'gender', 'personal_phone', 'personal_email',
  'address_line1', 'address_line2', 'city', 'state_region', 'postal_code',
  'emergency_contact_name', 'emergency_contact_phone', 'emergency_contact_relation',
  'blood_group',
] as const;

function explain(e: unknown): never {
  const msg = (e as Error)?.message ?? '';
  const map: [RegExp, string][] = [
    [/ex_employment_no_overlap/,
      'That employee already has an assignment covering this date. '
      + 'The change must take effect after the current one begins.'],
    [/employee_employee_number_key|duplicate key.*employee_number/,
      'That employee number is already in use.'],
    [/employee_work_email_key|duplicate key.*work_email/,
      'That work email address is already in use.'],
    [/was retired on/, msg],
    [/may not be modified in place/,
      'History cannot be edited. Record a new assignment instead of changing the old one.'],
    [/back-dat/i, 'This cannot take effect in the past. Choose today or a future date.'],
    [/not_self_managed|ck_employment_not_self/, 'Somebody cannot be their own manager.'],
    [/violates foreign key/, 'That department, designation or manager does not exist.'],
    [/before the joining date|effective before/, msg],
    [/isempty|NOT isempty/,
      'The current assignment already starts on this date, so closing it here would leave a '
      + 'period covering no days. Choose a later effective date.'],
    [/violates check constraint/, msg],
  ];
  for (const [re, text] of map) if (re.test(msg)) throw new BadRequestException(text);
  throw new BadRequestException(msg || 'That change could not be saved.');
}

@Controller('people')
export class PeopleController {
  constructor(private readonly db: Db, private readonly authz: Authz) {}

  private async gate(req: Request, action: Action, subjectEmployeeId?: string) {
    const ctx = authContext(req);
    try {
      await this.authz.assertCan(ctx, action, {
        type: 'employee',
        ...(subjectEmployeeId ? { id: subjectEmployeeId, subjectEmployeeId } : {}),
      });
    } catch (e) {
      if (e instanceof AuthzDeniedError) throw new NotFoundException('Not found');
      throw e;
    }
    return ctx;
  }

  private async audit(eventType: string, subject: string, req: Request, after: unknown) {
    const me = currentActor(req);
    await this.db.rows(
      `INSERT INTO audit_event (source, event_type, actor_kind, actor_user_id, actor_employee_id,
                                actor_roles, subject_employee_id, subject_type, session_id,
                                source_ip, row_pk, table_name, field_classes, after)
       VALUES ('application', $1, 'user', $2, $3, $4, $5, 'employee', $6, $7, $5, 'employee',
               ARRAY['PERSONAL'], $8::jsonb)`,
      [eventType, me.userId, me.employeeId, me.roles, subject, me.sessionId, clientIp(req),
        JSON.stringify(after)]).catch((e) => {
      // eslint-disable-next-line no-console
      console.error('PEOPLE AUDIT WRITE FAILED', eventType, (e as Error).message);
    });
  }

  // =========================================================================
  /**
   * Create an employee.
   *
   * THREE ROWS IN ONE TRANSACTION, because a person who exists with no job and no history is not
   * a record of anything:
   *
   *   `employee`         who they are
   *   `employment`       what their job is, effective-dated from the joining date
   *   `employment_event` that they JOINED, which is what moves the status off `pre_boarding`
   *
   * The event is the part that is easy to leave out and impossible to reconstruct later. 0015
   * derives every cached lifecycle column from that log as of the business date, so a joining
   * event dated in the future correctly leaves the employee `pre_boarding` until the day arrives -
   * which is how a notice-period hire is meant to look.
   */
  @Post('employees')
  @Authenticated()
  async create(@Req() req: Request, @Body() body: {
    employeeNumber?: string; fullName?: string; workEmail?: string; joinedOn?: string;
    departmentId?: string; designationId?: string; managerId?: string | null;
    workLocation?: string; employmentType?: string;
  }) {
    await this.gate(req, 'people.employee.create');

    const number = String(body?.employeeNumber ?? '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9-]{2,15}$/.test(number)) {
      throw new BadRequestException(
        'Employee number must be 3-16 characters, starting with a letter');
    }
    const fullName = String(body?.fullName ?? '').trim().replace(/\s+/g, ' ');
    if (fullName.length < 2 || fullName.length > 120) {
      throw new BadRequestException('Full name must be between 2 and 120 characters');
    }
    const workEmail = String(body?.workEmail ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(workEmail)) {
      throw new BadRequestException('A valid work email address is required');
    }
    const joinedOn = isoDate(body?.joinedOn);
    if (!joinedOn) throw new BadRequestException('A joining date is required (YYYY-MM-DD)');
    if (!isUuid(body?.departmentId)) throw new BadRequestException('Choose a department');
    if (!isUuid(body?.designationId)) throw new BadRequestException('Choose a designation');
    const managerId = isUuid(body?.managerId) ? body.managerId : null;

    try {
      const id = await this.db.tx(async (q) => {
        // A joining date in the past is ordinary - somebody is entered a week after they start -
        // so the effective-dated rail is opted past explicitly rather than the date being refused.
        await q(`SET LOCAL hrm.allow_backdated_period = 'on'`);

        const created = await q(
          `INSERT INTO employee (employee_number, full_name, work_email, joined_on, status)
           VALUES ($1, $2, $3, $4, 'pre_boarding') RETURNING id`,
          [number, fullName, workEmail, joinedOn]);
        const newId = created[0].id as string;

        await q(
          `INSERT INTO employment (employee_id, department_id, designation_id, manager_id,
                                   work_location, employment_type, valid_from, reason)
           VALUES ($1, $2, $3, $4, COALESCE($5, 'Kochi'), COALESCE($6, 'permanent'), $7, 'joined')`,
          [newId, body.departmentId, body.designationId, managerId,
            body?.workLocation ? String(body.workLocation).slice(0, 80) : null,
            body?.employmentType ? String(body.employmentType).slice(0, 40) : null,
            joinedOn]);

        // The lifecycle event. `pre_boarding -> active` is the only legal move here and the FSM
        // transition table proves it, so an invented status cannot be written.
        await q(
          `INSERT INTO employment_event
             (employee_id, event_type, from_status, to_status, effective_on, reason)
           VALUES ($1, 'joined', 'pre_boarding', 'active', $2, 'created through the employee master')`,
          [newId, joinedOn]);

        return newId;
      });

      await this.audit('people.employee.created', id, req,
        { employee_number: number, joined_on: joinedOn });
      return { id, employeeNumber: number };
    } catch (e) { explain(e); }
  }

  // =========================================================================
  /**
   * Edit identity and personal details.
   *
   * The writable set is computed from the READ mask, so it narrows automatically with the caller:
   * an employee may set their own emergency contact and blood group, HR may not (those are
   * SELF_ONLY in the registry - third-party data and health data, DEC-035). Sending a field the
   * caller cannot see is refused loudly rather than dropped silently, because a form that
   * appeared to save something and did not is worse than one that said no.
   */
  @Patch('employees/:id')
  @Authenticated()
  async update(@Req() req: Request, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    if (!isUuid(id)) throw new NotFoundException('Not found');
    const ctx = await this.gate(req, 'people.employee.update', id);
    const me = currentActor(req);

    const exists = await this.db.one(`SELECT employee_number FROM employee WHERE id = $1`, [id]);
    if (!exists) throw new NotFoundException('Not found');

    // What this caller may SEE on this record - and therefore what they may set.
    const probe = Object.fromEntries(EDITABLE.map((f) => [f, null]));
    const visible = this.authz.maskRow(ctx, 'employee', probe, {
      isSubject: ctx.employeeId === id,
    });

    const sets: string[] = [];
    const params: unknown[] = [id];
    const refused: string[] = [];
    const changed: string[] = [];

    for (const field of EDITABLE) {
      if (!(field in body)) continue;
      if (!(field in visible)) { refused.push(field); continue; }
      const raw = body[field];
      const value = raw === null || raw === '' ? null : String(raw).trim().slice(0, 200);
      params.push(value);
      sets.push(`${field} = $${params.length}`);
      changed.push(field);
    }

    if (refused.length > 0) {
      throw new BadRequestException(
        `You cannot set ${refused.join(', ')} on this record. `
        + 'Those fields belong to the employee themselves.');
    }
    if (sets.length === 0) throw new BadRequestException('Nothing to change.');

    try {
      await this.db.rows(
        `UPDATE employee SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
    } catch (e) { explain(e); }

    // The FIELD NAMES, never the values. `audit_event` is append-only with decade retention, so
    // recording the new home address there would create a second permanent copy of it.
    await this.audit('people.employee.updated', id, req,
      { fields: changed, by: me.employeeId === id ? 'self' : 'hr' });
    return { ok: true, changed };
  }

  // =========================================================================
  /**
   * Move somebody: transfer, promotion, or a change of line manager.
   *
   * All three are one act - close the current employment period, open the next - and the endpoint
   * says so rather than offering three verbs that do the same thing. What distinguishes a
   * promotion from a transfer is which column differs, and the `reason` is what makes it legible
   * to whoever reads the history later, so it is required.
   */
  @Post('employees/:id/assignment')
  @Authenticated()
  async assign(@Req() req: Request, @Param('id') id: string, @Body() body: {
    departmentId?: string; designationId?: string; managerId?: string | null;
    workLocation?: string; employmentType?: string; effectiveFrom?: string; reason?: string;
  }) {
    if (!isUuid(id)) throw new NotFoundException('Not found');
    // The policy's `isSelf` deny-override refuses this for your own record, so an HR admin cannot
    // promote themselves. It is enforced in `packages/authz`, not here.
    await this.gate(req, 'people.assignment.change', id);

    const current = await this.db.one(
      `SELECT em.department_id, em.designation_id, em.manager_id, em.work_location,
              em.employment_type, em.valid_from, e.employee_number, e.joined_on
         FROM employee e
         LEFT JOIN employment em ON em.employee_id = e.id
                                AND em.valid_period @> fn_business_date()
        WHERE e.id = $1`, [id]);
    if (!current) throw new NotFoundException('Not found');

    const reason = String(body?.reason ?? '').trim();
    if (reason.length < 3) {
      throw new BadRequestException(
        'Record why this is changing - a transfer without a reason is unexplainable later');
    }
    const from = isoDate(body?.effectiveFrom);
    if (!from) throw new BadRequestException('An effective date is required (YYYY-MM-DD)');

    const next = {
      departmentId: isUuid(body?.departmentId) ? body.departmentId : current.department_id,
      designationId: isUuid(body?.designationId) ? body.designationId : current.designation_id,
      managerId: body?.managerId === null ? null
        : isUuid(body?.managerId) ? body.managerId : current.manager_id,
      workLocation: body?.workLocation ? String(body.workLocation).slice(0, 80)
        : current.work_location,
      employmentType: body?.employmentType ? String(body.employmentType).slice(0, 40)
        : current.employment_type,
    };

    if (next.managerId === id) throw new BadRequestException('Somebody cannot be their own manager.');

    // Nothing actually differs - refuse rather than write a period that records no change, which
    // would clutter the history with a transfer that never happened.
    const same = next.departmentId === current.department_id
      && next.designationId === current.designation_id
      && next.managerId === current.manager_id
      && next.workLocation === current.work_location
      && next.employmentType === current.employment_type;
    if (same) throw new BadRequestException('Nothing would change in this assignment.');

    try {
      await this.db.tx(async (q) => {
        if (current.valid_from) {
          await q(
            `UPDATE employment SET valid_to = $2::date
              WHERE employee_id = $1 AND valid_to IS NULL`, [id, from]);
        }
        await q(
          `INSERT INTO employment (employee_id, department_id, designation_id, manager_id,
                                   work_location, employment_type, valid_from, reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8)`,
          [id, next.departmentId, next.designationId, next.managerId,
            next.workLocation, next.employmentType, from, reason.slice(0, 500)]);
      });
    } catch (e) { explain(e); }

    await this.audit('people.assignment.changed', id, req,
      { effective_from: from, reason: reason.slice(0, 200) });
    return { ok: true, effectiveFrom: from };
  }
}

@Module({ controllers: [PeopleController] })
export class PeopleModule {}
