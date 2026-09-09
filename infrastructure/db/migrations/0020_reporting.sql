-- =============================================================================
-- 0020  HR reporting
-- =============================================================================
--
-- Module 14. Reporting is where an authorization model gets tested hardest, and where this one
-- could most easily have been undone, so the shape of these functions is deliberate.
--
-- EVERY FUNCTION HERE RETURNS PER-EMPLOYEE ROWS. None of them aggregates across people.
--
-- That is not an oversight - it is the whole design. `ai/context/rbac-rules.md` warns that a
-- list query filtered in application code "still leaks via counts, pagination totals and
-- timing". A report is nothing BUT counts and totals, so it is the worst possible place to get
-- that wrong: a manager who cannot open E3's record but receives a headcount that includes them
-- has still learned something about E3.
--
-- So the contract is: these functions produce rows, the caller composes
-- `AuthorizationService.scope()` into the same SQL statement, and the SUM happens after the
-- filter, inside the database. The aggregate a user sees is therefore computed only over rows
-- they were allowed to see, and there is no intermediate total that ever existed.
--
-- The cost is that a function may compute rows the caller then discards. At this organisation's
-- size that is irrelevant, and it buys a property that is otherwise very easy to lose.
--
-- AS-OF CORRECTNESS. Every report that touches department, designation, manager or project
-- membership resolves it AS OF the date being reported, never as of today. A report that mixed
-- today's org chart with last quarter's effort would be confidently wrong, and would look right.
-- That is the entire reason the preceding six migrations made those tables effective-dated.
--
-- RECONCILIATION IS REPORTED, NEVER CORRECTED (ADR-0015). `fn_attendance_vs_effort` returns the
-- variance and nothing else. There is no function here that adjusts attendance to match effort
-- or the reverse, and there must never be: an employee who attended eight hours and logged five
-- has a reporting discrepancy, not a data error.
--
-- WFH HAS TWO SOURCES AND THEY CAN DISAGREE. It is a leave TYPE (`reduces_attendance = false`)
-- and also an `attendance_day.status`. `fn_wfh_usage` returns both counts side by side rather
-- than picking one, because a day approved as WFH with no corresponding attendance record is a
-- real operational question and averaging it away would hide it.
--
-- Class C. Verified by testing/db/0020_reporting.verify.sql.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Headcount movement - joiners and leavers, from the lifecycle log
-- -----------------------------------------------------------------------------
--
-- Read from `employment_event` (0014) rather than from `employee.joined_on` / `exited_on`,
-- because those columns are a CACHE of the log (0015) and a future-dated exit deliberately does
-- not appear in them yet. A movement report asks "what happened in this window", which is a
-- question about the log.

CREATE OR REPLACE FUNCTION fn_headcount_movement(p_from date, p_to date)
RETURNS TABLE (
    employee_id   uuid,
    event_type    text,
    effective_on  date,
    exit_type     text,
    department_id uuid,
    designation_id uuid
)
LANGUAGE sql STABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
    SELECT ee.employee_id,
           ee.event_type,
           ee.effective_on,
           ee.exit_type,
           -- The assignment in force ON THE DAY OF THE EVENT, not today's. A leaver's department
           -- is the one they left from.
           em.department_id,
           em.designation_id
      FROM public.employment_event ee
      LEFT JOIN public.employment em
             ON em.employee_id = ee.employee_id
            AND em.valid_period @> ee.effective_on
     WHERE ee.effective_on >= p_from
       AND ee.effective_on <= p_to
       AND ee.event_type IN ('joined', 'confirmed', 'promoted', 'transferred',
                             'resigned', 'termination_initiated', 'exited');
$$;

COMMENT ON FUNCTION fn_headcount_movement(date, date) IS
    'Joiners, leavers and in-service events in a window, from the append-only lifecycle log. '
    'Department and designation are resolved as of the EVENT date - a leaver belongs to the '
    'department they left from, not to wherever that person''s successor sits now.';

-- -----------------------------------------------------------------------------
-- 2. Leave liability - what the company owes, per employee per type
-- -----------------------------------------------------------------------------
--
-- Reads `leave_account`, which is itself derived from the append-only ledger (0007). NUMERIC
-- throughout: Rule 4 forbids floating point for leave balances, and a liability figure that
-- drifted by rounding is a figure finance cannot reconcile.

CREATE OR REPLACE FUNCTION fn_leave_liability(p_leave_year integer)
RETURNS TABLE (
    employee_id   uuid,
    leave_type_id uuid,
    leave_code    text,
    is_paid       boolean,
    accrued       numeric,
    taken         numeric,
    available     numeric
)
LANGUAGE sql STABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
    SELECT la.employee_id,
           lt.id,
           lt.code,
           lt.is_paid,
           la.accrued,
           la.taken,
           la.available
      FROM public.leave_account la
      JOIN public.leave_type lt ON lt.id = la.leave_type_id
     WHERE la.leave_year = p_leave_year
       AND lt.archived_at IS NULL;
$$;

COMMENT ON FUNCTION fn_leave_liability(integer) IS
    'Outstanding leave per employee per type. `is_paid` is returned so a caller can separate '
    'what is a financial liability (paid types) from what is merely an entitlement - summing '
    'them together would overstate the obligation by including LWP.';

-- -----------------------------------------------------------------------------
-- 3. Attendance summary, with the expected working days alongside
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_attendance_summary(p_from date, p_to date)
RETURNS TABLE (
    employee_id     uuid,
    present_days    integer,
    late_days       integer,
    wfh_days        integer,
    absent_days     integer,
    leave_days      integer,
    week_off_days   integer,
    holiday_days    integer,
    worked_minutes  bigint,
    expected_days   integer
)
LANGUAGE sql STABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
    SELECT ad.employee_id,
           count(*) FILTER (WHERE ad.status IN ('present', 'late'))::integer,
           count(*) FILTER (WHERE ad.status = 'late')::integer,
           count(*) FILTER (WHERE ad.status = 'wfh')::integer,
           count(*) FILTER (WHERE ad.status = 'absent')::integer,
           count(*) FILTER (WHERE ad.status = 'leave')::integer,
           count(*) FILTER (WHERE ad.status = 'week_off')::integer,
           count(*) FILTER (WHERE ad.status = 'holiday')::integer,
           COALESCE(sum(ad.worked_minutes), 0)::bigint,
           -- The same working-day count the leave engine uses, so "present out of expected"
           -- cannot disagree with what a leave application was measured against.
           public.fn_working_days(p_from, p_to)::integer
      FROM public.attendance_day ad
     WHERE ad.business_date >= p_from AND ad.business_date <= p_to
     GROUP BY ad.employee_id;
$$;

-- -----------------------------------------------------------------------------
-- 4. WFH usage - both sources, side by side
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_wfh_usage(p_from date, p_to date)
RETURNS TABLE (
    employee_id       uuid,
    attendance_days   integer,
    approved_days     numeric,
    disagreement      integer
)
LANGUAGE sql STABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
    WITH att AS (
        SELECT ad.employee_id, count(*)::integer AS days
          FROM public.attendance_day ad
         WHERE ad.status = 'wfh'
           AND ad.business_date >= p_from AND ad.business_date <= p_to
         GROUP BY ad.employee_id
    ), req AS (
        SELECT r.employee_id, sum(r.working_days) AS days
          FROM public.leave_request r
          JOIN public.leave_type lt ON lt.id = r.leave_type_id
         WHERE lt.code = 'WFH' AND r.status = 'approved'
           AND r.from_date <= p_to AND r.to_date >= p_from
         GROUP BY r.employee_id
    )
    SELECT COALESCE(att.employee_id, req.employee_id),
           COALESCE(att.days, 0),
           COALESCE(req.days, 0),
           -- REPORTED, not reconciled away. An approved WFH day with no attendance record, or
           -- an attendance record with no approval, is an operational question for HR.
           (COALESCE(att.days, 0) - COALESCE(req.days, 0)::integer)
      FROM att FULL OUTER JOIN req ON req.employee_id = att.employee_id;
$$;

COMMENT ON FUNCTION fn_wfh_usage(date, date) IS
    'WFH from BOTH sources: attendance_day.status and approved WFH leave requests. They can '
    'disagree, and `disagreement` reports by how much rather than choosing a winner - the same '
    'principle as ADR-0015''s attendance-versus-effort variance.';

-- -----------------------------------------------------------------------------
-- 5. Attendance versus logged effort - the ADR-0015 reconciliation, parameterised
-- -----------------------------------------------------------------------------
--
-- `v_work_attendance_variance` already exists and stays. This is the same question over a date
-- window, because a report needs a period and a view cannot take one.

CREATE OR REPLACE FUNCTION fn_attendance_vs_effort(p_from date, p_to date)
RETURNS TABLE (
    employee_id        uuid,
    business_date      date,
    attendance_status  text,
    attended_minutes   integer,
    logged_minutes     bigint,
    variance_minutes   bigint,
    note               text
)
LANGUAGE sql STABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
    SELECT ad.employee_id,
           ad.business_date,
           ad.status,
           COALESCE(ad.worked_minutes, 0),
           COALESCE(e.minutes, 0),
           COALESCE(ad.worked_minutes, 0) - COALESCE(e.minutes, 0),
           CASE
               WHEN ad.status IN ('present', 'late', 'wfh') AND COALESCE(e.minutes, 0) = 0
                   THEN 'attended but nothing logged'
               WHEN ad.status NOT IN ('present', 'late', 'wfh') AND COALESCE(e.minutes, 0) > 0
                   THEN 'effort logged on a non-working day'
               WHEN COALESCE(e.minutes, 0) > COALESCE(ad.worked_minutes, 0) + 120
                   THEN 'logged well beyond attended time'
               WHEN ad.status IN ('present', 'late', 'wfh')
                    AND COALESCE(e.minutes, 0) < COALESCE(ad.worked_minutes, 0) - 120
                   THEN 'logged well under attended time'
           END
      FROM public.attendance_day ad
      LEFT JOIN (
            SELECT wl.employee_id, wl.work_date, sum(wle.minutes) AS minutes
              FROM public.work_log wl
              JOIN public.work_log_entry wle ON wle.work_log_id = wl.id
             GROUP BY wl.employee_id, wl.work_date
      ) e ON e.employee_id = ad.employee_id AND e.work_date = ad.business_date
     WHERE ad.business_date >= p_from AND ad.business_date <= p_to;
$$;

COMMENT ON FUNCTION fn_attendance_vs_effort(date, date) IS
    'ADR-0015. Returns the variance and a plain-language note. It NEVER adjusts either side, and '
    'no function that does so may be added: an employee who attended eight hours and logged five '
    'has a reporting discrepancy, not a data error. The 120-minute band exists so ordinary '
    'imprecision does not drown the real outliers.';

-- -----------------------------------------------------------------------------
-- 6. Timesheet compliance - who has not submitted
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_timesheet_compliance(p_from date, p_to date)
RETURNS TABLE (
    employee_id    uuid,
    period_start   date,
    period_end     date,
    status         text,
    logged_minutes bigint,
    days_waiting   integer
)
LANGUAGE sql STABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
    SELECT tp.employee_id,
           tp.period_start,
           tp.period_end,
           tp.status,
           COALESCE(sum(wle.minutes), 0)::bigint,
           -- How long it has sat unresolved. Counted from the period end for a draft, and from
           -- submission for anything waiting on a manager, because those are different waits.
           GREATEST(0, (public.fn_business_date()
               - CASE WHEN tp.status IN ('submitted', 'under_review')
                      THEN COALESCE(tp.submitted_at::date, tp.period_end)
                      ELSE tp.period_end END))::integer
      FROM public.timesheet_period tp
      LEFT JOIN public.work_log wl ON wl.timesheet_period_id = tp.id
      LEFT JOIN public.work_log_entry wle ON wle.work_log_id = wl.id
     WHERE tp.period_start >= p_from AND tp.period_start <= p_to
     GROUP BY tp.employee_id, tp.period_start, tp.period_end, tp.status, tp.submitted_at;
$$;

-- -----------------------------------------------------------------------------
-- 7. Document compliance - missing and expiring
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_document_compliance(p_expiring_within_days integer DEFAULT 60)
RETURNS TABLE (
    employee_id     uuid,
    filed_types     integer,
    pending_scan    integer,
    expiring_soon   integer,
    expired         integer
)
LANGUAGE sql STABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
    SELECT e.id,
           count(DISTINCT d.document_type_code) FILTER (
                WHERE d.withdrawn_at IS NULL AND d.current_version_id IS NOT NULL)::integer,
           count(*) FILTER (
                WHERE d.withdrawn_at IS NULL AND d.current_version_id IS NULL)::integer,
           count(*) FILTER (
                WHERE d.withdrawn_at IS NULL AND d.expires_on IS NOT NULL
                  AND d.expires_on >= public.fn_business_date()
                  AND d.expires_on <= public.fn_business_date() + p_expiring_within_days)::integer,
           count(*) FILTER (
                WHERE d.withdrawn_at IS NULL AND d.expires_on IS NOT NULL
                  AND d.expires_on < public.fn_business_date())::integer
      FROM public.employee e
      LEFT JOIN public.employee_document d ON d.employee_id = e.id
     GROUP BY e.id;
$$;

COMMENT ON FUNCTION fn_document_compliance(integer) IS
    'Per-employee document posture. Counts only, no titles and no types - a compliance report '
    'that named the document types would tell a reader who holds a MEDICAL certificate, which is '
    'information about health. Which documents exist is a per-employee question answered by the '
    'documents endpoint, under its own field mask.';

-- -----------------------------------------------------------------------------
-- 8. Grants - read only. Reporting never writes.
-- -----------------------------------------------------------------------------
--
-- These are all STABLE functions over existing tables, so `hrm_app` already holds EXECUTE via
-- 0008's blanket grant. Stated explicitly because a reporting layer that acquired a write
-- privilege would be the beginning of a report that "fixes" what it finds.

COMMIT;
