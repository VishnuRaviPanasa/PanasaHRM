import {
  BadRequestException, Body, Controller, Get, Module, NotFoundException, Param, Patch, Post,
  Query, Req,
} from '@nestjs/common';
import { AuthzDeniedError } from '@panasa/authz';
import type { Request } from 'express';
import { Authenticated, currentActor } from './auth';
import { Authz, authContext } from './authz';
import { Db } from './db';

/**
 * The organisation masters: departments and designations.
 *
 * THE TWO ARE DIFFERENT SHAPES, AND THE ENDPOINTS SAY SO RATHER THAN PRETENDING OTHERWISE.
 *
 * DEC-043 split department IDENTITY from department STRUCTURE. The code and the name are ordinary
 * mutable reference data - `temporal-data-rules.md` names a designation's display name as the
 * canonical example - so renaming is a PATCH. But where a department SITS is effective-dated, so
 * re-parenting is not an edit at all: it closes the current placement and opens a new one, and
 * last year's cost allocation keeps resolving to last year's parent. Hence two endpoints where a
 * CRUD generator would have produced one.
 *
 * A designation is retired with a DATE, never deleted and never flagged (DEC-044): a retired title
 * must stay valid for the historical `employment` rows pointing at it while being refused for a
 * NEW assignment, and only a date can answer "was this retired on the day being assigned".
 *
 * ALMOST NOTHING IS VALIDATED HERE. Overlapping placements, back-dated closures, in-place edits of
 * history, self-parenting and now cycles (0026) are all refused by the database. This controller's
 * job is to translate those refusals into something an HR administrator can act on - a 400 with a
 * sentence, not a 500 with "Internal server error". Where it does check something first, it is to
 * produce a better message, never because the check is the control.
 */

const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);

const isoDate = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

const code = (v: unknown, field: string): string => {
  const s = String(v ?? '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{1,15}$/.test(s)) {
    throw new BadRequestException(
      `${field} must be 2-16 characters, starting with a letter (A-Z, 0-9, - and _)`);
  }
  return s;
};

const name = (v: unknown, field: string): string => {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (s.length < 2 || s.length > 120) {
    throw new BadRequestException(`${field} must be between 2 and 120 characters`);
  }
  return s;
};

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

/** Turn a database refusal into a sentence HR can act on. */
function explain(e: unknown): never {
  const msg = (e as Error)?.message ?? '';
  const map: [RegExp, string][] = [
    [/ex_department_period_no_overlap|exclusion constraint/,
      'That department already has a placement covering this date. Close the current one first.'],
    [/already inside its own subtree/, msg],
    [/not_self_parent|ck_department_period_not_self/,
      'A department cannot be its own parent.'],
    [/may not be modified in place/,
      'History cannot be edited. Close the current placement and record a new one instead.'],
    [/back-dat/i,
      'This cannot take effect in the past. Choose today or a future date.'],
    [/department_code_key|uq_department_code|duplicate key.*department/,
      'A department with that code already exists.'],
    [/designation_code_key|duplicate key.*designation/,
      'A designation with that code already exists.'],
    [/isempty|NOT isempty/,
      'That department already has a placement starting on this date, so closing it here would '
      + 'leave a period covering no days at all. Choose a later date.'],
    [/retired on/, msg],
    [/violates foreign key/, 'That parent department does not exist.'],
  ];
  for (const [re, text] of map) if (re.test(msg)) throw new BadRequestException(text);
  throw new BadRequestException(msg || 'That change could not be saved.');
}

@Controller('org')
export class OrgController {
  constructor(private readonly db: Db, private readonly authz: Authz) {}

  private async gate(req: Request, action: 'org.unit.manage' | 'org.designation.manage') {
    const ctx = authContext(req);
    try {
      await this.authz.assertCan(ctx, action, {
        type: action === 'org.unit.manage' ? 'department' : 'designation',
      });
    } catch (e) {
      // Organisation-scoped, so a denial reveals no individual record's existence and 403 is the
      // honest status - the same reasoning DEC-053 recorded for settings.
      if (e instanceof AuthzDeniedError) {
        throw new BadRequestException('You do not have permission to manage the organisation.');
      }
      throw e;
    }
    return ctx;
  }

  private async audit(eventType: string, table: string, id: string, req: Request, after: unknown) {
    const me = currentActor(req);
    await this.db.rows(
      `INSERT INTO audit_event (source, event_type, actor_kind, actor_user_id, actor_employee_id,
                                actor_roles, subject_type, session_id, source_ip, row_pk,
                                table_name, field_classes, after)
       VALUES ('application', $1, 'user', $2, $3, $4, $5, $6, $7, $8, $5,
               ARRAY['PUBLIC_INTERNAL'], $9::jsonb)`,
      [eventType, me.userId, me.employeeId, me.roles, table, me.sessionId, clientIp(req),
        id, JSON.stringify(after)]).catch((e) => {
      // eslint-disable-next-line no-console
      console.error('ORG AUDIT WRITE FAILED', eventType, (e as Error).message);
    });
  }

  // =========================================================================
  // Departments
  // =========================================================================
  /**
   * The department master, resolved AS OF a date.
   *
   * `asOf` is a real parameter and not decoration: the whole reason the placement is
   * effective-dated is that "which department sat under which" has an answer per date. A master
   * screen that could only show today would make a scheduled reorganisation invisible until it
   * happened, which is exactly when somebody wants to check it.
   */
  @Get('departments')
  @Authenticated()
  async departments(@Req() req: Request, @Query('asOf') asOf?: string) {
    await this.gate(req, 'org.unit.manage');
    const on = isoDate(asOf);

    const rows = await this.db.rows(
      `WITH d AS (SELECT COALESCE($1::date, fn_business_date()) AS on_date)
       SELECT dep.id, dep.code, dep.name, dep.description,
              p.parent_department_id, par.code AS parent_code, par.name AS parent_name,
              p.valid_from, p.valid_to, p.reason,
              h.employee_number AS head_number, h.full_name AS head_name,
              fn_department_headcount_asof(dep.id, (SELECT on_date FROM d), false) AS direct_headcount,
              fn_department_headcount_asof(dep.id, (SELECT on_date FROM d), true)  AS subtree_headcount,
              (p.id IS NULL) AS unplaced,
              -- A placement that starts in the future is a SCHEDULED reorganisation, and saying so
              -- is the point of letting the screen look at another date.
              EXISTS (SELECT 1 FROM department_period f
                       WHERE f.department_id = dep.id
                         AND f.valid_from > (SELECT on_date FROM d)) AS has_future_placement
         FROM department dep
         LEFT JOIN department_period p
                ON p.department_id = dep.id
               AND p.valid_period @> (SELECT on_date FROM d)
         LEFT JOIN department par ON par.id = p.parent_department_id
         LEFT JOIN employee h ON h.id = p.head_employee_id
        ORDER BY par.code NULLS FIRST, dep.code`,
      [on]);

    return { asOf: on, rows };
  }

  @Post('departments')
  @Authenticated()
  async createDepartment(@Req() req: Request, @Body() body: {
    code?: string; name?: string; description?: string;
    parentId?: string | null; effectiveFrom?: string;
  }) {
    await this.gate(req, 'org.unit.manage');
    const c = code(body?.code, 'Department code');
    const n = name(body?.name, 'Department name');
    const parentId = isUuid(body?.parentId) ? body.parentId : null;
    const from = isoDate(body?.effectiveFrom);

    try {
      const id = await this.db.tx(async (q) => {
        const created = await q(
          `INSERT INTO department (code, name, description) VALUES ($1, $2, $3) RETURNING id`,
          [c, n, body?.description ? String(body.description).slice(0, 500) : null]);
        const newId = created[0].id as string;

        // The department row and its first PLACEMENT are two facts. Creating one without the
        // other would leave a department that exists and sits nowhere - which the list endpoint
        // reports as `unplaced` precisely because the schema permits it.
        await q(
          `INSERT INTO department_period (department_id, parent_department_id, valid_from, reason)
           VALUES ($1, $2, COALESCE($3::date, fn_business_date()), $4)`,
          [newId, parentId, from, 'created']);
        return newId;
      });

      await this.audit('org.department.created', 'department', id, req,
        { code: c, name: n, parentId });
      return { id, code: c };
    } catch (e) { explain(e); }
  }

  /**
   * Rename. IDENTITY only - mutable by design (DEC-043).
   *
   * `temporal-data-rules.md` names a display name as the canonical thing that is NOT
   * effective-dated: a department that changes its name is the same department, and versioning
   * the label would make every historical query pick a name it then has to explain.
   */
  @Patch('departments/:id')
  @Authenticated()
  async renameDepartment(@Req() req: Request, @Param('id') id: string, @Body() body: {
    name?: string; description?: string;
  }) {
    await this.gate(req, 'org.unit.manage');
    if (!isUuid(id)) throw new NotFoundException('Not found');
    const n = body?.name === undefined ? null : name(body.name, 'Department name');

    try {
      const done = await this.db.rows(
        `UPDATE department
            SET name        = COALESCE($2, name),
                description = COALESCE($3, description),
                updated_at  = now()
          WHERE id = $1
        RETURNING code, name`,
        [id, n, body?.description === undefined ? null : String(body.description).slice(0, 500)]);
      if (done.length === 0) throw new NotFoundException('Not found');

      await this.audit('org.department.renamed', 'department', id, req, done[0]);
      return { ok: true, ...done[0] };
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      explain(e);
    }
  }

  /**
   * Re-parent. NOT an edit - a new period (Must-Know Rule 3).
   *
   * Closing the current placement and opening the next is the whole mechanism: last quarter's
   * cost allocation keeps resolving to last quarter's parent, and the reorganisation is a fact
   * with a date rather than an overwrite. The database refuses a back-dated close outright
   * (DEC-029) and refuses a parent inside this department's own subtree (0026), so both arrive
   * here as messages rather than as validation this endpoint has to remember.
   */
  @Post('departments/:id/reparent')
  @Authenticated()
  async reparentDepartment(@Req() req: Request, @Param('id') id: string, @Body() body: {
    parentId?: string | null; effectiveFrom?: string; reason?: string; headEmployeeId?: string | null;
  }) {
    await this.gate(req, 'org.unit.manage');
    if (!isUuid(id)) throw new NotFoundException('Not found');

    const dep = await this.db.one(`SELECT code FROM department WHERE id = $1`, [id]);
    if (!dep) throw new NotFoundException('Not found');

    const parentId = isUuid(body?.parentId) ? body.parentId : null;
    const head = isUuid(body?.headEmployeeId) ? body.headEmployeeId : null;
    const from = isoDate(body?.effectiveFrom);
    const reason = String(body?.reason ?? '').trim();
    if (reason.length < 3) {
      throw new BadRequestException(
        'Record why this is moving - a reorganisation without a reason is unexplainable later');
    }
    if (parentId === id) throw new BadRequestException('A department cannot be its own parent.');

    try {
      await this.db.tx(async (q) => {
        // Close the placement in force, forward-dated. If there is none the department is
        // unplaced and this simply opens its first.
        await q(
          `UPDATE department_period
              SET valid_to = COALESCE($2::date, fn_business_date())
            WHERE department_id = $1 AND valid_to IS NULL`,
          [id, from]);
        await q(
          `INSERT INTO department_period
             (department_id, parent_department_id, head_employee_id, valid_from, reason)
           VALUES ($1, $2, $3, COALESCE($4::date, fn_business_date()), $5)`,
          [id, parentId, head, from, reason.slice(0, 500)]);
      });

      await this.audit('org.department.reparented', 'department', id, req,
        { code: dep.code, parentId, effectiveFrom: from, reason: reason.slice(0, 200) });
      return { ok: true };
    } catch (e) { explain(e); }
  }

  // =========================================================================
  // Designations
  // =========================================================================
  @Get('designations')
  @Authenticated()
  async designations(@Req() req: Request) {
    await this.gate(req, 'org.designation.manage');
    const rows = await this.db.rows(
      `SELECT g.id, g.code, g.name, g.grade, g.description, g.retired_on,
              (g.retired_on IS NOT NULL AND g.retired_on <= fn_business_date()) AS retired,
              -- How many people hold it TODAY. Retiring a title that 40 people hold is a
              -- different act from retiring one nobody has, and the screen should say which.
              (SELECT count(*) FROM employment em
                WHERE em.designation_id = g.id
                  AND em.valid_period @> fn_business_date())::int AS holders
         FROM designation g
        ORDER BY (g.retired_on IS NOT NULL), g.grade DESC, g.name`);
    return { rows };
  }

  @Post('designations')
  @Authenticated()
  async createDesignation(@Req() req: Request, @Body() body: {
    code?: string; name?: string; grade?: number; description?: string;
  }) {
    await this.gate(req, 'org.designation.manage');
    const c = code(body?.code, 'Designation code');
    const n = name(body?.name, 'Designation name');
    const grade = Number(body?.grade);
    if (!Number.isInteger(grade) || grade < 1 || grade > 20) {
      throw new BadRequestException('Grade must be a whole number between 1 and 20');
    }

    try {
      const created = await this.db.rows(
        `INSERT INTO designation (code, name, grade, description)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [c, n, grade, body?.description ? String(body.description).slice(0, 500) : null]);
      const id = created[0].id as string;
      await this.audit('org.designation.created', 'designation', id, req, { code: c, name: n, grade });
      return { id, code: c };
    } catch (e) { explain(e); }
  }

  @Patch('designations/:id')
  @Authenticated()
  async renameDesignation(@Req() req: Request, @Param('id') id: string, @Body() body: {
    name?: string; description?: string; grade?: number;
  }) {
    await this.gate(req, 'org.designation.manage');
    if (!isUuid(id)) throw new NotFoundException('Not found');
    const n = body?.name === undefined ? null : name(body.name, 'Designation name');
    let grade: number | null = null;
    if (body?.grade !== undefined) {
      grade = Number(body.grade);
      if (!Number.isInteger(grade) || grade < 1 || grade > 20) {
        throw new BadRequestException('Grade must be a whole number between 1 and 20');
      }
    }

    try {
      const done = await this.db.rows(
        `UPDATE designation
            SET name = COALESCE($2, name),
                grade = COALESCE($3, grade),
                description = COALESCE($4, description),
                updated_at = now()
          WHERE id = $1
        RETURNING code, name, grade`,
        [id, n, grade,
          body?.description === undefined ? null : String(body.description).slice(0, 500)]);
      if (done.length === 0) throw new NotFoundException('Not found');
      await this.audit('org.designation.renamed', 'designation', id, req, done[0]);
      return { ok: true, ...done[0] };
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      explain(e);
    }
  }

  /**
   * Retire, or un-retire. A DATE, never a delete and never a flag (DEC-044).
   *
   * The historical `employment` rows keep pointing at it - which is the whole reason it is not a
   * delete - and `tg_employment_designation_active` refuses it for a NEW assignment from the
   * retirement date. Un-retiring is permitted because retiring the wrong title is an ordinary
   * mistake and the alternative would be creating a duplicate.
   */
  @Post('designations/:id/retire')
  @Authenticated()
  async retireDesignation(@Req() req: Request, @Param('id') id: string, @Body() body: {
    retiredOn?: string | null; reinstate?: boolean;
  }) {
    await this.gate(req, 'org.designation.manage');
    if (!isUuid(id)) throw new NotFoundException('Not found');

    const g = await this.db.one(
      `SELECT g.code, g.name,
              (SELECT count(*) FROM employment em
                WHERE em.designation_id = g.id
                  AND em.valid_period @> fn_business_date())::int AS holders
         FROM designation g WHERE g.id = $1`, [id]);
    if (!g) throw new NotFoundException('Not found');

    const reinstate = body?.reinstate === true;
    const on = reinstate ? null : (isoDate(body?.retiredOn) ?? null);

    try {
      await this.db.rows(
        `UPDATE designation
            SET retired_on = CASE WHEN $3::boolean THEN NULL
                                  ELSE COALESCE($2::date, fn_business_date()) END,
                updated_at = now()
          WHERE id = $1`,
        [id, on, reinstate]);
      await this.audit(
        reinstate ? 'org.designation.reinstated' : 'org.designation.retired',
        'designation', id, req, { code: g.code, retiredOn: on, holders: g.holders });
      // Said back to the caller rather than refused: retiring a title people still hold is a
      // legitimate act (nobody new gets it), but it should not be a surprise.
      return { ok: true, holders: g.holders as number, retired: !reinstate };
    } catch (e) { explain(e); }
  }
}

@Module({ controllers: [OrgController] })
export class OrgModule {}
