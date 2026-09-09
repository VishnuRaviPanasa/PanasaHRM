-- =============================================================================
-- 0016  Identity, roles and revocation
-- =============================================================================
--
-- Module 2's schema. Implements the parts of ADR-0009 (authentication) and ADR-0010 (sessions)
-- that are structural, so the application layer has somewhere correct to write.
--
-- WHAT WAS WRONG BEFORE THIS
--
--   * `app_user.role` was a single `text` column with a three-value CHECK. One role, no history,
--     no grant record, no revocation date. ADR-0002 and `ai/context/temporal-data-rules.md` both
--     list `user_role` as effective-dated; it did not exist.
--   * There was no federated identity table at all, so ADR-0009's central requirement -
--     `UNIQUE (tenant_id, subject)` on the Entra `oid` - had nothing to constrain. Without it,
--     anyone able to insert a second row claiming an existing `oid` inherits that person's
--     account at their next sign-in.
--   * `password_hash` was `NOT NULL`, so a federated-only account was unrepresentable. ADR-0009
--     requires that disabling local authentication DESTROYS the hash rather than hiding it
--     behind a flag - impossible against a NOT NULL column.
--   * Nothing revoked anything. An employee could be marked `exited` and keep a live session.
--
-- THE MUTUAL EXCLUSION IS A TRIGGER, NOT A CHECK, AND THAT IS DELIBERATE
--
-- ADR-0009 wants `CHECK (entra_object_id IS NULL OR password_hash IS NULL)` - the constraint that
-- kills the MFA-downgrade attack, where a privileged account with conditional access is entered
-- through the password route instead. But the federated identity lives in `user_identity` so it
-- can carry `UNIQUE (tenant_id, subject)`, and a CHECK cannot span tables. It is therefore
-- enforced in both directions by trigger:
--
--   * linking a federated identity to a user holding a password hash is refused;
--   * setting a password hash on a user with a federated identity is refused.
--
-- Both are `ENABLE ALWAYS` (DEC-030). The mechanism differs from the ADR's wording; the
-- guarantee does not, and it binds the CREDENTIAL rather than a boolean - which is the point the
-- ADR's own amendment insists on.
--
-- REVOCATION IS DRIVEN INTO THIS SYSTEM, NOT ASKED OF ENTRA
--
-- ADR-0009's corollary: because authorization must never synchronously depend on the IdP
-- (Rule 12 and its scoped exception), offboarding cannot be a question we ask Microsoft. It has
-- to be a local kill-switch that takes effect on the next request.
--
-- `tg_employee_revoke_on_exit` fires on `employee`, not on `employment_event`, and that placement
-- is the whole correctness argument: it triggers when the cached status BECOMES `exited`, which
-- is `fn_refresh_employment_status`'s decision (0015). So a resignation recorded today with a
-- last working day next month revokes nothing today, and revokes on the day it takes effect -
-- via the same catch-up path. Hanging it off the event would have revoked access the moment HR
-- typed the future date, which is the 0014 defect all over again.
--
-- `session.id` IS ADR-0010's non-secret surrogate
--
-- ADR-0010 requires `audit_event.session_id` to hold a non-secret per-session correlation id,
-- never the bearer token or any hash of it. `session.id` is already `uuid` and already not the
-- token, so it is that surrogate. No column is added and nothing is widened to fit - the
-- mismatch the ADR warns about does not arise.
--
-- Class C. Verified by testing/db/0016_identity_and_roles.verify.sql.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. app_user: make a federated-only account, and a break-glass account, representable
-- -----------------------------------------------------------------------------

ALTER TABLE app_user
    -- ADR-0009: a federated account holds NO local credential. Nullable so the hash can be
    -- destroyed rather than flagged.
    ALTER COLUMN password_hash DROP NOT NULL,
    -- ADR-0009's named exception: a small enumerated set of break-glass accounts may hold local
    -- credentials without being employees.
    ALTER COLUMN employee_id DROP NOT NULL;

ALTER TABLE app_user
    ADD COLUMN is_break_glass     boolean     NOT NULL DEFAULT false,
    ADD COLUMN password_algo      text,
    ADD COLUMN password_set_at    timestamptz,
    ADD COLUMN failed_login_count integer     NOT NULL DEFAULT 0,
    ADD COLUMN locked_until       timestamptz,
    ADD COLUMN disabled_at        timestamptz,
    ADD COLUMN disabled_reason    text;

-- Backfill BEFORE the constraints that police these columns. Existing rows all carry a scrypt
-- hash from the seed, and ck_app_user_password_algo below requires the pair to agree - so the
-- first draft of this migration added the constraint first and refused to apply.
UPDATE app_user SET password_algo = 'scrypt'
 WHERE password_hash IS NOT NULL AND password_algo IS NULL;

ALTER TABLE app_user
    -- Only a break-glass account may exist without an employee behind it.
    ADD CONSTRAINT ck_app_user_employee_or_break_glass
        CHECK (employee_id IS NOT NULL OR is_break_glass),

    -- A password hash must say how it was computed, so a scrypt row cannot be mistaken for
    -- argon2id during the rehash-on-login migration.
    ADD CONSTRAINT ck_app_user_password_algo
        CHECK ((password_hash IS NULL) = (password_algo IS NULL)),
    ADD CONSTRAINT ck_app_user_password_algo_value
        CHECK (password_algo IS NULL OR password_algo IN ('scrypt', 'argon2id')),

    ADD CONSTRAINT ck_app_user_failed_login_sane
        CHECK (failed_login_count >= 0),

    -- A disabled account records when and why. `is_enabled = false` with no reason is an
    -- unexplained lockout nobody can audit.
    ADD CONSTRAINT ck_app_user_disabled_explained
        CHECK (is_enabled OR (disabled_at IS NOT NULL AND disabled_reason IS NOT NULL));


COMMENT ON COLUMN app_user.role IS
    'SUPERSEDED by user_role, which is effective-dated and multi-valued. Retained only until the '
    'application stops reading it (expand/contract, DEC-011); a later migration drops it. Do not '
    'add new readers.';

COMMENT ON COLUMN app_user.is_break_glass IS
    'ADR-0009 named exception. Sealed, MFA-enforced, excluded from bulk administration, and every '
    'authentication by one must raise an ALERT rather than merely an audit row. Their number is a '
    'reviewed figure, not an emergent one.';

-- -----------------------------------------------------------------------------
-- 2. user_identity: federated identity, keyed on the immutable oid
-- -----------------------------------------------------------------------------

CREATE TABLE user_identity (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL REFERENCES app_user(id),

    provider      text NOT NULL DEFAULT 'entra',
    -- Entra `tid`. Verified at sign-in; a token from another tenant is not our user.
    tenant_id     text NOT NULL,
    -- Entra `oid`. Immutable, and NEVER email - email is a display attribute a directory
    -- administrator or the user can influence.
    subject       text NOT NULL,

    -- ADR-0009: a link is created only by an authenticated administrative action, never by a
    -- login. An unrecognised oid at sign-in is refused and alerted on.
    linked_by     uuid REFERENCES employee(id),
    linked_at     timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz,

    -- THE constraint. Two rows sharing an oid must be impossible at the database level.
    CONSTRAINT uq_user_identity_subject UNIQUE (tenant_id, subject),
    -- One federated identity per user per provider.
    CONSTRAINT uq_user_identity_user_provider UNIQUE (user_id, provider),

    CONSTRAINT ck_user_identity_provider CHECK (provider IN ('entra')),
    CONSTRAINT ck_user_identity_subject_not_email CHECK (subject NOT LIKE '%@%')
);

COMMENT ON TABLE user_identity IS
    'Federated identity links. UNIQUE (tenant_id, subject) is the account-takeover control from '
    'ADR-0009: without it, a second row claiming an existing Entra oid inherits that account.';

COMMENT ON CONSTRAINT ck_user_identity_subject_not_email ON user_identity IS
    'An Entra oid is a GUID. If an email address ever lands here, identity has been linked on a '
    'mutable display attribute - the exact failure ADR-0009 forbids - so the shape is constrained '
    'rather than trusted.';

CREATE INDEX ix_user_identity_user ON user_identity (user_id);

-- -----------------------------------------------------------------------------
-- 3. The mutual exclusion, both directions
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_block_federated_with_password()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
DECLARE v_hash text;
BEGIN
    SELECT u.password_hash INTO v_hash FROM public.app_user u WHERE u.id = NEW.user_id;
    IF v_hash IS NOT NULL THEN
        RAISE EXCEPTION
            USING MESSAGE =
                'cannot link a federated identity while this account still holds a local password '
                'hash. ADR-0009: disabling local authentication means DESTROYING the credential, '
                'not hiding it behind a flag - otherwise the password route bypasses conditional '
                'access on a privileged account',
                  ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_user_identity_no_password
    BEFORE INSERT OR UPDATE ON user_identity
    FOR EACH ROW EXECUTE FUNCTION fn_block_federated_with_password();

ALTER TABLE user_identity ENABLE ALWAYS TRIGGER tg_user_identity_no_password;

CREATE OR REPLACE FUNCTION fn_block_password_on_federated()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
BEGIN
    IF NEW.password_hash IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.user_identity ui WHERE ui.user_id = NEW.id) THEN
        RAISE EXCEPTION
            USING MESSAGE =
                'this account authenticates through Entra; setting a local password would re-arm '
                'the MFA-downgrade path ADR-0009 exists to close',
                  ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_app_user_no_password_when_federated
    BEFORE INSERT OR UPDATE OF password_hash ON app_user
    FOR EACH ROW EXECUTE FUNCTION fn_block_password_on_federated();

ALTER TABLE app_user ENABLE ALWAYS TRIGGER tg_app_user_no_password_when_federated;

-- -----------------------------------------------------------------------------
-- 4. user_role: effective-dated, multi-valued role grants
-- -----------------------------------------------------------------------------

CREATE TABLE user_role (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES app_user(id),
    role         text NOT NULL,

    valid_from   date NOT NULL,
    valid_to     date,
    valid_period daterange GENERATED ALWAYS AS (daterange(valid_from, valid_to, '[)')) STORED,

    granted_by   uuid REFERENCES employee(id),
    reason       text,
    created_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT ck_user_role_value CHECK (role IN
        ('employee', 'manager', 'hr_admin', 'hr_ops', 'finance', 'auditor')),

    -- Mandatory, never optional (temporal-data-rules rule 1). A zero-length period slips past
    -- the exclusion constraint - empty && anything is false - then matches no as-of query, so
    -- the grant silently vanishes for reasons nobody can reproduce.
    CONSTRAINT ck_user_role_not_empty
        CHECK (NOT isempty(daterange(valid_from, valid_to, '[)'))),

    -- The same role may not be granted twice over overlapping periods. DIFFERENT roles may
    -- overlap - that is what multi-role means.
    CONSTRAINT ex_user_role_no_overlap EXCLUDE USING gist (
        user_id WITH =, role WITH =, valid_period WITH &&)
);

COMMENT ON TABLE user_role IS
    'Effective-dated role grants. ADR-0005 amendment (b): a grant resolves AS OF NOW, never as of '
    'the record being viewed - otherwise an expired role could be re-acquired by choosing a '
    'historical as-of date, which is privilege escalation with a date picker as its interface. '
    'Scope-graph EDGES resolve as of the record date; GRANTS do not. The two are independent.';

CREATE INDEX ix_user_role_asof ON user_role (user_id, valid_period);
CREATE INDEX ix_user_role_role ON user_role (role, valid_period);

-- Rule 3: a grant period is history. Closing an open one is allowed; rewriting a past one is not.
CREATE TRIGGER tg_user_role_immutable_history
    BEFORE UPDATE OR DELETE ON user_role
    FOR EACH ROW EXECUTE FUNCTION fn_block_historical_mutation();

ALTER TABLE user_role ENABLE ALWAYS TRIGGER tg_user_role_immutable_history;

CREATE TRIGGER tg_user_role_no_backdate
    BEFORE INSERT ON user_role
    FOR EACH ROW EXECUTE FUNCTION fn_block_backdated_period();

ALTER TABLE user_role ENABLE ALWAYS TRIGGER tg_user_role_no_backdate;

CREATE TRIGGER tg_user_role_no_truncate
    BEFORE TRUNCATE ON user_role
    FOR EACH STATEMENT EXECUTE FUNCTION fn_block_mutation();

ALTER TABLE user_role ENABLE ALWAYS TRIGGER tg_user_role_no_truncate;

-- Backfill from the column being superseded. Back-dated, so it needs the DEC-029 opt-in.
SET LOCAL hrm.allow_backdated_period = 'on';

INSERT INTO user_role (user_id, role, valid_from, reason)
SELECT u.id, u.role, COALESCE(e.joined_on, DATE '2020-01-01'),
       'backfilled by migration 0016 from app_user.role'
  FROM app_user u
  LEFT JOIN employee e ON e.id = u.employee_id
 WHERE NOT EXISTS (SELECT 1 FROM user_role r WHERE r.user_id = u.id AND r.role = u.role);

-- Everybody who is anybody is also an employee. `manager` and `hr_admin` are additive, not
-- alternatives - which is the whole reason this table is multi-valued.
INSERT INTO user_role (user_id, role, valid_from, reason)
SELECT u.id, 'employee', COALESCE(e.joined_on, DATE '2020-01-01'),
       'backfilled by migration 0016: every account is also an employee'
  FROM app_user u
  LEFT JOIN employee e ON e.id = u.employee_id
 WHERE u.role <> 'employee'
   AND u.employee_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM user_role r WHERE r.user_id = u.id AND r.role = 'employee');

-- -----------------------------------------------------------------------------
-- 5. Resolving grants - as of now, by design
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_user_roles_asof(p_user uuid, p_on date)
RETURNS text[]
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
    SELECT COALESCE(array_agg(r.role ORDER BY r.role), '{}'::text[])
      FROM public.user_role r
     WHERE r.user_id = p_user
       AND r.valid_period @> p_on;
$$;

-- The overload every caller should use. Taking no date makes "as of now" the path of least
-- resistance, so a caller cannot accidentally resolve grants as of a record's date.
CREATE OR REPLACE FUNCTION fn_user_roles(p_user uuid)
RETURNS text[]
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
    SELECT public.fn_user_roles_asof(p_user, public.fn_business_date());
$$;

COMMENT ON FUNCTION fn_user_roles(uuid) IS
    'Role grants in force NOW. Use this, not the dated overload, for every authorization '
    'decision - ADR-0005(b). The dated form exists for administrative history views and tests.';

-- -----------------------------------------------------------------------------
-- 6. Sessions: absolute lifetime, activity, and a revocation reason
-- -----------------------------------------------------------------------------

ALTER TABLE session
    ADD COLUMN absolute_expires_at timestamptz,
    ADD COLUMN last_seen_at        timestamptz,
    ADD COLUMN revoked_reason      text,
    ADD COLUMN created_ip          inet,
    ADD COLUMN user_agent_digest   text;

-- An absolute cap so a session cannot be kept alive indefinitely by activity alone.
UPDATE session SET absolute_expires_at = created_at + INTERVAL '7 days'
 WHERE absolute_expires_at IS NULL;

ALTER TABLE session
    ALTER COLUMN absolute_expires_at SET NOT NULL,
    ADD CONSTRAINT ck_session_absolute_after_expiry
        CHECK (absolute_expires_at >= expires_at),
    ADD CONSTRAINT ck_session_revoked_explained
        CHECK (revoked_at IS NULL OR revoked_reason IS NOT NULL);

COMMENT ON COLUMN session.id IS
    'ADR-0010''s non-secret per-session surrogate, and what audit_event.session_id holds. It is '
    'NOT the bearer token and NOT a hash of it: neither the token nor any hash of it may ever be '
    'written to audit_event, an append-only table with a decade of retention.';

COMMENT ON COLUMN session.token_hash IS
    'SHA-256 of the 256-bit cookie value. The value itself is never persisted anywhere, so a '
    'database or backup disclosure yields no usable session token.';

COMMENT ON COLUMN session.user_agent_digest IS
    'A hash, not the user-agent string. Enough to notice a session moving between clients; not a '
    'fingerprint retained in the clear.';

-- Bulk revocation by user is the offboarding path, so it gets an index.
CREATE INDEX ix_session_user_live ON session (user_id) WHERE revoked_at IS NULL;

-- -----------------------------------------------------------------------------
-- 7. Revocation
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_revoke_sessions_for_user(p_user uuid, p_reason text)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
DECLARE v_n integer;
BEGIN
    IF p_reason IS NULL OR btrim(p_reason) = '' THEN
        RAISE EXCEPTION USING MESSAGE = 'a revocation must state a reason',
                              ERRCODE = 'restrict_violation';
    END IF;
    UPDATE public.session s
       SET revoked_at = now(), revoked_reason = p_reason
     WHERE s.user_id = p_user AND s.revoked_at IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n;
END;
$$;

COMMENT ON FUNCTION fn_revoke_sessions_for_user(uuid, text) IS
    'Ends every live session for a user. Postgres is currently the session store; when Redis '
    'becomes authoritative (ADR-0010) the Redis keys must be deleted in the same operation, or '
    'this function stops being a kill-switch and becomes a bookkeeping entry.';

-- The offboarding kill-switch. Fires on `employee`, so it triggers when the cached status
-- BECOMES exited - i.e. when fn_refresh_employment_status (0015) decides the exit has taken
-- effect. A future-dated exit therefore revokes nothing until its date arrives.
CREATE OR REPLACE FUNCTION fn_revoke_access_on_exit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
DECLARE v_user uuid;
BEGIN
    IF NEW.status = 'exited' AND OLD.status IS DISTINCT FROM 'exited' THEN
        FOR v_user IN SELECT u.id FROM public.app_user u WHERE u.employee_id = NEW.id LOOP
            PERFORM public.fn_revoke_sessions_for_user(v_user, 'employment ended');
            UPDATE public.app_user u
               SET is_enabled = false,
                   disabled_at = now(),
                   disabled_reason = 'employment ended'
             WHERE u.id = v_user AND u.is_enabled;
        END LOOP;
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER tg_employee_revoke_on_exit
    AFTER UPDATE OF status ON employee
    FOR EACH ROW EXECUTE FUNCTION fn_revoke_access_on_exit();

ALTER TABLE employee ENABLE ALWAYS TRIGGER tg_employee_revoke_on_exit;

-- Closing a role grant is revocation too, and it must not be possible to keep a privilege by
-- holding a session open. Nothing caches roles across requests (ADR-0010), so an expired grant
-- stops applying on the next request without touching the session - which is why there is no
-- trigger here. Stated so its absence reads as a decision rather than an omission.

-- -----------------------------------------------------------------------------
-- 8. Security audit emission
-- -----------------------------------------------------------------------------
--
-- Must-Know Rule 2 requires an audit record for every state change. Authentication events are
-- state changes with no table behind them, so they need an explicit emitter. `audit_event`'s
-- ck_audit_shape requires source = 'application' to carry an event_type.
--
CREATE OR REPLACE FUNCTION fn_audit_security(
    p_event_type       text,
    p_actor_user       uuid    DEFAULT NULL,
    p_actor_employee   uuid    DEFAULT NULL,
    p_subject_employee uuid    DEFAULT NULL,
    p_session          uuid    DEFAULT NULL,
    p_correlation      uuid    DEFAULT NULL,
    p_source_ip        inet    DEFAULT NULL,
    p_reason           text    DEFAULT NULL,
    p_roles            text[]  DEFAULT NULL,
    p_after            jsonb   DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
DECLARE v_id bigint;
BEGIN
    IF p_event_type IS NULL OR btrim(p_event_type) = '' THEN
        RAISE EXCEPTION USING MESSAGE = 'a security audit row needs an event_type',
                              ERRCODE = 'restrict_violation';
    END IF;

    INSERT INTO public.audit_event (
        source, event_type, actor_kind, actor_user_id, actor_employee_id, actor_roles,
        subject_employee_id, subject_type, session_id, correlation_id, source_ip, reason, after)
    VALUES (
        'application', p_event_type,
        CASE WHEN p_actor_user IS NULL THEN 'system' ELSE 'user' END,
        p_actor_user, p_actor_employee, p_roles,
        p_subject_employee, 'identity', p_session, p_correlation, p_source_ip, p_reason, p_after)
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

COMMENT ON FUNCTION fn_audit_security IS
    'Emits a security audit row. NEVER pass a session token or any hash of one - session_id takes '
    'session.id, the non-secret surrogate (ADR-0010). `after` must carry no credential material: '
    'audit_event is append-only with decade retention, so anything written here is unrecallable.';

-- -----------------------------------------------------------------------------
-- 9. Grants
-- -----------------------------------------------------------------------------
--
-- No DELETE anywhere. `user_role` is effective-dated (Rule 3) and `user_identity` links are
-- administrative records. UPDATE on `user_role` is safe because fn_block_historical_mutation is
-- ENABLE ALWAYS and permits only closing an open period.

GRANT INSERT, UPDATE ON app_user       TO hrm_app;   -- last_login_at, lockout, disable
GRANT INSERT, UPDATE ON session        TO hrm_app;   -- create, touch, revoke
GRANT INSERT, UPDATE ON user_role      TO hrm_app;   -- grant, and close to revoke
GRANT INSERT, UPDATE ON user_identity  TO hrm_app;   -- admin-initiated linking, last_seen_at

COMMIT;
