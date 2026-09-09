-- Adversarial verification of infrastructure/db/migrations/0002_configuration.sql.
--
-- The point of these blocks is that HR will edit these values through a screen. A settings
-- form is a bulk data operation wearing a form, so the database has to refuse configurations
-- that would silently produce wrong attendance for everyone.
--
-- Run: npm run db:verify

\set ON_ERROR_STOP on
\pset tuples_only on

-- C1: the seeded policy resolves for a PAST date
-- Without this, a recompute of a historical month has no policy to read.
DO $$
DECLARE v attendance_policy;
BEGIN
    v := fn_attendance_policy_asof(DATE '2021-06-15');
    IF v.grace_period_minutes = 15 AND v.full_day_min_minutes = 465 THEN
        RAISE NOTICE 'PASS  C1 policy resolves for a past date (grace=%, full=%)',
            v.grace_period_minutes, v.full_day_min_minutes;
    ELSE
        RAISE EXCEPTION 'FAIL  C1 no usable policy for a past date';
    END IF;
END $$;

-- C2: THE point of effective dating.
-- Change policy with effect from today; a past date must STILL resolve the old values.
DO $$
DECLARE v_old attendance_policy; v_new attendance_policy;
BEGIN
    UPDATE attendance_policy SET valid_to = fn_business_date() WHERE valid_to IS NULL;
    INSERT INTO attendance_policy (legal_entity_id, grace_period_minutes, half_day_min_minutes,
                                   full_day_min_minutes, standard_day_minutes, valid_from, reason)
    VALUES (NULL, 20, 240, 460, 480, fn_business_date(), 'verification: grace raised to 20');

    v_old := fn_attendance_policy_asof(DATE '2021-06-15');
    v_new := fn_attendance_policy_asof(fn_business_date());

    IF v_old.grace_period_minutes = 15 AND v_new.grace_period_minutes = 20 THEN
        RAISE NOTICE 'PASS  C2 history preserved: 2021 sees grace=%, today sees grace=%',
            v_old.grace_period_minutes, v_new.grace_period_minutes;
    ELSE
        RAISE EXCEPTION 'FAIL  C2 policy change leaked backwards (2021=%, today=%)',
            v_old.grace_period_minutes, v_new.grace_period_minutes;
    END IF;
END $$;

-- C3: overlapping policy versions are rejected
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
    BEGIN
        INSERT INTO attendance_policy (legal_entity_id, valid_from, valid_to, reason)
        VALUES (NULL, DATE '2030-06-01', DATE '2031-01-01', 'overlaps the open-ended initial version');
    EXCEPTION WHEN exclusion_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  C3 overlapping policy period rejected';
    ELSE RAISE EXCEPTION 'FAIL  C3 overlapping policy period ACCEPTED'; END IF;
END $$;

-- C4: a zero-length policy period is rejected (the empty-range trap)
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
    BEGIN
        INSERT INTO attendance_policy (legal_entity_id, valid_from, valid_to, reason)
        VALUES (NULL, DATE '2030-01-01', DATE '2030-01-01', 'zero length');
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  C4 zero-length policy period rejected';
    ELSE RAISE EXCEPTION 'FAIL  C4 zero-length period ACCEPTED - the empty-range hole is open'; END IF;
END $$;

-- C5: THE grace/full-day interaction.
-- grace 15 + full_day 480 against a 480-minute standard day means anyone using the grace
-- is classified a half day. HR must not be able to save that from the settings screen.
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
    BEGIN
        INSERT INTO attendance_policy (legal_entity_id, grace_period_minutes,
            half_day_min_minutes, full_day_min_minutes, standard_day_minutes, valid_from, reason)
        VALUES (NULL, 15, 240, 480, 480, DATE '2031-01-01', 'grace made worthless');
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  C5 grace-defeating config rejected (full_day 480 vs grace 15)';
    ELSE RAISE EXCEPTION 'FAIL  C5 a config that makes the grace period cost half a day was SAVED'; END IF;
END $$;

-- C6: thresholds must be ordered - half day below full day
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
    BEGIN
        INSERT INTO attendance_policy (legal_entity_id, grace_period_minutes,
            half_day_min_minutes, full_day_min_minutes, standard_day_minutes, valid_from, reason)
        VALUES (NULL, 15, 470, 460, 480, DATE '2032-01-01', 'half day above full day');
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  C6 inverted thresholds rejected';
    ELSE RAISE EXCEPTION 'FAIL  C6 half_day > full_day was ACCEPTED'; END IF;
END $$;

-- C7: an absurd grace period is rejected
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
    BEGIN
        INSERT INTO attendance_policy (legal_entity_id, grace_period_minutes,
            half_day_min_minutes, full_day_min_minutes, standard_day_minutes, valid_from, reason)
        VALUES (NULL, 240, 240, 240, 480, DATE '2033-01-01', 'four hour grace');
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  C7 out-of-range grace rejected';
    ELSE RAISE EXCEPTION 'FAIL  C7 a 4-hour grace period was ACCEPTED'; END IF;
END $$;

-- C8: probation_months stays NULL - "unknown", not "zero"
DO $$
DECLARE v employment_policy;
BEGIN
    v := fn_employment_policy_asof(fn_business_date());
    IF v.notice_period_days = 90 AND v.probation_months IS NULL THEN
        RAISE NOTICE 'PASS  C8 notice=90, probation NULL (unresolved C4, not assumed zero)';
    ELSE
        RAISE EXCEPTION 'FAIL  C8 employment policy seeded wrong (notice=%, probation=%)',
            v.notice_period_days, v.probation_months;
    END IF;
END $$;

-- C9: salary disbursement day cannot exceed 28 (the date must exist in February)
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
    BEGIN
        INSERT INTO employment_policy (legal_entity_id, salary_disbursement_day, valid_from, reason)
        VALUES (NULL, 31, DATE '2034-01-01', 'the 31st of February');
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  C9 salary day > 28 rejected';
    ELSE RAISE EXCEPTION 'FAIL  C9 salary disbursement day 31 ACCEPTED'; END IF;
END $$;

-- C10: org_setting key shape is enforced
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
    BEGIN
        INSERT INTO org_setting (key, value, value_type, category, label)
        VALUES ('Company Name!', '"x"', 'string', 'company', 'bad key');
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  C10 malformed setting key rejected';
    ELSE RAISE EXCEPTION 'FAIL  C10 malformed key ACCEPTED'; END IF;
END $$;

-- C11: org_setting updates bump updated_at (so "who changed what when" is answerable)
DO $$
DECLARE t1 TIMESTAMPTZ; t2 TIMESTAMPTZ;
BEGIN
    SELECT updated_at INTO t1 FROM org_setting WHERE key = 'company.display_name';
    PERFORM pg_sleep(0.01);
    UPDATE org_setting SET value = '"Panasa Technology"' WHERE key = 'company.display_name';
    SELECT updated_at INTO t2 FROM org_setting WHERE key = 'company.display_name';
    IF t2 > t1 THEN RAISE NOTICE 'PASS  C11 org_setting updated_at is maintained';
    ELSE RAISE EXCEPTION 'FAIL  C11 updated_at did not advance'; END IF;
END $$;

-- No restore block. It was removed on 2026-09-08 for two independent reasons:
--
--   1. It is redundant. scripts/migrate.mjs now runs every verify script inside a transaction
--      that is always rolled back (DEC-024), so idempotency is structural rather than manual.
--
--   2. It was itself a Rule 3 violation. `UPDATE attendance_policy SET valid_to = NULL` re-opened
--      a closed period, and the DELETE removed policy versions outright. Migration 0004 now
--      blocks both, so this block would fail. The ADR verification noted that the suite
--      demonstrated the hole while reporting green - restoring state by rewriting history is
--      exactly the operation the system must refuse.

SELECT 'CONFIGURATION VERIFICATION COMPLETE' AS result;
