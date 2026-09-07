-- 0003_leave_policy_configuration.sql
--
-- Moves the remaining open handbook questions from "blocked on HR" to "configurable by HR".
--
-- C1 sandwich rule · C2 advance notice · C4 probation length and accrual method
-- C5 carry-forward expiry · C6 comp-off validity basis · C12 accrual during maternity
--
-- THE SAFEGUARD (the reason this migration is not simply a win):
--
-- Making a value configurable does not make it correct. It moves the risk from "the
-- developer guessed" to "HR never looked, and the engineering default silently became
-- policy". So every policy row carries `unconfirmed_fields` - the list of columns whose
-- value is an engineering default rather than a human decision. The settings screen
-- badges them, and reports refuse to present a number as authoritative while the fields
-- feeding it are unconfirmed.
--
-- A trigger validates that the array contains real column names, so a typo cannot
-- silently un-badge a field.

BEGIN;

-- ---------------------------------------------------------------------------
-- unconfirmed_fields: engineering default vs human decision
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_validate_unconfirmed_fields() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE bad TEXT;
BEGIN
    IF NEW.unconfirmed_fields IS NULL OR cardinality(NEW.unconfirmed_fields) = 0 THEN
        RETURN NEW;
    END IF;
    SELECT f INTO bad
      FROM unnest(NEW.unconfirmed_fields) AS f
     WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = TG_TABLE_NAME AND column_name = f)
     LIMIT 1;
    IF bad IS NOT NULL THEN
        RAISE EXCEPTION 'unconfirmed_fields references a column that does not exist on %: %',
            TG_TABLE_NAME, bad USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION fn_validate_unconfirmed_fields() IS
    'Stops a typo in unconfirmed_fields silently un-badging a value that HR never confirmed.';

ALTER TABLE attendance_policy  ADD COLUMN unconfirmed_fields TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE employment_policy  ADD COLUMN unconfirmed_fields TEXT[] NOT NULL DEFAULT '{}';

CREATE TRIGGER tg_attendance_policy_unconfirmed
    BEFORE INSERT OR UPDATE ON attendance_policy
    FOR EACH ROW EXECUTE FUNCTION fn_validate_unconfirmed_fields();

CREATE TRIGGER tg_employment_policy_unconfirmed
    BEFORE INSERT OR UPDATE ON employment_policy
    FOR EACH ROW EXECUTE FUNCTION fn_validate_unconfirmed_fields();


-- ---------------------------------------------------------------------------
-- C4: probation, as configuration rather than a blocker
-- ---------------------------------------------------------------------------

ALTER TABLE employment_policy
    ADD COLUMN probation_accrual_method   TEXT NOT NULL DEFAULT 'segmented',
    ADD COLUMN confirmation_topup_timing  TEXT NOT NULL DEFAULT 'immediate';

ALTER TABLE employment_policy
    ADD CONSTRAINT ck_employment_probation_method
        CHECK (probation_accrual_method IN
               ('segmented', 'annual_capped', 'annual_probation_rate')),
    ADD CONSTRAINT ck_employment_topup_timing
        CHECK (confirmation_topup_timing IN ('immediate', 'next_leave_year'));

COMMENT ON COLUMN employment_policy.probation_accrual_method IS
    'How first-year entitlement is computed. segmented = probation rate pro-rated over the '
    'probation period PLUS confirmed rate pro-rated over the remainder. annual_capped = '
    'confirmed rate pro-rated over the whole year, usage capped at the probation figure while '
    'on probation. annual_probation_rate = probation rate for the whole first year, uplift only '
    'from the next leave year. For a 15-March joiner with 6-month probation these give roughly '
    '6.5 / 9.6 / 4.8 days - the settings screen must show that arithmetic, because nobody can '
    'choose between these names in the abstract.';


-- ---------------------------------------------------------------------------
-- Leave types and effective-dated leave policy
-- ---------------------------------------------------------------------------

CREATE TABLE leave_type (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code                     TEXT NOT NULL,
    name                     TEXT NOT NULL,
    is_paid                  BOOLEAN NOT NULL DEFAULT true,
    -- Does taking it reduce attendance? WFH is paid, approved, and NOT absence.
    reduces_attendance       BOOLEAN NOT NULL DEFAULT true,
    unit                     TEXT NOT NULL DEFAULT 'day',
    gender_restriction       TEXT,
    requires_document_after_days SMALLINT,
    is_statutory             BOOLEAN NOT NULL DEFAULT false,
    display_order            SMALLINT NOT NULL DEFAULT 100,
    archived_at              TIMESTAMPTZ,

    CONSTRAINT ck_leave_type_unit CHECK (unit IN ('day', 'half_day', 'hour')),
    CONSTRAINT ck_leave_type_gender
        CHECK (gender_restriction IS NULL OR gender_restriction IN ('female', 'male'))
);

CREATE UNIQUE INDEX uq_leave_type_code_active
    ON leave_type (lower(code)) WHERE archived_at IS NULL;

COMMENT ON COLUMN leave_type.reduces_attendance IS
    'False for WFH: it is paid, approved and present. payable_day_fraction stays 1.0.';


CREATE TABLE leave_policy (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    leave_type_id            UUID NOT NULL REFERENCES leave_type(id),
    legal_entity_id          UUID,

    -- Entitlement
    entitlement_days_confirmed NUMERIC(5,2) NOT NULL DEFAULT 0,
    entitlement_days_probation NUMERIC(5,2) NOT NULL DEFAULT 0,
    accrual_method           TEXT NOT NULL DEFAULT 'front_load',
    accrual_proration        TEXT NOT NULL DEFAULT 'by_join_date',
    max_balance_days         NUMERIC(5,2),

    -- Carry forward (C5)
    carry_forward_enabled    BOOLEAN NOT NULL DEFAULT false,
    carry_forward_max_days   NUMERIC(5,2) NOT NULL DEFAULT 0,
    carry_forward_expiry_months SMALLINT,
    carry_forward_is_additive BOOLEAN NOT NULL DEFAULT true,
    min_service_months_for_carry SMALLINT NOT NULL DEFAULT 0,

    -- Usage cap (C3, answered: max, warn)
    period_cap_days          NUMERIC(5,2),
    period_cap_months        SMALLINT,
    period_cap_window        TEXT NOT NULL DEFAULT 'calendar',
    period_cap_enforcement   TEXT NOT NULL DEFAULT 'warn',

    -- Day expansion (C1)
    sandwich_rule            TEXT NOT NULL DEFAULT 'none',

    -- Request rules (C2)
    advance_notice_days      SMALLINT NOT NULL DEFAULT 2,
    allow_backdated_days     SMALLINT NOT NULL DEFAULT 7,
    allow_half_day           BOOLEAN NOT NULL DEFAULT true,
    allow_negative_balance   BOOLEAN NOT NULL DEFAULT false,
    max_negative_days        NUMERIC(5,2) NOT NULL DEFAULT 0,

    -- Earned-lot expiry (C6) - comp-off
    lot_validity_months      SMALLINT,
    lot_expiry_basis         TEXT NOT NULL DEFAULT 'worked_date',

    -- Accrual continuation (C12)
    accrues_during_paid_leave   BOOLEAN NOT NULL DEFAULT true,
    accrues_during_unpaid_leave BOOLEAN NOT NULL DEFAULT false,

    -- Employment-status predicates
    blocked_during_status    TEXT[] NOT NULL DEFAULT '{}',
    extends_notice_period    BOOLEAN NOT NULL DEFAULT false,

    -- Second approver, e.g. WFH needs the IT manager as well
    requires_second_approver_role TEXT,

    unconfirmed_fields       TEXT[] NOT NULL DEFAULT '{}',

    valid_from               DATE NOT NULL,
    valid_to                 DATE,
    valid_period             daterange GENERATED ALWAYS AS
                                 (daterange(valid_from, valid_to, '[)')) STORED,
    reason                   TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by_user_id       UUID,

    CONSTRAINT ck_leave_policy_not_empty
        CHECK (NOT isempty(daterange(valid_from, valid_to, '[)'))),
    CONSTRAINT ck_leave_policy_accrual
        CHECK (accrual_method IN ('none','front_load','monthly','per_worked_days','anniversary','on_event')),
    CONSTRAINT ck_leave_policy_proration
        CHECK (accrual_proration IN ('none','by_join_date','by_days_worked')),
    CONSTRAINT ck_leave_policy_cap_window
        CHECK (period_cap_window IN ('calendar','rolling')),
    CONSTRAINT ck_leave_policy_cap_enforcement
        CHECK (period_cap_enforcement IN ('warn','block')),
    CONSTRAINT ck_leave_policy_sandwich
        CHECK (sandwich_rule IN ('none','holidays','week_offs','both')),
    CONSTRAINT ck_leave_policy_lot_basis
        CHECK (lot_expiry_basis IN ('worked_date','approved_date','earned_date')),
    -- A cap needs both a size and a window, or neither. Half a cap is a silent no-op.
    CONSTRAINT ck_leave_policy_cap_complete
        CHECK ((period_cap_days IS NULL) = (period_cap_months IS NULL)),
    -- Carry-forward that is enabled but capped at zero is a configuration mistake that
    -- looks enabled in the UI and does nothing.
    CONSTRAINT ck_leave_policy_carry_coherent
        CHECK (NOT carry_forward_enabled OR carry_forward_max_days > 0),
    CONSTRAINT ck_leave_policy_negative_coherent
        CHECK (allow_negative_balance OR max_negative_days = 0),

    CONSTRAINT ex_leave_policy_no_overlap EXCLUDE USING gist (
        leave_type_id WITH =,
        COALESCE(legal_entity_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
        valid_period WITH &&
    )
);

CREATE TRIGGER tg_leave_policy_unconfirmed
    BEFORE INSERT OR UPDATE ON leave_policy
    FOR EACH ROW EXECUTE FUNCTION fn_validate_unconfirmed_fields();

CREATE OR REPLACE FUNCTION fn_leave_policy_asof(
    p_leave_type_code TEXT,
    p_as_of DATE,
    p_legal_entity_id UUID DEFAULT NULL
) RETURNS leave_policy
LANGUAGE sql STABLE AS $$
    SELECT lp.*
      FROM leave_policy lp
      JOIN leave_type lt ON lt.id = lp.leave_type_id
     WHERE lower(lt.code) = lower(p_leave_type_code)
       AND lp.valid_period @> p_as_of
       AND (lp.legal_entity_id = p_legal_entity_id OR lp.legal_entity_id IS NULL)
     ORDER BY lp.legal_entity_id NULLS LAST
     LIMIT 1;
$$;


-- ---------------------------------------------------------------------------
-- Seed. Values HR confirmed are unbadged; engineering defaults are listed in
-- unconfirmed_fields so the settings screen can mark them.
-- ---------------------------------------------------------------------------

INSERT INTO leave_type (code, name, is_paid, reduces_attendance, requires_document_after_days,
                        is_statutory, display_order) VALUES
  ('CL',  'Casual Leave',        true,  true,  NULL, false, 10),
  ('SL',  'Sick Leave',          true,  true,  2,    false, 20),
  ('ML',  'Maternity Leave',     true,  true,  NULL, true,  30),
  ('CO',  'Compensatory Off',    true,  true,  NULL, false, 40),
  ('WFH', 'Work From Home',      true,  false, NULL, false, 50),
  ('LWP', 'Leave Without Pay',   false, true,  NULL, false, 60);

-- CL
INSERT INTO leave_policy (leave_type_id, entitlement_days_confirmed, entitlement_days_probation,
    carry_forward_enabled, carry_forward_max_days, carry_forward_expiry_months,
    min_service_months_for_carry, period_cap_days, period_cap_months,
    blocked_during_status, valid_from, reason, unconfirmed_fields)
SELECT id, 12, 6, true, 6, 12, 12, 6, 6, ARRAY['on_notice'], DATE '2020-01-01',
    'Handbook v3. Usage cap confirmed by HR 2026-09-08 (C3).',
    ARRAY['carry_forward_expiry_months','carry_forward_is_additive','period_cap_window','advance_notice_days','sandwich_rule']
FROM leave_type WHERE code = 'CL';

-- SL
INSERT INTO leave_policy (leave_type_id, entitlement_days_confirmed, entitlement_days_probation,
    period_cap_days, period_cap_months, extends_notice_period, valid_from, reason, unconfirmed_fields)
SELECT id, 12, 6, 6, 6, true, DATE '2020-01-01',
    'Handbook v3. Usage cap confirmed by HR 2026-09-08 (C3).',
    ARRAY['period_cap_window','advance_notice_days','sandwich_rule']
FROM leave_type WHERE code = 'SL';

-- ML - accrual during maternity is C12
INSERT INTO leave_policy (leave_type_id, entitlement_days_confirmed, accrual_method,
    valid_from, reason, unconfirmed_fields)
SELECT id, 182, 'on_event', DATE '2020-01-01',
    '26 weeks per the Maternity Benefit Act; 12 weeks if 2+ living children (not yet modelled).',
    ARRAY['accrues_during_paid_leave']
FROM leave_type WHERE code = 'ML';

-- CO - 3 month validity, basis is C6
INSERT INTO leave_policy (leave_type_id, accrual_method, lot_validity_months, lot_expiry_basis,
    valid_from, reason, unconfirmed_fields)
SELECT id, 'on_event', 3, 'worked_date', DATE '2020-01-01',
    'Handbook 4.6: valid three months. The date it runs from is unstated (C6).',
    ARRAY['lot_expiry_basis']
FROM leave_type WHERE code = 'CO';

-- WFH - monthly, does not reduce attendance, needs the IT manager too
INSERT INTO leave_policy (leave_type_id, entitlement_days_confirmed, accrual_method,
    max_balance_days, carry_forward_enabled, requires_second_approver_role,
    advance_notice_days, valid_from, reason)
SELECT id, 12, 'monthly', 1, false, 'it_manager', 2, DATE '2020-01-01',
    'Handbook 2.7: 12/yr, max 1 per month, no carry-over, dual approval, 48h notice.'
FROM leave_type WHERE code = 'WFH';

-- LWP
INSERT INTO leave_policy (leave_type_id, accrual_method, allow_negative_balance,
    valid_from, reason)
SELECT id, 'none', false, DATE '2020-01-01', 'Unpaid. No entitlement to accrue.'
FROM leave_type WHERE code = 'LWP';

-- Badge the engineering defaults on the existing policy rows
UPDATE attendance_policy
   SET unconfirmed_fields = ARRAY['full_day_min_minutes','ot_enabled','ot_min_minutes']
 WHERE valid_from = DATE '2020-01-01';

UPDATE employment_policy
   SET unconfirmed_fields = ARRAY['probation_months','probation_accrual_method',
                                  'confirmation_topup_timing']
 WHERE valid_from = DATE '2020-01-01';


-- ---------------------------------------------------------------------------
-- Assertions
-- ---------------------------------------------------------------------------

DO $$
DECLARE v leave_policy; n INT;
BEGIN
    SELECT count(*) INTO n FROM leave_type WHERE archived_at IS NULL;
    IF n <> 6 THEN RAISE EXCEPTION 'assertion failed: expected 6 leave types, found %', n; END IF;

    v := fn_leave_policy_asof('CL', DATE '2021-06-15');
    IF v.entitlement_days_confirmed <> 12 OR v.period_cap_days <> 6 THEN
        RAISE EXCEPTION 'assertion failed: CL policy not resolvable for a past date';
    END IF;

    SELECT count(*) INTO n FROM leave_policy WHERE cardinality(unconfirmed_fields) > 0;
    IF n = 0 THEN
        RAISE EXCEPTION 'assertion failed: no unconfirmed fields badged - the safeguard is inert';
    END IF;
END;
$$;

COMMIT;
