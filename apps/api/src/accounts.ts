import {
  BadRequestException, Body, Controller, Get, Module, NotFoundException, Param, Post, Req,
} from '@nestjs/common';
import { AuthzDeniedError, type Action } from '@panasa/authz';
import { createHash, randomInt, randomBytes, scryptSync } from 'node:crypto';
import type { Request } from 'express';
import { Authenticated, currentActor } from './auth';
import { Authz, authContext } from './authz';
import { Db } from './db';

/**
 * Account provisioning: how an employee who has never signed in gets a way in.
 *
 * THIS CLOSED A GAP THAT HAD BEEN OPEN SINCE 0009. `POST /employees` created people; nothing
 * created their logins. The only `INSERT INTO app_user` in the whole repository was the demo seed,
 * so every account in the running system was placed there by `npm run db:seed` and HR could create
 * an employee who was structurally incapable of authenticating. It was reported repeatedly as
 * "there is no account-creation path", which understated how much was already built: the schema,
 * the six-role effective-dated grant table, and five `identity.*` matrix rows were all waiting.
 * What was missing was this file.
 *
 * HR NEVER LEARNS ANYBODY'S PASSWORD. The obvious shortcut - HR types an initial password and
 * tells the employee - is what the reference application does, and it means a working credential
 * for a real person exists in a mailbox and in the memory of whoever typed it. Instead an account
 * is created with NO credential (legal since 0009: `password_hash` is nullable) and the system
 * mints a single-use activation code. The employee spends it and chooses their own password.
 * Nobody else ever knows it - not HR, not this process, not the database, not the log.
 *
 * NO EXTERNAL SERVICE IS INVOLVED. The code is returned to HR exactly once, to hand over. That is
 * not a limitation reluctantly accepted: an SMTP dependency on this path would be a Rule 12
 * violation needing the outbox and a drain worker that does not exist yet (settings.ts:39), and
 * for one site with a few dozen people a code read out loud is fewer moving parts than a mail
 * relay that can be down.
 *
 * ISSUING A CODE IS NOT A PASSWORD RESET, and the difference is the whole security story.
 * Provisioning hands entry to an account that nobody holds yet; a reset hands entry to an account
 * somebody already holds, and belongs to the holder, proven by something they have. Conflate them
 * and this endpoint becomes an account-takeover primitive: whoever can call it mints a code for
 * the HR Manager's live account and sets its password. **Migration 0029 refuses an activation for
 * any account that already has a credential**, so the distinction is a database rail rather than a
 * rule this file has to remember - and `identity.account.reissue` is a separate action from
 * `identity.account.create` so it can be tightened without touching the other (DEC-115).
 *
 * ROLES ARE A GRANT, NOT A COLUMN. `fn_user_roles` resolves an actor's roles from the
 * effective-dated `user_role` table as-of `fn_business_date()`; `app_user.role` is denormalised
 * and only the login lookup reads it. An account created without a `user_role` row would therefore
 * authenticate successfully and then be able to do nothing at all. Both are written, in one
 * transaction, and roles are ADDITIVE exactly as the seed has them - a manager is granted
 * `manager` and `employee`.
 */

const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);

/**
 * Every role, for both provisioning and granting.
 *
 * THESE WERE TWO DIFFERENT LISTS AND SHOULD NOT HAVE BEEN. When provisioning shipped,
 * `ck_app_user_role` genuinely permitted only `employee`, `manager` and `hr_admin` on the account
 * row while `ck_user_role_value` permitted six on the grant, so writing a wider role would have
 * left the two disagreeing - and the endpoint refused it, correctly, with the gap recorded as
 * DEC-129. **Migration 0031 then widened the column to all seven and closed that gap**, which is
 * stated in its own header - but this constant was left at three, so the Create login screen went
 * on offering exactly the roles the database had stopped objecting to. Reported from the screen:
 * "only 3 roles are there, how can I create a finance head?"
 *
 * The distinction that remains is real but is not about which roles are allowed: provisioning
 * writes `app_user.role`, a denormalised column the login lookup reads, AND a `user_role` grant;
 * granting writes only the latter, which is the effective-dated table `fn_user_roles` resolves and
 * the only one authorization consults. Same set, two moments.
 */
const GRANTABLE = ['employee', 'manager', 'hr_admin', 'hr_ops', 'finance', 'auditor',
  'delivery_head'] as const;
const PROVISIONABLE = GRANTABLE;
type ProvisionableRole = (typeof PROVISIONABLE)[number];

/**
 * The activation code alphabet: 30 characters with every look-alike removed - no 0/O, no 1/I/L,
 * and no U (which is read as V often enough to matter). Somebody is going to read this down a
 * corridor or copy it off a sticky note, and a code that cannot be transcribed is a support call.
 *
 * 20 characters over 30 symbols is ~98 bits. `randomInt` is used rather than `randomBytes % 30`
 * because the modulo is biased - 256 is not a multiple of 30, so six symbols would be ~17% more
 * likely than the rest, which is exactly the kind of quiet weakening nobody notices.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 20;
const ACTIVATION_DAYS = 7;

function mintCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  // Grouped for reading aloud. The groups are cosmetic - `normaliseCode` strips them.
  return out.replace(/(.{5})(?=.)/g, '$1-');
}

/** Uppercase, drop anything that is not in the alphabet. Tolerates spaces, dashes and lowercase. */
const normaliseCode = (v: unknown): string =>
  String(v ?? '').toUpperCase().split('').filter((c) => CODE_ALPHABET.includes(c)).join('');

const hashCode = (code: string): string => createHash('sha256').update(code).digest('hex');

/**
 * scrypt, in the exact `scrypt$N$r$p$salt$hash` shape `AuthService.verify` parses and
 * `scripts/seed.mjs` produces. A password set here must be verifiable by the login path, so the
 * format is copied deliberately rather than re-invented.
 *
 * TRACK B, unchanged by this file: ADR-0009 specifies argon2id, and `password_algo` exists so the
 * two can coexist during a rehash-on-login migration. Writing argon2id here while the verifier
 * only understands scrypt would lock the employee out of the account they just activated.
 */
function hashPassword(plain: string): string {
  const N = 16384, r = 8, p = 1, keylen = 64;
  const salt = randomBytes(16);
  const dk = scryptSync(plain, salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', N, r, p, salt.toString('base64'), dk.toString('base64')].join('$');
}

/**
 * ADR-0009 binds the password policy to NIST SP 800-63B Rev 4: **length plus a breached-password
 * blocklist, no composition rules, no forced rotation**. So there is deliberately no
 * "one uppercase, one digit, one symbol" check here - those rules measurably push people towards
 * `Password1!` and the ADR rules them out by name.
 *
 * The breach blocklist is TRACK B and is NOT implemented - it needs a corpus this repository does
 * not carry. What is checked is the subset that needs no data: the length floor, and the handful of
 * values that are guaranteed-bad *for this particular account* because the attacker already knows
 * them. Recorded as a gap rather than presented as the ADR's blocklist.
 */
function passwordProblem(password: string, context: string[]): string | null {
  if (password.length < 12) return 'Choose a password of at least 12 characters';
  // NIST asks that long passphrases be accepted; the cap only stops a hashing-cost denial.
  if (password.length > 128) return 'That password is longer than 128 characters';
  if (/^(.)\1+$/.test(password)) return 'That password is a single repeated character';
  const flat = password.toLowerCase();
  for (const c of context) {
    if (c && c.length >= 4 && flat.includes(c.toLowerCase())) {
      return 'Do not use your name, email address or the activation code in your password';
    }
  }
  return null;
}

/*
 * `identity`, not `people`. The employee master lives under `@Controller('people')` and it was
 * tempting to hang these off it - but an account is `identity`'s aggregate, and a module that
 * publishes its routes under another module's prefix is a boundary violation that reads as
 * harmless right up until somebody moves one of them. `ai/context/architecture-principles.md`
 * lists the two as separate bounded contexts with `identity` depended on by all.
 */
@Controller('identity')
export class AccountsController {
  constructor(private readonly db: Db, private readonly authz: Authz) {}

  private async gate(req: Request, action: Action, subjectEmployeeId?: string) {
    const ctx = authContext(req);
    try {
      await this.authz.assertCan(ctx, action, {
        type: 'employee',
        ...(subjectEmployeeId ? { id: subjectEmployeeId, subjectEmployeeId } : {}),
      });
    } catch (e) {
      // A denial is a 404, so the existence of an account is not readable by probing.
      if (e instanceof AuthzDeniedError) throw new NotFoundException('Not found');
      throw e;
    }
    return ctx;
  }

  // =========================================================================
  /**
   * What is the state of this employee's login? Never the code.
   *
   * Three states the UI has to tell apart: no account, an account with a live code outstanding,
   * and an activated account. The code itself is unreadable here even for the person who issued
   * it - it exists in the response to `create` and nowhere else, which is what makes "single use"
   * true rather than aspirational.
   */
  @Get('accounts/by-employee/:employeeId')
  @Authenticated()
  async state(@Req() req: Request, @Param('employeeId') employeeId: string) {
    if (!isUuid(employeeId)) throw new BadRequestException('Not a valid employee');
    await this.gate(req, 'identity.account.create', employeeId);

    const row = await this.db.one(
      /*
       * `activated` is `password_hash IS NOT NULL`, NOT `password_set_at IS NOT NULL`.
       * `password_set_at` is nullable and the demo seed never populates it, so every seeded
       * account read as un-activated - which is also the bug that made a reissue for a live
       * account fall through to the database rail instead of the readable message. The CREDENTIAL
       * is the fact; the timestamp is a convenience, exactly as ADR-0009 argues for the
       * `password_hash IS NULL` CHECK over a boolean flag.
       */
      `SELECT u.id, u.email, u.is_enabled, u.password_hash IS NOT NULL AS activated,
              u.last_login_at, fn_user_roles(u.id) AS roles,
              (SELECT count(*) FROM user_activation a WHERE a.user_id = u.id) AS issued,
              (SELECT a.expires_at FROM user_activation a
                WHERE a.user_id = u.id AND a.consumed_at IS NULL
                  AND a.expires_at > now()) AS live_expires_at
         FROM app_user u
        WHERE u.employee_id = $1`, [employeeId]);

    if (!row) return { hasAccount: false, grantable: GRANTABLE };
    return {
      hasAccount: true,
      userId: row.id as string,
      email: row.email as string,
      isEnabled: row.is_enabled as boolean,
      activated: row.activated as boolean,
      lastLoginAt: row.last_login_at,
      roles: (row.roles ?? []) as string[],
      activationsIssued: Number(row.issued ?? 0),
      liveActivationExpiresAt: row.live_expires_at,
      grants: await this.db.rows(
        `SELECT role, valid_from::text AS valid_from, valid_to::text AS valid_to, reason,
                (valid_period @> fn_business_date()) AS in_force,
                g.full_name AS granted_by_name
           FROM user_role ur
           LEFT JOIN employee g ON g.id = ur.granted_by
          WHERE ur.user_id = $1
          ORDER BY (valid_period @> fn_business_date()) DESC, valid_from DESC`, [row.id]),
      grantable: GRANTABLE,
    };
  }

  // =========================================================================
  /**
   * Grant a role. ADDITIVE - roles are a set, not a slot, so this never replaces anything.
   *
   * NOBODY GRANTS THEMSELVES A ROLE, and that refusal is the important line in this file. An HR
   * admin who could give themselves `finance` would be able to approve the salary annexures they
   * prepared - the separation of duty the whole onboarding chain is built on, undone in two
   * clicks, by the one person the chain most needs to keep out of the approval. The database's
   * `ck_sae_no_self_approval` does not help here: it stops somebody approving their OWN package,
   * not approving everybody else's with a role they awarded themselves.
   *
   * `identity.role.grant` is already break-glass-denied in the policy, for the same family of
   * reason: a sealed credential exists to restore access, not to mint privilege.
   */
  @Post('accounts/:userId/roles')
  @Authenticated()
  async grantRole(
    @Req() req: Request,
    @Param('userId') userId: string,
    @Body() body: { role?: string; reason?: string },
  ) {
    if (!isUuid(userId)) throw new BadRequestException('Not a valid account');
    const target = await this.db.one(
      `SELECT id, employee_id, is_break_glass FROM app_user WHERE id = $1`, [userId]);
    if (!target) throw new NotFoundException('Not found');
    await this.gate(req, 'identity.role.grant', target.employee_id as string | undefined);
    const me = currentActor(req);

    if (me.userId === userId) {
      throw new BadRequestException(
        'You cannot grant yourself a role. Ask another administrator.');
    }
    if (target.is_break_glass) {
      throw new BadRequestException('Break-glass accounts are sealed and excluded from this.');
    }

    const role = String(body?.role ?? '');
    if (!(GRANTABLE as readonly string[]).includes(role)) {
      throw new BadRequestException(`Role must be one of ${GRANTABLE.join(', ')}`);
    }
    const reason = String(body?.reason ?? '').trim().slice(0, 500) || 'granted by HR';

    try {
      await this.db.tx(async (q) => {
        /*
         * `valid_from` is the business date, so the grant takes effect today and never earlier.
         * Back-dating a privilege would mean an audit trail in which somebody held a role during a
         * period they demonstrably did not - which is worse than useless when the question being
         * asked later is "who could have approved this at the time".
         */
        await q(
          `INSERT INTO user_role (user_id, role, valid_from, granted_by, reason)
           VALUES ($1, $2, fn_business_date(), $3, $4)`,
          [userId, role, me.employeeId, reason]);
        await q(
          `INSERT INTO audit_event (source, event_type, actor_kind, actor_user_id,
                                    actor_employee_id, actor_roles, subject_employee_id,
                                    subject_type, session_id, row_pk, table_name, field_classes,
                                    after)
           VALUES ('application', 'identity.role.granted', 'user', $1, $2, $3, $4, 'employee', $5,
                   $6, 'user_role', ARRAY['SENSITIVE'], $7::jsonb)`,
          [me.userId, me.employeeId, me.roles, target.employee_id, me.sessionId, userId,
            JSON.stringify({ role, reason })]);
        await q(
          `INSERT INTO outbox_event (event_type, aggregate_type, aggregate_id, payload,
                                     actor_user_id)
           VALUES ('identity.role.granted', 'app_user', $1, $2::jsonb, $3)`,
          [userId, JSON.stringify({ role }), me.userId]);
      });
      return { ok: true, role };
    } catch (e) {
      throw AccountsController.explain(e);
    }
  }

  /**
   * Revoke a role by CLOSING ITS PERIOD, which is the only thing Rule 3 permits.
   *
   * There is no delete. `fn_block_historical_mutation` refuses one outright and permits exactly
   * one kind of UPDATE: setting `valid_to` on the currently-open period, to a date no earlier than
   * the business date. So the grant stays in the record forever and stops being in force from
   * today - which is what makes "who could have approved this in March" answerable at all.
   *
   * TWO REFUSALS, both about not locking the organisation out of itself:
   *   * `employee` cannot be revoked. Every account is also an employee and most of what anybody
   *     does they do as one; removing it would leave a login that can reach almost nothing.
   *   * THE LAST HR ADMIN cannot be revoked. Nobody would be able to grant it back - there is no
   *     other path to that role in the product - so the organisation would be locked out of its
   *     own administration with only a database console to recover. This is a CONTROLLER check
   *     and honestly a weaker rail than the database ones elsewhere in this file; it is here
   *     because the alternative is a statement-level trigger counting rows across the table, and
   *     the failure it prevents is operational rather than a matter of integrity.
   */
  @Post('accounts/:userId/roles/:role/revoke')
  @Authenticated()
  async revokeRole(
    @Req() req: Request,
    @Param('userId') userId: string,
    @Param('role') role: string,
    @Body() body: { reason?: string },
  ) {
    if (!isUuid(userId)) throw new BadRequestException('Not a valid account');
    const target = await this.db.one(
      `SELECT id, employee_id FROM app_user WHERE id = $1`, [userId]);
    if (!target) throw new NotFoundException('Not found');
    await this.gate(req, 'identity.role.revoke', target.employee_id as string | undefined);
    const me = currentActor(req);

    if (role === 'employee') {
      throw new BadRequestException(
        'Every account is also an employee. That role cannot be removed.');
    }

    if (role === 'hr_admin') {
      const others = await this.db.one(
        `SELECT count(*)::int AS n
           FROM user_role ur
          WHERE ur.role = 'hr_admin'
            AND ur.valid_period @> fn_business_date()
            AND ur.user_id <> $1`, [userId]);
      if (Number(others?.n ?? 0) === 0) {
        throw new BadRequestException(
          'This is the last HR administrator. Grant the role to somebody else first, or nobody '
          + 'will be able to grant it back.');
      }
    }

    const reason = String(body?.reason ?? '').trim().slice(0, 500);
    if (reason.length < 3) {
      throw new BadRequestException('A reason is required, and is what makes this reviewable later');
    }

    /*
     * WHEN THE REVOCATION TAKES EFFECT, and why it is not always "now".
     *
     * A grant is a PERIOD, and `ck_user_role_not_empty` refuses an empty one - so a role granted
     * TODAY cannot also end today, because `[today, today)` contains no days and a role held for
     * zero days is not a thing the model can say. Closing at `valid_from + 1` in that case is the
     * honest answer: they did hold it today, and it lapses tomorrow.
     *
     * For every grant made before today - which is the ordinary case - `valid_to = today` on a
     * half-open period means the role is NOT in force today, so the revocation is immediate.
     *
     * This is a real one-day exposure on a same-day grant-then-revoke, and it is a property of
     * effective dating rather than an oversight. The immediate kill switch for a compromised
     * account is disabling the ACCOUNT (`app_user.is_enabled`, `disabled_at`), which is a
     * different act - and one this product does not yet expose an endpoint for.
     */
    const open = await this.db.one(
      `SELECT id, valid_from::text AS valid_from,
              GREATEST(fn_business_date(), valid_from + 1)::text AS ends_on,
              GREATEST(fn_business_date(), valid_from + 1) > fn_business_date() AS deferred
         FROM user_role
        WHERE user_id = $1 AND role = $2 AND valid_period @> fn_business_date()`,
      [userId, role]);
    if (!open) throw new BadRequestException('That role is not currently held.');

    try {
      await this.db.tx(async (q) => {
        await q(
          `UPDATE user_role
              SET valid_to = GREATEST(fn_business_date(), valid_from + 1), reason = $2
            WHERE id = $1`,
          [open.id, reason]);
        await q(
          `INSERT INTO audit_event (source, event_type, actor_kind, actor_user_id,
                                    actor_employee_id, actor_roles, subject_employee_id,
                                    subject_type, session_id, row_pk, table_name, field_classes,
                                    after)
           VALUES ('application', 'identity.role.revoked', 'user', $1, $2, $3, $4, 'employee', $5,
                   $6, 'user_role', ARRAY['SENSITIVE'], $7::jsonb)`,
          [me.userId, me.employeeId, me.roles, target.employee_id, me.sessionId, userId,
            JSON.stringify({ role, reason })]);
        await q(
          `INSERT INTO outbox_event (event_type, aggregate_type, aggregate_id, payload,
                                     actor_user_id)
           VALUES ('identity.role.revoked', 'app_user', $1, $2::jsonb, $3)`,
          [userId, JSON.stringify({ role }), me.userId]);
      });
      return { ok: true, role, endsOn: open.ends_on as string, deferred: !!open.deferred };
    } catch (e) {
      throw AccountsController.explain(e);
    }
  }

  // =========================================================================
  /**
   * Create the login, and mint its first activation code.
   *
   * THE EMAIL IS DERIVED, NOT SUPPLIED. It is the employee's `work_email` from the master record,
   * which `POST /employees` already validated. An independent field here could be typed
   * differently from the directory, and then "who is jsmith@?" has two answers - so there is no
   * field to get wrong.
   */
  @Post('accounts')
  @Authenticated()
  async create(@Req() req: Request, @Body() body: { employeeId?: string; role?: string }) {
    const employeeId = body?.employeeId;
    if (!isUuid(employeeId)) throw new BadRequestException('Not a valid employee');
    await this.gate(req, 'identity.account.create', employeeId);
    const me = currentActor(req);

    const role = String(body?.role ?? 'employee') as ProvisionableRole;
    if (!PROVISIONABLE.includes(role)) {
      throw new BadRequestException(`Role must be one of ${PROVISIONABLE.join(', ')}`);
    }

    const emp = await this.db.one(
      `SELECT id, employee_number, full_name, work_email, status FROM employee WHERE id = $1`,
      [employeeId]);
    if (!emp) throw new NotFoundException('Not found');
    if (!emp.work_email) {
      throw new BadRequestException('This employee has no work email address to sign in with');
    }

    const existing = await this.db.one(
      `SELECT id, password_hash IS NOT NULL AS has_password FROM app_user WHERE employee_id = $1`,
      [employeeId]);
    if (existing) {
      throw new BadRequestException(existing.has_password
        ? 'This employee already has an active login'
        : 'This employee already has a login awaiting activation - reissue its code instead');
    }

    const code = mintCode();

    try {
      const userId = await this.db.tx(async (q) => {
        const created = await q(
          `INSERT INTO app_user (employee_id, email, role) VALUES ($1, $2, $3) RETURNING id`,
          [employeeId, String(emp.work_email).toLowerCase(), role]);
        const newId = created[0].id as string;

        /*
         * The role GRANT, which is what authorization actually reads. Valid from the company's
         * business date rather than the joining date: the account exists from now, and dating it
         * back would need the `hrm.allow_backdated_period` rail opened for no reason.
         *
         * Additive, as the seed has it - a manager holds `manager` AND `employee`, because most
         * of what a manager does they do as an employee.
         */
        await q(
          `INSERT INTO user_role (user_id, role, valid_from, granted_by, reason)
           VALUES ($1, $2, fn_business_date(), $3, 'account provisioned by HR')`,
          [newId, role, me.employeeId]);
        if (role !== 'employee') {
          await q(
            `INSERT INTO user_role (user_id, role, valid_from, granted_by, reason)
             VALUES ($1, 'employee', fn_business_date(), $2,
                     'every account is also an employee')`,
            [newId, me.employeeId]);
        }

        await q(
          `INSERT INTO user_activation (user_id, token_hash, issued_by_user_id, expires_at)
           VALUES ($1, $2, $3, now() + ($4 || ' days')::interval)`,
          [newId, hashCode(normaliseCode(code)), me.userId, String(ACTIVATION_DAYS)]);

        /*
         * Audit and outbox INSIDE the transaction (Rule 2). `people.ts` writes its audit row
         * after the transaction commits and swallows the failure, which is survivable for a name
         * change; for "somebody was handed a way into an account" an audit row that can go
         * missing is not. No credential, no code and no hash appears in either payload.
         */
        await q(
          `INSERT INTO audit_event (source, event_type, actor_kind, actor_user_id,
                                    actor_employee_id, actor_roles, subject_employee_id,
                                    subject_type, session_id, row_pk, table_name, field_classes,
                                    after)
           VALUES ('application', 'identity.account.created', 'user', $1, $2, $3, $4, 'employee',
                   $5, $6, 'app_user', ARRAY['PERSONAL'], $7::jsonb)`,
          [me.userId, me.employeeId, me.roles, employeeId, me.sessionId, newId,
            JSON.stringify({
              role, email: String(emp.work_email).toLowerCase(),
              activation_expires_in_days: ACTIVATION_DAYS,
            })]);

        await q(
          `INSERT INTO outbox_event (event_type, aggregate_type, aggregate_id, payload,
                                     actor_user_id)
           VALUES ('identity.account.created', 'app_user', $1, $2::jsonb, $3)`,
          [newId, JSON.stringify({ employeeId, role }), me.userId]);

        return newId;
      });

      return {
        userId,
        email: String(emp.work_email).toLowerCase(),
        role,
        /*
         * THE ONLY TIME THIS VALUE EXISTS OUTSIDE THE EMPLOYEE'S HEAD. Only its SHA-256 was
         * stored, so it cannot be recovered, re-read or looked up - if HR loses it the answer is
         * a reissue, which is why that action exists.
         */
        activationCode: code,
        expiresInDays: ACTIVATION_DAYS,
      };
    } catch (e) {
      throw AccountsController.explain(e);
    }
  }

  // =========================================================================
  /**
   * Reissue the activation code - the previous one was lost, or it expired.
   *
   * The old row is consumed as `superseded` in the same transaction as the new one is written,
   * because `ux_user_activation_one_live` permits exactly one live token per account. That is not
   * tidiness: two live codes means two people can set the password and the second silently wins.
   * The database refuses the second INSERT, so this ordering is the only one that works.
   */
  @Post('accounts/:userId/activation')
  @Authenticated()
  async reissue(@Req() req: Request, @Param('userId') userId: string) {
    if (!isUuid(userId)) throw new BadRequestException('Not a valid account');
    const target = await this.db.one(
      `SELECT u.id, u.employee_id, u.password_hash IS NOT NULL AS has_password, u.is_break_glass
         FROM app_user u WHERE u.id = $1`, [userId]);
    if (!target) throw new NotFoundException('Not found');

    await this.gate(req, 'identity.account.reissue', target.employee_id as string | undefined);
    const me = currentActor(req);

    // Checked here for a readable message; 0029 refuses it regardless, which is what makes it a
    // guarantee rather than a courtesy.
    if (target.has_password) {
      throw new BadRequestException(
        'This account already has a password. Issuing an activation code would be a password '
        + 'reset, which is a different action.');
    }

    const code = mintCode();
    try {
      await this.db.tx(async (q) => {
        await q(
          `UPDATE user_activation SET consumed_at = now(), consumed_reason = 'superseded'
            WHERE user_id = $1 AND consumed_at IS NULL`, [userId]);
        await q(
          `INSERT INTO user_activation (user_id, token_hash, issued_by_user_id, expires_at)
           VALUES ($1, $2, $3, now() + ($4 || ' days')::interval)`,
          [userId, hashCode(normaliseCode(code)), me.userId, String(ACTIVATION_DAYS)]);
        await q(
          `INSERT INTO audit_event (source, event_type, actor_kind, actor_user_id,
                                    actor_employee_id, actor_roles, subject_employee_id,
                                    subject_type, session_id, row_pk, table_name, field_classes,
                                    after)
           VALUES ('application', 'identity.account.activation_reissued', 'user', $1, $2, $3, $4,
                   'employee', $5, $6, 'user_activation', ARRAY['PERSONAL'], $7::jsonb)`,
          [me.userId, me.employeeId, me.roles, target.employee_id, me.sessionId, userId,
            JSON.stringify({ expires_in_days: ACTIVATION_DAYS })]);
      });
    } catch (e) {
      throw AccountsController.explain(e);
    }

    return { activationCode: code, expiresInDays: ACTIVATION_DAYS };
  }

  // =========================================================================
  /**
   * Spend the code and choose a password. UNAUTHENTICATED, by necessity - the whole point is that
   * the person cannot sign in yet.
   *
   * EVERY FAILURE RETURNS THE SAME MESSAGE. Unknown, expired, already spent and
   * belongs-to-a-disabled-account are indistinguishable from outside, on the same reasoning as
   * `AuthService.login`'s single "Email or password is incorrect": a distinct message for
   * "expired" confirms that a code was real, which is a probing oracle. Brute force is not the
   * threat model at ~98 bits, but leaking existence is free to prevent.
   *
   * No session is created. Activating and signing in are separate acts, so this endpoint never
   * needs to mint a cookie and the sign-in path stays the only place that does.
   */
  @Post('activate')
  async activate(@Body() body: { code?: string; password?: string }) {
    const code = normaliseCode(body?.code);
    const password = typeof body?.password === 'string' ? body.password : '';
    const refuse = () => new BadRequestException(
      'That activation code is not valid. Ask HR to issue a new one.');

    if (code.length !== CODE_LENGTH) throw refuse();

    const row = await this.db.one(
      `SELECT a.id, a.user_id, u.email, u.is_enabled, u.password_hash, e.full_name
         FROM user_activation a
         JOIN app_user u ON u.id = a.user_id
         LEFT JOIN employee e ON e.id = u.employee_id
        WHERE a.token_hash = $1 AND a.consumed_at IS NULL AND a.expires_at > now()`,
      [hashCode(code)]);

    // A disabled account, or one that has somehow acquired a credential, is refused with the same
    // message - and 0029 would refuse the write anyway.
    if (!row || !row.is_enabled || row.password_hash) throw refuse();

    // Validated only AFTER the code is known good, so the policy text cannot be used to probe
    // which codes exist.
    const problem = passwordProblem(password, [
      String(row.email ?? '').split('@')[0] ?? '',
      ...String(row.full_name ?? '').split(/\s+/),
      code,
    ]);
    if (problem) throw new BadRequestException(problem);

    const stored = hashPassword(password);
    await this.db.tx(async (q) => {
      /*
       * The UPDATE is guarded on `password_hash IS NULL`, so two redemptions racing on the same
       * code cannot both set a password - the second matches no row. Belt and braces alongside the
       * single-use consumption below, because this is the one write that hands out access.
       */
      const set = await q(
        `UPDATE app_user
            SET password_hash = $2, password_algo = 'scrypt', password_set_at = now(),
                failed_login_count = 0, locked_until = NULL
          WHERE id = $1 AND password_hash IS NULL
          RETURNING id`, [row.user_id, stored]);
      if (set.length !== 1) throw new BadRequestException('That activation code is no longer valid');

      await q(
        `UPDATE user_activation SET consumed_at = now(), consumed_reason = 'redeemed'
          WHERE id = $1 AND consumed_at IS NULL`, [row.id]);

      /*
       * `actor_kind = 'user'` and the actor IS the subject: this is the employee acting on their
       * own account, with no session yet, so there is no `session_id` to record.
       */
      await q(
        `INSERT INTO audit_event (source, event_type, actor_kind, actor_user_id,
                                  actor_employee_id, actor_roles, subject_type, row_pk,
                                  table_name, field_classes, after)
         SELECT 'application', 'identity.account.activated', 'user', u.id, u.employee_id,
                fn_user_roles(u.id), 'employee', u.id, 'app_user', ARRAY['SENSITIVE'],
                $2::jsonb
           FROM app_user u WHERE u.id = $1`,
        [row.user_id, JSON.stringify({ activation_id: row.id })]);

      await q(
        `INSERT INTO outbox_event (event_type, aggregate_type, aggregate_id, payload,
                                   actor_user_id)
         VALUES ('identity.account.activated', 'app_user', $1, $2::jsonb, $1)`,
        [row.user_id, JSON.stringify({ activationId: row.id })]);
    });

    return { ok: true, email: row.email as string };
  }

  /** Turn the database's own rails into messages, without leaking their SQL. */
  private static explain(e: unknown): Error {
    const msg = (e as Error)?.message ?? '';
    if (/already has a password/.test(msg)) {
      return new BadRequestException(
        'This account already has a password. Issuing an activation code would be a password '
        + 'reset, which is a different action.');
    }
    if (/break-glass/.test(msg)) {
      return new BadRequestException('Break-glass accounts cannot be activated through this flow.');
    }
    if (/ux_user_activation_one_live/.test(msg)) {
      return new BadRequestException(
        'This account already has a live activation code. Reissue it instead of adding another.');
    }
    if (/app_user_email_key/.test(msg)) {
      return new BadRequestException('That email address already has a login.');
    }
    if (/ex_user_role_no_overlap/.test(msg)) {
      return new BadRequestException('They already hold that role.');
    }
    if (/ck_user_role_not_empty/.test(msg)) {
      return new BadRequestException(
        'A role cannot be held for zero days. One granted today ends tomorrow at the earliest.');
    }
    if (/may not be modified in place|may not be DELETEd/.test(msg)) {
      return new BadRequestException(
        'A role grant is effective-dated: it can be ended from today, never erased.');
    }
    return e as Error;
  }
}

@Module({ controllers: [AccountsController] })
export class AccountsModule {}
