-- =============================================================================
-- Verification for 0015: future-dated lifecycle events must not take effect early
--
-- F3 is the check that matters. Before 0015, recording a resignation with a future last working
-- day marked the employee `exited` immediately - and `exited` gates attendance, leave accrual
-- and payroll, so the system would have stopped paying somebody who was still working.
--
-- Every fixture here is created by the check that uses it. The first draft of 0014's suite
-- selected seeded employees by predicate and went vacuous when the seed changed underneath it.
--
-- Runs inside a transaction the runner always rolls back (DEC-024).
-- =============================================================================

-- F1: the derivation function exists and pins search_path (precedent 0013).
DO $$
DECLARE v_bad TEXT;
BEGIN
    SELECT string_agg(p.proname, ', ') INTO v_bad
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('fn_refresh_employment_status','fn_refresh_due_employment_status')
       AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig,'{}')) cfg
                        WHERE cfg LIKE 'search_path=%');
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'FAIL  F1 unpinned search_path: %', v_bad;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname='public' AND p.proname='fn_refresh_employment_status') THEN
        RAISE EXCEPTION 'FAIL  F1 fn_refresh_employment_status does not exist';
    END IF;
    RAISE NOTICE 'PASS  F1 refresh functions exist and pin search_path';
END $$;

-- F2: a pre-boarding hire recorded in advance is NOT active yet.
DO $$
DECLARE v_emp UUID; v_join DATE; r RECORD;
BEGIN
    v_join := fn_business_date() + 30;
    INSERT INTO employee (employee_number, full_name, work_email, joined_on)
    VALUES ('VERIFY-F2','Future Hire','verify-f2@example.invalid', v_join)
    RETURNING id INTO v_emp;

    INSERT INTO employment_event (employee_id, event_type, from_status, to_status, effective_on)
    VALUES (v_emp, 'joined', 'pre_boarding', 'active', v_join);

    SELECT status INTO r FROM employee WHERE id = v_emp;
    IF r.status <> 'pre_boarding' THEN
        RAISE EXCEPTION 'FAIL  F2 a hire joining in 30 days is already %', r.status;
    END IF;
    IF fn_employment_status_asof(v_emp, v_join) <> 'active' THEN
        RAISE EXCEPTION 'FAIL  F2 as-of the joining date they are not active';
    END IF;
    RAISE NOTICE 'PASS  F2 a future joining event does not activate the employee early';
END $$;

-- F3: THE ONE THAT MATTERS. A scheduled exit must not exit the employee today.
DO $$
DECLARE v_emp UUID; v_lwd DATE; r RECORD;
BEGIN
    v_lwd := fn_business_date() + 30;
    INSERT INTO employee (employee_number, full_name, work_email, joined_on, status)
    VALUES ('VERIFY-F3','Scheduled Leaver','verify-f3@example.invalid','2022-01-03','pre_boarding')
    RETURNING id INTO v_emp;

    INSERT INTO employment_event (employee_id, event_type, from_status, to_status, effective_on)
    VALUES (v_emp, 'joined', 'pre_boarding', 'active', '2022-01-03');

    INSERT INTO employment_event
        (employee_id, event_type, from_status, to_status, effective_on, last_working_day)
    VALUES (v_emp, 'resigned', 'active', 'on_notice', fn_business_date(), v_lwd);

    INSERT INTO employment_event
        (employee_id, event_type, from_status, to_status, effective_on, exit_type, reason)
    VALUES (v_emp, 'exited', 'on_notice', 'exited', v_lwd, 'resignation', 'served notice');

    SELECT status, exited_on, exit_type, resigned_on, last_working_day INTO r
      FROM employee WHERE id = v_emp;

    IF r.status = 'exited' OR r.exited_on IS NOT NULL THEN
        RAISE EXCEPTION
            'FAIL  F3 an employee with a last working day on % is ALREADY exited (status=%, '
            'exited_on=%). Attendance, leave accrual and payroll all gate on this',
            v_lwd, r.status, r.exited_on;
    END IF;
    IF r.status <> 'on_notice' THEN
        RAISE EXCEPTION 'FAIL  F3 expected on_notice, got %', r.status;
    END IF;
    IF r.last_working_day <> v_lwd THEN
        RAISE EXCEPTION 'FAIL  F3 the notice date did not materialise: %', r.last_working_day;
    END IF;

    -- ... and the log still knows the truth about the future.
    IF fn_employment_status_asof(v_emp, v_lwd - 1) <> 'on_notice'
       OR fn_employment_status_asof(v_emp, v_lwd) <> 'exited' THEN
        RAISE EXCEPTION 'FAIL  F3 as-of resolution is wrong across the exit boundary';
    END IF;

    RAISE NOTICE 'PASS  F3 a scheduled exit stays on_notice until the date arrives';
END $$;

-- F4: the cache is SELF-HEALING. Corrupt it directly, refresh, and it repairs itself. This is
-- the property that makes the derived rewrite better than the per-column CASE it replaced.
DO $$
DECLARE v_emp UUID; v_join DATE := DATE '2023-03-06'; r RECORD;
BEGIN
    INSERT INTO employee (employee_number, full_name, work_email, joined_on, status)
    VALUES ('VERIFY-F4','Self Healer','verify-f4@example.invalid', v_join, 'pre_boarding')
    RETURNING id INTO v_emp;

    INSERT INTO employment_event (employee_id, event_type, from_status, to_status, effective_on)
    VALUES (v_emp, 'joined', 'pre_boarding', 'active', v_join);
    INSERT INTO employment_event (employee_id, event_type, from_status, to_status, effective_on)
    VALUES (v_emp, 'confirmed', 'active', 'active', v_join + 180);

    -- Corrupt the cache behind the log's back.
    UPDATE employee SET confirmed_on = NULL, status = 'pre_boarding' WHERE id = v_emp;
    SELECT status, confirmed_on INTO r FROM employee WHERE id = v_emp;
    IF r.confirmed_on IS NOT NULL THEN
        RAISE EXCEPTION 'FAIL  F4 could not stage the corruption';
    END IF;

    PERFORM fn_refresh_employment_status(v_emp);

    SELECT status, confirmed_on INTO r FROM employee WHERE id = v_emp;
    IF r.status = 'active' AND r.confirmed_on = v_join + 180 THEN
        RAISE NOTICE 'PASS  F4 a corrupted cache is repaired from the log by one refresh';
    ELSE
        RAISE EXCEPTION 'FAIL  F4 refresh did not repair: status=% confirmed_on=%',
            r.status, r.confirmed_on;
    END IF;
END $$;

-- F5: refreshing is idempotent - it is going to run on a schedule.
DO $$
DECLARE v_emp UUID; v_join DATE := DATE '2023-04-06'; a RECORD; b RECORD;
BEGIN
    INSERT INTO employee (employee_number, full_name, work_email, joined_on, status)
    VALUES ('VERIFY-F5','Idempotent','verify-f5@example.invalid', v_join, 'pre_boarding')
    RETURNING id INTO v_emp;
    INSERT INTO employment_event (employee_id, event_type, from_status, to_status, effective_on)
    VALUES (v_emp, 'joined', 'pre_boarding', 'active', v_join);

    PERFORM fn_refresh_employment_status(v_emp);
    SELECT status, confirmed_on, resigned_on, exited_on INTO a FROM employee WHERE id = v_emp;
    PERFORM fn_refresh_employment_status(v_emp);
    PERFORM fn_refresh_employment_status(v_emp);
    SELECT status, confirmed_on, resigned_on, exited_on INTO b FROM employee WHERE id = v_emp;

    IF a IS DISTINCT FROM b THEN
        RAISE EXCEPTION 'FAIL  F5 refresh is not idempotent: % vs %', a, b;
    END IF;
    RAISE NOTICE 'PASS  F5 refresh is idempotent';
END $$;

-- F6: withdrawing a resignation still clears the notice under the derived model. Regression
-- guard on 0014's L14, whose mechanism 0015 replaced entirely.
DO $$
DECLARE v_emp UUID; v_join DATE := DATE '2023-05-08'; r RECORD;
BEGIN
    INSERT INTO employee (employee_number, full_name, work_email, joined_on, status)
    VALUES ('VERIFY-F6','Withdrawer 2','verify-f6@example.invalid', v_join, 'pre_boarding')
    RETURNING id INTO v_emp;

    INSERT INTO employment_event (employee_id, event_type, from_status, to_status, effective_on)
    VALUES (v_emp, 'joined', 'pre_boarding', 'active', v_join);
    INSERT INTO employment_event
        (employee_id, event_type, from_status, to_status, effective_on, last_working_day)
    VALUES (v_emp, 'resigned', 'active', 'on_notice', v_join + 100, v_join + 130);
    INSERT INTO employment_event (employee_id, event_type, from_status, to_status, effective_on)
    VALUES (v_emp, 'resignation_withdrawn', 'on_notice', 'active', v_join + 110);

    SELECT status, resigned_on, last_working_day INTO r FROM employee WHERE id = v_emp;
    IF r.status = 'active' AND r.resigned_on IS NULL AND r.last_working_day IS NULL THEN
        RAISE NOTICE 'PASS  F6 withdrawal clears the notice under the derived model too';
    ELSE
        RAISE EXCEPTION 'FAIL  F6 stale notice: % % %',
            r.status, r.resigned_on, r.last_working_day;
    END IF;
END $$;

-- F7: the exit reason is derived from the exit event, so the RESTRICTED column cannot drift
-- away from the log entry that justifies it.
DO $$
DECLARE v_emp UUID; v_join DATE := DATE '2023-06-05'; r RECORD;
BEGIN
    INSERT INTO employee (employee_number, full_name, work_email, joined_on, status)
    VALUES ('VERIFY-F7','Exiter','verify-f7@example.invalid', v_join, 'pre_boarding')
    RETURNING id INTO v_emp;

    INSERT INTO employment_event (employee_id, event_type, from_status, to_status, effective_on)
    VALUES (v_emp, 'joined', 'pre_boarding', 'active', v_join);
    INSERT INTO employment_event
        (employee_id, event_type, from_status, to_status, effective_on, exit_type, reason)
    VALUES (v_emp, 'exited', 'active', 'exited', v_join + 400, 'end_of_contract',
            'fixed-term contract concluded');

    SELECT status, exited_on, exit_type, exit_reason INTO r FROM employee WHERE id = v_emp;
    IF r.status = 'exited' AND r.exit_type = 'end_of_contract'
       AND r.exit_reason = 'fixed-term contract concluded' THEN
        RAISE NOTICE 'PASS  F7 exit type and reason are derived from the exit event';
    ELSE
        RAISE EXCEPTION 'FAIL  F7 % % %', r.status, r.exit_type, r.exit_reason;
    END IF;
END $$;

-- F8: a new employee row does not claim to be active before its joining event.
DO $$
DECLARE v_default TEXT;
BEGIN
    SELECT pg_get_expr(d.adbin, d.adrelid) INTO v_default
      FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
     WHERE d.adrelid = 'employee'::regclass AND a.attname = 'status';
    IF v_default ILIKE '%pre_boarding%' THEN
        RAISE NOTICE 'PASS  F8 employee.status defaults to pre_boarding';
    ELSE
        RAISE EXCEPTION
            'FAIL  F8 employee.status defaults to %, so a row created before its joining event '
            'claims to be active', v_default;
    END IF;
END $$;

-- F9: the catch-up returns a count and does not throw on a clean dataset.
DO $$
DECLARE v_n INTEGER;
BEGIN
    v_n := fn_refresh_due_employment_status();
    IF v_n IS NULL OR v_n < 0 THEN
        RAISE EXCEPTION 'FAIL  F9 catch-up returned %', v_n;
    END IF;
    RAISE NOTICE 'PASS  F9 catch-up ran, % employee(s) refreshed', v_n;
END $$;

-- F10: every seeded employee's cached status agrees with the log. If these ever diverge on a
-- clean seed, the cache has stopped being a cache.
DO $$
DECLARE v_bad BIGINT;
BEGIN
    SELECT count(*) INTO v_bad
      FROM employee e
     WHERE e.status <> fn_employment_status_asof(e.id, fn_business_date());
    IF v_bad = 0 THEN
        RAISE NOTICE 'PASS  F10 cached status agrees with the log for every employee';
    ELSE
        RAISE EXCEPTION 'FAIL  F10 % employees have a cached status the log contradicts', v_bad;
    END IF;
END $$;
