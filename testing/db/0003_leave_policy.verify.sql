-- Adversarial verification of 0003_leave_policy_configuration.sql.
--
-- These questions used to be blockers. They are now settings, which moves the risk from
-- "the developer guessed" to "HR never looked and the default became policy". The
-- unconfirmed_fields safeguard is what these blocks mostly test.

\set ON_ERROR_STOP on
\pset tuples_only on

-- L1: CL policy resolves for a past date with HR's confirmed cap
DO $$
DECLARE v leave_policy;
BEGIN
    v := fn_leave_policy_asof('CL', DATE '2021-06-15');
    IF v.entitlement_days_confirmed = 12 AND v.entitlement_days_probation = 6
       AND v.period_cap_days = 6 AND v.period_cap_enforcement = 'warn' THEN
        RAISE NOTICE 'PASS  L1 CL resolves: 12/6 days, cap 6 per 6 months, enforcement=warn';
    ELSE
        RAISE EXCEPTION 'FAIL  L1 CL policy wrong';
    END IF;
END $$;

-- L2: WFH does not reduce attendance - it is paid, approved and present
DO $$
DECLARE v BOOLEAN;
BEGIN
    SELECT reduces_attendance INTO v FROM leave_type WHERE code = 'WFH';
    IF v = false THEN RAISE NOTICE 'PASS  L2 WFH does not reduce attendance';
    ELSE RAISE EXCEPTION 'FAIL  L2 WFH would be counted as absence'; END IF;
END $$;

-- L3: THE SAFEGUARD. A typo in unconfirmed_fields must be rejected, or a value HR never
-- confirmed silently loses its badge and starts looking authoritative.
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
    BEGIN
        UPDATE leave_policy SET unconfirmed_fields = ARRAY['no_such_column']
         WHERE leave_type_id = (SELECT id FROM leave_type WHERE code = 'CL');
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  L3 typo in unconfirmed_fields rejected';
    ELSE RAISE EXCEPTION 'FAIL  L3 a nonexistent column was accepted - the badge is unreliable'; END IF;
END $$;

-- L4: engineering defaults are actually badged, so the screen can mark them
DO $$
DECLARE n INT; f TEXT[];
BEGIN
    SELECT unconfirmed_fields INTO f FROM employment_policy WHERE valid_from = DATE '2020-01-01';
    IF 'probation_months' = ANY(f) AND 'probation_accrual_method' = ANY(f) THEN
        RAISE NOTICE 'PASS  L4 probation fields badged unconfirmed (C4 still open)';
    ELSE
        RAISE EXCEPTION 'FAIL  L4 probation is not badged - it would look like settled policy';
    END IF;
END $$;

-- L5: a half-configured cap is rejected. Size with no window is a silent no-op.
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
    BEGIN
        INSERT INTO leave_policy (leave_type_id, period_cap_days, period_cap_months, valid_from)
        SELECT id, 6, NULL, DATE '2040-01-01' FROM leave_type WHERE code = 'CL';
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  L5 cap size without a window rejected';
    ELSE RAISE EXCEPTION 'FAIL  L5 half-configured cap accepted - it would silently do nothing'; END IF;
END $$;

-- L6: carry-forward enabled but capped at zero is rejected. Looks on, does nothing.
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
    BEGIN
        INSERT INTO leave_policy (leave_type_id, carry_forward_enabled, carry_forward_max_days,
                                  valid_from)
        SELECT id, true, 0, DATE '2041-01-01' FROM leave_type WHERE code = 'CL';
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  L6 carry-forward enabled with zero cap rejected';
    ELSE RAISE EXCEPTION 'FAIL  L6 a carry-forward that silently does nothing was accepted'; END IF;
END $$;

-- L7: overlapping policy versions for the same leave type are rejected
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
    BEGIN
        INSERT INTO leave_policy (leave_type_id, valid_from, valid_to)
        SELECT id, DATE '2020-06-01', DATE '2021-01-01' FROM leave_type WHERE code = 'CL';
    EXCEPTION WHEN exclusion_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  L7 overlapping leave policy rejected';
    ELSE RAISE EXCEPTION 'FAIL  L7 overlapping leave policy accepted'; END IF;
END $$;

-- L8: the probation accrual method enum only accepts the three modelled readings
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
    BEGIN
        INSERT INTO employment_policy (probation_accrual_method, valid_from)
        VALUES ('whatever_hr_types', DATE '2042-01-01');
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  L8 unmodelled probation method rejected';
    ELSE RAISE EXCEPTION 'FAIL  L8 an unimplemented accrual method was accepted'; END IF;
END $$;

-- L9: policy change with effect from today leaves history intact
DO $$
DECLARE v_old leave_policy; v_new leave_policy;
BEGIN
    UPDATE leave_policy SET valid_to = CURRENT_DATE
     WHERE leave_type_id = (SELECT id FROM leave_type WHERE code='CL') AND valid_to IS NULL;
    INSERT INTO leave_policy (leave_type_id, entitlement_days_confirmed,
        entitlement_days_probation, period_cap_days, period_cap_months, valid_from, reason)
    SELECT id, 15, 6, 6, 6, CURRENT_DATE, 'verification: CL raised to 15'
      FROM leave_type WHERE code = 'CL';

    v_old := fn_leave_policy_asof('CL', DATE '2021-06-15');
    v_new := fn_leave_policy_asof('CL', CURRENT_DATE);
    IF v_old.entitlement_days_confirmed = 12 AND v_new.entitlement_days_confirmed = 15 THEN
        RAISE NOTICE 'PASS  L9 history intact: 2021 sees 12 days, today sees 15';
    ELSE
        RAISE EXCEPTION 'FAIL  L9 entitlement change leaked backwards (2021=%, today=%)',
            v_old.entitlement_days_confirmed, v_new.entitlement_days_confirmed;
    END IF;
END $$;

-- restore
DELETE FROM leave_policy WHERE reason LIKE 'verification:%';
UPDATE leave_policy SET valid_to = NULL
 WHERE valid_from = DATE '2020-01-01'
   AND leave_type_id = (SELECT id FROM leave_type WHERE code = 'CL');

SELECT 'LEAVE POLICY VERIFICATION COMPLETE' AS result;
