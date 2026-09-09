-- =============================================================================
-- Verification for 0014: the employment lifecycle
--
-- Every guarantee the migration claims is asserted here, and each was written by first making
-- it FAIL. The rails that matter most are the ones a service method could otherwise be trusted
-- to enforce: an illegal status transition, an out-of-order event, and an exit with no reason.
--
-- The whole script runs inside a transaction the runner always rolls back (DEC-024), so these
-- checks write freely - including creating throwaway employees for the cycle test.
-- =============================================================================

-- L1: the state machine exists as DATA and is deterministic. The PK on (event_type,
-- from_status) is what makes "this event applied to this status" have exactly one outcome.
DO $$
DECLARE v_rows INT; v_pk TEXT;
BEGIN
    SELECT count(*) INTO v_rows FROM employment_status_transition;
    SELECT pg_get_constraintdef(oid) INTO v_pk
      FROM pg_constraint
     WHERE conrelid = 'employment_status_transition'::regclass AND contype = 'p';

    IF v_rows < 10 THEN
        RAISE EXCEPTION 'FAIL  L1 the transition table holds only % rows', v_rows;
    END IF;
    IF v_pk IS NULL OR v_pk NOT ILIKE '%event_type%' OR v_pk NOT ILIKE '%from_status%' THEN
        RAISE EXCEPTION 'FAIL  L1 the FSM is not keyed on (event_type, from_status): %', v_pk;
    END IF;
    RAISE NOTICE 'PASS  L1 FSM is data: % legal moves, keyed %', v_rows, v_pk;
END $$;

-- L2: the event table is bound to the machine by a composite foreign key, not by application
-- code. Must-Know Rule 11 plus "prefer a constraint over a rule".
DO $$
DECLARE v_def TEXT;
BEGIN
    SELECT pg_get_constraintdef(oid) INTO v_def
      FROM pg_constraint WHERE conname = 'fk_employment_event_transition';
    IF v_def IS NULL THEN
        RAISE EXCEPTION 'FAIL  L2 employment_event has no FK into the transition table';
    END IF;
    IF v_def NOT ILIKE '%to_status%' THEN
        RAISE EXCEPTION 'FAIL  L2 the FK does not constrain to_status, so a legal (event, from) '
                        'pair could still record any outcome: %', v_def;
    END IF;
    RAISE NOTICE 'PASS  L2 transition FK covers the whole triple: %', v_def;
END $$;

-- L3: THE ISOLATED FSM TEST. from_status is genuinely correct, so the coherence trigger passes
-- and the foreign key is the thing under test. Written because the first draft of this suite
-- "passed" while only ever exercising the trigger.
DO $$
DECLARE v_emp UUID; v_ok BOOLEAN := false;
BEGIN
    SELECT id INTO v_emp FROM employee WHERE status = 'active' LIMIT 1;
    BEGIN
        INSERT INTO employment_event (employee_id, event_type, from_status, to_status, effective_on)
        VALUES (v_emp, 'promoted', 'active', 'exited', fn_business_date());
    EXCEPTION WHEN foreign_key_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  L3 a legal event with an illegal outcome is refused by the FSM FK';
    ELSE RAISE EXCEPTION 'FAIL  L3 promoted:active->exited was accepted'; END IF;
END $$;

-- L4: a fabricated event type cannot be invented at the call site.
DO $$
DECLARE v_emp UUID; v_ok BOOLEAN := false;
BEGIN
    SELECT id INTO v_emp FROM employee WHERE status = 'active' LIMIT 1;
    BEGIN
        INSERT INTO employment_event (employee_id, event_type, from_status, to_status, effective_on)
        VALUES (v_emp, 'abducted', 'active', 'exited', fn_business_date());
    EXCEPTION WHEN foreign_key_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  L4 an unknown event_type is refused';
    ELSE RAISE EXCEPTION 'FAIL  L4 event_type "abducted" was accepted'; END IF;
END $$;

-- L5: the event must start from the status the employee is ACTUALLY in. The FK cannot know
-- this; it only knows the move is legal in the abstract.
DO $$
DECLARE v_emp UUID; v_ok BOOLEAN := false;
BEGIN
    SELECT id INTO v_emp FROM employee WHERE status = 'active' LIMIT 1;
    BEGIN
        INSERT INTO employment_event (employee_id, event_type, from_status, to_status, effective_on)
        VALUES (v_emp, 'joined', 'pre_boarding', 'active', fn_business_date());
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  L5 an event whose from_status contradicts reality is refused';
    ELSE RAISE EXCEPTION 'FAIL  L5 re-joining an already-active employee was accepted'; END IF;
END $$;

-- L6: history cannot be inserted out of order. An append-only log tolerates late entries
-- (recorded_at says so) but not incoherent ones.
DO $$
DECLARE v_emp UUID; v_joined DATE; v_ok BOOLEAN := false;
BEGIN
    SELECT id, joined_on INTO v_emp, v_joined FROM employee WHERE status = 'active' LIMIT 1;
    BEGIN
        INSERT INTO employment_event (employee_id, event_type, from_status, to_status, effective_on)
        VALUES (v_emp, 'confirmed', 'active', 'active', v_joined + 1);
        -- the joining event sits at v_joined, so v_joined + 1 is fine; now go backwards
        INSERT INTO employment_event (employee_id, event_type, from_status, to_status, effective_on)
        VALUES (v_emp, 'confirmed', 'active', 'active', v_joined);
        -- same date is allowed (>=), so step properly before it
        INSERT INTO employment_event (employee_id, event_type, from_status, to_status, effective_on)
        VALUES (v_emp, 'confirmed', 'active', 'active', v_joined - 1);
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  L6 an event effective before the previous one is refused';
    ELSE RAISE EXCEPTION 'FAIL  L6 lifecycle events can be inserted out of order'; END IF;
END $$;

-- L7: nothing can happen to somebody before they joined.
DO $$
DECLARE v_emp UUID; v_joined DATE; v_ok BOOLEAN := false;
BEGIN
    SELECT id, joined_on INTO v_emp, v_joined FROM employee WHERE status = 'active' LIMIT 1;
    BEGIN
        INSERT INTO employment_event (employee_id, event_type, from_status, to_status, effective_on)
        VALUES (v_emp, 'confirmed', 'active', 'active', v_joined - 30);
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  L7 an event predating the joining date is refused';
    ELSE RAISE EXCEPTION 'FAIL  L7 an event before joining was accepted'; END IF;
END $$;

-- L8: an exit must say WHY. `status = exited` with no exit_type breaks service-length and
-- final-settlement arithmetic silently.
DO $$
DECLARE v_emp UUID; v_ok BOOLEAN := false;
BEGIN
    SELECT id INTO v_emp FROM employee WHERE status = 'active' LIMIT 1;
    BEGIN
        INSERT INTO employment_event (employee_id, event_type, from_status, to_status, effective_on)
        VALUES (v_emp, 'exited', 'active', 'exited', fn_business_date());
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  L8 an exit with no exit_type is refused';
    ELSE RAISE EXCEPTION 'FAIL  L8 an exit was recorded with no reason'; END IF;
END $$;

-- L9: and the inverse - an exit_type on something that is not an exit is meaningless.
DO $$
DECLARE v_emp UUID; v_ok BOOLEAN := false;
BEGIN
    SELECT id INTO v_emp FROM employee WHERE status = 'active' LIMIT 1;
    BEGIN
        INSERT INTO employment_event
            (employee_id, event_type, from_status, to_status, effective_on, exit_type)
        VALUES (v_emp, 'confirmed', 'active', 'active', fn_business_date(), 'resignation');
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  L9 an exit_type on a non-exit event is refused';
    ELSE RAISE EXCEPTION 'FAIL  L9 exit_type was accepted on a confirmation'; END IF;
END $$;

-- L10: a last working day cannot precede the event that set it.
DO $$
DECLARE v_emp UUID; v_ok BOOLEAN := false;
BEGIN
    SELECT id INTO v_emp FROM employee WHERE status = 'active' LIMIT 1;
    BEGIN
        INSERT INTO employment_event
            (employee_id, event_type, from_status, to_status, effective_on, last_working_day)
        VALUES (v_emp, 'resigned', 'active', 'on_notice', fn_business_date(), fn_business_date() - 7);
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  L10 a last working day before the resignation date is refused';
    ELSE RAISE EXCEPTION 'FAIL  L10 a backwards notice period was accepted'; END IF;
END $$;

-- L11: the log is append-only. UPDATE, DELETE and TRUNCATE all refused.
DO $$
DECLARE v_u BOOLEAN := false; v_d BOOLEAN := false; v_t BOOLEAN := false; v_before BIGINT;
BEGIN
    SELECT count(*) INTO v_before FROM employment_event;

    BEGIN UPDATE employment_event SET reason = 'tampered';
    EXCEPTION WHEN restrict_violation THEN v_u := true; END;

    BEGIN DELETE FROM employment_event;
    EXCEPTION WHEN restrict_violation THEN v_d := true; END;

    BEGIN TRUNCATE employment_event;
    EXCEPTION WHEN restrict_violation THEN v_t := true;
              WHEN dependent_objects_still_exist THEN v_t := true; END;

    IF v_u AND v_d AND v_t AND (SELECT count(*) FROM employment_event) = v_before THEN
        RAISE NOTICE 'PASS  L11 employment_event is append-only (% rows intact)', v_before;
    ELSE
        RAISE EXCEPTION 'FAIL  L11 update=% delete=% truncate=%', v_u, v_d, v_t;
    END IF;
END $$;

-- L12: every rail is ENABLE ALWAYS (DEC-030). A trigger created merely ENABLE is switched off
-- by session_replication_role = 'replica', which PGOPTIONS carries in from any client.
DO $$
DECLARE v_weak TEXT;
BEGIN
    SELECT string_agg(t.tgname, ', ') INTO v_weak
      FROM pg_trigger t
     WHERE t.tgrelid = 'employment_event'::regclass
       AND NOT t.tgisinternal
       AND t.tgenabled <> 'A';
    IF v_weak IS NULL THEN
        RAISE NOTICE 'PASS  L12 all employment_event triggers are ENABLE ALWAYS';
    ELSE
        RAISE EXCEPTION 'FAIL  L12 these triggers can be disabled by a session GUC: %', v_weak;
    END IF;
END $$;

-- L13: THE READ MODEL. employee.status and its date columns are maintained by trigger, so the
-- column and the history cannot diverge. Confirm -> resign -> exit, checked at each step.
DO $$
DECLARE v_emp UUID; v_joined DATE := DATE '2024-01-08'; r RECORD;
BEGIN
    -- Self-contained fixture. The first draft of this check selected a seeded employee
    -- `WHERE confirmed_on IS NULL`; the seed later began confirming everyone, the SELECT
    -- returned no row, and the whole check went vacuous against a NULL employee id. A test
    -- must not depend on seed state it does not create - same lesson as DEC-023.
    INSERT INTO employee (employee_number, full_name, work_email, joined_on, status)
    VALUES ('VERIFY-L13', 'Read Model', 'verify-l13@example.invalid', v_joined, 'pre_boarding')
    RETURNING id INTO v_emp;

    INSERT INTO employment_event (employee_id, event_type, from_status, to_status, effective_on)
    VALUES (v_emp, 'joined', 'pre_boarding', 'active', v_joined);

    INSERT INTO employment_event (employee_id, event_type, from_status, to_status, effective_on)
    VALUES (v_emp, 'confirmed', 'active', 'active', v_joined + 180);
    SELECT status, confirmed_on INTO r FROM employee WHERE id = v_emp;
    IF r.confirmed_on <> v_joined + 180 THEN
        RAISE EXCEPTION 'FAIL  L13 confirmation did not materialise: %', r.confirmed_on;
    END IF;

    INSERT INTO employment_event
        (employee_id, event_type, from_status, to_status, effective_on, last_working_day)
    VALUES (v_emp, 'resigned', 'active', 'on_notice', v_joined + 200, v_joined + 230);
    SELECT status, resigned_on, last_working_day INTO r FROM employee WHERE id = v_emp;
    IF r.status <> 'on_notice' OR r.resigned_on <> v_joined + 200
       OR r.last_working_day <> v_joined + 230 THEN
        RAISE EXCEPTION 'FAIL  L13 resignation did not materialise: % % %',
            r.status, r.resigned_on, r.last_working_day;
    END IF;

    INSERT INTO employment_event
        (employee_id, event_type, from_status, to_status, effective_on, exit_type)
    VALUES (v_emp, 'exited', 'on_notice', 'exited', v_joined + 230, 'resignation');
    SELECT status, exited_on, exit_type INTO r FROM employee WHERE id = v_emp;
    IF r.status <> 'exited' OR r.exited_on <> v_joined + 230 OR r.exit_type <> 'resignation' THEN
        RAISE EXCEPTION 'FAIL  L13 exit did not materialise: % % %',
            r.status, r.exited_on, r.exit_type;
    END IF;

    RAISE NOTICE 'PASS  L13 confirm/resign/exit all materialise onto employee';
END $$;

-- L14: a withdrawn resignation CLEARS the notice. Leaving a stale resigned_on behind would
-- keep an employee looking like a leaver forever, and notice arithmetic would still fire.
DO $$
DECLARE v_emp UUID; v_joined DATE := DATE '2024-02-08'; r RECORD;
BEGIN
    -- Self-contained, for the same reason as L13.
    INSERT INTO employee (employee_number, full_name, work_email, joined_on, status)
    VALUES ('VERIFY-L14', 'Withdrawer', 'verify-l14@example.invalid', v_joined, 'pre_boarding')
    RETURNING id INTO v_emp;

    INSERT INTO employment_event (employee_id, event_type, from_status, to_status, effective_on)
    VALUES (v_emp, 'joined', 'pre_boarding', 'active', v_joined);

    INSERT INTO employment_event
        (employee_id, event_type, from_status, to_status, effective_on, last_working_day)
    VALUES (v_emp, 'resigned', 'active', 'on_notice', v_joined + 300, v_joined + 330);

    INSERT INTO employment_event (employee_id, event_type, from_status, to_status, effective_on)
    VALUES (v_emp, 'resignation_withdrawn', 'on_notice', 'active', v_joined + 310);

    SELECT status, resigned_on, last_working_day INTO r FROM employee WHERE id = v_emp;
    IF r.status = 'active' AND r.resigned_on IS NULL AND r.last_working_day IS NULL THEN
        RAISE NOTICE 'PASS  L14 withdrawing a resignation clears both notice dates';
    ELSE
        RAISE EXCEPTION 'FAIL  L14 stale notice left behind: % % %',
            r.status, r.resigned_on, r.last_working_day;
    END IF;
END $$;

-- L15: `exited` is terminal. Nothing may follow it - there is no transition out.
DO $$
DECLARE v_emp UUID; v_ok BOOLEAN := false;
BEGIN
    SELECT id INTO v_emp FROM employee WHERE status = 'active' LIMIT 1;
    INSERT INTO employment_event
        (employee_id, event_type, from_status, to_status, effective_on, exit_type)
    VALUES (v_emp, 'exited', 'active', 'exited', fn_business_date(), 'termination');
    BEGIN
        INSERT INTO employment_event (employee_id, event_type, from_status, to_status, effective_on)
        VALUES (v_emp, 'confirmed', 'exited', 'active', fn_business_date() + 1);
    EXCEPTION WHEN foreign_key_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  L15 exited is terminal - no transition leaves it';
    ELSE RAISE EXCEPTION 'FAIL  L15 an exited employee was resurrected'; END IF;
END $$;

-- L16: employee.status cannot be edited into an incoherent state behind the log's back.
DO $$
DECLARE v_emp UUID; v_ok BOOLEAN := false;
BEGIN
    SELECT id INTO v_emp FROM employee WHERE status = 'active' LIMIT 1;
    BEGIN
        UPDATE employee SET status = 'exited' WHERE id = v_emp;
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  L16 status=exited with no exited_on/exit_type is refused';
    ELSE RAISE EXCEPTION 'FAIL  L16 an employee was marked exited with no date or reason'; END IF;
END $$;

-- L17: status AS OF a date comes from the log, not from the cached column.
DO $$
DECLARE v_emp UUID; v_joined DATE; v_before TEXT; v_on TEXT;
BEGIN
    SELECT id, joined_on INTO v_emp, v_joined FROM employee WHERE status = 'active' LIMIT 1;
    v_before := fn_employment_status_asof(v_emp, v_joined - 1);
    v_on     := fn_employment_status_asof(v_emp, v_joined);
    IF v_before = 'pre_boarding' AND v_on = 'active' THEN
        RAISE NOTICE 'PASS  L17 as-of status: pre_boarding the day before joining, active on it';
    ELSE
        RAISE EXCEPTION 'FAIL  L17 before=% on=%', v_before, v_on;
    END IF;
END $$;

-- L18: the backfill made the log TOTAL. Without a joining event per existing employee,
-- fn_employment_status_asof would contradict employee.status for every one of them.
DO $$
DECLARE v_orphans BIGINT;
BEGIN
    SELECT count(*) INTO v_orphans
      FROM employee e
     WHERE NOT EXISTS (SELECT 1 FROM employment_event ee WHERE ee.employee_id = e.id);
    IF v_orphans = 0 THEN
        RAISE NOTICE 'PASS  L18 every employee has at least one lifecycle event';
    ELSE
        RAISE EXCEPTION 'FAIL  L18 % employees have no lifecycle history', v_orphans;
    END IF;
END $$;

-- L19: TEMPORAL DECAY of the reporting graph. This is the authorization-critical one:
-- ai/context/rbac-rules.md requires that a rolled-off manager loses access automatically and
-- that a former manager still resolves for the period they actually managed.
DO $$
DECLARE v_mgr UUID; v_sub UUID; v_then INT; v_now INT; v_changed DATE;
BEGIN
    -- Find a manager edge that was closed at some point - a real reorg in the data.
    SELECT em.manager_id, em.employee_id, em.valid_to
      INTO v_mgr, v_sub, v_changed
      FROM employment em
     WHERE em.manager_id IS NOT NULL AND em.valid_to IS NOT NULL
     ORDER BY em.valid_to LIMIT 1;

    IF v_mgr IS NULL THEN
        RAISE NOTICE 'INFO  L19 no closed manager edge in this dataset - decay not exercised';
        RETURN;
    END IF;

    SELECT count(*) INTO v_then FROM fn_reporting_subtree_asof(v_mgr, v_changed - 1)
     WHERE employee_id = v_sub;
    SELECT count(*) INTO v_now  FROM fn_reporting_subtree_asof(v_mgr, v_changed + 1)
     WHERE employee_id = v_sub;

    IF v_then = 1 AND v_now = 0 THEN
        RAISE NOTICE 'PASS  L19 temporal decay: in scope before %, out of scope after', v_changed;
    ELSE
        RAISE EXCEPTION 'FAIL  L19 before=% after=% across the reorg on %', v_then, v_now, v_changed;
    END IF;
END $$;

-- L20: direct report vs subtree are DIFFERENT questions. rbac-rules.md deliberately grants a
-- manager attendance over the whole subtree but compensation only over direct reports, so
-- collapsing the two would silently widen access by a whole reporting level.
DO $$
DECLARE v_top UUID; v_deep UUID; v_direct BOOLEAN; v_sub BOOLEAN; v_on DATE;
BEGIN
    -- Find any manager with a depth-2 descendant, at a date where that holds.
    SELECT em.manager_id, s.employee_id, em.valid_from
      INTO v_top, v_deep, v_on
      FROM employment em
      JOIN LATERAL fn_reporting_subtree_asof(em.manager_id, GREATEST(em.valid_from, '2022-01-01'::date)) s
        ON s.depth >= 2
     WHERE em.manager_id IS NOT NULL
     LIMIT 1;

    IF v_top IS NULL THEN
        RAISE NOTICE 'INFO  L20 no depth-2 reporting line in this dataset';
        RETURN;
    END IF;

    v_on := GREATEST(v_on, '2022-01-01'::date);
    v_direct := fn_is_direct_report_asof(v_top, v_deep, v_on);
    v_sub    := fn_is_in_subtree_asof(v_top, v_deep, v_on);

    IF v_sub AND NOT v_direct THEN
        RAISE NOTICE 'PASS  L20 a depth-2 report is in the subtree but is NOT a direct report';
    ELSE
        RAISE EXCEPTION 'FAIL  L20 direct=% subtree=% - the two graphs have collapsed',
            v_direct, v_sub;
    END IF;
END $$;

-- L21: THE CYCLE GUARD. The EXCLUDE constraint gives one employment row per date, so the graph
-- is a forest per date UNLESS two people manage each other - and ck_employment_not_self_managed
-- blocks only self-management, so A -> B -> A is accepted by the schema today. Without the path
-- guard this recursion runs to the depth cap on every call that touches such a pair.
DO $$
DECLARE v_a UUID; v_b UUID; v_dept UUID; v_desig UUID; v_rows INT; v_t0 TIMESTAMPTZ;
BEGIN
    SET LOCAL hrm.allow_backdated_period = 'on';
    SELECT id INTO v_dept  FROM department  LIMIT 1;
    SELECT id INTO v_desig FROM designation LIMIT 1;

    INSERT INTO employee (employee_number, full_name, work_email, joined_on)
    VALUES ('VERIFY-CYC-A', 'Cycle A', 'verify-cyc-a@example.invalid', '2024-01-01')
    RETURNING id INTO v_a;
    INSERT INTO employee (employee_number, full_name, work_email, joined_on)
    VALUES ('VERIFY-CYC-B', 'Cycle B', 'verify-cyc-b@example.invalid', '2024-01-01')
    RETURNING id INTO v_b;

    INSERT INTO employment (employee_id, department_id, designation_id, manager_id, valid_from)
    VALUES (v_a, v_dept, v_desig, v_b, '2024-01-01'),
           (v_b, v_dept, v_desig, v_a, '2024-01-01');

    v_t0 := clock_timestamp();
    SELECT count(*) INTO v_rows FROM fn_reporting_subtree_asof(v_a, '2026-01-01');

    IF clock_timestamp() - v_t0 > INTERVAL '2 seconds' THEN
        RAISE EXCEPTION 'FAIL  L21 the cycle walk took %', clock_timestamp() - v_t0;
    END IF;
    IF v_rows <> 1 THEN
        RAISE EXCEPTION 'FAIL  L21 a mutual-management cycle yielded % rows, expected 1', v_rows;
    END IF;
    RAISE NOTICE 'PASS  L21 a mutual-management cycle terminates, % row, in %',
        v_rows, clock_timestamp() - v_t0;
END $$;

-- L22: MUST-KNOW RULE 5. Every new lifecycle date is DATE, not a timestamp. A last working day
-- that drifted a timezone would change notice arithmetic and final settlement.
DO $$
DECLARE v_bad TEXT;
BEGIN
    SELECT string_agg(format('%s.%s is %s', c.relname, a.attname,
                             format_type(a.atttypid, a.atttypmod)), ', ')
      INTO v_bad
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relname IN ('employee', 'employment_event')
       AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attname IN ('effective_on','last_working_day','confirmed_on','probation_end_on',
                         'resigned_on','exited_on','joined_on')
       AND format_type(a.atttypid, a.atttypmod) <> 'date';
    IF v_bad IS NULL THEN
        RAISE NOTICE 'PASS  L22 every lifecycle date column is DATE (Rule 5)';
    ELSE
        RAISE EXCEPTION 'FAIL  L22 date-only values stored as timestamps: %', v_bad;
    END IF;
END $$;

-- L23: the resolvers pin search_path. Precedent 0013: an unpinned STABLE function on the
-- request path can be hijacked by a pg_temp object of the same name.
DO $$
DECLARE v_bad TEXT;
BEGIN
    SELECT string_agg(p.proname, ', ') INTO v_bad
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('fn_employment_status_asof','fn_reporting_subtree_asof',
                         'fn_is_direct_report_asof','fn_is_in_subtree_asof',
                         'fn_employment_event_guard','fn_employment_event_apply')
       AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) cfg
                        WHERE cfg LIKE 'search_path=%');
    IF v_bad IS NULL THEN
        RAISE NOTICE 'PASS  L23 all lifecycle functions pin search_path';
    ELSE
        RAISE EXCEPTION 'FAIL  L23 unpinned search_path: %', v_bad;
    END IF;
END $$;

-- L24: `marital_status` is deliberately ABSENT. It is the exact input Employee Handbook
-- §1.3.4.5 would consume, and CLAUDE.md's Forbidden Actions bar implementing that clause in any
-- form. This check exists so the column cannot be added casually by a later migration without
-- somebody reading this comment first.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_attribute
                WHERE attrelid = 'employee'::regclass
                  AND attname = 'marital_status' AND attnum > 0 AND NOT attisdropped) THEN
        RAISE EXCEPTION
            'FAIL  L24 employee.marital_status exists. It is the input to Employee Handbook '
            '§1.3.4.5, which CLAUDE.md forbids implementing in any form. If HR genuinely needs '
            'it for statutory reporting, that needs a decision and a DEC entry, not a column';
    END IF;
    RAISE NOTICE 'PASS  L24 marital_status is absent (handbook §1.3.4.5 is under legal review)';
END $$;

-- L25: hrm_app can record lifecycle but never rewrite it. 0008's model, extended.
DO $$
DECLARE v_bad TEXT;
BEGIN
    SELECT string_agg(format('%s:%s', table_name, privilege_type), ', ') INTO v_bad
      FROM information_schema.role_table_grants
     WHERE grantee = 'hrm_app'
       AND table_name = 'employment_event'
       AND privilege_type IN ('UPDATE','DELETE','TRUNCATE');
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'FAIL  L25 hrm_app can mutate the lifecycle log: %', v_bad;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                    WHERE grantee = 'hrm_app' AND table_name = 'employment_event'
                      AND privilege_type = 'INSERT') THEN
        RAISE EXCEPTION 'FAIL  L25 hrm_app cannot INSERT a lifecycle event, so Module 1 cannot '
                        'work once the app stops connecting as owner';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                    WHERE grantee = 'hrm_app' AND table_name = 'employee'
                      AND privilege_type = 'UPDATE') THEN
        RAISE EXCEPTION 'FAIL  L25 hrm_app cannot UPDATE employee, so no profile edit is possible';
    END IF;

    RAISE NOTICE 'PASS  L25 hrm_app may append lifecycle and edit profile, never rewrite history';
END $$;
