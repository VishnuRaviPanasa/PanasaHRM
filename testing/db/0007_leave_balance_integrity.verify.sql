-- =============================================================================
-- Verification for 0007: ADR-0006's leave balance mechanism (single-session properties)
--
-- The CONCURRENCY proof is not here and cannot be: write skew is invisible to a single session
-- by definition. It lives in `testing/db/concurrency/leave-overdraw.test.mjs`, which fires 20
-- real connections at one account. These checks cover the properties a single session CAN prove.
-- =============================================================================

-- V1: the CHECK exists and references the generated column. ADR-0006's snippet was flagged in
-- review as possibly illegal; it is legal on PostgreSQL 18 and this pins that.
DO $$
DECLARE v_def TEXT;
BEGIN
    SELECT pg_get_constraintdef(oid) INTO v_def
      FROM pg_constraint WHERE conname = 'ck_leave_account_no_overdraw';
    IF v_def IS NULL THEN RAISE EXCEPTION 'FAIL  V1 the anti-overdraw CHECK does not exist'; END IF;
    IF v_def ILIKE '%available%' AND v_def ILIKE '%allowed_negative%' THEN
        RAISE NOTICE 'PASS  V1 anti-overdraw CHECK present: %', v_def;
    ELSE
        RAISE EXCEPTION 'FAIL  V1 CHECK does not constrain available against allowed_negative: %', v_def;
    END IF;
END $$;

-- V2: money/day quantities are NUMERIC, never floating point (Must-Know Rule 4).
DO $$
DECLARE v_bad TEXT;
BEGIN
    SELECT string_agg(a.attname, ', ') INTO v_bad
      FROM pg_attribute a
     WHERE a.attrelid = 'leave_account'::regclass AND a.attnum > 0 AND NOT a.attisdropped
       AND format_type(a.atttypid, NULL) IN ('double precision', 'real');
    IF v_bad IS NULL THEN RAISE NOTICE 'PASS  V2 no floating-point balance column';
    ELSE RAISE EXCEPTION 'FAIL  V2 floating point in a balance: %', v_bad; END IF;
END $$;

-- V3: a single-session overdraw is refused. Necessary but NOT sufficient - it does not prove
-- anything about concurrency, which is the whole point of ADR-0006.
DO $$
DECLARE v_cl UUID; v_emp UUID := gen_random_uuid(); v_ok BOOLEAN := false;
BEGIN
    SELECT id INTO v_cl FROM leave_type WHERE code = 'CL';
    INSERT INTO leave_ledger (employee_id, leave_type_id, leave_year, entry_type, days, reason)
    VALUES (v_emp, v_cl, 2026, 'accrual', 2, 'verification');
    BEGIN
        INSERT INTO leave_ledger (employee_id, leave_type_id, leave_year, entry_type, days, reason)
        VALUES (v_emp, v_cl, 2026, 'hold', 3, 'verification: overdraw');
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  V3 spending more than the balance raises 23514';
    ELSE RAISE EXCEPTION 'FAIL  V3 an overdraw was accepted'; END IF;
END $$;

-- V4: the account materialises on first use. Without the INSERT ... ON CONFLICT before the
-- FOR UPDATE, the lock would grab nothing and the CHECK would never be evaluated.
DO $$
DECLARE v_cl UUID; v_emp UUID := gen_random_uuid(); v_avail NUMERIC;
BEGIN
    SELECT id INTO v_cl FROM leave_type WHERE code = 'CL';
    INSERT INTO leave_ledger (employee_id, leave_type_id, leave_year, entry_type, days, reason)
    VALUES (v_emp, v_cl, 2026, 'accrual', 5, 'verification');
    SELECT available INTO v_avail FROM leave_account
     WHERE employee_id = v_emp AND leave_type_id = v_cl AND leave_year = 2026;
    IF v_avail = 5 THEN RAISE NOTICE 'PASS  V4 first ledger entry materialises the account (avail=%)', v_avail;
    ELSE RAISE EXCEPTION 'FAIL  V4 account not materialised (avail=%)', v_avail; END IF;
END $$;

-- V5: Must-Know Rule 6, mechanically. leave_account has exactly one writer.
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
    BEGIN
        UPDATE leave_account SET accrued = accrued + 100;
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  V5 direct UPDATE of leave_account is refused (Rule 6)';
    ELSE RAISE EXCEPTION 'FAIL  V5 a balance can be set independently of the ledger'; END IF;
END $$;

-- V6: the writer flag is cleared immediately, so it cannot be reused later in the transaction.
DO $$
DECLARE v_cl UUID; v_emp UUID := gen_random_uuid(); v_ok BOOLEAN := false;
BEGIN
    SELECT id INTO v_cl FROM leave_type WHERE code = 'CL';
    INSERT INTO leave_ledger (employee_id, leave_type_id, leave_year, entry_type, days, reason)
    VALUES (v_emp, v_cl, 2026, 'accrual', 5, 'verification');
    -- the trigger has just run and set, then cleared, the flag
    BEGIN
        UPDATE leave_account SET accrued = accrued + 100 WHERE employee_id = v_emp;
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  V6 the writer flag does not leak to later statements';
    ELSE RAISE EXCEPTION 'FAIL  V6 the flag stayed on - one ledger write authorises any UPDATE'; END IF;
END $$;

-- V7: the ledger is append-only, and TRUNCATE does not bypass it.
--
-- TRUNCATE is accepted as blocked by EITHER the statement trigger (restrict_violation) or a
-- foreign key (feature_not_supported) - `leave_request` references leave_ledger since migration
-- 0011, and PostgreSQL refuses on the FK before any trigger runs. Insisting on the trigger here
-- would fail every time a new FK is added, which has now happened three times. The trigger
-- itself is isolated by P7a in 0005's suite, against a table with no inbound FK.
-- Row survival is asserted either way, so a genuinely successful truncate cannot pass.
DO $$
DECLARE v_u BOOLEAN := false; v_d BOOLEAN := false; v_t TEXT := 'ALLOWED'; v_rows INT;
BEGIN
    BEGIN UPDATE leave_ledger SET days = 1; EXCEPTION WHEN restrict_violation THEN v_u := true; END;
    BEGIN DELETE FROM leave_ledger;         EXCEPTION WHEN restrict_violation THEN v_d := true; END;
    BEGIN TRUNCATE leave_ledger;
    EXCEPTION WHEN restrict_violation   THEN v_t := 'trigger';
              WHEN feature_not_supported THEN v_t := 'foreign key';
    END;
    SELECT count(*) INTO v_rows FROM leave_ledger;
    IF v_u AND v_d AND v_t <> 'ALLOWED' AND v_rows > 0 THEN
        RAISE NOTICE 'PASS  V7 ledger UPDATE and DELETE blocked; TRUNCATE blocked by % (% rows intact)',
            v_t, v_rows;
    ELSE
        RAISE EXCEPTION 'FAIL  V7 (update=%, delete=%, truncate=%, rows=%)', v_u, v_d, v_t, v_rows;
    END IF;
END $$;

-- V8: the ledger records the resolved policy VERSION (§9 amendment to ADR-0006).
DO $$
DECLARE v_has BOOLEAN;
BEGIN
    SELECT EXISTS (SELECT 1 FROM pg_attribute
                    WHERE attrelid = 'leave_ledger'::regclass
                      AND attname = 'leave_policy_id' AND attnum > 0 AND NOT attisdropped)
      INTO v_has;
    IF v_has THEN RAISE NOTICE 'PASS  V8 leave_ledger carries leave_policy_id';
    ELSE RAISE EXCEPTION 'FAIL  V8 no policy version on the ledger row - balances are not re-derivable';
    END IF;
END $$;

-- V9: every protective trigger on these tables is ENABLE ALWAYS.
DO $$
DECLARE v_weak TEXT;
BEGIN
    SELECT string_agg(c.relname || '.' || t.tgname, ', ') INTO v_weak
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE NOT t.tgisinternal
       AND c.relname IN ('leave_ledger', 'leave_account')
       AND t.tgenabled <> 'A';
    IF v_weak IS NULL THEN RAISE NOTICE 'PASS  V9 leave rails are all ENABLE ALWAYS';
    ELSE RAISE EXCEPTION 'FAIL  V9 not ENABLE ALWAYS: %', v_weak; END IF;
END $$;

SELECT 'LEAVE BALANCE INTEGRITY VERIFICATION COMPLETE' AS result;
