-- =============================================================================
-- 0028  Who entered this effort, and on whose behalf
-- =============================================================================
--
-- WHY. HR is about to be able to create work logs for other people (the `work.log.write_for`
-- action). The moment that exists, "8 hours on CPRT" stops being self-evidently something the
-- employee said about their own day - it may be something HR recorded about it. Those are
-- different claims, and a timesheet the employee never touched should not be indistinguishable
-- from one they submitted.
--
-- `work_log_entry` carried no actor at all: id, work_log_id, project_id, task_id, minutes,
-- description, created_at. The employee is on the parent `work_log`, which answers WHOSE day it
-- is but not WHO FILLED IT IN. Every effort report, variance figure and approval decision reads
-- these rows, so the distinction has to live on the row rather than in an audit table somebody
-- would have to think to consult.
--
-- FOUND BY RUNNING IT: THIS MIGRATION CANNOT BACKFILL. The first version added the columns
-- nullable, ran `UPDATE work_log_entry SET entered_by_employee_id = wl.employee_id`, and then set
-- NOT NULL. It failed on the UPDATE:
--
--     ERROR: the timesheet period for this work log is approved and is locked
--     CONTEXT: PL/pgSQL function public.fn_work_log_period_lock()
--
-- 0019's ENABLE ALWAYS lock refuses any INSERT, UPDATE or DELETE touching an entry inside a
-- submitted, under-review or approved period, and it has NO bypass GUC - unlike
-- `hrm.allow_backdated_period` or `hrm.payslip_event_writer`, which are opt-ins for rails that
-- were designed to have one. That absence is deliberate: ADR-0015/0016 correct history by
-- adjustment, never by editing it in place. **A migration is not an exception to that**, and
-- adding a bypass so this migration could write would have weakened the rail permanently to
-- backfill a column once.
--
-- SO THERE IS NO BACKFILL. `entry_source` is added with a DDL default, which the row triggers
-- never see (ADD COLUMN ... DEFAULT is metadata-only from PG 11, and DML triggers do not fire for
-- DDL), so every historical row reads 'self' without a single UPDATE. `entered_by_employee_id`
-- cannot be a constant - it differs per row - so history keeps NULL there, meaning exactly
-- "recorded before 0028". That is not the ambiguity a nullable provenance column usually is:
-- `entry_source` is NOT NULL for those rows, and 'self' is not a guess, because `POST /work-log`
-- wrote `me.employeeId` and had no parameter capable of naming anybody else. The subject is on
-- the parent log. Going forward the trigger REQUIRES the column on insert, so it is NOT NULL in
-- practice for every row created from now on.
--
-- WHY A TRIGGER AND NOT A CHECK. `entry_source` and `entered_by_employee_id` can disagree -
-- 'self' with somebody else's id, or 'hr_entry' with the employee's own - and either is a lie
-- about provenance in a table that feeds approvals. The rule spans the entry and its parent
-- `work_log`, which a CHECK cannot see. ENABLE ALWAYS, per DEC-030.
--
-- NOT DESTRUCTIVE. Two added columns, one constraint, one trigger, no UPDATE, no DELETE, nothing
-- dropped, no existing value changed.

-- Atomic, like every migration from 0017 onward. Without this the runner autocommits
-- each statement (scripts/migrate.mjs: "The migration file supplies its own
-- BEGIN/COMMIT when it wants one"), so a failure part-way leaves the schema changed
-- and schema_migration with no row - and the next run then fails on "already exists".
BEGIN;

-- A DDL default: applies to every existing row without firing fn_work_log_period_lock().
ALTER TABLE work_log_entry ADD COLUMN entry_source TEXT NOT NULL DEFAULT 'self';

-- No default possible - the value differs per row. NULL means "predates 0028"; see the header.
ALTER TABLE work_log_entry ADD COLUMN entered_by_employee_id UUID REFERENCES employee(id);

ALTER TABLE work_log_entry
    ADD CONSTRAINT ck_work_log_entry_source CHECK (entry_source IN ('self', 'hr_entry'));

CREATE INDEX ix_work_log_entry_entered_by ON work_log_entry (entered_by_employee_id);

COMMENT ON COLUMN work_log_entry.entered_by_employee_id IS
    'The employee who actually recorded this line. Equal to the parent work_log.employee_id for '
    'self-entry; the HR administrator for an on-behalf entry. NULL only on rows predating 0028, '
    'which are all self-entered by construction. Required on insert by '
    'trg_work_log_entry_provenance - it is not a CHECK because 0019''s period lock made a '
    'backfill impossible, so the column cannot be declared NOT NULL.';

COMMENT ON COLUMN work_log_entry.entry_source IS
    'self = the employee recorded their own effort. hr_entry = recorded for them by HR through '
    'work.log.write_for. Not derivable from entered_by alone once HR can also log their own time.';

-- ---------------------------------------------------------------- coherence

CREATE OR REPLACE FUNCTION fn_work_log_entry_provenance() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_subject UUID;
BEGIN
    -- Required on insert. This is where NOT NULL would have lived if a backfill were possible.
    IF TG_OP = 'INSERT' AND NEW.entered_by_employee_id IS NULL THEN
        RAISE EXCEPTION
            'entered_by_employee_id is required - every new work log line records who entered it'
            USING ERRCODE = 'not_null_violation';
    END IF;

    -- Historical rows carry NULL and are not re-litigated by an unrelated UPDATE.
    IF NEW.entered_by_employee_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT employee_id INTO v_subject FROM work_log WHERE id = NEW.work_log_id;

    IF NEW.entry_source = 'self' AND NEW.entered_by_employee_id <> v_subject THEN
        RAISE EXCEPTION
            'entry_source=self but the line was recorded by % for % - an on-behalf entry is '
            'hr_entry', NEW.entered_by_employee_id, v_subject
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.entry_source = 'hr_entry' AND NEW.entered_by_employee_id = v_subject THEN
        RAISE EXCEPTION
            'entry_source=hr_entry but the recorder IS the subject (%) - that is self-entry',
            v_subject
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END $$;

COMMENT ON FUNCTION fn_work_log_entry_provenance() IS
    'Keeps entry_source and entered_by_employee_id from disagreeing, and requires the recorder on '
    'insert. The rule spans work_log_entry and its parent work_log, which is why it is not a '
    'CHECK constraint.';

CREATE TRIGGER trg_work_log_entry_provenance
    BEFORE INSERT OR UPDATE OF entered_by_employee_id, entry_source, work_log_id
    ON work_log_entry
    FOR EACH ROW EXECUTE FUNCTION fn_work_log_entry_provenance();

-- DEC-030: the rail must survive a restore or a bulk load, not only ordinary traffic.
ALTER TABLE work_log_entry ENABLE ALWAYS TRIGGER trg_work_log_entry_provenance;

COMMIT;
