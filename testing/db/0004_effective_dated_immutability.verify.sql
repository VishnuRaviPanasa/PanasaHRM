-- =============================================================================
-- Verification for 0004: Must-Know Rule 3 enforcement (in-place UPDATE and DELETE)
--
-- Strengthened 2026-09-08 after review found several checks passing for the wrong reason:
--   * R2/R7 changed `grace_period_minutes`, which independently violates
--     ck_attendance_policy_grace_usable - so they would have failed with no trigger at all and
--     never tested an otherwise-LEGAL edit. They now change `ot_min_minutes`, which carries no
--     cross-column CHECK, and R2 first proves that value is schema-legal via a real INSERT.
--   * R9 ran after R5, so its target row started today and `valid_to = today - 30` was an
--     inverted range rejected by the empty-range CHECK. It now runs while the 2020 period is
--     still open, where the only thing that can reject it is the trigger.
--   * R3 checked trigger EXISTENCE only, and passed against a DISABLED trigger. It now checks
--     tgenabled, and requires ENABLE ALWAYS so session_replication_role cannot switch it off.
--
-- Every check attempts a mutation that MUST fail, or one that MUST succeed, and asserts the
-- outcome. Only `restrict_violation` is caught: if the trigger were absent and some other
-- constraint fired, that exception would escape and fail the run loudly rather than silently
-- looking like a pass.
--
-- Runs inside the transaction scripts/migrate.mjs opens and always rolls back (DEC-024).
-- =============================================================================

-- R1: a policy row may not be DELETEd -------------------------------------------------------
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
    BEGIN
        DELETE FROM attendance_policy WHERE valid_from = DATE '2020-01-01';
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  R1 DELETE of an effective-dated policy row is blocked';
    ELSE RAISE EXCEPTION 'FAIL  R1 a policy row was deleted - Rule 3 is not enforced'; END IF;
END $$;

-- R2: an otherwise-LEGAL value change is refused in place -------------------------------------
-- The positive control matters: it proves ot_min_minutes = 45 is acceptable to the schema, so
-- the refusal below can only be the Rule 3 trigger.
DO $$
DECLARE v_ok BOOLEAN := false; v_legal BOOLEAN := false; v_ot SMALLINT;
BEGIN
    BEGIN
        INSERT INTO attendance_policy (legal_entity_id, ot_min_minutes, valid_from, reason)
        VALUES ('11111111-1111-1111-1111-111111111111', 45, DATE '2090-01-01',
                'verification: positive control, this value is schema-legal');
        v_legal := true;
    EXCEPTION WHEN OTHERS THEN v_legal := false;
    END;

    BEGIN
        UPDATE attendance_policy SET ot_min_minutes = 45
         WHERE valid_from = DATE '2020-01-01';
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;

    SELECT ot_min_minutes INTO v_ot
      FROM attendance_policy WHERE valid_from = DATE '2020-01-01';

    IF v_legal AND v_ok AND v_ot = 30 THEN
        RAISE NOTICE 'PASS  R2 a schema-legal in-place value change is blocked (ot still %)', v_ot;
    ELSE
        RAISE EXCEPTION 'FAIL  R2 (value legal=%, blocked=%, ot=%)', v_legal, v_ok, v_ot;
    END IF;
END $$;

-- R9: back-dating the closure of a STILL-OPEN period.
-- Deliberately placed before R5: while the 2020 period is open, 2020-01-01 .. (today-30) is a
-- perfectly valid non-empty range, so the empty-range CHECK cannot reject it. Only the trigger can.
DO $$
DECLARE v_ok BOOLEAN := false; v_target DATE;
BEGIN
    v_target := fn_business_date() - 30;
    IF v_target <= DATE '2020-01-01' THEN
        RAISE EXCEPTION 'FAIL  R9 fixture invalid: target % is not after the period start', v_target;
    END IF;
    BEGIN
        UPDATE attendance_policy SET valid_to = v_target
         WHERE valid_from = DATE '2020-01-01' AND valid_to IS NULL;
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    IF v_ok THEN
        RAISE NOTICE 'PASS  R9 back-dating valid_to to % is blocked (range was valid)', v_target;
    ELSE
        RAISE EXCEPTION 'FAIL  R9 a period was closed retroactively at %', v_target;
    END IF;
END $$;

-- R3: coverage AND enabled state.
-- Any table carrying both valid_from and valid_to is effective-dated regardless of what its
-- range column is called, so keying on `valid_period` alone would miss a future variant.
DO $$
DECLARE v_missing TEXT; v_weak TEXT;
BEGIN
    SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO v_missing
      FROM pg_class c
     WHERE c.relkind IN ('r', 'p')
       AND c.relnamespace = 'public'::regnamespace
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                    AND a.attname = 'valid_from' AND a.attnum > 0 AND NOT a.attisdropped)
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                    AND a.attname = 'valid_to' AND a.attnum > 0 AND NOT a.attisdropped)
       AND NOT EXISTS (
            SELECT 1 FROM pg_trigger t
             WHERE t.tgrelid = c.oid AND NOT t.tgisinternal
               AND t.tgfoid = 'fn_block_historical_mutation'::regproc);
    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'FAIL  R3 effective-dated table(s) with no Rule 3 trigger: %', v_missing;
    END IF;

    -- Existence is not enough: a DISABLED trigger enforces nothing, and one that is merely
    -- ENABLED (tgenabled='O') is switched off by session_replication_role='replica'.
    SELECT string_agg(c.relname || '.' || t.tgname || '=' || t.tgenabled::text, ', ' ORDER BY c.relname)
      INTO v_weak
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE NOT t.tgisinternal
       AND t.tgfoid IN ('fn_block_historical_mutation'::regproc,
                        'fn_block_backdated_period'::regproc,
                        'fn_block_mutation'::regproc)
       AND t.tgenabled <> 'A';
    IF v_weak IS NOT NULL THEN
        RAISE EXCEPTION 'FAIL  R3 protective trigger(s) not ENABLE ALWAYS: %', v_weak;
    END IF;

    RAISE NOTICE 'PASS  R3 every effective-dated table is covered, and every rail is ENABLE ALWAYS';
END $$;

-- R4: the protection is functional on ALL THREE tables ---------------------------------------
DO $$
DECLARE v_emp BOOLEAN := false; v_lv BOOLEAN := false;
BEGIN
    BEGIN
        UPDATE employment_policy SET notice_period_days = 45 WHERE valid_to IS NULL;
    EXCEPTION WHEN restrict_violation THEN v_emp := true;
    END;
    BEGIN
        DELETE FROM leave_policy
         WHERE leave_type_id = (SELECT id FROM leave_type WHERE code = 'CL');
    EXCEPTION WHEN restrict_violation THEN v_lv := true;
    END;
    IF v_emp AND v_lv THEN
        RAISE NOTICE 'PASS  R4 employment_policy UPDATE and leave_policy DELETE both blocked';
    ELSE
        RAISE EXCEPTION 'FAIL  R4 coverage gap (employment blocked=%, leave blocked=%)', v_emp, v_lv;
    END IF;
END $$;

-- R5 + R6: THE REPLACEMENT MECHANISM, and history intact afterwards --------------------------
DO $$
DECLARE v_old attendance_policy; v_new attendance_policy;
BEGIN
    UPDATE attendance_policy
       SET valid_to = fn_business_date(), reason = 'verification: superseded by R5'
     WHERE valid_to IS NULL AND valid_from = DATE '2020-01-01';

    INSERT INTO attendance_policy (legal_entity_id, grace_period_minutes, half_day_min_minutes,
                                   full_day_min_minutes, standard_day_minutes, valid_from, reason)
    VALUES (NULL, 20, 240, 460, 480, fn_business_date(), 'verification: R5 replacement period');

    v_old := fn_attendance_policy_asof(DATE '2021-06-15');
    v_new := fn_attendance_policy_asof(fn_business_date());

    IF v_old.grace_period_minutes = 15 AND v_new.grace_period_minutes = 20 THEN
        RAISE NOTICE 'PASS  R5 close-then-insert still works (the sanctioned replacement path)';
        RAISE NOTICE 'PASS  R6 history intact after replacement: 2021 sees %, today sees %',
            v_old.grace_period_minutes, v_new.grace_period_minutes;
    ELSE
        RAISE EXCEPTION 'FAIL  R5/R6 replacement broke as-of resolution (2021=%, today=%)',
            v_old.grace_period_minutes, v_new.grace_period_minutes;
    END IF;
END $$;

-- R7: the row closed by R5 is now HISTORICAL. A legal value change must still be refused. -----
DO $$
DECLARE v_ok BOOLEAN := false; v_ot SMALLINT;
BEGIN
    BEGIN
        UPDATE attendance_policy SET ot_min_minutes = 45
         WHERE valid_from = DATE '2020-01-01';
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    SELECT ot_min_minutes INTO v_ot FROM attendance_policy WHERE valid_from = DATE '2020-01-01';
    IF v_ok AND v_ot = 30 THEN
        RAISE NOTICE 'PASS  R7 a closed (historical) period cannot be edited, even legally';
    ELSE RAISE EXCEPTION 'FAIL  R7 a historical period was rewritten (blocked=%, ot=%)', v_ok, v_ot;
    END IF;
END $$;

-- R8: re-opening a closed period --------------------------------------------------------------
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
    BEGIN
        UPDATE attendance_policy SET valid_to = NULL WHERE valid_from = DATE '2020-01-01';
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  R8 re-opening a closed period is blocked';
    ELSE RAISE EXCEPTION 'FAIL  R8 a closed period was re-opened - history is rewritable'; END IF;
END $$;

-- R10: the badge column stays writable (DEC-020 / DEC-027) ------------------------------------
DO $$
DECLARE v_ok BOOLEAN := true;
BEGIN
    BEGIN
        UPDATE attendance_policy SET unconfirmed_fields = ARRAY['grace_period_minutes']
         WHERE valid_to IS NULL;
    EXCEPTION WHEN OTHERS THEN v_ok := false;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  R10 unconfirmed_fields badge remains updatable';
    ELSE RAISE EXCEPTION 'FAIL  R10 the badge cannot be maintained - DEC-020 is unworkable'; END IF;
END $$;

-- R11: an unqualified mass UPDATE --------------------------------------------------------------
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
    BEGIN
        UPDATE leave_policy SET entitlement_days_confirmed = 99;
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  R11 unqualified mass UPDATE is blocked';
    ELSE RAISE EXCEPTION 'FAIL  R11 every leave policy was overwritten at once'; END IF;
END $$;

-- R12: moving valid_from re-attributes the past ------------------------------------------------
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
    BEGIN
        UPDATE employment_policy SET valid_from = DATE '2019-01-01' WHERE valid_to IS NULL;
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  R12 moving valid_from is blocked';
    ELSE RAISE EXCEPTION 'FAIL  R12 a period start was moved'; END IF;
END $$;

-- R13: the migration is in the numbered chain and recorded as applied --------------------------
DO $$
DECLARE v_n INT;
BEGIN
    SELECT count(*) INTO v_n FROM schema_migration WHERE version IN ('0004', '0005');
    IF v_n = 2 THEN RAISE NOTICE 'PASS  R13 migrations 0004 and 0005 are both recorded';
    ELSE RAISE EXCEPTION 'FAIL  R13 chain incomplete (found % of 2)', v_n; END IF;
END $$;

SELECT 'RULE 3 IMMUTABILITY VERIFICATION COMPLETE' AS result;
