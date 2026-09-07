-- 0002_configuration.sql
--
-- Configuration, in the two classes ADR-0019 defines:
--
--   1. EFFECTIVE-DATED POLICY - anything a historical recomputation reads.
--      attendance_policy, employment_policy. (leave_policy arrives with the leave
--      module, following the same pattern.)
--
--   2. MUTABLE SETTINGS - org_setting. Values nothing computes history from.
--
-- The dividing test: would a historical recomputation give a different answer if this
-- value changed? If yes it is policy and must be versioned.
--
-- Seeds the values HR confirmed on 2026-09-08.

BEGIN;

-- ---------------------------------------------------------------------------
-- Class 1: effective-dated policy
-- ---------------------------------------------------------------------------

CREATE TABLE attendance_policy (
    id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Scope. NULL legal_entity_id = group-wide default. A per-entity row overrides it.
    legal_entity_id        UUID,

    -- Classification thresholds (HR-confirmed 2026-09-08)
    grace_period_minutes   SMALLINT    NOT NULL DEFAULT 15,
    half_day_min_minutes   SMALLINT    NOT NULL DEFAULT 240,
    full_day_min_minutes   SMALLINT    NOT NULL DEFAULT 465,
    standard_day_minutes   SMALLINT    NOT NULL DEFAULT 480,

    -- Overtime. Captured but unpaid until a policy exists (C7).
    ot_enabled             BOOLEAN     NOT NULL DEFAULT false,
    ot_min_minutes         SMALLINT    NOT NULL DEFAULT 30,

    -- Validity
    valid_from             DATE        NOT NULL,
    valid_to               DATE,
    valid_period           daterange   GENERATED ALWAYS AS
                               (daterange(valid_from, valid_to, '[)')) STORED,

    -- Provenance. A policy change is a bulk data operation wearing a form.
    reason                 TEXT,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by_user_id     UUID,

    CONSTRAINT ck_attendance_policy_not_empty
        CHECK (NOT isempty(daterange(valid_from, valid_to, '[)'))),

    -- full_day must be reachable within the shift, and half_day must be below it.
    -- Without this, a typo silently classifies every employee as a half day.
    CONSTRAINT ck_attendance_policy_thresholds_ordered
        CHECK (half_day_min_minutes > 0
           AND half_day_min_minutes < full_day_min_minutes
           AND full_day_min_minutes <= standard_day_minutes),

    CONSTRAINT ck_attendance_policy_grace_sane
        CHECK (grace_period_minutes >= 0 AND grace_period_minutes <= 120),

    -- The interaction HR must confirm: a full day must remain achievable by someone who
    -- uses the whole grace period, or the grace costs half a day's pay.
    CONSTRAINT ck_attendance_policy_grace_usable
        CHECK (full_day_min_minutes <= standard_day_minutes - grace_period_minutes),

    CONSTRAINT ex_attendance_policy_no_overlap EXCLUDE USING gist (
        COALESCE(legal_entity_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
        valid_period WITH &&
    )
);

COMMENT ON TABLE attendance_policy IS
    'Effective-dated (ADR-0019). Attendance derivation resolves the version in force AS OF the '
    'business date being computed - never the current version.';
COMMENT ON CONSTRAINT ck_attendance_policy_grace_usable ON attendance_policy IS
    'Standard day is 480 min. With a 15 min grace, a strict 480 full-day threshold would classify '
    'anyone arriving at 09:10 as a half day, making the grace worthless. This constraint makes '
    'that configuration impossible to save.';


CREATE TABLE employment_policy (
    id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    legal_entity_id        UUID,

    notice_period_days     SMALLINT    NOT NULL DEFAULT 90,
    probation_months       SMALLINT,                      -- C4: unknown, deliberately NULL
    cl_blocked_in_notice   BOOLEAN     NOT NULL DEFAULT true,
    sl_extends_notice      BOOLEAN     NOT NULL DEFAULT true,
    salary_disbursement_day SMALLINT   NOT NULL DEFAULT 10,

    valid_from             DATE        NOT NULL,
    valid_to               DATE,
    valid_period           daterange   GENERATED ALWAYS AS
                               (daterange(valid_from, valid_to, '[)')) STORED,
    reason                 TEXT,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by_user_id     UUID,

    CONSTRAINT ck_employment_policy_not_empty
        CHECK (NOT isempty(daterange(valid_from, valid_to, '[)'))),
    CONSTRAINT ck_employment_policy_sane
        CHECK (notice_period_days BETWEEN 0 AND 365
           AND (probation_months IS NULL OR probation_months BETWEEN 0 AND 24)
           AND salary_disbursement_day BETWEEN 1 AND 28),
    CONSTRAINT ex_employment_policy_no_overlap EXCLUDE USING gist (
        COALESCE(legal_entity_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
        valid_period WITH &&
    )
);

COMMENT ON COLUMN employment_policy.probation_months IS
    'NULL until HR answers C4. NULL means "unknown", NOT "no probation" - callers must treat it '
    'as unresolved and refuse to compute rather than assume zero.';
COMMENT ON COLUMN employment_policy.salary_disbursement_day IS
    'Capped at 28 so the date exists in February.';


-- ---------------------------------------------------------------------------
-- Class 2: mutable settings
-- ---------------------------------------------------------------------------

CREATE TABLE org_setting (
    key            TEXT        PRIMARY KEY,
    value          JSONB       NOT NULL,
    value_type     TEXT        NOT NULL,
    category       TEXT        NOT NULL,
    label          TEXT        NOT NULL,
    description    TEXT,
    is_secret      BOOLEAN     NOT NULL DEFAULT false,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by_user_id UUID,

    CONSTRAINT ck_org_setting_key   CHECK (key ~ '^[a-z][a-z0-9_.]*$'),
    CONSTRAINT ck_org_setting_type  CHECK (value_type IN ('string','number','boolean','json')),
    CONSTRAINT ck_org_setting_cat   CHECK (category IN ('company','notification','integration','feature'))
);

COMMENT ON TABLE org_setting IS
    'Mutable settings (ADR-0019 class 2). Nothing computes history from these. Anything a '
    'historical recomputation reads belongs in an effective-dated policy table instead.';
COMMENT ON COLUMN org_setting.is_secret IS
    'Marks a value that must never be returned to a client or written to a log. Secrets should '
    'not live here at all - this flag exists to fail loudly if one does.';

CREATE TRIGGER tg_org_setting_updated_at
    BEFORE UPDATE ON org_setting
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();


-- ---------------------------------------------------------------------------
-- Policy resolvers
--
-- Callers MUST use these, never a direct table read. A direct read defaults to the
-- current version and silently computes the wrong answer for a past date - the same
-- hazard as every effective-dated table.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_attendance_policy_asof(
    p_as_of DATE,
    p_legal_entity_id UUID DEFAULT NULL
) RETURNS attendance_policy
LANGUAGE sql STABLE AS $$
    SELECT *
      FROM attendance_policy
     WHERE valid_period @> p_as_of
       AND (legal_entity_id = p_legal_entity_id OR legal_entity_id IS NULL)
     ORDER BY legal_entity_id NULLS LAST   -- entity-specific row wins over the group default
     LIMIT 1;
$$;

COMMENT ON FUNCTION fn_attendance_policy_asof(DATE, UUID) IS
    'Resolves the policy in force AS OF a business date. Attendance derivation calls this with '
    'the date being computed, so a recompute of March reads March policy.';

CREATE OR REPLACE FUNCTION fn_employment_policy_asof(
    p_as_of DATE,
    p_legal_entity_id UUID DEFAULT NULL
) RETURNS employment_policy
LANGUAGE sql STABLE AS $$
    SELECT *
      FROM employment_policy
     WHERE valid_period @> p_as_of
       AND (legal_entity_id = p_legal_entity_id OR legal_entity_id IS NULL)
     ORDER BY legal_entity_id NULLS LAST
     LIMIT 1;
$$;


-- ---------------------------------------------------------------------------
-- Seed: the values HR confirmed on 2026-09-08
--
-- valid_from is the system epoch, not today, so historical recomputation has a policy
-- to resolve. Backdating the first version is correct: these values describe what the
-- handbook already said, they are not a new decision taken today.
-- ---------------------------------------------------------------------------

INSERT INTO attendance_policy (
    legal_entity_id, grace_period_minutes, half_day_min_minutes,
    full_day_min_minutes, standard_day_minutes, valid_from, reason
) VALUES (
    NULL, 15, 240, 465, 480, DATE '2020-01-01',
    'Initial policy. Grace, half-day and full-day confirmed by HR 2026-09-08 (C8). '
    'full_day_min_minutes is 465 rather than 480 so an employee using the full grace still '
    'earns a full day - pending confirmation, OR-08.'
);

INSERT INTO employment_policy (
    legal_entity_id, notice_period_days, probation_months,
    cl_blocked_in_notice, sl_extends_notice, salary_disbursement_day, valid_from, reason
) VALUES (
    NULL, 90, NULL, true, true, 10, DATE '2020-01-01',
    'Initial policy from Employee Handbook v3. probation_months is NULL pending C4.'
);

INSERT INTO org_setting (key, value, value_type, category, label, description) VALUES
  ('company.legal_name',  '"Panasa Technology Pvt. Ltd."', 'string', 'company',
   'Legal entity name', 'As registered.'),
  ('company.display_name','"Panasa"',                      'string', 'company',
   'Display name', 'Shown in the UI and in emails.'),
  ('company.timezone',    '"Asia/Kolkata"',                'string', 'company',
   'Business timezone', 'Drives business-date attribution. Changing it re-attributes punches.'),
  ('notification.from_address', '"noreply@panasatech.com"','string', 'notification',
   'From address', NULL),
  ('notification.reply_to',     '"hr@panasatech.com"',     'string', 'notification',
   'Reply-to address', NULL),
  ('feature.work_logging_enabled', 'false',                'boolean','feature',
   'Daily work logging', 'Enables the work module. Off until Phase 7.');


-- ---------------------------------------------------------------------------
-- Post-migration assertions
-- ---------------------------------------------------------------------------

DO $$
DECLARE v_pol attendance_policy;
BEGIN
    IF to_regclass('attendance_policy') IS NULL
    OR to_regclass('employment_policy') IS NULL
    OR to_regclass('org_setting') IS NULL THEN
        RAISE EXCEPTION 'assertion failed: configuration tables were not created';
    END IF;

    -- The resolver must find a policy for a date years in the past, or historical
    -- recomputation has nothing to read.
    v_pol := fn_attendance_policy_asof(DATE '2021-06-15');
    IF v_pol.grace_period_minutes IS NULL THEN
        RAISE EXCEPTION 'assertion failed: no attendance policy resolvable for a past date';
    END IF;
    IF v_pol.grace_period_minutes <> 15 OR v_pol.full_day_min_minutes <> 465 THEN
        RAISE EXCEPTION 'assertion failed: seeded policy values are wrong (grace=%, full=%)',
            v_pol.grace_period_minutes, v_pol.full_day_min_minutes;
    END IF;
END;
$$;

COMMIT;
