import {
  BadRequestException, Body, Controller, Get, Module, NotFoundException, Param, Patch, Post, Query,
  Req,
} from '@nestjs/common';
import { AuthzDeniedError, type Action } from '@panasa/authz';
import type { Request } from 'express';
import { Authenticated, currentActor } from './auth';
import { Authz, authContext } from './authz';
import { Db } from './db';
import { toPaise } from './payroll';

/**
 * Onboarding: the salary annexure, its two approvals, and the offer letter.
 *
 * THE CHAIN. HR prepares an annexure for somebody in `pre_boarding`, the finance head approves the
 * money, the delivery head approves the hire, HR issues the offer letter, and the person accepts
 * or declines. Accepting is what lets the existing `joined` lifecycle event run; declining moves
 * them to `offer_declined`, the terminal state migration 0031 added.
 *
 * FOUR ACTIONS, NOT ONE, AND THIS FILE DECIDES NONE OF THEM. `onboarding.annexure.write`,
 * `.approve_finance`, `.approve_delivery` and `onboarding.offer.manage` are separate because they
 * are four acts by three people; `hr_admin` is denied both approvals because they typed the
 * figures, and an approval by the author is not an approval. All of that lives in
 * `packages/authz` (Must-Know Rule 1) and is asserted by 413 matrix cells.
 *
 * THE DATABASE IS THE REAL GATE, NOT THIS CONTROLLER. Every move is an INSERT into
 * `salary_annexure_event`, which carries a composite foreign key onto the whole
 * (event_type, from_status, to_status) triple - so a move nobody designed is refused by Postgres
 * whatever this file does. The trigger on that table also re-reads the current status `FOR UPDATE`
 * and refuses an event whose `from_status` is stale, which is what makes two approvers clicking at
 * once safe rather than last-write-wins. This controller's job is to be a readable front for those
 * rails and to say what went wrong in English.
 *
 * NOTHING IS CALCULATED. ADR-0012 is BLOCKED, so no statutory or gross-to-net computation may
 * exist. Components are entered; the total is a SUM of what was typed; and the annual CTC is typed
 * a second time and must agree with that sum before the annexure may go to finance - the same
 * reconciliation 0024 uses for payslips, because a component out by a factor of ten is silent
 * otherwise and is the number the offer letter will carry.
 */

const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);

const isoDate = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

/** The decisions this controller can record, and the transition each one is. */
const MOVES = {
  submit: { from: 'draft', to: 'finance_review' },
  finance_approve: { from: 'finance_review', to: 'delivery_review' },
  finance_reject: { from: 'finance_review', to: 'draft' },
  delivery_approve: { from: 'delivery_review', to: 'delivery_approved' },
  delivery_reject: { from: 'delivery_review', to: 'draft' },
  issue_offer: { from: 'delivery_approved', to: 'offer_issued' },
  accept_offer: { from: 'offer_issued', to: 'offer_accepted' },
  decline_offer: { from: 'offer_issued', to: 'offer_declined' },
  withdraw: { from: null, to: 'withdrawn' },
} as const;
type Move = keyof typeof MOVES;

const REASON_REQUIRED: Move[] = ['finance_reject', 'delivery_reject', 'withdraw', 'decline_offer'];

interface ComponentIn { kind?: string; code?: string; label?: string; amount?: string }

@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly db: Db, private readonly authz: Authz) {}

  private async gate(req: Request, action: Action, subjectEmployeeId?: string) {
    const ctx = authContext(req);
    try {
      await this.authz.assertCan(ctx, action, {
        type: 'salary_annexure',
        ...(subjectEmployeeId ? { subjectEmployeeId } : {}),
      });
    } catch (e) {
      if (e instanceof AuthzDeniedError) throw new NotFoundException('Not found');
      throw e;
    }
    return ctx;
  }

  /** The annexure plus who it is about, or a 404 that does not confirm it exists. */
  private async load(id: string) {
    const row = await this.db.one(
      `SELECT a.*, e.employee_number, e.full_name, e.status AS employee_status,
              p.full_name AS prepared_by_name
         FROM salary_annexure a
         JOIN employee e ON e.id = a.employee_id
         LEFT JOIN employee p ON p.id = a.prepared_by
        WHERE a.id = $1`, [id]);
    if (!row) throw new NotFoundException('Not found');
    return row;
  }

  // =========================================================================
  /**
   * The queue. Everyone who can read sees the same rows; what differs is what they can DO, which
   * the client asks about separately rather than this endpoint guessing from a role.
   */
  @Get('annexures')
  @Authenticated()
  async list(@Req() req: Request, @Query('status') status?: string) {
    await this.gate(req, 'onboarding.annexure.read');
    const rows = await this.db.rows(
      `SELECT a.id, a.status, a.declared_annual_ctc_minor::text AS ctc_minor,
              a.proposed_joining_on::text AS proposed_joining_on, a.created_at, a.updated_at,
              e.id AS employee_id, e.employee_number, e.full_name, e.status AS employee_status,
              (a.offer_document_id IS NOT NULL) AS has_offer_letter
         FROM salary_annexure a
         JOIN employee e ON e.id = a.employee_id
        WHERE ($1::text IS NULL OR a.status = $1)
        ORDER BY (a.status IN ('finance_review', 'delivery_review')) DESC, a.updated_at DESC`,
      [status && status !== 'all' ? status : null]);
    return { rows };
  }

  @Get('annexures/:id')
  @Authenticated()
  async detail(@Req() req: Request, @Param('id') id: string) {
    if (!isUuid(id)) throw new BadRequestException('Not a valid annexure');
    const a = await this.load(id);
    await this.gate(req, 'onboarding.annexure.read', a.employee_id as string);

    const components = await this.db.rows(
      `SELECT id, kind, component_code, label, amount_minor::text AS amount_minor, sort_order
         FROM salary_annexure_component WHERE annexure_id = $1
        ORDER BY kind DESC, sort_order, label`, [id]);

    const events = await this.db.rows(
      `SELECT ev.event_type, ev.from_status, ev.to_status, ev.reason, ev.created_at,
              ev.ctc_at_decision_minor::text AS ctc_at_decision_minor,
              actor.full_name AS actor_name
         FROM salary_annexure_event ev
         LEFT JOIN employee actor ON actor.id = ev.actor_employee_id
        WHERE ev.annexure_id = $1
        ORDER BY ev.created_at, ev.id`, [id]);

    return {
      annexure: {
        id: a.id,
        status: a.status,
        employeeId: a.employee_id,
        employeeNumber: a.employee_number,
        employeeName: a.full_name,
        employeeStatus: a.employee_status,
        ctcMinor: String(a.declared_annual_ctc_minor),
        proposedJoiningOn: a.proposed_joining_on,
        preparedByName: a.prepared_by_name,
        hasOfferLetter: a.offer_document_id !== null,
        createdAt: a.created_at,
        updatedAt: a.updated_at,
      },
      components,
      events,
    };
  }

  // =========================================================================
  /**
   * Prepare one. The employee must be in `pre_boarding` - an annexure is what precedes joining,
   * and offering a package to somebody who already works here is a pay revision, which is a
   * different act this does not implement.
   */
  @Post('annexures')
  @Authenticated()
  async create(@Req() req: Request, @Body() body: {
    employeeId?: string; annualCtc?: string; proposedJoiningOn?: string;
    components?: ComponentIn[];
  }) {
    const employeeId = body?.employeeId;
    if (!isUuid(employeeId)) throw new BadRequestException('Choose an employee');
    await this.gate(req, 'onboarding.annexure.write', employeeId);
    const me = currentActor(req);

    const emp = await this.db.one(
      `SELECT id, status, full_name FROM employee WHERE id = $1`, [employeeId]);
    if (!emp) throw new NotFoundException('Not found');
    if (emp.status !== 'pre_boarding') {
      throw new BadRequestException(
        `${emp.full_name} is ${emp.status}, not pre-boarding. An annexure is prepared before `
        + 'somebody joins; changing the pay of a current employee is a different act.');
    }

    const ctc = toPaise(body?.annualCtc, 'Annual CTC');
    if (ctc <= 0n) throw new BadRequestException('Annual CTC must be more than zero');
    const joiningOn = isoDate(body?.proposedJoiningOn);
    if (!joiningOn) throw new BadRequestException('A proposed joining date is required');

    const components = OnboardingController.parseComponents(body?.components ?? []);

    try {
      const id = await this.db.tx(async (q) => {
        const made = await q(
          `INSERT INTO salary_annexure (employee_id, declared_annual_ctc_minor,
                                        proposed_joining_on, prepared_by)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [employeeId, ctc.toString(), joiningOn, me.employeeId]);
        const newId = made[0].id as string;
        await OnboardingController.writeComponents(q, newId, components);
        await OnboardingController.audit(q, req, 'onboarding.annexure.created', newId, employeeId,
          { annual_ctc_minor: ctc.toString(), proposed_joining_on: joiningOn });
        return newId;
      });
      return { id };
    } catch (e) { throw OnboardingController.explain(e); }
  }

  /**
   * Edit a draft. The whole component set is replaced rather than patched line by line, because a
   * partial update of a set that must sum to a declared total is a way to leave it inconsistent
   * between two requests. Refused once it has left draft - by the database, not by this check.
   */
  @Patch('annexures/:id')
  @Authenticated()
  async update(@Req() req: Request, @Param('id') id: string, @Body() body: {
    annualCtc?: string; proposedJoiningOn?: string; components?: ComponentIn[];
  }) {
    if (!isUuid(id)) throw new BadRequestException('Not a valid annexure');
    const a = await this.load(id);
    await this.gate(req, 'onboarding.annexure.write', a.employee_id as string);

    if (a.status !== 'draft') {
      throw new BadRequestException(
        `This annexure is ${a.status}. Its figures are what was approved - send it back to draft `
        + 'to change them.');
    }

    const ctc = body?.annualCtc !== undefined
      ? toPaise(body.annualCtc, 'Annual CTC') : BigInt(String(a.declared_annual_ctc_minor));
    if (ctc <= 0n) throw new BadRequestException('Annual CTC must be more than zero');
    const joiningOn = body?.proposedJoiningOn !== undefined
      ? isoDate(body.proposedJoiningOn) : (a.proposed_joining_on as string);
    if (!joiningOn) throw new BadRequestException('A proposed joining date is required');

    const components = body?.components !== undefined
      ? OnboardingController.parseComponents(body.components) : null;

    try {
      await this.db.tx(async (q) => {
        await q(
          `UPDATE salary_annexure
              SET declared_annual_ctc_minor = $2, proposed_joining_on = $3, updated_at = now()
            WHERE id = $1`, [id, ctc.toString(), joiningOn]);
        if (components) {
          await q(`DELETE FROM salary_annexure_component WHERE annexure_id = $1`, [id]);
          await OnboardingController.writeComponents(q, id, components);
        }
        await OnboardingController.audit(q, req, 'onboarding.annexure.updated', id,
          a.employee_id as string, { annual_ctc_minor: ctc.toString() });
      });
      return { ok: true };
    } catch (e) { throw OnboardingController.explain(e); }
  }

  // =========================================================================
  /**
   * Every move through the chain, behind one method - because they are all the same mechanical
   * act (write an event; the trigger applies it) and differ only in which permission admits them.
   */
  @Post('annexures/:id/:move')
  @Authenticated()
  async move(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('move') moveName: string,
    @Body() body: { reason?: string },
  ) {
    if (!isUuid(id)) throw new BadRequestException('Not a valid annexure');
    const move = moveName as Move;
    if (!(move in MOVES)) throw new NotFoundException('Not found');

    const a = await this.load(id);
    const subject = a.employee_id as string;

    // WHICH PERMISSION ADMITS THIS MOVE. The mapping is here and the decision is not: each of
    // these is a distinct action in the matrix, and `assertCan` is the only thing that answers.
    const action: Action =
      move === 'finance_approve' || move === 'finance_reject'
        ? 'onboarding.annexure.approve_finance'
        : move === 'delivery_approve' || move === 'delivery_reject'
          ? 'onboarding.annexure.approve_delivery'
          : move === 'submit' || move === 'withdraw'
            ? 'onboarding.annexure.write'
            : 'onboarding.offer.manage';
    await this.gate(req, action, subject);
    const me = currentActor(req);

    const reason = String(body?.reason ?? '').trim();
    if (REASON_REQUIRED.includes(move) && reason.length < 3) {
      throw new BadRequestException('A reason is required, and is what makes this reviewable later');
    }

    /*
     * NOBODY DECIDES ON THEIR OWN PACKAGE. Checked here for a readable message; the database
     * refuses it regardless (`ck_sae_no_self_approval`), which is what makes it a guarantee.
     */
    if (me.employeeId && me.employeeId === subject) {
      throw new BadRequestException('You cannot act on your own salary annexure.');
    }

    const from = MOVES[move].from ?? (a.status as string);
    const to = MOVES[move].to;

    try {
      await this.db.tx(async (q) => {
        await q(
          `INSERT INTO salary_annexure_event
             (annexure_id, event_type, from_status, to_status, actor_employee_id, actor_roles,
              subject_employee_id, reason, ctc_at_decision_minor)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NULLIF($8, ''), $9)`,
          [id, move, from, to, me.employeeId, me.roles, subject, reason,
            String(a.declared_annual_ctc_minor)]);

        /*
         * A DECLINED OFFER MOVES THE PERSON, TOO. Without this the annexure says declined and the
         * employee sits in pre_boarding forever, which is the gap 0031's terminal state exists to
         * close. It is a lifecycle event like any other, so the composite FK onto
         * `employment_status_transition` decides whether it is legal.
         */
        if (move === 'decline_offer') {
          await q(
            `INSERT INTO employment_event
               (employee_id, event_type, from_status, to_status, effective_on, reason, recorded_by)
             VALUES ($1, 'offer_declined', 'pre_boarding', 'offer_declined', fn_business_date(),
                     $2, $3)`,
            [subject, reason.slice(0, 500), me.employeeId]);
          await q(`UPDATE employee SET status = 'offer_declined' WHERE id = $1`, [subject]);
        }

        await OnboardingController.audit(q, req, `onboarding.annexure.${move}`, id, subject,
          { from, to, ...(reason ? { reason: reason.slice(0, 200) } : {}) });

        await q(
          `INSERT INTO outbox_event (event_type, aggregate_type, aggregate_id, payload,
                                     actor_user_id)
           VALUES ($1, 'salary_annexure', $2, $3::jsonb, $4)`,
          [`onboarding.annexure.${move}`, id,
            JSON.stringify({ employeeId: subject, from, to }), me.userId]);
      });
      return { ok: true, status: to };
    } catch (e) { throw OnboardingController.explain(e); }
  }

  // =========================================================================
  private static parseComponents(input: ComponentIn[]) {
    if (!Array.isArray(input)) throw new BadRequestException('Components must be a list');
    if (input.length > 40) throw new BadRequestException('That is more components than an annexure needs');
    const seen = new Set<string>();
    return input.map((c, i) => {
      const kind = String(c?.kind ?? 'earning');
      if (kind !== 'earning' && kind !== 'deduction') {
        throw new BadRequestException('A component is either an earning or a deduction');
      }
      const code = String(c?.code ?? '').trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9_]{1,23}$/.test(code)) {
        throw new BadRequestException(`"${code || '(blank)'}" is not a valid component code`);
      }
      if (seen.has(code)) throw new BadRequestException(`${code} appears twice`);
      seen.add(code);
      const label = String(c?.label ?? '').trim() || code;
      const amount = toPaise(c?.amount, `${code} amount`);
      if (amount <= 0n) {
        // Deductions are entered POSITIVE and subtracted - one convention, the same one the
        // payslip screen already asks for.
        throw new BadRequestException(`${code} must be a positive amount`);
      }
      return { kind, code, label: label.slice(0, 80), amount, sort: i };
    });
  }

  private static async writeComponents(
    q: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>,
    annexureId: string,
    components: { kind: string; code: string; label: string; amount: bigint; sort: number }[],
  ) {
    for (const c of components) {
      await q(
        `INSERT INTO salary_annexure_component
           (annexure_id, kind, component_code, label, amount_minor, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [annexureId, c.kind, c.code, c.label, c.amount.toString(), c.sort]);
    }
  }

  private static async audit(
    q: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>,
    req: Request, eventType: string, rowPk: string, subject: string, after: unknown,
  ) {
    const me = currentActor(req);
    await q(
      `INSERT INTO audit_event (source, event_type, actor_kind, actor_user_id, actor_employee_id,
                                actor_roles, subject_employee_id, subject_type, session_id,
                                row_pk, table_name, field_classes, after)
       VALUES ('application', $1, 'user', $2, $3, $4, $5, 'employee', $6, $7, 'salary_annexure',
               ARRAY['RESTRICTED'], $8::jsonb)`,
      [eventType, me.userId, me.employeeId, me.roles, subject, me.sessionId, rowPk,
        JSON.stringify(after)]);
  }

  /** The database's own rails, in English, without leaking their SQL. */
  private static explain(e: unknown): Error {
    const msg = (e as Error)?.message ?? '';
    if (/ux_salary_annexure_one_live/.test(msg)) {
      return new BadRequestException(
        'This person already has an annexure in progress. Withdraw it before starting another.');
    }
    if (/components total .* but the annual CTC/.test(msg)) {
      return new BadRequestException(msg.replace(/^.*?ERROR:\s*/i, ''));
    }
    if (/is what was approved|send it back to draft/.test(msg)) {
      return new BadRequestException(
        'These figures were approved and cannot be edited. Send the annexure back to draft first.');
    }
    if (/not .* - somebody else moved it first/.test(msg)) {
      return new BadRequestException(
        'Somebody else moved this annexure while you were looking at it. Reload and try again.');
    }
    if (/fk_sae_transition|salary_annexure_status_transition/.test(msg)) {
      return new BadRequestException('That is not a step this annexure can take from where it is.');
    }
    if (/ck_sae_no_self_approval/.test(msg)) {
      return new BadRequestException('You cannot act on your own salary annexure.');
    }
    if (/ck_sae_reason_required/.test(msg)) {
      return new BadRequestException('A reason is required for that.');
    }
    return e as Error;
  }
}

@Module({ controllers: [OnboardingController] })
export class OnboardingModule {}
