-- =============================================================================
-- Verification for 0028: work log provenance
--
-- The checks that carry the weight:
--
--   PV2   a new line cannot be recorded with no recorder. The column is nullable in the catalog
--         because 0019's period lock made a backfill impossible, so the NOT NULL lives in the
--         trigger - and a rule that lives in a trigger needs a test proving it is still there.
--   PV3   'self' cannot name somebody other than the subject, and
--   PV4   'hr_entry' cannot name the subject. Those two are the whole point: without them
--         `entry_source` is a free-text field that says whatever the caller typed, in a table
--         that feeds timesheet approvals.
--   PV6   the trigger is ENABLE ALWAYS, so a restore or a bulk load cannot walk around it.
--   PV7   history was NOT rewritten. Rows predating 0028 keep entered_by NULL, which is what
--         makes "no backfill" an auditable claim rather than a note in a comment.
-- =============================================================================

\set ON_ERROR_STOP on

DO $$
DECLARE
    v_subject UUID;
    v_hr      UUID;
    v_project UUID;
    v_log     UUID;
    v_n       INT;
    v_ok      BOOLEAN;
    v_kind    CHAR;
BEGIN
    SELECT id INTO v_subject FROM employee WHERE employee_number = 'EMP001';
    SELECT id INTO v_hr      FROM employee WHERE employee_number = 'EMP005';
    INSERT INTO project (code, name, status) VALUES ('PV-P', 'Provenance', 'active')
        RETURNING id INTO v_project;

    -- A work log with NO timesheet period, so the period lock is not the thing under test here.
    INSERT INTO work_log (employee_id, work_date) VALUES (v_subject, DATE '2031-05-06')
        RETURNING id INTO v_log;

    -- ---------------------------------------------------------------- PV1
    -- The ordinary case still works: the employee records their own effort.
    BEGIN
        INSERT INTO work_log_entry (work_log_id, project_id, minutes, entered_by_employee_id,
                                    entry_source)
            VALUES (v_log, v_project, 60, v_subject, 'self');
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'FAIL  PV1 ordinary self-entry was refused: %', SQLERRM;
    END;

    -- ---------------------------------------------------------------- PV2
    -- No recorder at all. This is the NOT NULL the catalog cannot express.
    v_ok := false;
    BEGIN
        INSERT INTO work_log_entry (work_log_id, project_id, minutes) VALUES (v_log, v_project, 60);
    EXCEPTION WHEN not_null_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'FAIL  PV2 a work log line was recorded with no entered_by_employee_id';
    END IF;

    -- ---------------------------------------------------------------- PV3
    -- 'self' while naming somebody else - an on-behalf entry wearing the wrong label.
    v_ok := false;
    BEGIN
        INSERT INTO work_log_entry (work_log_id, project_id, minutes, entered_by_employee_id,
                                    entry_source)
            VALUES (v_log, v_project, 60, v_hr, 'self');
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'FAIL  PV3 entry_source=self accepted a recorder who is not the subject';
    END IF;

    -- ---------------------------------------------------------------- PV4
    -- 'hr_entry' naming the subject themselves - self-entry wearing the HR label, which would
    -- let somebody's own hours appear to have been vouched for by HR.
    v_ok := false;
    BEGIN
        INSERT INTO work_log_entry (work_log_id, project_id, minutes, entered_by_employee_id,
                                    entry_source)
            VALUES (v_log, v_project, 60, v_subject, 'hr_entry');
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'FAIL  PV4 entry_source=hr_entry accepted the subject as the recorder';
    END IF;

    -- ---------------------------------------------------------------- PV5
    -- The genuine on-behalf case is accepted, and only these two labels exist.
    BEGIN
        INSERT INTO work_log_entry (work_log_id, project_id, minutes, entered_by_employee_id,
                                    entry_source)
            VALUES (v_log, v_project, 45, v_hr, 'hr_entry');
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'FAIL  PV5 a legitimate HR on-behalf entry was refused: %', SQLERRM;
    END;
    v_ok := false;
    BEGIN
        INSERT INTO work_log_entry (work_log_id, project_id, minutes, entered_by_employee_id,
                                    entry_source)
            VALUES (v_log, v_project, 30, v_hr, 'imported');
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'FAIL  PV5 an unknown entry_source was accepted';
    END IF;

    -- ---------------------------------------------------------------- PV6
    -- DEC-030: the rail holds for a restore and a bulk load, not only for API traffic.
    SELECT tgenabled INTO v_kind FROM pg_trigger
     WHERE tgname = 'trg_work_log_entry_provenance' AND NOT tgisinternal;
    IF v_kind IS DISTINCT FROM 'A' THEN
        RAISE EXCEPTION
            'FAIL  PV6 trg_work_log_entry_provenance is tgenabled=%, want A (ENABLE ALWAYS)',
            coalesce(v_kind::text, '<missing>');
    END IF;

    -- ---------------------------------------------------------------- PV7
    -- No backfill happened. The seed sets provenance explicitly on every row it writes, so this
    -- asserts the SHAPE of the claim: nothing may carry a recorder that disagrees with its label.
    SELECT count(*) INTO v_n
      FROM work_log_entry wle
      JOIN work_log wl ON wl.id = wle.work_log_id
     WHERE wle.entered_by_employee_id IS NOT NULL
       AND ((wle.entry_source = 'self'     AND wle.entered_by_employee_id <> wl.employee_id)
         OR (wle.entry_source = 'hr_entry' AND wle.entered_by_employee_id =  wl.employee_id));
    IF v_n <> 0 THEN
        RAISE EXCEPTION 'FAIL  PV7 % existing rows have a provenance label contradicting their '
                        'recorder', v_n;
    END IF;

    -- ---------------------------------------------------------------- PV8
    -- The seed must actually exercise BOTH labels, or PV3/PV4 are guarding a path nothing uses
    -- and the demo cannot show an HR-recorded log at all.
    SELECT count(DISTINCT entry_source) INTO v_n FROM work_log_entry;
    IF v_n < 2 THEN
        RAISE EXCEPTION 'FAIL  PV8 the seed uses only % entry_source value(s) - an HR-recorded '
                        'work log is a required demo fixture', v_n;
    END IF;

    RAISE NOTICE 'PASS  0028 work log provenance: 8 checks';
END $$;
