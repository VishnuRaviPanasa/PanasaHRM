-- =============================================================================
-- 0009  People, organization and identity - the Demo MVP core
-- =============================================================================
--
-- TRACK A (manager demo). Built on the established architecture, deliberately not gold-plated.
--
-- WHAT FOLLOWS THE ARCHITECTURE, because it is cheap now and expensive later:
--   * `employment` is EFFECTIVE-DATED (ADR-0002) and carries the Rule 3 trigger. Not optional -
--     `0004_..verify.sql` R3 fails any table with valid_from + valid_to that lacks it, so the
--     hardening work already forces this. It is also what makes "show me the org as it was in
--     March" possible, which is the one thing that cannot be retrofitted.
--   * Money and durations are integers or numeric, never float (Rule 4).
--   * Date-only values are DATE, never timestamp (Rule 5).
--
-- WHAT IS DEMO-GRADE AND FLAGGED FOR TRACK B:
--   * `app_user.password_hash` will hold a scrypt hash, not argon2id. ADR-0009 specifies
--     argon2id; scrypt is in Node's stdlib and needs no native module, which keeps the demo
--     build reliable. TRACK B: swap to argon2id before any real credential exists.
--   * No Entra/OIDC path. ADR-0009's primary auth is out of demo scope.
--   * `session` is a simple server-side row. ADR-0010's Redis-authoritative design, token
--     hashing and instant-revocation semantics are Track B.
--   * No `person` / `employee` split (ADR-0004's rehire model). One `employee` row. TRACK B.
--   * No authz service. Role is a column and the API checks it. **Must-Know Rule 1 says
--     authorization goes through `packages/authz`, which does not exist.** TRACK B - recorded,
--     not pretended away.
--
-- Change class: C (schema). Non-destructive: creates tables, seeds demo data.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Organization
-- ---------------------------------------------------------------------------
CREATE TABLE department (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE designation (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    grade       SMALLINT NOT NULL DEFAULT 1,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------
CREATE TABLE employee (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_number   TEXT NOT NULL UNIQUE,
    full_name         TEXT NOT NULL,
    work_email        TEXT NOT NULL UNIQUE,
    personal_phone    TEXT,
    gender            TEXT,
    date_of_birth     DATE,
    joined_on         DATE NOT NULL,                 -- Rule 5: DATE, never a timestamp
    exited_on         DATE,
    status            TEXT NOT NULL DEFAULT 'active',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_employee_status
        CHECK (status IN ('pre_boarding', 'active', 'on_notice', 'exited')),
    CONSTRAINT ck_employee_gender
        CHECK (gender IS NULL OR gender IN ('female', 'male', 'other')),
    CONSTRAINT ck_employee_exit_after_join
        CHECK (exited_on IS NULL OR exited_on >= joined_on)
);

-- The effective-dated assignment. THIS is where org history lives (ADR-0002).
CREATE TABLE employment (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id    UUID NOT NULL REFERENCES employee(id),
    department_id  UUID NOT NULL REFERENCES department(id),
    designation_id UUID NOT NULL REFERENCES designation(id),
    manager_id     UUID REFERENCES employee(id),
    work_location  TEXT NOT NULL DEFAULT 'Kochi',
    employment_type TEXT NOT NULL DEFAULT 'permanent',

    valid_from     DATE NOT NULL,
    valid_to       DATE,
    valid_period   daterange GENERATED ALWAYS AS
                       (daterange(valid_from, valid_to, '[)')) STORED,
    reason         TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_employment_not_empty
        CHECK (NOT isempty(daterange(valid_from, valid_to, '[)'))),
    CONSTRAINT ck_employment_type
        CHECK (employment_type IN ('permanent', 'probation', 'contract', 'intern')),
    CONSTRAINT ck_employment_not_self_managed
        CHECK (manager_id IS NULL OR manager_id <> employee_id),

    -- One assignment per employee at a time. This is the constraint that makes history honest.
    CONSTRAINT ex_employment_no_overlap EXCLUDE USING gist (
        employee_id WITH =,
        valid_period WITH &&
    )
);

CREATE INDEX ix_employment_asof ON employment (employee_id, valid_period);
CREATE INDEX ix_employment_manager ON employment (manager_id) WHERE manager_id IS NOT NULL;

-- Rule 3 applies. R3's catalogue check enforces this: any table carrying valid_from + valid_to
-- must have the trigger, or db:verify goes red.
CREATE TRIGGER tg_employment_immutable_history
    BEFORE UPDATE OR DELETE ON employment
    FOR EACH ROW EXECUTE FUNCTION fn_block_historical_mutation();
CREATE TRIGGER tg_employment_no_backdate
    BEFORE INSERT ON employment
    FOR EACH ROW EXECUTE FUNCTION fn_block_backdated_period();
CREATE TRIGGER tg_employment_no_truncate
    BEFORE TRUNCATE ON employment
    FOR EACH STATEMENT EXECUTE FUNCTION fn_block_mutation();

ALTER TABLE employment ENABLE ALWAYS TRIGGER tg_employment_immutable_history;
ALTER TABLE employment ENABLE ALWAYS TRIGGER tg_employment_no_backdate;
ALTER TABLE employment ENABLE ALWAYS TRIGGER tg_employment_no_truncate;

-- Resolve the assignment in force AS OF a date. Every read goes through this, never a direct
-- table read - that is the discipline ADR-0002 exists to enforce.
CREATE OR REPLACE FUNCTION fn_employment_asof(p_employee UUID, p_on DATE)
RETURNS employment
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT e.* FROM public.employment e
     WHERE e.employee_id = p_employee
       AND e.valid_period @> p_on
     LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- Identity (demo-grade - see the header)
-- ---------------------------------------------------------------------------
CREATE TABLE app_user (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id    UUID NOT NULL UNIQUE REFERENCES employee(id),
    email          TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,
    role           TEXT NOT NULL DEFAULT 'employee',
    is_enabled     BOOLEAN NOT NULL DEFAULT true,
    last_login_at  TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_app_user_role CHECK (role IN ('employee', 'manager', 'hr_admin'))
);

CREATE TABLE session (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash   TEXT NOT NULL UNIQUE,     -- sha256 of the cookie value; never the value itself
    user_id      UUID NOT NULL REFERENCES app_user(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL,
    revoked_at   TIMESTAMPTZ
);

CREATE INDEX ix_session_live ON session (token_hash) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Holidays - the real 2026 calendar (docs/requirements/holiday-calendar-2026.md)
-- ---------------------------------------------------------------------------
CREATE TABLE holiday (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    holiday_on   DATE NOT NULL,
    name         TEXT NOT NULL,
    is_optional  BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT uq_holiday UNIQUE (holiday_on, name)
);

CREATE INDEX ix_holiday_on ON holiday (holiday_on);

-- A working day: not a weekend, not a mandatory holiday. The leave calculation depends on this,
-- and it is the thing the demo shows the system computing.
CREATE OR REPLACE FUNCTION fn_is_working_day(p_on DATE)
RETURNS BOOLEAN
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT EXTRACT(ISODOW FROM p_on) < 6
       AND NOT EXISTS (SELECT 1 FROM public.holiday h
                        WHERE h.holiday_on = p_on AND NOT h.is_optional);
$$;

CREATE OR REPLACE FUNCTION fn_working_days(p_from DATE, p_to DATE)
RETURNS INTEGER
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT count(*)::int FROM generate_series(p_from, p_to, INTERVAL '1 day') d
     WHERE public.fn_is_working_day(d::date);
$$;

COMMENT ON FUNCTION fn_working_days(DATE, DATE) IS
    'Working days inclusive of both ends: excludes Sat/Sun and mandatory holidays. Optional '
    'holidays are NOT excluded - an employee elects those, and the election cap is OR-06.';

COMMIT;
