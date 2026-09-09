-- =============================================================================
-- 0010  Attendance and Daily Work Management - the Demo MVP
-- =============================================================================
--
-- TRACK A. The architectural point this demo must make visible is ADR-0015:
--
--     ATTENDANCE AND WORK EFFORT ARE SEPARATE DOMAINS. Neither derives from the other.
--
--   Attendance answers "was this person present?" - statutory, payroll days.
--   The work log answers "what did they do?" - project effort, accomplishment evidence.
--
--   They reconcile by REPORT, never by derivation. That is why `attendance_day` carries no
--   project and `work_log_entry` carries no attendance status, and why the demo shows a day
--   where the two legitimately disagree.
--
-- ALSO FOLLOWED, because it is the cheap half of ADR-0016:
--   * Effort is `minutes INTEGER`. Never decimal hours, never float. Display converts.
--   * No rate or cost column on a work log entry. Cost is a report-time concern behind an
--     authorization check that does not exist yet - so the demo simply does not show cost.
--
-- DEMO-GRADE, FLAGGED FOR TRACK B:
--   * `attendance_day` is entered/seeded directly. ADR-0011's raw-punch ingestion, nightly
--     derivation job, `input_fingerprint` and monthly partitioning are all Track B. The
--     partition-key finding (business_date, not timestamptz) is recorded in ADR-0011.
--   * The timesheet FSM is a status column with a CHECK, not ADR-0007's table-driven engine.
--     **This is a real deviation.** ADR-0007's whole claim is that a new approval flow is
--     configuration, not code - and a status column is code. TRACK B: replace with the FSM.
--     Recorded so nobody mistakes the demo for the architecture.
--   * No project-membership authorization graph (ADR-0005's second graph). The demo checks
--     "is this employee the manager" and nothing more. TRACK B.
--
-- Change class: C (schema, attendance/work arithmetic).
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Attendance: "was this person present?"
-- ---------------------------------------------------------------------------
CREATE TABLE attendance_day (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id     UUID NOT NULL REFERENCES employee(id),
    business_date   DATE NOT NULL,                  -- Rule 5. Also ADR-0011's partition key.

    status          TEXT NOT NULL,
    first_in_at     TIMESTAMPTZ,
    last_out_at     TIMESTAMPTZ,
    worked_minutes  INTEGER NOT NULL DEFAULT 0,     -- integer, never float

    -- The only value payroll may ever consume (ADR-0015). numeric, never float (Rule 4 by proxy).
    payable_day_fraction NUMERIC(3,2) NOT NULL DEFAULT 0,

    -- Snapshot of the policy version the verdict was computed under, so it stays explainable.
    attendance_policy_id UUID REFERENCES attendance_policy(id),

    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_attendance_day UNIQUE (employee_id, business_date),
    CONSTRAINT ck_attendance_status CHECK (status IN
        ('present', 'late', 'half_day', 'absent', 'wfh', 'leave', 'holiday', 'week_off')),
    CONSTRAINT ck_attendance_minutes CHECK (worked_minutes BETWEEN 0 AND 1440),
    CONSTRAINT ck_attendance_fraction CHECK (payable_day_fraction BETWEEN 0 AND 1)
);

CREATE INDEX ix_attendance_employee_month
    ON attendance_day (employee_id, business_date DESC);
CREATE INDEX ix_attendance_date ON attendance_day (business_date);

COMMENT ON COLUMN attendance_day.payable_day_fraction IS
    'The ONLY value payroll consumes (ADR-0015). Never derived from work-log minutes.';

-- ---------------------------------------------------------------------------
-- Work management: "what did they do?"
-- ---------------------------------------------------------------------------
CREATE TABLE project (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code         TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    client_name  TEXT,
    status       TEXT NOT NULL DEFAULT 'active',
    manager_id   UUID REFERENCES employee(id),
    started_on   DATE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_project_status CHECK (status IN ('active', 'on_hold', 'closed'))
);

CREATE TABLE project_member (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id   UUID NOT NULL REFERENCES project(id),
    employee_id  UUID NOT NULL REFERENCES employee(id),
    role         TEXT NOT NULL DEFAULT 'contributor',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_project_member UNIQUE (project_id, employee_id),
    CONSTRAINT ck_project_member_role
        CHECK (role IN ('contributor', 'lead', 'project_manager'))
);

COMMENT ON TABLE project_member IS
    'ADR-0005 calls this the SECOND authorization graph - project membership governs work '
    'resources, distinct from the reporting hierarchy. The demo does not resolve it yet; it is '
    'modelled so the demo data is shaped correctly. TRACK B.';

CREATE TABLE task (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id   UUID NOT NULL REFERENCES project(id),
    code         TEXT,
    title        TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_task_status CHECK (status IN ('open', 'in_progress', 'done'))
);

CREATE INDEX ix_task_project ON task (project_id);

-- The approvable, lockable unit is the PERIOD, not the day (ADR-0015 / plan Phase 7).
CREATE TABLE timesheet_period (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id   UUID NOT NULL REFERENCES employee(id),
    period_start  DATE NOT NULL,
    period_end    DATE NOT NULL,

    status        TEXT NOT NULL DEFAULT 'draft',
    submitted_at  TIMESTAMPTZ,
    decided_at    TIMESTAMPTZ,
    decided_by    UUID REFERENCES employee(id),
    return_note   TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_timesheet_period UNIQUE (employee_id, period_start),
    CONSTRAINT ck_timesheet_range CHECK (period_end > period_start),
    -- DEMO-GRADE: ADR-0007 requires this to be table-driven workflow data, not an enum.
    CONSTRAINT ck_timesheet_status
        CHECK (status IN ('draft', 'submitted', 'approved', 'returned')),
    CONSTRAINT ck_timesheet_decision_coherent
        CHECK ((status IN ('approved', 'returned')) = (decided_at IS NOT NULL))
);

-- One work log per employee per day.
CREATE TABLE work_log (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id   UUID NOT NULL REFERENCES employee(id),
    work_date     DATE NOT NULL,                    -- Rule 5
    timesheet_period_id UUID REFERENCES timesheet_period(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_work_log UNIQUE (employee_id, work_date)
);

CREATE INDEX ix_work_log_period ON work_log (timesheet_period_id);

CREATE TABLE work_log_entry (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    work_log_id  UUID NOT NULL REFERENCES work_log(id) ON DELETE CASCADE,
    project_id   UUID NOT NULL REFERENCES project(id),
    task_id      UUID REFERENCES task(id),

    -- ADR-0016: INTEGER minutes. Never decimal hours. No rate, no cost column, ever.
    minutes      INTEGER NOT NULL,
    description  TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_work_log_entry_minutes CHECK (minutes > 0 AND minutes <= 1440)
);

CREATE INDEX ix_work_log_entry_log ON work_log_entry (work_log_id);
CREATE INDEX ix_work_log_entry_project ON work_log_entry (project_id);

COMMENT ON COLUMN work_log_entry.minutes IS
    'ADR-0016: integer minutes. Decimal hours reintroduce rounding into something that may feed '
    'billing. Display converts; storage does not.';

-- A submitted or approved period is locked. Demo-grade version of ADR-0011's is_locked: the
-- point is that a locked period cannot be edited, and that it fails at the DATABASE.
CREATE OR REPLACE FUNCTION fn_work_log_period_lock() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_status TEXT; v_log UUID;
BEGIN
    v_log := CASE WHEN TG_OP = 'DELETE' THEN OLD.work_log_id ELSE NEW.work_log_id END;

    SELECT tp.status INTO v_status
      FROM public.work_log wl
      JOIN public.timesheet_period tp ON tp.id = wl.timesheet_period_id
     WHERE wl.id = v_log;

    IF v_status IN ('submitted', 'approved') THEN
        RAISE EXCEPTION
            'the timesheet period for this work log is % and is locked', v_status
            USING ERRCODE = 'restrict_violation',
                  HINT = 'A submitted or approved period is corrected by an adjustment, never by '
                         'editing history in place.';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER tg_work_log_entry_period_lock
    BEFORE INSERT OR UPDATE OR DELETE ON work_log_entry
    FOR EACH ROW EXECUTE FUNCTION fn_work_log_period_lock();

ALTER TABLE work_log_entry ENABLE ALWAYS TRIGGER tg_work_log_entry_period_lock;

-- ---------------------------------------------------------------------------
-- The reconciliation view. ADR-0015: it FLAGS, it never corrects.
-- ---------------------------------------------------------------------------
CREATE VIEW v_work_attendance_variance AS
SELECT
    e.id                                   AS employee_id,
    e.full_name,
    d.business_date,
    d.status                               AS attendance_status,
    d.worked_minutes                       AS attendance_minutes,
    coalesce(sum(wle.minutes), 0)::int     AS logged_minutes,
    CASE
        WHEN d.status IN ('absent', 'leave') AND coalesce(sum(wle.minutes), 0) > 0
            THEN 'logged effort on a non-working day'
        WHEN d.status IN ('present', 'late', 'wfh') AND coalesce(sum(wle.minutes), 0) = 0
            THEN 'present but nothing logged'
        WHEN coalesce(sum(wle.minutes), 0) > d.worked_minutes + 120
            THEN 'logged materially more than attended'
        ELSE NULL
    END                                    AS variance_flag
  FROM employee e
  JOIN attendance_day d ON d.employee_id = e.id
  LEFT JOIN work_log wl ON wl.employee_id = e.id AND wl.work_date = d.business_date
  LEFT JOIN work_log_entry wle ON wle.work_log_id = wl.id
 GROUP BY e.id, e.full_name, d.business_date, d.status, d.worked_minutes;

COMMENT ON VIEW v_work_attendance_variance IS
    'ADR-0015: the variance report FLAGS and never corrects. It writes to neither domain. '
    'TRACK B: it must be permission-gated (it is functionally a per-employee under-reporting '
    'flag, which collides with ADR-0017) and it must resolve BOTH authorization graphs.';

COMMIT;
