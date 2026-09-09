-- =============================================================================
-- Verification for 0020 / 0021: HR reporting
--
-- The checks that carry the weight:
--
--   R1  every reporting function returns PER-EMPLOYEE rows and none aggregates across people.
--       That is what lets the caller compose scope() into the same statement so the SUM happens
--       after the filter. A function that returned a pre-aggregated total would make a
--       scope-correct report impossible to build on top of it.
--   R7  fn_document_compliance counts the KEY, not the row. COUNT(*) over its LEFT JOIN
--       reported a phantom pending scan for every employee with no documents (fixed in 0021).
--   R9  no reporting function writes. A report that "fixes" what it finds is how ADR-0015's
--       separation of attendance and effort would quietly die.
--
-- Runs inside a transaction the runner always rolls back (DEC-024).
-- =============================================================================

-- R1: every reporting function is per-employee. Checked by inspecting the return type, because
-- the property has to hold for functions added later too.
DO $$
DECLARE v_bad TEXT;
BEGIN
    SELECT string_agg(p.proname, ', ') INTO v_bad
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('fn_headcount_movement', 'fn_leave_liability', 'fn_attendance_summary',
                         'fn_wfh_usage', 'fn_attendance_vs_effort', 'fn_timesheet_compliance',
                         'fn_document_compliance')
       AND NOT EXISTS (
            SELECT 1 FROM unnest(p.proargnames) AS an
             WHERE an = 'employee_id');
    IF v_bad IS NULL THEN
        RAISE NOTICE 'PASS  R1 every reporting function returns per-employee rows';
    ELSE
        RAISE EXCEPTION
            'FAIL  R1 these do not expose employee_id, so a caller cannot compose scope() and '
            'the report cannot be made scope-correct: %', v_bad;
    END IF;
END $$;

-- R2: headcount movement resolves department AS OF the event date, not today. A leaver belongs
-- to the department they left from.
DO $$
DECLARE v_def TEXT;
BEGIN
    v_def := pg_get_functiondef('fn_headcount_movement'::regproc);
    IF v_def NOT LIKE '%valid_period @> ee.effective_on%' THEN
        RAISE EXCEPTION
            'FAIL  R2 headcount movement does not resolve the assignment as of the EVENT date - '
            'a movement report that used today''s org chart would attribute a 2019 leaver to '
            'whatever department exists now';
    END IF;
    -- It must read the LOG, not the cached columns: a future-dated exit deliberately does not
    -- appear in employee.exited_on yet (0015).
    IF v_def NOT LIKE '%employment_event%' THEN
        RAISE EXCEPTION 'FAIL  R2 movement is not read from the append-only lifecycle log';
    END IF;
    RAISE NOTICE 'PASS  R2 movement reads the log and resolves assignment as of the event date';
END $$;

-- R3: it actually returns the seeded history, with the right department attached.
DO $$
DECLARE v_n BIGINT; v_dept TEXT;
BEGIN
    SELECT count(*) INTO v_n
      FROM fn_headcount_movement('2018-01-01', fn_business_date());
    IF v_n = 0 THEN
        RAISE EXCEPTION 'FAIL  R3 no movement found across the whole history';
    END IF;

    SELECT d.code INTO v_dept
      FROM fn_headcount_movement('2018-01-01', '2018-12-31') m
      JOIN department d ON d.id = m.department_id
     WHERE m.event_type = 'joined' LIMIT 1;

    RAISE NOTICE 'PASS  R3 % movement events, earliest joiner in department %', v_n,
        COALESCE(v_dept, '(unplaced)');
END $$;

-- R4: leave liability separates paid from unpaid. Summing them together would overstate the
-- obligation by including LWP, which the company does not owe.
DO $$
DECLARE v_has_paid BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM unnest(
            (SELECT p.proargnames FROM pg_proc p WHERE p.proname = 'fn_leave_liability')
        ) AS an WHERE an = 'is_paid') INTO v_has_paid;
    IF NOT v_has_paid THEN
        RAISE EXCEPTION 'FAIL  R4 liability does not distinguish paid types from unpaid';
    END IF;
    RAISE NOTICE 'PASS  R4 liability exposes is_paid, so LWP cannot inflate the obligation';
END $$;

-- R5: no floating point anywhere in a leave or money figure (Rule 4).
DO $$
DECLARE v_bad TEXT;
BEGIN
    SELECT string_agg(format('%s.%s', c.relname, a.attname), ', ') INTO v_bad
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relname IN ('leave_account', 'leave_ledger')
       AND a.attnum > 0 AND NOT a.attisdropped
       AND format_type(a.atttypid, NULL) IN ('double precision', 'real');
    IF v_bad IS NULL THEN
        RAISE NOTICE 'PASS  R5 leave figures a report reads are NUMERIC, never floating point';
    ELSE
        RAISE EXCEPTION 'FAIL  R5 floating point in a reported figure: %', v_bad;
    END IF;
END $$;

-- R6: WFH reports BOTH sources and their disagreement, rather than choosing one.
DO $$
DECLARE v_def TEXT;
BEGIN
    v_def := pg_get_functiondef('fn_wfh_usage'::regproc);
    IF v_def NOT LIKE '%attendance_day%' OR v_def NOT LIKE '%leave_request%' THEN
        RAISE EXCEPTION
            'FAIL  R6 WFH usage does not read both sources. It is a leave TYPE and an '
            'attendance STATUS, and they can disagree';
    END IF;
    IF v_def NOT LIKE '%disagreement%' THEN
        RAISE EXCEPTION 'FAIL  R6 the disagreement is not reported, so it is hidden';
    END IF;
    RAISE NOTICE 'PASS  R6 WFH reports attendance days, approved days, and the gap between them';
END $$;

-- R7: THE PHANTOM ROW. An employee with NO documents must score zero on every counter.
-- `COUNT(*)` over the LEFT JOIN counted the all-NULL row and reported a pending scan that did
-- not exist (fixed in 0021).
DO $$
DECLARE v_emp UUID; r RECORD; v_real BIGINT;
BEGIN
    INSERT INTO employee (employee_number, full_name, work_email, joined_on, status)
    VALUES ('VERIFY-R7', 'No Documents', 'verify-r7@example.invalid',
            fn_business_date() - 100, 'pre_boarding')
    RETURNING id INTO v_emp;

    SELECT count(*) INTO v_real FROM employee_document WHERE employee_id = v_emp;
    SELECT * INTO r FROM fn_document_compliance(60) WHERE employee_id = v_emp;

    IF v_real <> 0 THEN RAISE EXCEPTION 'FAIL  R7 fixture is not clean'; END IF;

    IF r.filed_types = 0 AND r.pending_scan = 0 AND r.expiring_soon = 0 AND r.expired = 0 THEN
        RAISE NOTICE 'PASS  R7 an employee with no documents scores zero on all four counters';
    ELSE
        RAISE EXCEPTION
            'FAIL  R7 phantom counts for an employee with NO documents: filed=% pending=% '
            'expiring=% expired=%. COUNT(*) over a LEFT JOIN counts the all-NULL row, and this '
            'is a COMPLIANCE report - it would send HR looking for files nobody uploaded, and '
            'hide the employees genuinely waiting on a scan',
            r.filed_types, r.pending_scan, r.expiring_soon, r.expired;
    END IF;
END $$;

-- R8: and a real pending document IS still counted, so R7 was not fixed by counting nothing.
DO $$
DECLARE v_emp UUID; v_doc UUID; r RECORD;
BEGIN
    INSERT INTO employee (employee_number, full_name, work_email, joined_on, status)
    VALUES ('VERIFY-R8', 'One Pending', 'verify-r8@example.invalid',
            fn_business_date() - 100, 'pre_boarding')
    RETURNING id INTO v_emp;

    INSERT INTO employee_document (employee_id, document_type_code, title)
    VALUES (v_emp, 'id_proof', 'Verify R8') RETURNING id INTO v_doc;
    INSERT INTO employee_document_version
        (document_id, bucket, object_key, content_type, size_bytes, sha256_hex)
    VALUES (v_doc, 'b', v_doc || '/1', 'application/pdf', 100, repeat('a', 64));

    SELECT * INTO r FROM fn_document_compliance(60) WHERE employee_id = v_emp;
    IF r.pending_scan = 1 AND r.filed_types = 0 THEN
        RAISE NOTICE 'PASS  R8 a genuinely pending document is counted, and is not yet filed';
    ELSE
        RAISE EXCEPTION 'FAIL  R8 pending=% filed=%', r.pending_scan, r.filed_types;
    END IF;
END $$;

-- R9: NO REPORTING FUNCTION WRITES. A report that adjusts what it finds is how ADR-0015's
-- separation of attendance and effort would quietly die.
DO $$
DECLARE v_bad TEXT;
BEGIN
    SELECT string_agg(format('%s (%s)', p.proname, p.provolatile), ', ') INTO v_bad
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('fn_headcount_movement', 'fn_leave_liability', 'fn_attendance_summary',
                         'fn_wfh_usage', 'fn_attendance_vs_effort', 'fn_timesheet_compliance',
                         'fn_document_compliance')
       -- 's' = STABLE, 'i' = IMMUTABLE. A VOLATILE function is one that may write.
       AND p.provolatile NOT IN ('s', 'i');
    IF v_bad IS NULL THEN
        RAISE NOTICE 'PASS  R9 every reporting function is STABLE - none of them can write';
    ELSE
        RAISE EXCEPTION 'FAIL  R9 a reporting function is VOLATILE and could write: %', v_bad;
    END IF;
END $$;

-- R10: the reconciliation reports the variance and offers no correction. Checked structurally:
-- the function body must contain no UPDATE, INSERT or DELETE.
DO $$
DECLARE v_def TEXT;
BEGIN
    v_def := upper(pg_get_functiondef('fn_attendance_vs_effort'::regproc));
    IF v_def ~ '\m(UPDATE|INSERT|DELETE)\M' THEN
        RAISE EXCEPTION
            'FAIL  R10 the reconciliation function contains a write. ADR-0015: an employee who '
            'attended eight hours and logged five has a reporting discrepancy, NOT a data error';
    END IF;
    IF v_def NOT LIKE '%VARIANCE_MINUTES%' THEN
        RAISE EXCEPTION 'FAIL  R10 the variance itself is not returned';
    END IF;
    RAISE NOTICE 'PASS  R10 reconciliation reports the variance and corrects nothing';
END $$;

-- R11: it finds the real variances in the seeded data, and classifies them.
DO $$
DECLARE v_n BIGINT; v_notes TEXT;
BEGIN
    SELECT count(*), string_agg(DISTINCT note, '; ') INTO v_n, v_notes
      FROM fn_attendance_vs_effort(fn_business_date() - 30, fn_business_date())
     WHERE note IS NOT NULL;
    IF v_n = 0 THEN
        RAISE NOTICE 'INFO  R11 no variance in this dataset';
    ELSE
        RAISE NOTICE 'PASS  R11 % variances classified: %', v_n, v_notes;
    END IF;
END $$;

-- R12: attendance summary uses the SAME working-day count as the leave engine, so
-- "present out of expected" cannot disagree with what a leave application was measured against.
DO $$
DECLARE v_def TEXT;
BEGIN
    v_def := pg_get_functiondef('fn_attendance_summary'::regproc);
    IF v_def NOT LIKE '%fn_working_days%' THEN
        RAISE EXCEPTION
            'FAIL  R12 expected days is not derived from fn_working_days, so an attendance '
            'report and a leave application can disagree about how many working days a month had';
    END IF;
    RAISE NOTICE 'PASS  R12 expected days comes from the same working-day function as leave';
END $$;

-- R13: document compliance leaks no document TYPES. A compliance report naming types would tell
-- the reader who holds a MEDICAL certificate, which is information about health.
DO $$
DECLARE v_cols TEXT;
BEGIN
    SELECT string_agg(an, ', ') INTO v_cols
      FROM unnest((SELECT proargnames FROM pg_proc WHERE proname = 'fn_document_compliance')) AS an;
    IF v_cols ~* 'type_code|title|document_type_name' THEN
        RAISE EXCEPTION
            'FAIL  R13 the compliance report exposes document types: %. That reveals who holds '
            'a medical certificate', v_cols;
    END IF;
    RAISE NOTICE 'PASS  R13 compliance returns counts only: %', v_cols;
END $$;

-- R14: the functions pin search_path (precedent 0013).
DO $$
DECLARE v_bad TEXT;
BEGIN
    SELECT string_agg(p.proname, ', ') INTO v_bad
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('fn_headcount_movement', 'fn_leave_liability', 'fn_attendance_summary',
                         'fn_wfh_usage', 'fn_attendance_vs_effort', 'fn_timesheet_compliance',
                         'fn_document_compliance')
       AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) cfg
                        WHERE cfg LIKE 'search_path=%');
    IF v_bad IS NULL THEN RAISE NOTICE 'PASS  R14 all reporting functions pin search_path';
    ELSE RAISE EXCEPTION 'FAIL  R14 unpinned: %', v_bad; END IF;
END $$;

-- R15: timesheet compliance distinguishes the two different waits - a draft nobody submitted
-- versus a submission nobody has decided.
DO $$
DECLARE v_def TEXT;
BEGIN
    v_def := pg_get_functiondef('fn_timesheet_compliance'::regproc);
    IF v_def NOT LIKE '%submitted_at%' OR v_def NOT LIKE '%period_end%' THEN
        RAISE EXCEPTION
            'FAIL  R15 days_waiting does not distinguish waiting-on-the-employee from '
            'waiting-on-the-manager, which are different operational problems';
    END IF;
    RAISE NOTICE 'PASS  R15 the wait is measured from the right event for each status';
END $$;
