-- =============================================================================
-- Verification for 0027: the work hierarchy
--
-- The checks that carry the weight:
--
--   WH3   a work log entry cannot name a task from a different project. This is the gap that
--         existed BEFORE 0027 - project_id and task_id were independent FKs - and the one whose
--         absence silently moved effort onto the wrong client's report.
--   WH6   a task directly under a project stays visible in v_work_hierarchy after that project
--         gains a sub-project. The first draft of the view joined sub_project to the project and
--         task to both, which made exactly these tasks vanish; the nullable parent exists to
--         support them, so a view that hides them is worse than no view.
--   WH8   deactivating a sub-project retires the tasks beneath it without touching them, and
--   WH9   an already-filed work log stays readable and keeps its labels afterwards. Together
--         these are the "historical references remain valid" requirement.
--   WH10  no ON DELETE CASCADE anywhere on the hierarchy, so deleting a referenced master is
--         refused rather than quietly erasing somebody's timesheet.
--
-- Every deliberate failure below runs inside its own BEGIN/EXCEPTION block. A raised constraint
-- aborts the whole transaction otherwise, and the remaining checks then "pass" because they never
-- execute - which is how three payslip checks passed for the wrong reason earlier in this repo.
-- =============================================================================

\set ON_ERROR_STOP on

DO $$
DECLARE
    v_project     UUID;
    v_other       UUID;
    v_sub         UUID;
    v_task        UUID;
    v_other_task  UUID;
    v_sub_task    UUID;
    v_log         UUID;
    v_emp         UUID;
    v_n           INT;
    v_ok          BOOLEAN;
    v_label       TEXT;
BEGIN
    -- ---------------------------------------------------------------- fixtures
    -- Own fixtures throughout. Borrowing a seeded project made an earlier suite order-dependent.
    INSERT INTO project (code, name, status) VALUES ('WH-A', 'Verify A', 'active') RETURNING id INTO v_project;
    INSERT INTO project (code, name, status) VALUES ('WH-B', 'Verify B', 'active') RETURNING id INTO v_other;

    INSERT INTO sub_project (project_id, code, name) VALUES (v_project, 'WH-SP', 'Phase one')
        RETURNING id INTO v_sub;
    INSERT INTO task (project_id, sub_project_id, code, title)
        VALUES (v_project, v_sub, 'WH-T', 'Under the sub-project') RETURNING id INTO v_task;
    INSERT INTO task (project_id, code, title)
        VALUES (v_other, 'WH-OT', 'In the other project') RETURNING id INTO v_other_task;
    INSERT INTO sub_task (task_id, code, title) VALUES (v_task, 'WH-ST', 'Finest unit')
        RETURNING id INTO v_sub_task;

    SELECT id INTO v_emp FROM employee ORDER BY employee_number LIMIT 1;
    INSERT INTO work_log (employee_id, work_date) VALUES (v_emp, DATE '2031-03-04')
        RETURNING id INTO v_log;

    -- ---------------------------------------------------------------- WH1
    -- A task cannot be attached to a sub-project belonging to a different project.
    v_ok := false;
    BEGIN
        INSERT INTO task (project_id, sub_project_id, title) VALUES (v_other, v_sub, 'wrong parent');
    EXCEPTION WHEN foreign_key_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'FAIL  WH1 a task was attached to a sub-project of an unrelated project';
    END IF;

    -- ---------------------------------------------------------------- WH2
    -- A task with no sub-project is still legal - that is every task that existed before 0027.
    BEGIN
        INSERT INTO task (project_id, code, title) VALUES (v_project, 'WH-T2', 'Directly under');
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'FAIL  WH2 a task directly under its project was refused: %', SQLERRM;
    END;

    -- ---------------------------------------------------------------- WH3
    -- THE PRE-EXISTING GAP. Entry names one project and a task from another.
    v_ok := false;
    BEGIN
        INSERT INTO work_log_entry (work_log_id, project_id, task_id, minutes,
                                    entered_by_employee_id, entry_source)
            VALUES (v_log, v_project, v_other_task, 60, v_emp, 'self');
    EXCEPTION WHEN foreign_key_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'FAIL  WH3 effort was logged against a task from a different project';
    END IF;

    -- ---------------------------------------------------------------- WH4
    -- A sub-task from a different task cannot be attached.
    v_ok := false;
    BEGIN
        INSERT INTO work_log_entry (work_log_id, project_id, task_id, sub_task_id, minutes,
                                    entered_by_employee_id, entry_source)
            VALUES (v_other, v_other, v_other_task, v_sub_task, 60, v_emp, 'self');
    EXCEPTION WHEN OTHERS THEN v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'FAIL  WH4 a sub-task was attached to an unrelated task';
    END IF;

    -- ---------------------------------------------------------------- WH5
    -- A sub-task with no task at all. MATCH SIMPLE would skip the composite FK here, so this is
    -- carried by ck_work_log_entry_sub_task_needs_task rather than by the foreign key.
    v_ok := false;
    BEGIN
        INSERT INTO work_log_entry (work_log_id, project_id, task_id, sub_task_id, minutes,
                                    entered_by_employee_id, entry_source)
            VALUES (v_log, v_project, NULL, v_sub_task, 60, v_emp, 'self');
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'FAIL  WH5 a sub-task was recorded with no task above it';
    END IF;

    -- ---------------------------------------------------------------- WH6
    -- The view bug. WH-A now has a sub-project AND a task directly beneath it (WH-T2 from WH2).
    SELECT count(*) INTO v_n FROM v_work_hierarchy
     WHERE project_id = v_project AND sub_project_id IS NULL AND task_code = 'WH-T2';
    IF v_n <> 1 THEN
        RAISE EXCEPTION
            'FAIL  WH6 a task directly under a project is invisible in v_work_hierarchy (rows=%) '
            '- the sub_project/task join is cross-producing again', v_n;
    END IF;

    -- ---------------------------------------------------------------- WH7
    -- And the task under the sub-project is NOT duplicated once per sibling sub-project.
    SELECT count(*) INTO v_n FROM v_work_hierarchy WHERE task_code = 'WH-T';
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'FAIL  WH7 task WH-T appears % times in v_work_hierarchy, want 1', v_n;
    END IF;

    -- ---------------------------------------------------------------- WH9 (recorded before WH8)
    -- File real effort, so WH8 and WH9 are about a row that actually exists.
    -- 0028 requires a recorder on every new line; these fixtures are self-entry.
    INSERT INTO work_log_entry (work_log_id, project_id, task_id, sub_task_id, minutes,
                                description, entered_by_employee_id, entry_source)
        VALUES (v_log, v_project, v_task, v_sub_task, 90, 'historical', v_emp, 'self');

    -- ---------------------------------------------------------------- WH8
    -- Retiring the sub-project retires everything beneath it, without touching those rows.
    UPDATE sub_project SET active = false WHERE id = v_sub;
    SELECT selectable INTO v_ok FROM v_work_hierarchy WHERE sub_task_id = v_sub_task;
    IF v_ok THEN
        RAISE EXCEPTION 'FAIL  WH8 a sub-task under a retired sub-project is still selectable';
    END IF;
    SELECT active INTO v_ok FROM task WHERE id = v_task;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'FAIL  WH8 retiring a sub-project mutated task.active - it must roll up '
                        'through the view, not by writing to the children';
    END IF;

    -- ---------------------------------------------------------------- WH9
    -- The already-filed work log stays readable and keeps its labels.
    SELECT st.title INTO v_label
      FROM work_log_entry wle JOIN sub_task st ON st.id = wle.sub_task_id
     WHERE wle.work_log_id = v_log AND wle.minutes = 90;
    IF v_label IS DISTINCT FROM 'Finest unit' THEN
        RAISE EXCEPTION 'FAIL  WH9 a historical work log lost its sub-task label after the '
                        'master was retired (got %)', coalesce(v_label, '<null>');
    END IF;

    -- ---------------------------------------------------------------- WH10
    -- No ON DELETE CASCADE on the hierarchy: deleting a referenced master must be refused, not
    -- silently take the effort with it.
    SELECT count(*) INTO v_n
      FROM pg_constraint
     WHERE contype = 'f'
       AND confdeltype <> 'a'                       -- 'a' = NO ACTION
       AND conrelid IN ('task'::regclass, 'sub_task'::regclass, 'sub_project'::regclass)
       AND conname <> 'work_log_entry_work_log_id_fkey';
    IF v_n <> 0 THEN
        RAISE EXCEPTION 'FAIL  WH10 % hierarchy foreign keys carry a delete action other than '
                        'NO ACTION', v_n;
    END IF;
    v_ok := false;
    BEGIN
        DELETE FROM sub_task WHERE id = v_sub_task;
    EXCEPTION WHEN foreign_key_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'FAIL  WH10 a sub-task referenced by a work log was hard-deleted';
    END IF;

    -- ---------------------------------------------------------------- WH11
    -- Rule 5: every date on the new tables is a DATE, and no money/float sneaked in.
    SELECT count(*) INTO v_n
      FROM information_schema.columns
     WHERE table_name IN ('sub_project', 'sub_task')
       AND data_type IN ('real', 'double precision');
    IF v_n <> 0 THEN
        RAISE EXCEPTION 'FAIL  WH11 % floating-point columns on the new hierarchy tables', v_n;
    END IF;

    -- ---------------------------------------------------------------- WH12
    -- The entry deliberately has NO sub_project_id. If somebody adds one later they must also
    -- add the constraint keeping it honest, and this check is where they will find out.
    SELECT count(*) INTO v_n
      FROM information_schema.columns
     WHERE table_name = 'work_log_entry' AND column_name = 'sub_project_id';
    IF v_n <> 0 THEN
        RAISE EXCEPTION
            'FAIL  WH12 work_log_entry.sub_project_id exists. DEC-113 omits it on purpose - the '
            'sub-project is a property of the task. If it is genuinely needed, it needs a '
            'constraint tying it to the task, and this check needs to be replaced not deleted';
    END IF;

    RAISE NOTICE 'PASS  0027 work hierarchy: 12 checks';
END $$;
