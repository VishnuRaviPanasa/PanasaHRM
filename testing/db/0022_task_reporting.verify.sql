-- =============================================================================
-- Verification for 0022 / 0023: task reporting
--
-- The checks that carry the weight:
--
--   TK1  fn_task_status publishes its subject as `assignee_employee_id`, the column
--        packages/authz renders for the `task` resource. 0022 published `employee_id` and every
--        SCOPED caller got a 500 while HR - whose predicate is literal `true` and names no
--        column - worked perfectly. This is the check that was missing when that shipped.
--   TK3  a closed task is never overdue, however far past its due date. Asserted with a fixture
--        that is BOTH done and 20 days late, because a fixture without that combination cannot
--        distinguish a correct implementation from one that ignores status.
--   TK5  an employee with no tasks scores zero on every counter - the COUNT(*)-over-LEFT-JOIN
--        phantom that had to be fixed in 0021 for documents.
--   TK7  an UNASSIGNED task is absent from the per-assignee cut and present in the per-project
--        cut. That is the whole justification for having two functions.
--   TK9  neither function writes.
--
-- EVERY CHECK BUILDS ITS OWN FIXTURE. Three separate failures this session (0014 L13, 0017 G5,
-- 0012 N8) came from a check borrowing seeded data that later moved, so nothing below reads a
-- seeded employee, project or task.
--
-- Runs inside a transaction the runner always rolls back (DEC-024).
-- =============================================================================

-- TK1: THE SUBJECT COLUMN. This is a contract with packages/authz, not a naming preference.
DO $$
DECLARE v_names TEXT[];
BEGIN
    SELECT p.proargnames INTO v_names
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_task_status';

    IF v_names @> ARRAY['assignee_employee_id'] AND NOT v_names @> ARRAY['employee_id'] THEN
        RAISE NOTICE 'PASS  TK1 fn_task_status publishes assignee_employee_id, as authz renders';
    ELSE
        RAISE EXCEPTION
            'FAIL  TK1 subject column is wrong: %. packages/authz renders '
            '<alias>.assignee_employee_id for the task resource, so a scoped caller would get '
            '"column does not exist" while HR (ALLOW_ALL -> literal true) still worked',
            v_names;
    END IF;
END $$;

-- TK2: and the project function is keyed on the PROJECT, so membership filters it.
DO $$
DECLARE v_names TEXT[];
BEGIN
    SELECT p.proargnames INTO v_names
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_project_task_status';

    IF v_names @> ARRAY['project_id'] THEN
        RAISE NOTICE 'PASS  TK2 fn_project_task_status is keyed on project_id';
    ELSE
        RAISE EXCEPTION 'FAIL  TK2 fn_project_task_status must publish project_id, got %', v_names;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- TK3..TK7 share one fixture: a project, a member, and five tasks chosen so that every counter
-- is exercised AND the two that must stay at zero have a reason to be wrong.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_proj UUID; v_emp UUID; v_desig UUID; v_dept UUID;
    v_join DATE := DATE '2024-02-01';
    r RECORD; rp RECORD;
BEGIN
    SET LOCAL hrm.allow_backdated_period = 'on';

    SELECT id INTO v_desig FROM designation WHERE retired_on IS NULL LIMIT 1;
    INSERT INTO department (code, name) VALUES ('VTK', 'Task Verify')
    RETURNING id INTO v_dept;
    INSERT INTO department_period (department_id, parent_department_id, valid_from)
    VALUES (v_dept, NULL, v_join);

    INSERT INTO employee (employee_number, full_name, work_email, joined_on, status)
    VALUES ('VERIFY-TK', 'Task Fixture', 'verify-tk@example.invalid', v_join, 'pre_boarding')
    RETURNING id INTO v_emp;
    INSERT INTO employment_event (employee_id, event_type, from_status, to_status, effective_on)
    VALUES (v_emp, 'joined', 'pre_boarding', 'active', v_join);
    INSERT INTO employment (employee_id, department_id, designation_id, valid_from)
    VALUES (v_emp, v_dept, v_desig, v_join);

    INSERT INTO project (code, name, client_name, started_on)
    VALUES ('VTKP', 'Task Verify Project', 'Internal', v_join)
    RETURNING id INTO v_proj;
    -- The assignee must be a project member: `fn_task_assignee_is_member` enforces it, and it
    -- refused the demo seed until the task rows were moved below the membership rows.
    INSERT INTO project_member (project_id, employee_id, role, valid_from, reason)
    VALUES (v_proj, v_emp, 'contributor', v_join, 'task verify fixture');

    INSERT INTO task (project_id, code, title, status, assignee_employee_id, due_on, closed_at)
    VALUES
        -- overdue: open work, due date passed
        (v_proj, 'VTK-1', 'Overdue',      'in_progress', v_emp, fn_business_date() - 9,  NULL),
        -- due soon: inside the default 7-day window
        (v_proj, 'VTK-2', 'Due soon',     'open',        v_emp, fn_business_date() + 2,  NULL),
        -- no due date: open, unplannable, must not be counted as overdue
        (v_proj, 'VTK-3', 'No date',      'blocked',     v_emp, NULL,                    NULL),
        -- DONE and 20 days past its due date. THE case TK3 exists for.
        (v_proj, 'VTK-4', 'Done late',    'done',        v_emp, fn_business_date() - 20, now()),
        -- cancelled, also past due. Not done, not overdue, not an achievement.
        (v_proj, 'VTK-5', 'Cancelled',    'cancelled',   v_emp, fn_business_date() - 15, now()),
        -- UNASSIGNED and open. Invisible to the per-assignee cut by construction.
        (v_proj, 'VTK-6', 'Unassigned',   'open',        NULL,  fn_business_date() + 1,  NULL);

    SELECT * INTO r FROM fn_task_status() WHERE assignee_employee_id = v_emp;

    -- TK3: a closed task is never overdue.
    IF r.overdue = 1 THEN
        RAISE NOTICE 'PASS  TK3 only the OPEN past-due task is overdue (done and cancelled ones are not)';
    ELSE
        RAISE EXCEPTION
            'FAIL  TK3 overdue = % (want 1). The fixture holds three past-due tasks, but two are '
            'closed - a closed task has stopped consuming time whatever its due date said',
            r.overdue;
    END IF;

    -- TK4: the remaining counters.
    IF r.open_tasks = 1 AND r.in_progress = 1 AND r.blocked = 1
       AND r.done_tasks = 1 AND r.cancelled_tasks = 1
       AND r.due_soon = 1 AND r.no_due_date = 1 THEN
        RAISE NOTICE 'PASS  TK4 status, due_soon and no_due_date counters are all correct';
    ELSE
        RAISE EXCEPTION
            'FAIL  TK4 open=% in_progress=% blocked=% done=% cancelled=% due_soon=% no_date=% '
            '(want 1 for each)',
            r.open_tasks, r.in_progress, r.blocked, r.done_tasks, r.cancelled_tasks,
            r.due_soon, r.no_due_date;
    END IF;

    -- TK5: THE PHANTOM ROW. A different employee with no tasks must score zero everywhere.
    DECLARE
        v_other UUID;
        v_sum INT;
    BEGIN
        INSERT INTO employee (employee_number, full_name, work_email, joined_on, status)
        VALUES ('VERIFY-TK2', 'No Tasks', 'verify-tk2@example.invalid', v_join, 'pre_boarding')
        RETURNING id INTO v_other;

        SELECT open_tasks + in_progress + blocked + done_tasks + cancelled_tasks
             + overdue + due_soon + no_due_date
          INTO v_sum
          FROM fn_task_status() WHERE assignee_employee_id = v_other;

        IF v_sum = 0 THEN
            RAISE NOTICE 'PASS  TK5 an employee with no tasks scores zero on all eight counters';
        ELSE
            RAISE EXCEPTION
                'FAIL  TK5 an employee with NO tasks has counters summing to % - COUNT(*) over '
                'the LEFT JOIN is counting the all-NULL row, the 0021 phantom again', v_sum;
        END IF;
    END;

    -- TK6: the project cut sees all six tasks and both closed ones.
    SELECT * INTO rp FROM fn_project_task_status() WHERE project_id = v_proj;
    IF rp.total_tasks = 6 AND rp.done_tasks = 1 AND rp.cancelled_tasks = 1
       AND rp.overdue = 1 AND rp.assignees = 1 THEN
        RAISE NOTICE 'PASS  TK6 project cut: total=%, overdue=%, distinct assignees=%',
            rp.total_tasks, rp.overdue, rp.assignees;
    ELSE
        RAISE EXCEPTION
            'FAIL  TK6 project cut total=% done=% cancelled=% overdue=% assignees=% '
            '(want 6/1/1/1/1)',
            rp.total_tasks, rp.done_tasks, rp.cancelled_tasks, rp.overdue, rp.assignees;
    END IF;

    -- TK7: THE REASON THERE ARE TWO FUNCTIONS. The unassigned task appears in exactly one cut.
    IF rp.unassigned = 1 THEN
        RAISE NOTICE 'PASS  TK7 the unassigned task is counted by the PROJECT cut';
    ELSE
        RAISE EXCEPTION
            'FAIL  TK7 project cut reports unassigned = % (want 1). An unassigned task has no '
            'subject, so the reporting graph cannot report it; if the project cut misses it too, '
            'the task is invisible to everybody', rp.unassigned;
    END IF;

    -- ... and it is NOT attributed to anybody in the assignee cut. Six tasks exist; the assignee
    -- cut must account for five.
    DECLARE v_attributed INT;
    BEGIN
        SELECT coalesce(sum(open_tasks + in_progress + blocked + done_tasks + cancelled_tasks), 0)
          INTO v_attributed
          FROM fn_task_status()
         WHERE assignee_employee_id IN (SELECT id FROM employee WHERE employee_number LIKE 'VERIFY-TK%');

        IF v_attributed = 5 THEN
            RAISE NOTICE 'PASS  TK8 the assignee cut accounts for 5 of 6 tasks - the unassigned one is absent';
        ELSE
            RAISE EXCEPTION
                'FAIL  TK8 assignee cut attributes % tasks (want 5 of 6). If it reports 6, an '
                'unassigned task is being credited to somebody', v_attributed;
        END IF;
    END;
END $$;

-- TK9: NEITHER FUNCTION WRITES. A task report that "tidies up" what it finds - closing a stale
-- task, reassigning an orphan - would be making management decisions inside a SELECT.
DO $$
DECLARE v_bad TEXT;
BEGIN
    SELECT string_agg(p.proname || ' is ' || p.provolatile::text, ', ') INTO v_bad
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('fn_task_status', 'fn_project_task_status')
       AND p.provolatile = 'v';

    IF v_bad IS NULL THEN
        RAISE NOTICE 'PASS  TK9 both task functions are STABLE, so neither can write';
    ELSE
        RAISE EXCEPTION 'FAIL  TK9 a task reporting function is VOLATILE: %', v_bad;
    END IF;
END $$;

-- TK10: search_path is pinned on both (precedent 0013).
DO $$
DECLARE v_bad TEXT;
BEGIN
    SELECT string_agg(p.proname, ', ') INTO v_bad
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('fn_task_status', 'fn_project_task_status')
       AND NOT EXISTS (
            SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS c
             WHERE c LIKE 'search_path=%');

    IF v_bad IS NULL THEN
        RAISE NOTICE 'PASS  TK10 both task functions pin search_path';
    ELSE
        RAISE EXCEPTION 'FAIL  TK10 search_path not pinned on: %', v_bad;
    END IF;
END $$;
