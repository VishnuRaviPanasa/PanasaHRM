import { Global, Injectable, Module } from '@nestjs/common';
import {
  AuthorizationService, type AuthContext, type AuthzAuditSink, type GraphPort, type Role,
} from '@panasa/authz';
import type { Request } from 'express';
import { Db } from './db';
import { currentActor, type Actor } from './auth';

/**
 * The application's binding to `packages/authz`.
 *
 * This is the FIRST place the real AuthorizationService is actually enforced rather than merely
 * tested. The documents module uses it; the other 29 routes are still on the transitional
 * `@Authenticated(...roles)` gate (OR-19), and this file is the pattern their retrofit follows.
 *
 * `GraphPort` is implemented against migration 0014's resolvers rather than by re-walking the
 * hierarchy in TypeScript. That is not laziness: `fn_reporting_subtree_asof` is depth-capped and
 * cycle-guarded and has 25 database checks behind it, and a hand-rolled JS walk would have to
 * re-earn all of that while being able to disagree with the SQL the scope predicates compose.
 */
@Injectable()
export class DbGraphPort implements GraphPort {
  constructor(private readonly db: Db) {}

  async isDirectReport(manager: string, employee: string, asOf: string): Promise<boolean> {
    const r = await this.db.one(
      `SELECT fn_is_direct_report_asof($1, $2, $3::date) AS ok`, [manager, employee, asOf]);
    return r?.ok === true;
  }

  async isInSubtree(manager: string, employee: string, asOf: string): Promise<boolean> {
    const r = await this.db.one(
      `SELECT fn_is_in_subtree_asof($1, $2, $3::date) AS ok`, [manager, employee, asOf]);
    return r?.ok === true;
  }

  /**
   * OR-17 IS CLOSED. `project_member` became effective-dated in migration 0019, so the project
   * scope graph now decays exactly like the reporting graph: somebody rolled off a project loses
   * access from the day their membership period closes, without their logged effort being
   * deleted or last quarter's report changing.
   *
   * `asOf` was previously accepted and ignored, which the code said so plainly. It is now
   * honoured by `fn_is_project_member_asof`.
   */
  async isProjectMember(
    employee: string, projectId: string, roles?: readonly string[], asOf?: string,
  ): Promise<boolean> {
    const r = await this.db.one(
      `SELECT fn_is_project_member_asof($1, $2, COALESCE($3::date, fn_business_date()), $4::text[])
              AS ok`,
      [employee, projectId, asOf ?? null, roles && roles.length ? [...roles] : null]);
    return r?.ok === true;
  }
}

/**
 * Every authorization DENY, and every allow carrying an `audit_read` obligation, lands in
 * `audit_event`.
 *
 * `security-guidelines.md` lists permission-deny bursts among the things that must be ALERTED on
 * rather than merely logged - so a denial nobody recorded is a missing detection, not a missing
 * log line. Recording allows too (where the policy asked for it) is what makes a bulk export
 * visible: one HR admin reading one document is routine, and the same admin reading two hundred
 * in an hour is not, and only the individual rows can tell them apart.
 */
@Injectable()
export class AuditSink implements AuthzAuditSink {
  constructor(private readonly db: Db) {}

  async record(entry: {
    action: string; decision: 'allow' | 'deny'; reasonCode: string;
    ctx: AuthContext; ref: { type: string; id?: string | undefined;
      subjectEmployeeId?: string | undefined };
  }): Promise<void> {
    try {
      await this.db.rows(
        `INSERT INTO audit_event (
            source, event_type, actor_kind, actor_user_id, actor_employee_id, actor_roles,
            subject_employee_id, subject_type, session_id, correlation_id, reason, row_pk)
         VALUES ('application', $1, 'user', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          `authz.${entry.decision}`,
          entry.ctx.userId,
          entry.ctx.employeeId,
          [...entry.ctx.roles],
          entry.ref.subjectEmployeeId ?? null,
          entry.ref.type,
          entry.ctx.sessionId ?? null,
          entry.ctx.correlationId ?? null,
          // The action and the reason CODE. Never a data value - the reason codes are a closed
          // set produced by the policy engine.
          `${entry.action}:${entry.reasonCode}`,
          entry.ref.id ?? null,
        ]);
    } catch (e) {
      // An audit failure must not become an authorization failure - that would let a full disk
      // deny every request. But it must be loud.
      // eslint-disable-next-line no-console
      console.error('AUTHZ AUDIT WRITE FAILED', entry.action, (e as Error).message);
    }
  }
}

@Injectable()
export class Authz extends AuthorizationService {
  constructor(graph: DbGraphPort, audit: AuditSink) {
    super(graph, audit);
  }
}

/**
 * Build the authorization context from the session actor.
 *
 * ADR-0010: roles are already resolved fresh per request by `AuthService.actorFor`, never cached
 * across requests. This only reshapes them.
 */
export function authContext(req: Request): AuthContext {
  const actor: Actor = currentActor(req);
  return {
    userId: actor.userId,
    employeeId: actor.employeeId ?? null,
    roles: actor.roles as Role[],
    isBreakGlass: actor.isBreakGlass,
    sessionId: actor.sessionId,
    correlationId: (req.headers['x-correlation-id'] as string | undefined) ?? undefined,
  };
}

@Global()
@Module({
  providers: [DbGraphPort, AuditSink, Authz],
  exports: [Authz],
})
export class AuthzModule {}
