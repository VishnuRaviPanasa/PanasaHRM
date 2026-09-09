import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Module, Param, Patch, Post,
  Query, Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthzDeniedError } from '@panasa/authz';
import { NotFoundException } from '@nestjs/common';
import { Authenticated, currentActor } from './auth';
import { Authz, authContext } from './authz';
import { Db } from './db';

/**
 * The company settings surface. Two classes of configuration, per ADR-0019:
 *
 *   POLICY   is effective-dated. A change does not update a row - it closes the current period
 *            and inserts a new one. There is no "save", only "change with effect from", because
 *            changing a threshold retroactively silently rewrites attendance that has already
 *            been computed and possibly paid.
 *
 *   SETTINGS are mutable. Nothing computes history from them, so a plain edit is correct.
 *
 * The Rule 3 perimeter (migrations 0004/0005) enforces this at the database level: an in-place
 * UPDATE of a policy value is refused, and so is a back-dated period unless the caller opts in
 * deliberately. This controller therefore has to do it the sanctioned way, which is the point.
 *
 * RETROFITTED ONTO `packages/authz` (OR-19). It previously carried
 * `@Authenticated('hr_admin', 'manager')`, which let a MANAGER read company policy - and
 * `authz-matrix.yaml` had said `manager: deny` for `config.policy.read` all along. The matrix was
 * right and the route was wrong: ADR-0005 amendment (a) makes these tables organisation-scoped,
 * "denied by default, reachable only by an explicit administrative permission", because a policy
 * row is a historical derivation input and reading one is a privilege rather than a default.
 *
 * `@Authenticated()` remains with NO roles - it establishes the session and populates the actor.
 * It grants nothing. Every decision below goes through `AuthorizationService`.
 *
 * TRACK B: the requirements call for step-up re-auth on any policy change and an alert on a
 * back-dated one. `requireStepUp` is decided by no ADR yet (recorded in the pass-1 report), so
 * the demo enforces hr_admin only. Policy changes should also emit a domain event so a recompute
 * can be scheduled - the outbox exists, the drain worker does not.
 */

const ATTENDANCE_FIELDS = [
  'grace_period_minutes', 'half_day_min_minutes', 'full_day_min_minutes',
  'standard_day_minutes', 'ot_enabled', 'ot_min_minutes',
] as const;

const EMPLOYMENT_FIELDS = [
  'notice_period_days', 'probation_months', 'cl_blocked_in_notice', 'sl_extends_notice',
  'salary_disbursement_day', 'probation_accrual_method', 'confirmation_topup_timing',
] as const;

type PolicyKind = 'attendance' | 'employment';

const TABLE: Record<PolicyKind, string> = {
  attendance: 'attendance_policy',
  employment: 'employment_policy',
};
const FIELDS: Record<PolicyKind, readonly string[]> = {
  attendance: ATTENDANCE_FIELDS,
  employment: EMPLOYMENT_FIELDS,
};

@Controller('settings')
export class SettingsController {
  constructor(private readonly db: Db, private readonly authz: Authz) {}

  private static assertKind(kind: string): PolicyKind {
    if (kind !== 'attendance' && kind !== 'employment') {
      throw new BadRequestException('Unknown policy. Use attendance or employment.');
    }
    return kind;
  }

  /** Everything the screen needs in one round trip. */
  /**
   * Policy and settings are ORGANISATION-scoped, so a denial does not reveal a record's
   * existence the way a per-employee 404 would - the endpoint's existence is not a secret.
   * `notFoundOnDeny: false` therefore gives an honest 403 rather than pretending the settings
   * screen is not there.
   */
  private async assert(req: Request, action: 'config.setting.read' | 'config.policy.read'
    | 'config.setting.write' | 'config.policy.write') {
    try {
      await this.authz.assertCan(authContext(req), action,
        { type: 'org_config' }, { notFoundOnDeny: false });
    } catch (e) {
      if (e instanceof AuthzDeniedError) {
        // The message has to match the ACTION. A write denial saying "cannot view" sends the
        // reader looking for the wrong problem.
        const verb = action.endsWith('.write') ? 'change' : 'view';
        throw e.httpStatus === 404
          ? new NotFoundException('Not found')
          : new ForbiddenException(`Only HR can ${verb} company settings`);
      }
      throw e;
    }
  }

  @Get()
  @Authenticated()
  async all(@Req() req: Request) {
    await this.assert(req, 'config.setting.read');
    const [businessDate] = await this.db.rows(`SELECT fn_business_date()::text AS d`);

    const attendance = await this.db.one(
      `SELECT * FROM attendance_policy WHERE valid_period @> fn_business_date() LIMIT 1`);
    const employment = await this.db.one(
      `SELECT * FROM employment_policy WHERE valid_period @> fn_business_date() LIMIT 1`);

    const settings = await this.db.rows(
      `SELECT key, value, value_type, category, label, description, updated_at
         FROM org_setting WHERE NOT is_secret ORDER BY category, key`);

    // Leave policy is shown read-only here: leave TYPES are a collection with their own admin
    // screen, not a scalar setting (requirements, "out of scope").
    const leave = await this.db.rows(
      `SELECT lt.code, lt.name,
              p.entitlement_days_confirmed, p.entitlement_days_probation,
              p.period_cap_days, p.period_cap_months, p.period_cap_enforcement,
              p.carry_forward_enabled, p.carry_forward_max_days, p.carry_forward_expiry_months,
              p.sandwich_rule, p.advance_notice_days, p.allow_backdated_days,
              p.lot_validity_months, p.lot_expiry_basis,
              p.valid_from, p.unconfirmed_fields
         FROM leave_type lt
         JOIN leave_policy p ON p.leave_type_id = lt.id AND p.valid_period @> fn_business_date()
        WHERE lt.archived_at IS NULL
        ORDER BY lt.display_order, lt.code`);

    const badgedCount =
      (attendance?.unconfirmed_fields?.length ?? 0) +
      (employment?.unconfirmed_fields?.length ?? 0) +
      leave.reduce((s, l) => s + (l.unconfirmed_fields?.length ?? 0), 0);

    return { businessDate: businessDate.d, attendance, employment, settings, leave, badgedCount };
  }

  /** Version history for one policy. This is what answers "why was I marked half-day in March". */
  @Get('policy/:kind/history')
  @Authenticated()
  async history(@Req() req: Request, @Param('kind') kindRaw: string) {
    await this.assert(req, 'config.policy.read');
    const kind = SettingsController.assertKind(kindRaw);
    // Every policy column is qualified with `p.`: the join to `employee` brings its own `id`
    // and `created_at`, so a bare `id` is ambiguous and Postgres rejects the whole query.
    const cols = FIELDS[kind].map((f) => `p.${f}`).join(', ');
    return {
      kind,
      versions: await this.db.rows(
        `SELECT p.id, ${cols}, p.valid_from, p.valid_to, p.reason, p.created_at,
                p.unconfirmed_fields, e.full_name AS created_by_name
           FROM ${TABLE[kind]} p
           LEFT JOIN employee e ON e.id = p.created_by_user_id
          ORDER BY p.valid_from DESC`),
    };
  }

  /**
   * The blast radius. Requirement 2: HR cannot tell a harmless change from a payroll incident
   * without being told what it touches.
   */
  @Get('policy/:kind/impact')
  @Authenticated()
  async impact(
    @Req() req: Request, @Param('kind') kindRaw: string, @Query('from') from?: string,
  ) {
    await this.assert(req, 'config.policy.read');
    SettingsController.assertKind(kindRaw);
    if (!from) throw new BadRequestException('from is required');

    const [today] = await this.db.rows(`SELECT fn_business_date()::text AS d`);
    const backdated = from < today.d;

    const counts = await this.db.one(
      `SELECT count(*)::int                              AS attendance_days,
              count(DISTINCT employee_id)::int           AS employees
         FROM attendance_day WHERE business_date >= $1::date`, [from]);

    // A locked payroll period would produce adjustments rather than in-place changes
    // (ADR-0011). Payroll does not exist yet, so this is honestly reported as zero rather than
    // invented - saying "0 locked" is true; implying the check is wired would not be.
    return {
      from,
      businessDate: today.d,
      backdated,
      attendanceDays: counts?.attendance_days ?? 0,
      employees: counts?.employees ?? 0,
      lockedPeriodDays: 0,
      payrollLockingImplemented: false,
      reasonRequired: backdated,
    };
  }

  /**
   * Change with effect from. NOT an update.
   *
   * Closes the period in force and inserts a successor, in one transaction. Both halves are
   * adjudicated by the Rule 3 trigger, so a bad request fails at the database rather than here.
   */
  @Post('policy/:kind')
  @Authenticated()
  async changePolicy(@Req() req: Request, @Param('kind') kindRaw: string,
                     @Body() body: { effectiveFrom?: string; reason?: string; values?: Record<string, unknown> }) {
    await this.assert(req, 'config.policy.write');
    const kind = SettingsController.assertKind(kindRaw);
    const me = currentActor(req);
    const table = TABLE[kind];
    const allowed = FIELDS[kind];

    const effectiveFrom = body?.effectiveFrom;
    if (!effectiveFrom) throw new BadRequestException('An effective date is required');

    const values = body?.values ?? {};
    const keys = Object.keys(values).filter((k) => allowed.includes(k));
    if (keys.length === 0) throw new BadRequestException('No recognised fields to change');

    return this.db.tx(async (q) => {
      const [today] = await q(`SELECT fn_business_date()::text AS d`);
      const backdated = effectiveFrom < today.d;
      if (backdated && !body?.reason?.trim()) {
        throw new BadRequestException('A reason is required for a back-dated policy change');
      }

      const [current] = await q(
        `SELECT * FROM ${table} WHERE valid_period @> $1::date LIMIT 1`, [effectiveFrom]);
      if (!current) {
        throw new BadRequestException(
          `No policy is in force on ${effectiveFrom}, so there is nothing to supersede. ` +
          `The policy epoch starts 2020-01-01.`);
      }
      if (current.valid_from === effectiveFrom) {
        throw new BadRequestException(
          `A policy period already starts on ${effectiveFrom}. Pick a different effective date — ` +
          `a historical period cannot be edited in place (Must-Know Rule 3).`);
      }

      // The successor carries forward everything not being changed, so a change to one field
      // never silently resets another.
      const next: Record<string, unknown> = {};
      for (const f of allowed) next[f] = current[f];
      for (const k of keys) next[k] = values[k];

      // Confirming a value removes its "unconfirmed" badge (DEC-020). A human has now looked
      // at it, which is the entire purpose of the badge.
      const stillUnconfirmed = (current.unconfirmed_fields ?? []).filter((f: string) => !keys.includes(f));

      if (backdated) {
        // Deliberate, greppable opt-in (DEC-029) rather than a silent bypass.
        await q(`SET LOCAL hrm.allow_backdated_period = 'on'`);
      }

      let closed;
      try {
        [closed] = await q(
          `UPDATE ${table} SET valid_to = $2, reason = coalesce($3, reason)
            WHERE id = $1 RETURNING id`,
          [current.id, effectiveFrom, body?.reason ?? null]);
      } catch (e: any) {
        if (e?.code === '23001') {
          throw new BadRequestException(
            `That date would rewrite history rather than end the current period. ${e.message}`);
        }
        throw e;
      }

      const cols = allowed.join(', ');
      const params = allowed.map((f) => next[f]);
      const placeholders = allowed.map((_, i) => `$${i + 1}`).join(', ');

      let inserted;
      try {
        [inserted] = await q(
          `INSERT INTO ${table} (${cols}, unconfirmed_fields, valid_from, reason, created_by_user_id)
           VALUES (${placeholders}, $${allowed.length + 1}, $${allowed.length + 2},
                   $${allowed.length + 3}, $${allowed.length + 4})
           RETURNING id, valid_from`,
          [...params, stillUnconfirmed, effectiveFrom, body?.reason ?? null, me.employeeId]);
      } catch (e: any) {
        // The database is what makes a bad configuration impossible; give its message through.
        if (e?.code === '23514') {
          throw new BadRequestException(
            `The database refused this combination: ${e.constraint ?? ''}. ${e.message}`);
        }
        if (e?.code === '23P01') {
          throw new BadRequestException('That effective date overlaps an existing policy period.');
        }
        throw e;
      }

      return {
        closed: closed.id,
        created: inserted.id,
        effectiveFrom: inserted.valid_from,
        changed: keys,
        confirmed: keys.filter((k) => (current.unconfirmed_fields ?? []).includes(k)),
      };
    });
  }

  /** A mutable setting. Plain edit - nothing computes history from these (ADR-0019 Class 2). */
  @Patch(':key')
  @Authenticated()
  async updateSetting(@Req() req: Request, @Param('key') key: string,
                      @Body() body: { value?: unknown }) {
    await this.assert(req, 'config.setting.write');
    const me = currentActor(req);
    const existing = await this.db.one(
      `SELECT key, value_type, is_secret FROM org_setting WHERE key = $1`, [key]);
    if (!existing) throw new BadRequestException('No such setting');
    if (existing.is_secret) throw new BadRequestException('That setting cannot be edited here');

    let value = body?.value;
    if (existing.value_type === 'boolean') value = Boolean(value);
    if (existing.value_type === 'string') {
      value = String(value ?? '').trim();
      if (!value) throw new BadRequestException('A value is required');
    }

    const updated = await this.db.one(
      `UPDATE org_setting SET value = $2::jsonb, updated_by_user_id = $3
        WHERE key = $1 RETURNING key, value, updated_at`,
      [key, JSON.stringify(value), me.employeeId]);

    return { setting: updated };
  }
}

@Module({ controllers: [SettingsController] })
export class SettingsModule {}
