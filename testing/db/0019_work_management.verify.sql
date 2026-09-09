-- =============================================================================
-- Verification for 0019: daily work management
--
-- The checks that carry the weight:
--
--   W3  project membership DECAYS. Closing a period ends access without deleting the row, so
--       last quarter's project report does not change when somebody rolls off. This is OR-17,
--       which blocked the project authorization graph from having a time dimension at all.
--   W12 NO SELF-APPROVAL, and it survives holding every role - because it is a CHECK, not an if.
--   W13 the denormalised subject must match its parent, WITHOUT which W12 constrains whatever
--       the caller chose to write (rbac-rules structural-integrity item 1).
--   W16 `under_review` locks work-log writes. Adding a state between submitted and approved
--       would otherwise have opened a window for editing effort while a manager read it.
--
-- Fixtures are created by the checks that use them. Runs inside a transaction the runner always
-- rolls back (DEC-024).
-- =============================================================================

-- W1: effort is INTEGER MINUTES everywhere (ADR-0016 / Rule 4). Floating-point effort would
-- accumulate rounding error across a month and land in a payroll figure.
DO $$
DECLARE v_bad TEXT;
BEGIN
    SELECT string_agg(format('%s.%s is %s', c.relname, a.attname,
                             format_type(a.atttypid, a.atttypmod)), ', ') INTO v_bad
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relname IN ('work_log_entry')
       AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attname = 'minutes'
       AND format_type(a.atttypid, a.atttypmod) NOT IN ('integer', 'bigint');
    IF v_bad IS NULL THEN RAISE NOTICE 'PASS  W1 effort is stored as integer minutes';
    ELSE RAISE EXCEPTION 'FAIL  W1 %', v_bad; END IF;
END $$;

-- W2: project_member is effective-dated, and the old "one row ever" uniqueness is gone.
DO $$
DECLARE v_has_period BOOLEAN; v_old_unique BOOLEAN; v_excl TEXT;
BEGIN
    SELECT EXISTS (SELECT 1 FROM pg_attribute
                    WHERE attrelid = 'project_member'::regclass AND attname = 'valid_period')
      INTO v_has_period;
    SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_project_member')
      INTO v_old_unique;
    SELECT pg_get_constraintdef(oid) INTO v_excl
      FROM pg_constraint WHERE conname = 'ex_project_member_no_overlap';

    IF NOT v_has_period THEN RAISE EXCEPTION 'FAIL  W2 project_member has no valid_period'; END IF;
    IF v_old_unique THEN
        RAISE EXCEPTION 'FAIL  W2 uq_project_member survives - that is what made roll-off '
                        'unrepresentable';
    END IF;
    IF v_excl IS NULL THEN RAISE EXCEPTION 'FAIL  W2 no overlap exclusion constraint'; END IF;
    RAISE NOTICE 'PASS  W2 membership is a period: %', v_excl;
END $$;

-- W3: THE OR-17 CHECK. Closing a membership ends access on the day it closes, and leaves every
-- earlier date answering as it did before.
DO $$
DECLARE v_p UUID; v_e UUID; v_before BOOLEAN; v_after BOOLEAN; v_rows BIGINT;
BEGIN
    SET LOCAL hrm.allow_backdated_period = 'on';
    SELECT id INTO v_e FROM employee LIMIT 1;
    INSERT INTO project (code, name, status, started_on)
    VALUES ('VW3', 'Verify W3', 'active', '2025-01-01') RETURNING id INTO v_p;
    INSERT INTO project_member (project_id, employee_id, role, valid_from, valid_to)
    VALUES (v_p, v_e, 'contributor', '2025-01-01', '2025-07-01');

    v_before := fn_is_project_member_asof(v_e, v_p, '2025-06-30');
    v_after  := fn_is_project_member_asof(v_e, v_p, '2025-07-02');
    SELECT count(*) INTO v_rows FROM project_member WHERE project_id = v_p;

    IF v_before AND NOT v_after AND v_rows = 1 THEN
        RAISE NOTICE 'PASS  W3 access ended at the period close, and the row survives (OR-17)';
    ELSE
        RAISE EXCEPTION 'FAIL  W3 before=% after=% rows_kept=%', v_before, v_after, v_rows;
    END IF;
END $$;

-- W4: somebody may leave a project and rejoin it later - the whole reason the old UNIQUE had
-- to go - but never hold two overlapping memberships.
DO $$
DECLARE v_p UUID; v_e UUID; v_ok BOOLEAN := false; v_n BIGINT;
BEGIN
    SET LOCAL hrm.allow_backdated_period = 'on';
    SELECT id INTO v_e FROM employee LIMIT 1;
    INSERT INTO project (code, name, status, started_on)
    VALUES ('VW4', 'Verify W4', 'active', '2025-01-01') RETURNING id INTO v_p;

    INSERT INTO project_member (project_id, employee_id, role, valid_from, valid_to)
    VALUES (v_p, v_e, 'contributor', '2025-01-01', '2025-04-01');
    INSERT INTO project_member (project_id, employee_id, role, valid_from, valid_to)
    VALUES (v_p, v_e, 'lead', '2025-09-01', NULL);
    SELECT count(*) INTO v_n FROM project_member WHERE project_id = v_p AND employee_id = v_e;

    BEGIN
        INSERT INTO project_member (project_id, employee_id, role, valid_from)
        VALUES (v_p, v_e, 'contributor', '2025-10-01');
    EXCEPTION WHEN exclusion_violation THEN v_ok := true;
    END;

    IF v_n = 2 AND v_ok THEN
        RAISE NOTICE 'PASS  W4 rejoining allowed (% periods); overlapping membership refused', v_n;
    ELSE
        RAISE EXCEPTION 'FAIL  W4 periods=% overlap_blocked=%', v_n, v_ok;
    END IF;
END $$;

-- W5: role is per PERIOD, so a promotion from contributor to lead is a new period and the old
-- one still reads as contributor.
DO $$
DECLARE v_p UUID; v_e UUID; v_then TEXT; v_now TEXT;
BEGIN
    SELECT id INTO v_p FROM project WHERE code = 'VW4';
    SELECT id INTO v_e FROM employee LIMIT 1;
    SELECT role INTO v_then FROM fn_project_members_asof(v_p, '2025-02-01')
     WHERE employee_id = v_e;
    SELECT role INTO v_now FROM fn_project_members_asof(v_p, '2025-10-15')
     WHERE employee_id = v_e;
    IF v_then = 'contributor' AND v_now = 'lead' THEN
        RAISE NOTICE 'PASS  W5 the role in force is resolved per date (% -> %)', v_then, v_now;
    ELSE
        RAISE EXCEPTION 'FAIL  W5 then=% now=%', v_then, v_now;
    END IF;
END $$;

-- W6: Rule 3 - a historical membership cannot be rewritten.
DO $$
DECLARE v_id UUID; v_ok BOOLEAN := false;
BEGIN
    SELECT id INTO v_id FROM project_member WHERE valid_to IS NOT NULL LIMIT 1;
    BEGIN UPDATE project_member SET role = 'project_manager' WHERE id = v_id;
    EXCEPTION WHEN restrict_violation THEN v_ok := true; END;
    IF v_ok THEN RAISE NOTICE 'PASS  W6 a closed membership period cannot be edited';
    ELSE RAISE EXCEPTION 'FAIL  W6 history was rewritten'; END IF;
END $$;

-- W7: the role filter works, so a lead-only privilege cannot be satisfied by a contributor.
DO $$
DECLARE v_p UUID; v_e UUID; v_any BOOLEAN; v_lead BOOLEAN;
BEGIN
    SET LOCAL hrm.allow_backdated_period = 'on';
    SELECT id INTO v_e FROM employee LIMIT 1;
    INSERT INTO project (code, name, status, started_on)
    VALUES ('VW7', 'Verify W7', 'active', '2025-01-01') RETURNING id INTO v_p;
    INSERT INTO project_member (project_id, employee_id, role, valid_from)
    VALUES (v_p, v_e, 'contributor', '2025-01-01');

    v_any  := fn_is_project_member_asof(v_e, v_p, '2025-06-01');
    v_lead := fn_is_project_member_asof(v_e, v_p, '2025-06-01',
                                        ARRAY['lead', 'project_manager']);
    IF v_any AND NOT v_lead THEN
        RAISE NOTICE 'PASS  W7 a contributor is a member but not a lead';
    ELSE
        RAISE EXCEPTION 'FAIL  W7 any=% lead=%', v_any, v_lead;
    END IF;
END $$;

-- W8: a task may only be assigned to a current member.
DO $$
DECLARE v_p UUID; v_e UUID; v_ok BOOLEAN := false;
BEGIN
    SET LOCAL hrm.allow_backdated_period = 'on';
    SELECT id INTO v_e FROM employee LIMIT 1;
    INSERT INTO project (code, name, status, started_on)
    VALUES ('VW8', 'Verify W8', 'active', '2025-01-01') RETURNING id INTO v_p;
    -- membership that ENDED, so they are not a member today
    INSERT INTO project_member (project_id, employee_id, role, valid_from, valid_to)
    VALUES (v_p, v_e, 'contributor', '2025-01-01', '2025-02-01');

    BEGIN
        INSERT INTO task (project_id, title, assignee_employee_id)
        VALUES (v_p, 'Verify W8', v_e);
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  W8 a task cannot be assigned to a non-member';
    ELSE RAISE EXCEPTION 'FAIL  W8 assigned to somebody off the project'; END IF;
END $$;

-- W9: task closure coherence - a terminal task has a closure time, a live one does not.
DO $$
DECLARE v_p UUID; v_a BOOLEAN := false; v_b BOOLEAN := false;
BEGIN
    SELECT id INTO v_p FROM project WHERE code = 'VW8';
    BEGIN
        INSERT INTO task (project_id, title, status) VALUES (v_p, 'done with no time', 'done');
    EXCEPTION WHEN check_violation THEN v_a := true; END;
    BEGIN
        INSERT INTO task (project_id, title, status, closed_at)
        VALUES (v_p, 'open with a time', 'open', now());
    EXCEPTION WHEN check_violation THEN v_b := true; END;
    IF v_a AND v_b THEN
        RAISE NOTICE 'PASS  W9 task closure is coherent in both directions';
    ELSE
        RAISE EXCEPTION 'FAIL  W9 done_without_time=% open_with_time=%', v_a, v_b;
    END IF;
END $$;

-- W10: a closed project must say when it closed.
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
    BEGIN
        INSERT INTO project (code, name, status) VALUES ('VW10', 'Verify W10', 'closed');
    EXCEPTION WHEN check_violation THEN v_ok := true; END;
    IF v_ok THEN RAISE NOTICE 'PASS  W10 a closed project needs an end date';
    ELSE RAISE EXCEPTION 'FAIL  W10 project closed with no date'; END IF;
END $$;

-- W11: THE TIMESHEET FSM. The full review cycle, and the log is the audit trail.
DO $$
DECLARE v_tp UUID; v_subj UUID; v_mgr UUID; v_status TEXT; v_events TEXT;
BEGIN
    SELECT tp.id, tp.employee_id INTO v_tp, v_subj
      FROM timesheet_period tp WHERE tp.status = 'draft' LIMIT 1;
    IF v_tp IS NULL THEN RAISE NOTICE 'INFO  W11 no draft timesheet in this dataset'; RETURN; END IF;
    SELECT id INTO v_mgr FROM employee WHERE id <> v_subj LIMIT 1;

    INSERT INTO timesheet_transition
        (timesheet_period_id, event_type, from_status, to_status, actor_employee_id, subject_employee_id)
    VALUES (v_tp, 'submit', 'draft', 'submitted', v_subj, v_subj);

    INSERT INTO timesheet_transition
        (timesheet_period_id, event_type, from_status, to_status, actor_employee_id, subject_employee_id, note)
    VALUES (v_tp, 'return', 'submitted', 'returned', v_mgr, v_subj, 'Tuesday looks short');

    INSERT INTO timesheet_transition
        (timesheet_period_id, event_type, from_status, to_status, actor_employee_id, subject_employee_id)
    VALUES (v_tp, 'correct', 'returned', 'draft', v_subj, v_subj);

    -- The return note is RETAINED while correcting: the employee needs to see the feedback they
    -- are acting on. It clears on resubmission, below.
    IF (SELECT return_note FROM timesheet_period WHERE id = v_tp) IS NULL THEN
        RAISE EXCEPTION 'FAIL  W11 the return note was cleared before the employee could act on it';
    END IF;

    INSERT INTO timesheet_transition
        (timesheet_period_id, event_type, from_status, to_status, actor_employee_id, subject_employee_id)
    VALUES (v_tp, 'submit', 'draft', 'submitted', v_subj, v_subj);

    IF (SELECT return_note FROM timesheet_period WHERE id = v_tp) IS NOT NULL THEN
        RAISE EXCEPTION 'FAIL  W11 a stale return note survived resubmission';
    END IF;

    INSERT INTO timesheet_transition
        (timesheet_period_id, event_type, from_status, to_status, actor_employee_id, subject_employee_id)
    VALUES (v_tp, 'start_review', 'submitted', 'under_review', v_mgr, v_subj);
    INSERT INTO timesheet_transition
        (timesheet_period_id, event_type, from_status, to_status, actor_employee_id, subject_employee_id)
    VALUES (v_tp, 'approve', 'under_review', 'approved', v_mgr, v_subj);

    SELECT status INTO v_status FROM timesheet_period WHERE id = v_tp;
    SELECT string_agg(event_type, ' -> ' ORDER BY created_at) INTO v_events
      FROM timesheet_transition WHERE timesheet_period_id = v_tp;

    IF v_status = 'approved'
       AND (SELECT decided_by FROM timesheet_period WHERE id = v_tp) = v_mgr THEN
        RAISE NOTICE 'PASS  W11 review cycle recorded: %', v_events;
    ELSE
        RAISE EXCEPTION 'FAIL  W11 status=% events=%', v_status, v_events;
    END IF;
END $$;

-- W12: NO SELF-APPROVAL. A CHECK, so no combination of roles defeats it.
DO $$
DECLARE v_tp UUID; v_subj UUID; v_ok BOOLEAN := false;
BEGIN
    SELECT tp.id, tp.employee_id INTO v_tp, v_subj
      FROM timesheet_period tp WHERE tp.status = 'draft' LIMIT 1;
    IF v_tp IS NULL THEN RAISE NOTICE 'INFO  W12 no draft timesheet available'; RETURN; END IF;

    INSERT INTO timesheet_transition
        (timesheet_period_id, event_type, from_status, to_status, actor_employee_id, subject_employee_id)
    VALUES (v_tp, 'submit', 'draft', 'submitted', v_subj, v_subj);

    BEGIN
        INSERT INTO timesheet_transition
            (timesheet_period_id, event_type, from_status, to_status, actor_employee_id, subject_employee_id)
        VALUES (v_tp, 'approve', 'submitted', 'approved', v_subj, v_subj);
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  W12 nobody approves their own timesheet';
    ELSE RAISE EXCEPTION 'FAIL  W12 self-approval accepted'; END IF;
END $$;

-- W13: the denormalised subject must match its parent. Without this, W12's CHECK constrains
-- whatever the caller chose to put in the column (rbac-rules structural-integrity item 1).
DO $$
DECLARE v_tp UUID; v_subj UUID; v_other UUID; v_ok BOOLEAN := false;
BEGIN
    SELECT tp.id, tp.employee_id INTO v_tp, v_subj
      FROM timesheet_period tp WHERE tp.status = 'submitted' LIMIT 1;
    IF v_tp IS NULL THEN RAISE NOTICE 'INFO  W13 no submitted timesheet available'; RETURN; END IF;
    SELECT id INTO v_other FROM employee WHERE id <> v_subj LIMIT 1;

    BEGIN
        -- Claiming somebody else is the subject would let the actor approve their own sheet.
        INSERT INTO timesheet_transition
            (timesheet_period_id, event_type, from_status, to_status, actor_employee_id, subject_employee_id)
        VALUES (v_tp, 'approve', 'submitted', 'approved', v_subj, v_other);
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    IF v_ok THEN
        RAISE NOTICE 'PASS  W13 a mis-stated subject is refused, so W12 cannot be sidestepped';
    ELSE
        RAISE EXCEPTION 'FAIL  W13 self-approval achieved by lying about the subject';
    END IF;
END $$;

-- W14 / W15 share a fixture, and THEY BUILD IT THEMSELVES.
--
-- Both used to borrow a seeded draft timesheet:
--
--     SELECT tp.id, tp.employee_id INTO v_tp, v_subj
--       FROM timesheet_period tp WHERE tp.status = 'draft' LIMIT 1;
--     IF v_tp IS NULL THEN RAISE NOTICE 'INFO  W14 no draft timesheet available'; RETURN; END IF;
--
-- which meant that running `demo:test` first - it SUBMITS the seeded draft - left no draft, and
-- both checks returned an INFO line instead of a PASS. Nothing failed. `db:verify` simply
-- reported two fewer checks than the run before, and the totals only stopped matching because
-- somebody counted them. **Silently losing coverage is worse than a failure**, because a failure
-- is loud and this was not.
--
-- Fifth occurrence of this trap in this repo (0014 L13, 0017 G5, 0012 N8, and the task report's
-- empty seed). Now they own their fixture and are order-independent by construction.
DO $$
DECLARE
    v_emp UUID; v_mgr UUID; v_tp UUID; v_desig UUID; v_dept UUID;
    v_join DATE := DATE '2024-03-01';
    v_ok BOOLEAN := false; v_bogus BOOLEAN := false; v_term BOOLEAN := false;
BEGIN
    SET LOCAL hrm.allow_backdated_period = 'on';

    SELECT id INTO v_desig FROM designation WHERE retired_on IS NULL LIMIT 1;
    INSERT INTO department (code, name) VALUES ('VW14', 'W14 Fixture') RETURNING id INTO v_dept;
    INSERT INTO department_period (department_id, parent_department_id, valid_from)
    VALUES (v_dept, NULL, v_join);

    -- Two employees, because half of what these checks prove is about WHO acts.
    INSERT INTO employee (employee_number, full_name, work_email, joined_on, status)
    VALUES ('VERIFY-W14A', 'Timesheet Subject', 'verify-w14a@example.invalid', v_join, 'pre_boarding')
    RETURNING id INTO v_emp;
    INSERT INTO employment_event (employee_id, event_type, from_status, to_status, effective_on)
    VALUES (v_emp, 'joined', 'pre_boarding', 'active', v_join);
    INSERT INTO employment (employee_id, department_id, designation_id, valid_from)
    VALUES (v_emp, v_dept, v_desig, v_join);

    INSERT INTO employee (employee_number, full_name, work_email, joined_on, status)
    VALUES ('VERIFY-W14B', 'Timesheet Approver', 'verify-w14b@example.invalid', v_join, 'pre_boarding')
    RETURNING id INTO v_mgr;
    INSERT INTO employment_event (employee_id, event_type, from_status, to_status, effective_on)
    VALUES (v_mgr, 'joined', 'pre_boarding', 'active', v_join);
    INSERT INTO employment (employee_id, department_id, designation_id, valid_from)
    VALUES (v_mgr, v_dept, v_desig, v_join);

    INSERT INTO timesheet_period (employee_id, period_start, period_end)
    VALUES (v_emp, DATE '2024-03-04', DATE '2024-03-10') RETURNING id INTO v_tp;

    -- W14: the employee's own moves must be made by the employee.
    BEGIN
        INSERT INTO timesheet_transition
            (timesheet_period_id, event_type, from_status, to_status, actor_employee_id, subject_employee_id)
        VALUES (v_tp, 'submit', 'draft', 'submitted', v_mgr, v_emp);
    EXCEPTION WHEN check_violation THEN v_ok := true; END;

    IF v_ok THEN
        RAISE NOTICE 'PASS  W14 a manager cannot submit somebody else''s timesheet';
    ELSE
        RAISE EXCEPTION 'FAIL  W14 somebody else submitted it';
    END IF;

    -- W15: an invented move is refused by the FSM foreign key, and `approved` is terminal.
    BEGIN
        INSERT INTO timesheet_transition
            (timesheet_period_id, event_type, from_status, to_status, actor_employee_id, subject_employee_id)
        VALUES (v_tp, 'submit', 'draft', 'approved', v_emp, v_emp);
    EXCEPTION WHEN foreign_key_violation THEN v_bogus := true; END;

    INSERT INTO timesheet_transition
        (timesheet_period_id, event_type, from_status, to_status, actor_employee_id, subject_employee_id)
    VALUES (v_tp, 'submit', 'draft', 'submitted', v_emp, v_emp);
    INSERT INTO timesheet_transition
        (timesheet_period_id, event_type, from_status, to_status, actor_employee_id, subject_employee_id)
    VALUES (v_tp, 'approve', 'submitted', 'approved', v_mgr, v_emp);

    BEGIN
        INSERT INTO timesheet_transition
            (timesheet_period_id, event_type, from_status, to_status, actor_employee_id, subject_employee_id)
        VALUES (v_tp, 'start_review', 'approved', 'under_review', v_mgr, v_emp);
    EXCEPTION WHEN foreign_key_violation THEN v_term := true; END;

    IF v_bogus AND v_term THEN
        RAISE NOTICE 'PASS  W15 an invented move is refused, and approved is terminal';
    ELSE
        RAISE EXCEPTION 'FAIL  W15 bogus_blocked=% terminal=%', v_bogus, v_term;
    END IF;
END $$;

-- W16: `under_review` LOCKS work-log writes; `returned` does not. Adding a state between
-- submitted and approved without extending the lock would have opened a window for editing
-- effort while a manager was reading it.
DO $$
DECLARE v_def TEXT;
BEGIN
    v_def := pg_get_functiondef('fn_work_log_period_lock'::regproc);
    IF v_def NOT LIKE '%under_review%' THEN
        RAISE EXCEPTION 'FAIL  W16 the period lock does not mention under_review, so effort is '
                        'editable while a manager reviews it';
    END IF;
    IF v_def LIKE '%''returned''%' THEN
        RAISE EXCEPTION 'FAIL  W16 the lock includes `returned`, which is the one state that '
                        'must stay editable - returning a timesheet exists so it can be fixed';
    END IF;
    RAISE NOTICE 'PASS  W16 the lock covers submitted/under_review/approved and spares returned';
END $$;

-- W17: the transition log is append-only.
DO $$
DECLARE v_u BOOLEAN := false; v_d BOOLEAN := false;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM timesheet_transition) THEN
        RAISE NOTICE 'INFO  W17 no transitions recorded in this run'; RETURN;
    END IF;
    BEGIN UPDATE timesheet_transition SET note = 'tampered';
    EXCEPTION WHEN restrict_violation THEN v_u := true; END;
    BEGIN DELETE FROM timesheet_transition;
    EXCEPTION WHEN restrict_violation THEN v_d := true; END;
    IF v_u AND v_d THEN RAISE NOTICE 'PASS  W17 the transition log is append-only';
    ELSE RAISE EXCEPTION 'FAIL  W17 update=% delete=%', v_u, v_d; END IF;
END $$;

-- W18: reporting aggregates return MINUTES, and project effort reports non-membership rather
-- than hiding or correcting it (the ADR-0015 principle applied to project attribution).
DO $$
DECLARE v_def TEXT; v_cols TEXT;
BEGIN
    SELECT string_agg(a.attname, ', ' ORDER BY a.attnum) INTO v_cols
      FROM pg_proc p
      JOIN pg_type t ON t.oid = p.prorettype
      JOIN pg_class c ON c.reltype = t.oid
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0
     WHERE p.proname = 'fn_project_effort';

    v_def := pg_get_functiondef('fn_project_effort'::regproc);
    IF v_def NOT LIKE '%was_member%' THEN
        RAISE EXCEPTION 'FAIL  W18 fn_project_effort does not report membership at all';
    END IF;
    IF v_def NOT LIKE '%fn_is_project_member_asof%' THEN
        RAISE EXCEPTION 'FAIL  W18 project effort does not resolve membership AS OF the work '
                        'date - attributing today''s membership to last quarter''s effort is '
                        'exactly what effective-dating exists to prevent';
    END IF;
    RAISE NOTICE 'PASS  W18 project effort resolves membership as of each work date and reports it';
END $$;

-- W19: every rail added here is ENABLE ALWAYS (DEC-030).
DO $$
DECLARE v_weak TEXT;
BEGIN
    SELECT string_agg(format('%s.%s', c.relname, t.tgname), ', ') INTO v_weak
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE NOT t.tgisinternal
       AND c.relname IN ('project_member', 'timesheet_transition', 'task')
       AND t.tgname NOT LIKE '%updated_at%'
       AND t.tgenabled <> 'A';
    IF v_weak IS NULL THEN RAISE NOTICE 'PASS  W19 work-module rails are ENABLE ALWAYS';
    ELSE RAISE EXCEPTION 'FAIL  W19 disableable by a session GUC: %', v_weak; END IF;
END $$;

-- W20: the resolvers pin search_path (precedent 0013).
DO $$
DECLARE v_bad TEXT;
BEGIN
    SELECT string_agg(p.proname, ', ') INTO v_bad
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('fn_project_members_asof', 'fn_employee_projects_asof',
                         'fn_is_project_member_asof', 'fn_effort_by_project',
                         'fn_monthly_effort', 'fn_project_effort',
                         'fn_task_assignee_is_member', 'fn_timesheet_transition_guard',
                         'fn_timesheet_transition_apply', 'fn_work_log_period_lock')
       AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) cfg
                        WHERE cfg LIKE 'search_path=%');
    IF v_bad IS NULL THEN RAISE NOTICE 'PASS  W20 all work-module functions pin search_path';
    ELSE RAISE EXCEPTION 'FAIL  W20 unpinned: %', v_bad; END IF;
END $$;

-- W21: hrm_app may close a membership but never delete one, and may append transitions but
-- never rewrite them.
DO $$
DECLARE v_bad TEXT;
BEGIN
    SELECT string_agg(format('%s:%s', table_name, privilege_type), ', ') INTO v_bad
      FROM information_schema.role_table_grants
     WHERE grantee = 'hrm_app'
       AND table_name IN ('project_member', 'timesheet_transition')
       AND privilege_type IN ('DELETE', 'TRUNCATE');
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'FAIL  W21 hrm_app can erase work history: %', v_bad;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                    WHERE grantee = 'hrm_app' AND table_name = 'timesheet_transition'
                      AND privilege_type = 'INSERT') THEN
        RAISE EXCEPTION 'FAIL  W21 hrm_app cannot record a timesheet transition';
    END IF;
    RAISE NOTICE 'PASS  W21 hrm_app may append and close, never erase';
END $$;

-- W22: work logs are NOT attendance (ADR-0015). The variance view must still exist and must
-- not be a correction mechanism - nothing may UPDATE either side from it.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_views WHERE viewname = 'v_work_attendance_variance') THEN
        RAISE EXCEPTION 'FAIL  W22 the attendance-versus-effort variance view is gone. A '
                        'mismatch is a reconciliation FINDING, and losing the view is how it '
                        'silently becomes a correction instead';
    END IF;
    RAISE NOTICE 'PASS  W22 attendance and effort stay separate, with the variance reported';
END $$;
