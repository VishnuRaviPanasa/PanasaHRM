-- =============================================================================
-- 0029  Account activation - how an employee's first credential reaches them
-- =============================================================================
--
-- WHY. `POST /employees` has existed since 0009. `app_user` has existed since 0009. Nothing has
-- ever connected them: the ONLY `INSERT INTO app_user` in this repository is the demo seed, so HR
-- could create an employee who was structurally incapable of signing in. Every account in the
-- running system was placed there by `npm run db:seed`.
--
-- The schema was already built for this and that shaped the design. `password_hash` is NULLABLE,
-- with `ck_app_user_password_algo CHECK ((password_hash IS NULL) = (password_algo IS NULL))`, so
-- an account that exists but has no credential is already a legal, representable state. This
-- migration adds the thing that turns that state into a usable one.
--
-- WHAT WAS DELIBERATELY NOT BUILT. The obvious shortcut is for HR to type an initial password and
-- tell the employee what it is - which is what the reference application does, emailing a
-- temporary password and holding the account at a `password_reset_pending` status. It works, and
-- it means a working credential for a real person exists in a mailbox and in the memory of
-- whoever typed it. Instead: HR creates the account with NO password, and the system mints a
-- single-use activation token. The employee redeems it and chooses their own password.
--
--   * nobody but the employee ever knows their password - not HR, not this table, not the log
--   * the token is stored as a SHA-256 hash, exactly as `session.token_hash` is (0009). A dump of
--     this table cannot be replayed
--   * it expires, and it can only be spent once
--   * no SMTP, no external service, nothing on the request path that can be down (Rule 12).
--     The token is shown to HR once, to hand over. On one site with a few dozen people that is
--     not a limitation, it is one fewer moving part
--
-- This is NIST SP 800-63B enrolment - a one-time secret exchanged for a chosen authenticator -
-- which is the standard ADR-0009 already binds the password policy to.
--
-- WHY A TABLE AND NOT A COLUMN ON `app_user`. Reissue. HR will lose the code, or the employee will
-- not get round to it before it expires, and the fix has to be "issue another" without touching
-- the account. Separate rows also mean the history of *how many times* an activation was issued
-- is readable, which matters when the answer is eleven.
-- =============================================================================

BEGIN;

CREATE TABLE user_activation (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES app_user (id),

    -- SHA-256 hex of the token, never the token. Same discipline as `session.token_hash`: this
    -- table is a list of things that CANNOT be used, only checked against.
    token_hash          TEXT NOT NULL UNIQUE,

    -- Who issued it. An activation is a privileged act - it hands somebody a way into an account -
    -- so it names its author on the row rather than only in the audit trail.
    issued_by_user_id   UUID NOT NULL REFERENCES app_user (id),

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ NOT NULL,

    -- Set when redeemed. Set when superseded by a reissue, or when revoked, with a reason.
    consumed_at         TIMESTAMPTZ,
    consumed_reason     TEXT,

    CONSTRAINT ck_user_activation_window
        CHECK (expires_at > created_at),

    -- A consumed row must say why, and an unconsumed row must not pretend to.
    CONSTRAINT ck_user_activation_consumed_explained
        CHECK ((consumed_at IS NULL) = (consumed_reason IS NULL)),

    CONSTRAINT ck_user_activation_reason_value
        CHECK (consumed_reason IS NULL
               OR consumed_reason IN ('redeemed', 'superseded', 'revoked'))
);

-- AT MOST ONE LIVE TOKEN PER ACCOUNT, enforced by the database rather than by the controller
-- remembering to tidy up. Two live tokens means two people can set the password, and the second
-- one silently wins. A reissue must therefore consume the previous row in the same transaction -
-- which is not a convention, it is the only way an INSERT succeeds.
CREATE UNIQUE INDEX ux_user_activation_one_live
    ON user_activation (user_id)
    WHERE consumed_at IS NULL;

CREATE INDEX ix_user_activation_user ON user_activation (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Append-mostly: the only column that may ever change is the consumption
-- ---------------------------------------------------------------------------
--
-- Without this, an UPDATE could re-point a token_hash at a different user_id, or push expires_at
-- forward on a token that has already been handed to somebody. Both turn this table from a rail
-- into a suggestion. `consumed_at`/`consumed_reason` are the only mutable pair, and once set they
-- cannot be cleared - un-consuming a token is how a single-use secret becomes multi-use.
CREATE OR REPLACE FUNCTION fn_user_activation_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.id                <> OLD.id
       OR NEW.user_id           <> OLD.user_id
       OR NEW.token_hash        <> OLD.token_hash
       OR NEW.issued_by_user_id <> OLD.issued_by_user_id
       OR NEW.created_at        <> OLD.created_at
       OR NEW.expires_at        <> OLD.expires_at THEN
        RAISE EXCEPTION
            'an activation token is immutable; only its consumption may be recorded'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NULL THEN
        RAISE EXCEPTION 'an activation token cannot be un-consumed'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_user_activation_immutable
    BEFORE UPDATE ON user_activation
    FOR EACH ROW EXECUTE FUNCTION fn_user_activation_immutable();

-- DEC-030: ENABLE ALWAYS, so a restore or a bulk load cannot walk around it.
ALTER TABLE user_activation ENABLE ALWAYS TRIGGER trg_user_activation_immutable;

-- ---------------------------------------------------------------------------
-- An activation may only exist for an account that has no credential yet
-- ---------------------------------------------------------------------------
--
-- THIS IS THE ONE THAT MATTERS. Without it, "issue an activation token" is an account-takeover
-- primitive: anybody who can reach that endpoint can mint a token for the HR Manager's live
-- account and set its password. Password RESET for an existing credential is a different act with
-- different authorization - it belongs to the account holder, proven by something they have - and
-- conflating the two is how an administrative convenience becomes a privilege escalation.
--
-- So the rail is: an activation token may be issued only while `password_hash IS NULL`. Setting a
-- password closes the door, and only a deliberate credential destruction (ADR-0009: disabling
-- local authentication means destroying the hash, not hiding it behind a flag) can reopen it.
--
-- Enforced as a trigger rather than a CHECK because the condition lives on another table, and as
-- a CONSTRAINT trigger so it also fires if the account gains a password mid-transaction.
CREATE OR REPLACE FUNCTION fn_user_activation_requires_no_credential()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_has_password BOOLEAN;
    v_break_glass  BOOLEAN;
BEGIN
    SELECT password_hash IS NOT NULL, is_break_glass
      INTO v_has_password, v_break_glass
      FROM app_user
     WHERE id = NEW.user_id;

    IF v_has_password THEN
        RAISE EXCEPTION
            'this account already has a password; issuing an activation token would be a reset, '
            'which is a different action with different authorization'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- ADR-0009: break-glass credentials are sealed and held offline, explicitly excluded from
    -- bulk administration. An activation flow is exactly the ordinary administration they are
    -- excluded from.
    IF v_break_glass THEN
        RAISE EXCEPTION 'break-glass accounts are sealed and cannot be activated through this flow'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_user_activation_requires_no_credential
    BEFORE INSERT ON user_activation
    FOR EACH ROW EXECUTE FUNCTION fn_user_activation_requires_no_credential();

ALTER TABLE user_activation ENABLE ALWAYS TRIGGER trg_user_activation_requires_no_credential;

COMMIT;
