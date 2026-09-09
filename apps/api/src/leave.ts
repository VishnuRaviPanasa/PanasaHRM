import {
  BadRequestException, Body, Controller, Get, Module, NotFoundException, Param, Post, Query, Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Authenticated, currentActor } from './auth';
import { Db } from './db';

const LEAVE_YEAR = 2026;   // TRACK B: derive from the leave year policy, not a constant.

@Controller('leave')
export class LeaveController {
  constructor(private readonly db: Db) {}

  /** Balances for the signed-in employee, folded from the ledger. */
  @Get('balance')
  @Authenticated()
  async balance(@Req() req: Request) {
    const me = currentActor(req);
    return {
      leaveYear: LEAVE_YEAR,
      balances: await this.db.rows(
        `SELECT lt.code, lt.name, lt.unit,
                a.accrued, a.carried_in, a.taken, a.pending, a.available
           FROM leave_type lt
           LEFT JOIN leave_account a
                  ON a.leave_type_id = lt.id AND a.employee_id = $1 AND a.leave_year = $2
          WHERE lt.archived_at IS NULL
          ORDER BY lt.display_order, lt.code`,
        [me.employeeId, LEAVE_YEAR]),
    };
  }

  /**
   * What a request WOULD cost, before submitting it. This is the demo's "the system calculates"
   * moment, so it explains itself rather than just returning a number.
   */
  @Get('preview')
  @Authenticated()
  async preview(@Req() req: Request, @Query('from') from: string, @Query('to') to: string,
                @Query('type') type = 'CL') {
    const me = currentActor(req);
    if (!from || !to) throw new BadRequestException('from and to are required');
    if (to < from) throw new BadRequestException('The end date is before the start date');

    const days = await this.db.rows(
      `SELECT d::date                                   AS on_date,
              to_char(d, 'Dy')                          AS weekday,
              EXTRACT(ISODOW FROM d) >= 6               AS is_weekend,
              h.name                                    AS holiday_name,
              h.is_optional                             AS holiday_optional,
              fn_is_working_day(d::date)                AS counts
         FROM generate_series($1::date, $2::date, INTERVAL '1 day') d
         LEFT JOIN holiday h ON h.holiday_on = d::date AND NOT h.is_optional
        ORDER BY d`,
      [from, to]);

    // Optional holidays are listed separately: they COUNT as leave unless the employee elects
    // them, and the election cap is still an open question (OR-06). Saying so out loud is more
    // honest than silently excluding them.
    const optional = await this.db.rows(
      `SELECT holiday_on, name FROM holiday
        WHERE holiday_on BETWEEN $1 AND $2 AND is_optional ORDER BY holiday_on`, [from, to]);

    const workingDays = days.filter((d) => d.counts).length;
    const account = await this.db.one(
      `SELECT a.available FROM leave_account a JOIN leave_type lt ON lt.id = a.leave_type_id
        WHERE a.employee_id = $1 AND lt.code = $2 AND a.leave_year = $3`,
      [me.employeeId, type, LEAVE_YEAR]);

    const available = Number(account?.available ?? 0);
    return {
      from, to, type, workingDays,
      calendarDays: days.length,
      days,
      optionalHolidaysInRange: optional,
      balanceBefore: available,
      balanceAfter: available - workingDays,
      sufficient: available - workingDays >= 0,
    };
  }

  /** Submit. Posts a real 'hold' to the ledger, so the balance drops immediately. */
  @Post('requests')
  @Authenticated()
  async apply(@Req() req: Request,
              @Body() body: { from?: string; to?: string; type?: string; reason?: string }) {
    const me = currentActor(req);
    const { from, to } = body ?? {};
    const type = body?.type ?? 'CL';
    if (!from || !to) throw new BadRequestException('from and to are required');
    if (to < from) throw new BadRequestException('The end date is before the start date');

    return this.db.tx(async (q) => {
      const [{ working_days }] = await q(`SELECT fn_working_days($1::date, $2::date) AS working_days`, [from, to]);
      if (Number(working_days) <= 0) {
        throw new BadRequestException(
          'That range contains no working days - it is all weekends and holidays');
      }

      const [lt] = await q(`SELECT id FROM leave_type WHERE code = $1`, [type]);
      if (!lt) throw new BadRequestException(`Unknown leave type ${type}`);

      const [pol] = await q(
        `SELECT id FROM leave_policy WHERE leave_type_id = $1 AND valid_period @> fn_business_date()
          LIMIT 1`, [lt.id]);

      // The 'hold' is what moves the balance. If it would overdraw, the CHECK on leave_account
      // raises 23514 and this whole transaction rolls back - request included.
      let hold;
      try {
        [hold] = await q(
          `INSERT INTO leave_ledger (employee_id, leave_type_id, leave_year, entry_type, days,
                                     leave_policy_id, reason)
           VALUES ($1, $2, $3, 'hold', $4, $5, $6) RETURNING id`,
          [me.employeeId, lt.id, LEAVE_YEAR, working_days, pol?.id ?? null,
           `leave request ${from} to ${to}`]);
      } catch (e: any) {
        if (e?.code === '23514') {
          throw new BadRequestException(
            `You do not have enough ${type} balance for ${working_days} working day(s)`);
        }
        throw e;
      }

      const [reqRow] = await q(
        `INSERT INTO leave_request (employee_id, leave_type_id, from_date, to_date,
                                    working_days, reason, hold_ledger_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, status, working_days`,
        [me.employeeId, lt.id, from, to, working_days, body?.reason ?? null, hold.id]);

      return { request: reqRow, workingDays: Number(working_days) };
    });
  }

  /** My requests. */
  @Get('requests')
  @Authenticated()
  async mine(@Req() req: Request) {
    const me = currentActor(req);
    return {
      requests: await this.db.rows(
        `SELECT r.id, lt.code AS type, r.from_date, r.to_date, r.working_days, r.status,
                r.reason, r.submitted_at, r.decided_at, r.decision_note,
                m.full_name AS decided_by_name
           FROM leave_request r
           JOIN leave_type lt ON lt.id = r.leave_type_id
           LEFT JOIN employee m ON m.id = r.decided_by
          WHERE r.employee_id = $1
          ORDER BY r.submitted_at DESC`, [me.employeeId]),
    };
  }

  /**
   * A manager's queue. Scope is "employees whose CURRENT employment names me as manager".
   * TRACK B: ADR-0005 requires this to come from AuthorizationService.scopeFor, not a WHERE.
   */
  @Get('approvals')
  @Authenticated('manager', 'hr_admin')
  async queue(@Req() req: Request) {
    const me = currentActor(req);
    return {
      requests: await this.db.rows(
        `SELECT r.id, e.full_name, e.employee_number, lt.code AS type,
                r.from_date, r.to_date, r.working_days, r.reason, r.submitted_at,
                a.available AS balance_now
           FROM leave_request r
           JOIN employee e ON e.id = r.employee_id
           JOIN leave_type lt ON lt.id = r.leave_type_id
           JOIN employment em ON em.employee_id = r.employee_id
                             AND em.valid_period @> fn_business_date()
           LEFT JOIN leave_account a ON a.employee_id = r.employee_id
                                    AND a.leave_type_id = r.leave_type_id
                                    AND a.leave_year = $2
          WHERE r.status = 'pending'
            AND ($3 = 'hr_admin' OR em.manager_id = $1)
          ORDER BY r.submitted_at`,
        [me.employeeId, LEAVE_YEAR, me.role]),
    };
  }

  @Post('approvals/:id/decide')
  @Authenticated('manager', 'hr_admin')
  async decide(@Req() req: Request, @Param('id') id: string,
               @Body() body: { decision?: 'approve' | 'reject'; note?: string }) {
    const me = currentActor(req);
    const decision = body?.decision;
    if (decision !== 'approve' && decision !== 'reject') {
      throw new BadRequestException('decision must be approve or reject');
    }

    return this.db.tx(async (q) => {
      const [r] = await q(
        `SELECT r.*, em.manager_id
           FROM leave_request r
           LEFT JOIN employment em ON em.employee_id = r.employee_id
                                  AND em.valid_period @> fn_business_date()
          WHERE r.id = $1 FOR UPDATE OF r`, [id]);

      if (!r) throw new NotFoundException('No such leave request');
      if (r.status !== 'pending') throw new BadRequestException(`Already ${r.status}`);
      if (me.role !== 'hr_admin' && r.manager_id !== me.employeeId) {
        throw new NotFoundException('No such leave request');  // 404, not 403 - do not confirm it exists
      }
      if (r.employee_id === me.employeeId) {
        throw new BadRequestException('You cannot decide your own leave request');
      }

      // 'take' turns the hold into consumption; 'release' returns it. Either way the balance is
      // recomputed by the ledger trigger, never written by this code (Must-Know Rule 6).
      const entryType = decision === 'approve' ? 'take' : 'release';
      const [settle] = await q(
        `INSERT INTO leave_ledger (employee_id, leave_type_id, leave_year, entry_type, days,
                                   leave_policy_id, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [r.employee_id, r.leave_type_id, r.leave_year ?? LEAVE_YEAR, entryType, r.working_days,
         null, `leave request ${decision}d by ${me.name}`]);

      const [updated] = await q(
        `UPDATE leave_request
            SET status = $2, decided_at = now(), decided_by = $3,
                decision_note = $4, settle_ledger_id = $5
          WHERE id = $1
          RETURNING id, status, working_days`,
        [id, decision === 'approve' ? 'approved' : 'rejected', me.employeeId,
         body?.note ?? null, settle.id]);

      const [acct] = await q(
        `SELECT available FROM leave_account
          WHERE employee_id = $1 AND leave_type_id = $2 AND leave_year = $3`,
        [r.employee_id, r.leave_type_id, r.leave_year ?? LEAVE_YEAR]);

      return { request: updated, balanceAfter: Number(acct?.available ?? 0) };
    });
  }
}

@Module({ controllers: [LeaveController] })
export class LeaveModule {}
