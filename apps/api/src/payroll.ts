import {
  BadRequestException, Body, Controller, Get, Module, NotFoundException, Param, Patch, Post,
  Query, Req, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthzDeniedError, objectKeyFor } from '@panasa/authz';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { Authenticated, currentActor } from './auth';
import { Authz, authContext } from './authz';
import { Db } from './db';
import { DOCUMENT_BUCKET, DocumentStorage, StorageModule } from './storage';

/**
 * Payslips.
 *
 * THIS IS NOT A PAYROLL ENGINE, AND THE BOUNDARY IS DELIBERATE.
 *
 * ADR-0012 (a versioned statutory rules engine) is Proposed and **BLOCKED** on plan question Q10:
 * is payroll built here or bought? Nothing in this file computes PF, ESI, professional tax or
 * TDS, and nothing here holds a rate, a threshold or a rounding rule. HR enters a payroll result
 * that was finalised elsewhere and attaches the PDF that was issued from it. That makes the
 * feature fully functional today without pre-empting a decision that is explicitly a human's.
 *
 * WHAT IT DOES GUARANTEE is that the PDF and the structured figures describe the same payslip.
 * `declared_net_minor` is what the PDF says; the lines are the structured data;
 * `fn_payslip_totals` derives the net; and migration 0024's issue guard refuses to issue unless
 * the two agree AND the document is clean, of type `payslip`, and about the same employee. None
 * of that is enforced in this file - it is enforced in the database, so a script, a migration or
 * the next code path cannot get it wrong either.
 *
 * MONEY NEVER TOUCHES A FLOAT (Rule 4). Amounts arrive as decimal STRINGS, are converted to
 * integer paise with `BigInt` string arithmetic, and are returned as strings. `parseFloat(x) *
 * 100` is the obvious implementation and is wrong: 0.07 * 100 is 7.000000000000001, and rounding
 * that away works until the day it does not.
 *
 * AUTHORIZATION IS ASKED TWICE, ON PURPOSE. `assertCan` decides whether the caller may touch this
 * resource at all, and `scope()` is composed INTO the SQL so the rows are filtered by the
 * database. Either alone would be a hole: the gate without the predicate lets a caller who passes
 * for their own record read everybody's, and the predicate without the gate turns a refusal into
 * a silent empty list. Every read is also audited, because for compensation the fact of a read is
 * itself the thing an auditor needs (rbac-rules attaches `auditRead()` to exactly this action).
 */

interface UploadedFileLike {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

const MAX_PAYSLIP_BYTES = 8 * 1024 * 1024;

/**
 * Client IP for the audit trail. Never logged as PII beyond the audit row itself.
 *
 * The API publishes no port of its own - the only path in from outside the compose network is
 * through the edge nginx (infrastructure/nginx/nginx.conf.template), which resolves the real
 * client via `set_real_ip_from` restricted to private ranges before setting X-Real-IP. So this
 * is a single, already-verified address, not a raw header to parse defensively - and trusting it
 * is what makes it trustworthy at all: without this, every audit row recorded the nginx
 * container's own address instead of the employee's, which is exactly what a review of real
 * `identity.login%` rows surfaced (2026-09-09).
 *
 * Falls back to the socket peer for anything that reaches the API directly - local
 * `npm run api:dev`, or a test hitting the API container with no edge in front of it. A sibling
 * container on the same compose network could still forge X-Real-IP directly to the API; the
 * edge is the only externally reachable path, and the residual internal one is accepted for a
 * single-VM deployment (ADR-0013).
 */
const clientIp = (req: Request): string | null => {
  const forwarded = req.headers['x-real-ip'];
  const header = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (header) return header;
  const raw = (req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
  return raw && raw !== '::1' ? raw : null;
};

const isoDate = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

/**
 * A decimal rupee string to integer paise, without ever forming a float.
 *
 * `Math.round(parseFloat(s) * 100)` is the version everybody writes. It is a Rule 4 violation
 * wearing a rounding call: the multiply happens in binary floating point, so the value being
 * rounded is already wrong, and the error is invisible until an amount lands on the wrong side of
 * a half. Here the digits are split as TEXT and assembled with BigInt, so the result is exact for
 * every input the regex admits.
 */
export const toPaise = (input: unknown, field: string): bigint => {
  const s = String(input ?? '').trim().replace(/[, ]/g, '');
  const m = /^(-?)(\d{1,12})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) {
    throw new BadRequestException(
      `${field} must be an amount like 50000 or 50000.75 (at most two decimal places)`);
  }
  const [, sign, whole, frac] = m;
  // Pad rather than parse: '5' is five TENTHS of a rupee (50 paise), not five paise.
  const paise = BigInt(whole) * 100n + BigInt(`${frac ?? ''}00`.slice(0, 2));
  return sign === '-' ? -paise : paise;
};

@Controller('payslips')
export class PayrollController {
  constructor(
    private readonly db: Db,
    private readonly authz: Authz,
    private readonly storage: DocumentStorage,
  ) {}

  /**
   * A denial is a 404.
   *
   * `rbac-rules.md`: a refusal must not confirm that the record exists. For pay that matters more
   * than usual - "403 on employee 7's payslip for March" tells the asker that employee 7 was paid
   * in March, which is exactly the fact they were not allowed to learn.
   */
  private static deny(e: unknown): never {
    if (e instanceof AuthzDeniedError) throw new NotFoundException('Not found');
    throw e;
  }

  private async audit(
    eventType: string, payslipId: string, req: Request, reason?: string | null,
  ): Promise<void> {
    const me = currentActor(req);
    try {
      await this.db.rows(
        `SELECT fn_audit_payslip($1, $2, $3, $4, $5, NULL, $6, $7, $8)`,
        [eventType, payslipId, me.userId, me.employeeId, me.sessionId,
          clientIp(req), reason ?? null, me.roles]);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('PAYSLIP AUDIT WRITE FAILED', eventType, (e as Error).message);
    }
  }

  /** The subject of a payslip, or null if it does not exist. Used to build the authz ref. */
  private async subjectOf(id: string): Promise<{ employeeId: string; status: string } | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const r = await this.db.one(
      `SELECT employee_id, status FROM payslip WHERE id = $1`, [id]);
    return r ? { employeeId: r.employee_id as string, status: r.status as string } : null;
  }

  /**
   * Gate one payslip by id, and hand back its subject.
   *
   * Looking the row up BEFORE the authorization decision is necessary rather than sloppy: the
   * policy is about the subject, and the subject is a column. The lookup selects only the two
   * fields needed to make the decision - never the amounts - so a caller who is about to be
   * refused never causes pay data to be read at all.
   */
  private async gateOne(req: Request, id: string, action: 'payroll.payslip.read' | 'payroll.payslip.manage') {
    const subject = await this.subjectOf(id);
    if (!subject) throw new NotFoundException('Not found');
    const ctx = authContext(req);
    try {
      await this.authz.assertCan(ctx, action, {
        type: 'payslip', id, subjectEmployeeId: subject.employeeId, dataClass: 'RESTRICTED',
      });
    } catch (e) { PayrollController.deny(e); }
    return { ctx, subject };
  }

  // -------------------------------------------------------------------------
  /** The component catalogue. Configuration (Rule 11), so the form is driven by data. */
  @Get('components')
  @Authenticated()
  async components(@Req() req: Request) {
    const ctx = authContext(req);
    // Reading the catalogue is a management act: it is the vocabulary of the pay register, and an
    // employee has no use for the list of components that could appear on somebody's payslip.
    try {
      await this.authz.assertCan(ctx, 'payroll.payslip.manage', { type: 'payslip' });
    } catch (e) { PayrollController.deny(e); }

    const components = await this.db.rows(
      `SELECT code, name, kind, is_statutory, display_order
         FROM payslip_component_type
        WHERE retired_on IS NULL OR retired_on > fn_business_date()
        ORDER BY kind DESC, display_order, name`);
    return { components };
  }

  // -------------------------------------------------------------------------
  /**
   * List payslips. An employee sees their own; HR and finance see the organisation.
   *
   * `employeeId` is the URL-tampering surface the security requirements call out, and it is
   * handled by ASKING ABOUT THAT SUBJECT rather than by comparing ids here. An employee who
   * passes a colleague's id fails `isSelf` and gets a 404. Even if that gate were wrong, the
   * scope predicate is still composed into the WHERE clause, so the query cannot return a row the
   * caller may not see. Two independent layers, neither relying on the other.
   */
  @Get()
  @Authenticated()
  async list(@Req() req: Request, @Query('employeeId') employeeId?: string) {
    const ctx = authContext(req);
    const asked = typeof employeeId === 'string' && employeeId.trim() ? employeeId.trim() : null;

    try {
      await this.authz.assertCan(ctx, 'payroll.payslip.read', {
        type: 'payslip',
        subjectEmployeeId: asked ?? ctx.employeeId ?? undefined,
        dataClass: 'RESTRICTED',
      });
    } catch (e) { PayrollController.deny(e); }

    const predicate = this.authz.scope(ctx, 'payroll.payslip.read', { type: 'payslip' });
    if (predicate.kind === 'none') return { rows: [] };

    const params: unknown[] = [];
    const where: string[] = [];
    const scope = predicate.render('p', 1);
    where.push(scope.sql);
    params.push(...scope.params);
    if (asked) { where.push(`p.employee_id = $${params.length + 1}`); params.push(asked); }

    const rows = await this.db.rows(
      `SELECT p.id, p.employee_id, e.employee_number, e.full_name,
              p.period_start, p.period_end, p.pay_date, p.status, p.currency_code,
              p.declared_net_minor::text AS declared_net_minor,
              t.net_minor::text          AS net_minor,
              t.gross_minor::text        AS gross_minor,
              t.deductions_minor::text   AS deductions_minor,
              t.line_count,
              (p.document_id IS NOT NULL) AS has_document,
              (p.declared_net_minor IS NOT NULL AND t.net_minor = p.declared_net_minor) AS reconciles,
              p.issued_at, p.voided_at, p.void_reason, p.source
         FROM payslip p
         JOIN employee e ON e.id = p.employee_id
         CROSS JOIN LATERAL fn_payslip_totals(p.id) t
        WHERE ${where.join(' AND ')}
        ORDER BY p.period_start DESC, e.employee_number`,
      params);

    // Default-deny field registry: a column added to `payslip` later is invisible until somebody
    // classifies it, which is the control that stopped 0014's accidental disclosure repeating.
    /*
     * `employee_id` is selected for ONE reason: maskList needs it to decide whether the caller is
     * the subject of each row. Without it every row looked like somebody else's, and the field
     * rules are `self: true` - so an employee's own payslip list came back stripped of every
     * figure. A default-deny registry fails in the safe direction, but it still fails.
     */
    const visible = this.authz.maskList(ctx, 'payslip', rows, (r) => (r.employee_id as string) ?? null);

    await this.db.rows(
      `INSERT INTO audit_event (source, event_type, actor_kind, actor_user_id, actor_employee_id,
                                actor_roles, subject_employee_id, subject_type, session_id,
                                source_ip, table_name, field_classes, after)
       VALUES ('application', 'payroll.payslip.listed', 'user', $1, $2, $3, $4, 'payslip', $5, $6,
               'payslip', ARRAY['RESTRICTED'], jsonb_build_object('rows', $7::int))`,
      [ctx.userId, ctx.employeeId, ctx.roles, asked ?? ctx.employeeId, currentActor(req).sessionId,
        clientIp(req), rows.length]).catch(() => undefined);

    return { rows: visible };
  }

  // -------------------------------------------------------------------------
  /** One payslip, with its lines and the derived totals. */
  @Get(':id')
  @Authenticated()
  async detail(@Req() req: Request, @Param('id') id: string) {
    const { ctx, subject } = await this.gateOne(req, id, 'payroll.payslip.read');

    const p = await this.db.one(
      `SELECT p.id, p.employee_id, e.employee_number, e.full_name,
              p.period_start, p.period_end, p.pay_date, p.status, p.currency_code,
              p.declared_net_minor::text AS declared_net_minor,
              p.note, p.source, p.issued_at, p.voided_at, p.void_reason,
              (p.document_id IS NOT NULL AND d.withdrawn_at IS NULL) AS has_document,
              p.created_at
         FROM payslip p
         JOIN employee e ON e.id = p.employee_id
         LEFT JOIN employee_document d ON d.id = p.document_id
        WHERE p.id = $1`, [id]);
    if (!p) throw new NotFoundException('Not found');

    const totals = await this.db.one(
      `SELECT gross_minor::text AS gross_minor, deductions_minor::text AS deductions_minor,
              net_minor::text AS net_minor, line_count
         FROM fn_payslip_totals($1)`, [id]);

    const lines = await this.db.rows(
      `SELECT l.component_code, c.name, c.kind, c.is_statutory,
              l.amount_minor::text AS amount_minor, l.note
         FROM payslip_line l
         JOIN payslip_component_type c ON c.code = l.component_code
        WHERE l.payslip_id = $1
        ORDER BY c.kind DESC, c.display_order, c.name`, [id]);

    await this.audit('payroll.payslip.read', id, req);

    const masked = this.authz.maskRow(ctx, 'payslip', p as Record<string, unknown>, {
      isSubject: ctx.employeeId === subject.employeeId,
    });

    return {
      payslip: masked,
      lines,
      totals,
      // Stated rather than left for the reader to compute: if these ever disagree on an ISSUED
      // payslip something has gone wrong that the issue guard was supposed to prevent.
      reconciles: p.declared_net_minor !== null
        && String(totals?.net_minor) === String(p.declared_net_minor),
    };
  }

  // -------------------------------------------------------------------------
  /** Create a draft. Nothing is issued here - a draft has no standing at all. */
  @Post()
  @Authenticated()
  async create(@Req() req: Request, @Body() body: {
    employeeId?: string; periodStart?: string; periodEnd?: string; payDate?: string;
    declaredNet?: string; note?: string;
    lines?: { componentCode?: string; amount?: string; note?: string }[];
  }) {
    const ctx = authContext(req);
    const employeeId = String(body?.employeeId ?? '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(employeeId)) {
      throw new BadRequestException('employeeId is required');
    }

    try {
      await this.authz.assertCan(ctx, 'payroll.payslip.manage', {
        type: 'payslip', subjectEmployeeId: employeeId, dataClass: 'RESTRICTED',
      });
    } catch (e) { PayrollController.deny(e); }

    const periodStart = isoDate(body?.periodStart);
    const periodEnd = isoDate(body?.periodEnd);
    if (!periodStart || !periodEnd) {
      throw new BadRequestException('periodStart and periodEnd must be dates (YYYY-MM-DD)');
    }
    if (periodEnd < periodStart) {
      throw new BadRequestException('periodEnd cannot be before periodStart');
    }
    const payDate = isoDate(body?.payDate);

    const declaredNet = body?.declaredNet === undefined || body?.declaredNet === null
      || String(body.declaredNet).trim() === ''
      ? null
      : toPaise(body.declaredNet, 'declaredNet');

    const lines = Array.isArray(body?.lines) ? body.lines : [];
    const parsed = lines.map((l, i) => {
      const code = String(l?.componentCode ?? '').trim();
      if (!/^[a-z][a-z0-9_]*$/.test(code)) {
        throw new BadRequestException(`lines[${i}].componentCode is not a component code`);
      }
      const amount = toPaise(l?.amount, `lines[${i}].amount`);
      if (amount === 0n) {
        throw new BadRequestException(`lines[${i}].amount cannot be zero`);
      }
      return { code, amount, note: l?.note ? String(l.note).slice(0, 500) : null };
    });

    const seen = new Set<string>();
    for (const l of parsed) {
      if (seen.has(l.code)) {
        throw new BadRequestException(`${l.code} appears twice - one line per component`);
      }
      seen.add(l.code);
    }

    const me = currentActor(req);

    /*
     * One transaction: the payslip, its lines, the audit row and the domain event. Rule 2 says the
     * event and the audit record go in the SAME transaction as the write, so a reader can never
     * see a payslip that no event explains.
     *
     * AND ITS FAILURES ARE 400s, NOT 500s. The exclusion constraint that stops a second live
     * payslip for one employee and period is a legitimate answer to a legitimate request, and it
     * surfaced as `500 Internal server error` - which tells HR nothing about what to do next and
     * reads as a broken product rather than a refused duplicate. Found by a test that had itself
     * asked for the same period twice.
     */
    const id = await this.db.tx(async (q) => {
      const created = await q(
        `INSERT INTO payslip (employee_id, period_start, period_end, pay_date,
                              declared_net_minor, note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [employeeId, periodStart, periodEnd, payDate,
          declaredNet === null ? null : declaredNet.toString(),
          body?.note ? String(body.note).slice(0, 2000) : null, me.employeeId]);
      const newId = created[0].id as string;

      for (const l of parsed) {
        await q(
          `INSERT INTO payslip_line (payslip_id, component_code, amount_minor, note)
           VALUES ($1, $2, $3, $4)`,
          [newId, l.code, l.amount.toString(), l.note]);
      }

      await q(
        `SELECT fn_audit_payslip($1, $2, $3, $4, $5, NULL, $6, $7, $8)`,
        ['payroll.payslip.created', newId, me.userId, me.employeeId, me.sessionId,
          clientIp(req), null, me.roles]);

      await q(
        `INSERT INTO outbox_event (event_type, aggregate_type, aggregate_id, payload, actor_user_id)
         VALUES ('payroll.payslip.created', 'payslip', $1, $2::jsonb, $3)`,
        [newId, JSON.stringify({ employeeId, periodStart, periodEnd, lineCount: parsed.length }),
          me.userId]);

      return newId;
    }).catch((e: unknown) => {
      const msg = (e as Error).message ?? '';
      if (/ex_payslip_one_live_per_period/.test(msg)) {
        throw new BadRequestException(
          'That employee already has a payslip covering part of this period. '
          + 'Void the existing one first, or choose a different period.');
      }
      if (/payslip_component_type|violates foreign key/.test(msg)) {
        throw new BadRequestException('One of those component codes does not exist.');
      }
      throw new BadRequestException(msg || 'That payslip could not be created.');
    });

    return { id, status: 'draft' };
  }

  // -------------------------------------------------------------------------
  /**
   * Edit a DRAFT. The database refuses this once the payslip is issued, so this endpoint does not
   * re-check the status - it lets the constraint speak, which is the layer that cannot be bypassed.
   */
  @Patch(':id')
  @Authenticated()
  async update(@Req() req: Request, @Param('id') id: string, @Body() body: {
    payDate?: string; declaredNet?: string; note?: string;
    lines?: { componentCode?: string; amount?: string; note?: string }[];
  }) {
    await this.gateOne(req, id, 'payroll.payslip.manage');
    const me = currentActor(req);

    const declaredNet = body?.declaredNet === undefined ? undefined
      : String(body.declaredNet).trim() === '' ? null
        : toPaise(body.declaredNet, 'declaredNet');

    const parsed = Array.isArray(body?.lines)
      ? body.lines.map((l, i) => {
        const code = String(l?.componentCode ?? '').trim();
        if (!/^[a-z][a-z0-9_]*$/.test(code)) {
          throw new BadRequestException(`lines[${i}].componentCode is not a component code`);
        }
        return {
          code,
          amount: toPaise(l?.amount, `lines[${i}].amount`),
          note: l?.note ? String(l.note).slice(0, 500) : null,
        };
      })
      : null;

    try {
      await this.db.tx(async (q) => {
        if (declaredNet !== undefined || body?.payDate !== undefined || body?.note !== undefined) {
          await q(
            `UPDATE payslip
                SET declared_net_minor = COALESCE($2, declared_net_minor),
                    pay_date           = COALESCE($3, pay_date),
                    note               = COALESCE($4, note),
                    updated_at         = now()
              WHERE id = $1`,
            [id,
              declaredNet === undefined ? null : declaredNet === null ? null : declaredNet.toString(),
              isoDate(body?.payDate),
              body?.note === undefined ? null : String(body.note).slice(0, 2000)]);
        }

        if (parsed) {
          // Replace wholesale. A partial line update would need its own identity scheme and
          // gains nothing: a draft payslip is small and HR is editing the whole thing anyway.
          await q(`DELETE FROM payslip_line WHERE payslip_id = $1`, [id]);
          for (const l of parsed) {
            await q(
              `INSERT INTO payslip_line (payslip_id, component_code, amount_minor, note)
               VALUES ($1, $2, $3, $4)`, [id, l.code, l.amount.toString(), l.note]);
          }
        }

        await q(
          `SELECT fn_audit_payslip($1, $2, $3, $4, $5, NULL, $6, $7, $8)`,
          ['payroll.payslip.updated', id, me.userId, me.employeeId, me.sessionId,
            clientIp(req), null, me.roles]);
      });
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }

    return { ok: true };
  }

  // -------------------------------------------------------------------------
  /**
   * Attach the PDF.
   *
   * The bytes go through `employee_document` rather than into a payslip-specific store, so this
   * feature inherits everything 0018 already proved: content-type allowlist, size cap, SHA-256
   * recorded and re-checked on the way out, append-only versions, an immutable object key with no
   * employee number or name in it, and the quarantine gate.
   *
   * ON CLEARING THE SCAN IN THE SAME REQUEST: there is no virus scanner (OR-23), so `clean` is an
   * administrative assertion wherever it happens - in `documents.ts` it is HR pressing a second
   * button. Doing it here in the same authenticated HR action is the same trust decision taken
   * once instead of twice, and it is recorded as its own audit event so it is visible rather than
   * implied. When a scanner lands, THIS is the line that stops doing it.
   */
  @Post(':id/document')
  @Authenticated()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PAYSLIP_BYTES + 1024 } }))
  async attach(
    @Req() req: Request,
    @Param('id') id: string,
    @UploadedFile() file: UploadedFileLike | undefined,
  ) {
    const { subject } = await this.gateOne(req, id, 'payroll.payslip.manage');
    if (!file || !file.buffer?.length) throw new BadRequestException('No file was uploaded');
    if (file.size > MAX_PAYSLIP_BYTES) {
      throw new BadRequestException('A payslip PDF must be 8 MB or smaller');
    }
    // A payslip is a PDF. The document table's allowlist is wider (images, office formats) because
    // an ID scan is legitimately a photograph; a payslip is a generated document, and narrowing
    // here removes the polyglot-image surface entirely for this type.
    if (file.mimetype !== 'application/pdf') {
      throw new BadRequestException('A payslip must be a PDF');
    }

    const existing = await this.db.one(
      `SELECT document_id, status, period_start, period_end FROM payslip WHERE id = $1`, [id]);
    if (!existing) throw new NotFoundException('Not found');
    if (existing.status !== 'draft') {
      throw new BadRequestException('Only a draft payslip can have its document attached');
    }

    const sha = DocumentStorage.sha256(file.buffer);
    const me = currentActor(req);
    const title = `Payslip ${String(existing.period_start).slice(0, 7)}`;

    const documentId = (existing.document_id as string | null) ?? randomUUID();
    const versionId = randomUUID();
    // The key carries the two surrogate ids and nothing else - 0018 check D15 asserts no object
    // key contains an employee number, name or email, because a bucket listing is readable by
    // anybody who reaches the storage layer.
    const key = objectKeyFor(documentId, versionId);

    try { await this.storage.ensureBucket(); }
    catch { throw new BadRequestException('Document storage is unavailable. Try again shortly.'); }

    // Object first, then the rows. An orphaned object is invisible; a row pointing at a missing
    // object is a download that 500s for a document the UI insists exists.
    await this.storage.put(key, file.buffer, file.mimetype);

    try {
      await this.db.tx(async (q) => {
        if (!existing.document_id) {
          await q(
            `INSERT INTO employee_document (id, employee_id, document_type_code, title, uploaded_by)
             VALUES ($1, $2, 'payslip', $3, $4)`,
            [documentId, subject.employeeId, title, me.employeeId]);
          await q(`UPDATE payslip SET document_id = $2, updated_at = now() WHERE id = $1`,
            [id, documentId]);
        }

        const next = await q(
          `SELECT COALESCE(max(version_no), 0) + 1 AS n
             FROM employee_document_version WHERE document_id = $1`, [documentId]);

        await q(
          `INSERT INTO employee_document_version
             (id, document_id, version_no, bucket, object_key, content_type, size_bytes,
              sha256_hex, original_name, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [versionId, documentId, next[0].n, DOCUMENT_BUCKET, key, file.mimetype,
            file.buffer.length, sha, file.originalname?.slice(0, 255) ?? null, me.employeeId]);
        const newVersionId = versionId;

        // See the doc comment. Visible as its own audit event, not folded into the upload.
        await q(
          `UPDATE employee_document_version
              SET scan_status = 'clean', scanned_at = now(),
                  scan_detail = 'no scanner configured (OR-23); asserted by HR on payslip upload'
            WHERE id = $1`, [newVersionId]);

        await q(`UPDATE employee_document SET current_version_id = $2, updated_at = now()
                  WHERE id = $1`, [documentId, newVersionId]);

        await q(
          `SELECT fn_audit_payslip($1, $2, $3, $4, $5, NULL, $6, $7, $8)`,
          ['payroll.payslip.document.attached', id, me.userId, me.employeeId, me.sessionId,
            clientIp(req), `sha256=${sha.slice(0, 12)}`, me.roles]);
        await q(
          `SELECT fn_audit_payslip($1, $2, $3, $4, $5, NULL, $6, $7, $8)`,
          ['payroll.payslip.document.cleared_without_scanner', id, me.userId, me.employeeId,
            me.sessionId, clientIp(req), 'OR-23: no scanner is configured', me.roles]);

      });

      return { ok: true, versionId, sha256: sha };
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  // -------------------------------------------------------------------------
  /**
   * Issue. Every substantive check lives in the database's issue guard, and this endpoint's job is
   * to translate its refusal into something a person can act on.
   */
  @Post(':id/issue')
  @Authenticated()
  async issue(@Req() req: Request, @Param('id') id: string) {
    const { subject } = await this.gateOne(req, id, 'payroll.payslip.manage');
    const me = currentActor(req);

    try {
      await this.db.tx(async (q) => {
        await q(
          `INSERT INTO payslip_event
             (payslip_id, subject_employee_id, event_type, from_status, to_status,
              actor_employee_id)
           VALUES ($1, $2, 'issue', 'draft', 'issued', $3)`,
          [id, subject.employeeId, me.employeeId]);

        await q(
          `SELECT fn_audit_payslip($1, $2, $3, $4, $5, NULL, $6, $7, $8)`,
          ['payroll.payslip.issued', id, me.userId, me.employeeId, me.sessionId,
            clientIp(req), null, me.roles]);
        await q(
          `INSERT INTO outbox_event (event_type, aggregate_type, aggregate_id, payload,
                                     actor_user_id)
           VALUES ('payroll.payslip.issued', 'payslip', $1, $2::jsonb, $3)`,
          [id, JSON.stringify({ employeeId: subject.employeeId }), me.userId]);
      });
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }

    return { ok: true, status: 'issued' };
  }

  // -------------------------------------------------------------------------
  /**
   * Void, with a reason. Never a delete: a deleted row takes its reason with it and would leave
   * the object in MinIO with no record of who was ever allowed to read it. The database trigger
   * withdraws the document as part of the same transition, which is what makes "a void payslip
   * leaves no reachable document" structural rather than something this endpoint must remember.
   */
  @Post(':id/void')
  @Authenticated()
  async void(@Req() req: Request, @Param('id') id: string, @Body() body: { reason?: string }) {
    const { subject } = await this.gateOne(req, id, 'payroll.payslip.manage');
    const reason = String(body?.reason ?? '').trim();
    if (reason.length < 3) {
      throw new BadRequestException('A void needs a reason - it is the part that matters later');
    }

    const current = await this.db.one(`SELECT status FROM payslip WHERE id = $1`, [id]);
    if (!current) throw new NotFoundException('Not found');
    if (current.status === 'void') throw new BadRequestException('That payslip is already void');

    const me = currentActor(req);
    try {
      await this.db.tx(async (q) => {
        await q(
          `INSERT INTO payslip_event
             (payslip_id, subject_employee_id, event_type, from_status, to_status,
              actor_employee_id, reason)
           VALUES ($1, $2, 'void', $3, 'void', $4, $5)`,
          [id, subject.employeeId, current.status, me.employeeId, reason.slice(0, 500)]);

        await q(
          `SELECT fn_audit_payslip($1, $2, $3, $4, $5, NULL, $6, $7, $8)`,
          ['payroll.payslip.voided', id, me.userId, me.employeeId, me.sessionId,
            clientIp(req), reason.slice(0, 500), me.roles]);
        await q(
          `INSERT INTO outbox_event (event_type, aggregate_type, aggregate_id, payload,
                                     actor_user_id)
           VALUES ('payroll.payslip.voided', 'payslip', $1, $2::jsonb, $3)`,
          [id, JSON.stringify({ employeeId: subject.employeeId, reason: reason.slice(0, 200) }),
            me.userId]);
      });
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }

    return { ok: true, status: 'void' };
  }

  // -------------------------------------------------------------------------
  /** The transition history. Append-only, so this is the whole story of the payslip. */
  @Get(':id/history')
  @Authenticated()
  async history(@Req() req: Request, @Param('id') id: string) {
    await this.gateOne(req, id, 'payroll.payslip.read');
    const events = await this.db.rows(
      `SELECT ev.event_type, ev.from_status, ev.to_status, ev.reason, ev.occurred_at,
              a.full_name AS actor_name, a.employee_number AS actor_number
         FROM payslip_event ev
         LEFT JOIN employee a ON a.id = ev.actor_employee_id
        WHERE ev.payslip_id = $1
        ORDER BY ev.id`, [id]);
    return { events };
  }

  // -------------------------------------------------------------------------
  /**
   * The PDF.
   *
   * THE PAYSLIP RECORD IS THE AUTHORITY FOR ITS DOCUMENT, not the document type. The `payslip`
   * document type is RESTRICTED, so `documents.document.download` gives it to HR alone and the
   * employee it is about cannot fetch it through /documents at all. Their door is this one, gated
   * by `payroll.payslip.read`, which admits the subject because a wage slip is theirs. Two doors
   * deliberately, and this one is narrower in every respect except adding the subject themselves -
   * which is never a disclosure to a third party.
   *
   * A VOID PAYSLIP SERVES NOTHING. The void transition withdraws the document row, and this
   * endpoint joins on `withdrawn_at IS NULL`, so the orphan is unreachable through both paths
   * rather than just this one.
   */
  @Get(':id/document')
  @Authenticated()
  async document(
    @Req() req: Request, @Param('id') id: string, @Res() res: Response,
    @Query('mode') mode?: string,
  ) {
    await this.gateOne(req, id, 'payroll.payslip.read');

    const row = await this.db.one(
      `SELECT v.id AS version_id, v.bucket, v.object_key, v.content_type, v.sha256_hex,
              v.original_name, p.status, p.period_start
         FROM payslip p
         JOIN employee_document d ON d.id = p.document_id AND d.withdrawn_at IS NULL
         JOIN employee_document_version v ON v.id = d.current_version_id
        WHERE p.id = $1 AND p.status <> 'void'`, [id]);

    if (!row) {
      // Covers all of: no document yet, a withdrawn one, a quarantined one, and a void payslip.
      // Identical response for each, because distinguishing them would leak the reason.
      throw new NotFoundException('No document is available for that payslip');
    }

    const body = await this.storage.get(row.object_key as string);

    // The hash was recorded when the bytes were stored. If it no longer matches, the content has
    // been substituted or corrupted, and serving it would be worse than failing.
    const actual = DocumentStorage.sha256(body);
    if (actual !== row.sha256_hex) {
      await this.audit('payroll.payslip.document.integrity_mismatch', id, req,
        `expected=${String(row.sha256_hex).slice(0, 12)} actual=${actual.slice(0, 12)}`);
      throw new BadRequestException('That file failed its integrity check and was not served.');
    }

    await this.audit(
      mode === 'view' ? 'payroll.payslip.document.viewed' : 'payroll.payslip.document.downloaded',
      id, req);

    res.setHeader('Content-Type', row.content_type as string);
    res.setHeader('Content-Length', String(body.length));
    // Always `attachment`, including for a view - the client renders a preview from a blob: URL it
    // builds after fetching these bytes, so this header never has to be relaxed (DEC-050).
    res.setHeader('Content-Disposition',
      `attachment; filename="payslip-${String(row.period_start).slice(0, 7)}.pdf"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.send(body);
  }
}

@Module({ imports: [StorageModule], controllers: [PayrollController] })
export class PayrollModule {}
