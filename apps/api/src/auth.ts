import {
  Body, CanActivate, Controller, ExecutionContext, ForbiddenException, Get, Global, Injectable,
  Module, Post, Req, Res, SetMetadata, UnauthorizedException, UseGuards, applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { Db } from './db';

/*
 * THE SESSION COOKIE, and why its name is computed rather than fixed.
 *
 * ADR-0010 specifies `__Host-hrm_session` with `Secure`. That prefix is not decoration: a browser
 * refuses a `__Host-` cookie unless it is Secure, Path=/ and carries NO Domain attribute, which
 * makes it impossible for a sibling subdomain to set or overwrite it. But a `Secure` cookie is
 * also refused over plain HTTP, so hardcoding it would break `http://localhost` development
 * outright - which is why this had stayed as the weaker form and was recorded as OR-21.
 *
 * Deriving both from one switch resolves that: development keeps a plain cookie over HTTP, and
 * any TLS deployment gets the full ADR-0010 form. The two can never drift apart, because the
 * prefix and the flag are computed from the same value - and a `__Host-` cookie without `Secure`
 * simply would not be stored by the browser, so a half-configured deployment fails loudly at
 * login rather than quietly downgrading.
 *
 * Set HRM_SECURE_COOKIES=true wherever the app is served over HTTPS. See .env.example.
 */
export const SECURE_COOKIES = process.env.HRM_SECURE_COOKIES === 'true';
export const COOKIE = SECURE_COOKIES ? '__Host-hrm_session' : 'hrm_session';

/** Mirrors ck_user_role_value in migration 0016. */
export type Role = 'employee' | 'manager' | 'hr_admin' | 'hr_ops' | 'finance' | 'auditor';

export interface Actor {
  userId: string;
  employeeId: string;
  employeeNumber: string;
  name: string;
  email: string;
  /**
   * Every role in force NOW, from `user_role` via `fn_user_roles`. Roles are ADDITIVE - a
   * manager is also an employee.
   *
   * ADR-0010: role, scope and employment status are read FRESH on every request and never cached
   * with a TTL, so a revoked grant or a disabled account takes effect on the next request rather
   * than at session expiry. That is the property that made stateless JWTs unacceptable.
   */
  roles: Role[];
  isBreakGlass: boolean;
  /** The non-secret per-session surrogate (session.id). Never the bearer token (ADR-0010). */
  sessionId: string;
  /**
   * TRANSITIONAL. The single legacy role from `app_user.role`, kept only so the controllers that
   * still read it keep working while they are retrofitted onto `@Authorize`. Migration 0016
   * marks the column superseded. Do not add new readers - use `roles`.
   */
  role: 'employee' | 'manager' | 'hr_admin';
}

/**
 * Authentication.
 *
 * WHAT IS NOW REAL (migration 0016):
 *   * Roles come from the effective-dated `user_role` table via `fn_user_roles`, resolved fresh
 *     on every request. Revoking a grant takes effect on the next request.
 *   * A disabled account and a locked account are refused, and the account records why.
 *   * Failed attempts are counted and throttled - NIST SP 800-63B r4 allows rate limiting and
 *     specifically does NOT want composition rules or forced rotation.
 *   * Every authentication outcome emits an audit row through `fn_audit_security`, including
 *     failures. `security-guidelines.md` lists permission-deny bursts as an alerting signal, so
 *     an unrecorded failure is a missing detection rather than a missing log line.
 *   * A break-glass authentication is flagged for alerting (ADR-0009 requires an alert, not
 *     merely an audit row).
 *
 * TRACK B, still outstanding and recorded rather than pretended away:
 *   * ADR-0009 specifies argon2id. This is scrypt. `app_user.password_algo` exists so the two
 *     can coexist during a rehash-on-login migration, which is why the column is there.
 *   * ADR-0010 makes Redis authoritative for session existence. This is still a Postgres row.
 *     Redis is running (port 55379, DEC-037) but nothing uses it yet.
 *   * Entra OIDC does not exist. `user_identity` is ready for it; the flow is not built, and it
 *     cannot be verified from this sandbox (no network, and no tenant).
 *   * The cookie now follows ADR-0010 when HRM_SECURE_COOKIES=true: `__Host-hrm_session` with
 *     `Secure`. Over plain HTTP it stays `hrm_session` without the flag, because a browser
 *     refuses both a Secure cookie on HTTP and a __Host- cookie without Secure. Half of OR-21
 *     closed; the other half - Redis as the authoritative session store - is still open.
 */
@Injectable()
export class AuthService {
  /** Lock after this many consecutive failures. */
  private static readonly MAX_FAILED = 10;
  private static readonly LOCK_MINUTES = 15;
  /** Rolling session window, and the absolute cap that activity cannot extend (ADR-0010). */
  private static readonly SESSION_HOURS = 12;
  private static readonly ABSOLUTE_DAYS = 7;

  constructor(private readonly db: Db) {}

  private static verify(plain: string, stored: string): boolean {
    const [scheme, N, r, p, salt, hash] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hash!, 'base64');
    const actual = scryptSync(plain, Buffer.from(salt!, 'base64'), expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
    });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Never passes a token or any hash of one - `fn_audit_security` takes session.id only. */
  private async audit(
    eventType: string,
    opts: {
      userId?: string | null; employeeId?: string | null; sessionId?: string | null;
      ip?: string | null; reason?: string | null; roles?: string[] | null;
    } = {},
  ) {
    try {
      await this.db.rows(
        `SELECT fn_audit_security($1, $2, $3, NULL, $4, NULL, $5, $6, $7)`,
        [eventType, opts.userId ?? null, opts.employeeId ?? null, opts.sessionId ?? null,
          opts.ip ?? null, opts.reason ?? null, opts.roles ?? null]);
    } catch (e) {
      // An audit write must never be the reason a login fails - but it must be loud.
      // eslint-disable-next-line no-console
      console.error('AUDIT WRITE FAILED', eventType, (e as Error).message);
    }
  }

  async login(email: string, password: string, ip: string | null):
  Promise<{ token: string; actor: Actor }> {
    const row = await this.db.one(
      `SELECT u.id AS user_id, u.password_hash, u.password_algo, u.role, u.is_enabled,
              u.is_break_glass, u.locked_until, u.failed_login_count, u.disabled_reason,
              e.id AS employee_id, e.employee_number, e.full_name, e.work_email, e.status
         FROM app_user u LEFT JOIN employee e ON e.id = u.employee_id
        WHERE lower(u.email) = lower($1)`, [email]);

    const deny = async (reason: string) => {
      await this.audit('identity.login.failed', {
        userId: row?.user_id ?? null, employeeId: row?.employee_id ?? null, ip, reason,
      });
      // One message for every failure mode - never leak which check failed.
      throw new UnauthorizedException('Email or password is incorrect');
    };

    if (!row) return deny('no_such_account') as never;

    if (row.locked_until && new Date(row.locked_until) > new Date()) {
      return deny('account_locked') as never;
    }
    if (!row.is_enabled) return deny(`account_disabled:${row.disabled_reason ?? 'unknown'}`) as never;
    if (!row.password_hash) return deny('no_local_credential') as never;

    if (!AuthService.verify(password, row.password_hash)) {
      // Count the failure and lock once the ceiling is reached.
      await this.db.rows(
        `UPDATE app_user
            SET failed_login_count = failed_login_count + 1,
                locked_until = CASE WHEN failed_login_count + 1 >= $2
                                    THEN now() + ($3 || ' minutes')::interval END
          WHERE id = $1`,
        [row.user_id, AuthService.MAX_FAILED, AuthService.LOCK_MINUTES]);
      return deny('bad_password') as never;
    }

    // An account whose employment has ended must not authenticate even if the revocation
    // trigger has not fired yet - belt and braces around fn_revoke_access_on_exit.
    if (row.status === 'exited') return deny('employment_ended') as never;

    const roles = await this.rolesFor(row.user_id);

    const token = randomBytes(32).toString('base64url');
    const session = await this.db.one(
      `INSERT INTO session (token_hash, user_id, expires_at, absolute_expires_at, created_ip)
       VALUES ($1, $2, now() + ($3 || ' hours')::interval,
                          now() + ($4 || ' days')::interval, $5)
       RETURNING id`,
      [AuthService.hashToken(token), row.user_id,
        AuthService.SESSION_HOURS, AuthService.ABSOLUTE_DAYS, ip]);

    await this.db.rows(
      `UPDATE app_user SET last_login_at = now(), failed_login_count = 0, locked_until = NULL
        WHERE id = $1`, [row.user_id]);

    // ADR-0009: every break-glass authentication raises an ALERT, not merely an audit row.
    await this.audit(
      row.is_break_glass ? 'identity.login.break_glass' : 'identity.login.succeeded',
      {
        userId: row.user_id, employeeId: row.employee_id, sessionId: session!.id, ip,
        reason: row.is_break_glass ? 'ALERT: break-glass credential used' : 'password',
        roles,
      });

    return {
      token,
      actor: {
        userId: row.user_id, employeeId: row.employee_id, employeeNumber: row.employee_number,
        name: row.full_name, email: row.work_email,
        roles, isBreakGlass: row.is_break_glass, sessionId: session!.id,
        role: row.role,
      },
    };
  }

  /** Roles in force NOW. Never cached across requests (ADR-0010). */
  private async rolesFor(userId: string): Promise<Role[]> {
    const r = await this.db.one(`SELECT fn_user_roles($1) AS roles`, [userId]);
    return (r?.roles ?? []) as Role[];
  }

  async actorFor(token: string | undefined): Promise<Actor | null> {
    if (!token) return null;
    const row = await this.db.one(
      `SELECT s.id AS session_id, u.id AS user_id, u.role, u.is_break_glass,
              e.id AS employee_id, e.employee_number, e.full_name, e.work_email, e.status
         FROM session s
         JOIN app_user u ON u.id = s.user_id
         LEFT JOIN employee e ON e.id = u.employee_id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND s.absolute_expires_at > now()
          AND u.is_enabled`,
      [AuthService.hashToken(token)]);
    if (!row) return null;

    // Employment status is an authorization input, so it is read fresh too. A session that
    // survived the revocation trigger still stops working here.
    if (row.status === 'exited') return null;

    await this.db.rows(`UPDATE session SET last_seen_at = now() WHERE id = $1`, [row.session_id]);

    return {
      userId: row.user_id, employeeId: row.employee_id, employeeNumber: row.employee_number,
      name: row.full_name, email: row.work_email,
      roles: await this.rolesFor(row.user_id),
      isBreakGlass: row.is_break_glass,
      sessionId: row.session_id,
      role: row.role,
    };
  }

  async logout(token: string | undefined, ip: string | null) {
    if (!token) return;
    const row = await this.db.one(
      `UPDATE session SET revoked_at = now(), revoked_reason = 'signed out'
        WHERE token_hash = $1 AND revoked_at IS NULL
        RETURNING id, user_id`,
      [AuthService.hashToken(token)]);
    if (row) {
      await this.audit('identity.session.ended', {
        userId: row.user_id, sessionId: row.id, ip, reason: 'signed out',
      });
    }
  }
}

const ROLES = 'hrm:roles';
export const Roles = (...roles: Actor['role'][]) => SetMetadata(ROLES, roles);

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly auth: AuthService, private readonly reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { actor?: Actor }>();
    const actor = await this.auth.actorFor(req.cookies?.[COOKIE]);
    if (!actor) throw new UnauthorizedException('Not signed in');
    req.actor = actor;

    /*
     * TRANSITIONAL COARSE GATE, and it is a Must-Know Rule 1 violation by construction.
     *
     * `packages/authz` now exists with a real AuthorizationService, a policy per action and a
     * matrix suite (308 assertions). What does NOT yet exist is the retrofit: these routes are
     * still annotated `@Authenticated('manager','hr_admin')` rather than
     * `@Authorize('work.timesheet.approve')`, and 29 of them need converting together with the
     * queries whose `scope()` predicate they must compose.
     *
     * It now checks `roles` rather than the single legacy column, so a revoked grant is honoured
     * immediately - but it is still a role comparison outside packages/authz. Tracked as the
     * next slice; see .claude/state/CURRENT_SLICE.md.
     */
    const required = this.reflector.getAllAndOverride<Actor['role'][]>(ROLES, [
      ctx.getHandler(), ctx.getClass(),
    ]);
    if (required?.length && !required.some((r) => actor.roles.includes(r as Role))) {
      throw new ForbiddenException('Your role does not allow this');
    }
    return true;
  }
}

export const Authenticated = (...roles: Actor['role'][]) =>
  applyDecorators(UseGuards(SessionGuard), Roles(...roles));

export const currentActor = (req: Request): Actor => (req as any).actor as Actor;

/** Client IP for the audit trail. Never logged as PII beyond the audit row itself. */
const clientIp = (req: Request): string | null => {
  const raw = (req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
  return raw && raw !== '::1' ? raw : null;
};

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  async login(
    @Body() body: { email?: string; password?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const email = (body?.email ?? '').trim();
    const password = body?.password ?? '';
    if (!email || !password) throw new UnauthorizedException('Email and password are required');

    const { token, actor } = await this.auth.login(email, password, clientIp(req));
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      // `path: '/'` and no `domain` are REQUIRED by the __Host- prefix, not merely conventional.
      path: '/',
      secure: SECURE_COOKIES,
      maxAge: 12 * 60 * 60 * 1000,
    });
    return { actor };
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[COOKIE], clientIp(req));
    // The clearing cookie must carry the same attributes as the one it replaces, or the browser
    // treats it as a different cookie and the original survives the logout.
    res.clearCookie(COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: SECURE_COOKIES });
    return { ok: true };
  }

  @Get('me')
  @Authenticated()
  me(@Req() req: Request) {
    return { actor: currentActor(req) };
  }
}

@Global()
@Module({
  providers: [AuthService, SessionGuard],
  controllers: [AuthController],
  exports: [AuthService, SessionGuard],
})
export class AuthModule {}
