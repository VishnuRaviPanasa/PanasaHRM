-- =============================================================================
-- 0015  Lifecycle read model: future-dated events must not take effect early
-- =============================================================================
--
-- THE DEFECT, found by running 0014 rather than reading it.
--
-- `fn_employment_event_apply` materialised `employee.status` from every inserted event
-- UNCONDITIONALLY, with no regard for whether the event had actually taken effect yet. So:
--
--   * A pre-boarding hire recorded in advance - a joining event effective next month - was
--     marked `active` the moment HR saved it.
--   * A resignation recorded with a future last working day marked the employee `exited`
--     immediately, weeks before they left.
--
-- The second is the damaging one. `exited` gates attendance, leave accrual and payroll, so
-- recording a scheduled exit would have stopped paying somebody who was still working. This is
-- the same failure `ai/context/temporal-data-rules.md` Rule 2 warns about for `valid_to IS NULL`
-- - treating a future-dated record as the present - reappearing on the lifecycle log.
--
-- THE FIX, and why it is a rewrite rather than a guard.
--
-- The original applied a CASE per column to patch the read model incrementally, which meant the
-- cache could only ever be as correct as the last event that touched it. It is replaced by
-- `fn_refresh_employment_status`, which DERIVES every cached column from the log as of the
-- business date. That is:
--
--   * correct for future events by construction, not by a condition somebody must remember;
--   * self-healing - a wrong cached value is repaired by the next refresh rather than persisting;
--   * the single definition of what the columns mean, instead of one per column per event type.
--
-- `employee.status`, `confirmed_on`, `resigned_on`, `last_working_day`, `exited_on`, `exit_type`
-- and `exit_reason` are therefore now strictly a CACHE. The append-only log is the truth, and
-- `fn_employment_status_asof` remains the only correct way to ask about any date but today.
--
-- A future event still has to take effect when its date arrives, and nothing runs at midnight to
-- do that. `fn_refresh_due_employment_status()` is that catch-up, for a daily job. Until the
-- scheduler exists this is a KNOWN GAP, recorded rather than hidden: a future-dated joining or
-- exit will not appear in the cached column until something calls it. Reads that must be right
-- regardless should use `fn_employment_status_asof(employee, fn_business_date())`, which needs
-- no job at all.
--
-- `employee.status` DEFAULT changes from 'active' to 'pre_boarding'. An employee row created
-- before its joining event should not claim to be active; with the trigger fixed, the default
-- was the remaining way to get that wrong.
--
-- Class C. Verified by testing/db/0015_lifecycle_future_dating.verify.sql.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Derive the cached columns from the log, as of the business date
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_refresh_employment_status(p_employee uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
DECLARE
    v_today  date := public.fn_business_date();
    v_status text;
    v_conf   date;
    v_notice record;
    v_exit   record;
BEGIN
    v_status := public.fn_employment_status_asof(p_employee, v_today);

    -- The most recent confirmation that has actually taken effect.
    SELECT max(ee.effective_on) INTO v_conf
      FROM public.employment_event ee
     WHERE ee.employee_id = p_employee
       AND ee.event_type  = 'confirmed'
       AND ee.effective_on <= v_today;

    -- The notice currently in force. A later withdrawal cancels an earlier resignation, so the
    -- governing row is simply the latest of the three - and if that is the withdrawal, there is
    -- no notice.
    SELECT ee.event_type, ee.effective_on, ee.last_working_day
      INTO v_notice
      FROM public.employment_event ee
     WHERE ee.employee_id = p_employee
       AND ee.event_type IN ('resigned', 'termination_initiated', 'resignation_withdrawn')
       AND ee.effective_on <= v_today
     ORDER BY ee.effective_on DESC, ee.recorded_at DESC
     LIMIT 1;

    -- The exit, only once it has taken effect.
    SELECT ee.effective_on, ee.exit_type, ee.last_working_day, ee.reason
      INTO v_exit
      FROM public.employment_event ee
     WHERE ee.employee_id = p_employee
       AND ee.event_type  = 'exited'
       AND ee.effective_on <= v_today
     ORDER BY ee.effective_on DESC, ee.recorded_at DESC
     LIMIT 1;

    UPDATE public.employee e
       SET status = v_status,

           confirmed_on = v_conf,

           resigned_on = CASE
                             WHEN v_notice.event_type IN ('resigned', 'termination_initiated')
                                 THEN v_notice.effective_on
                         END,

           last_working_day = COALESCE(
                                  v_exit.last_working_day,
                                  CASE
                                      WHEN v_notice.event_type IN ('resigned','termination_initiated')
                                          THEN v_notice.last_working_day
                                  END),

           exited_on   = v_exit.effective_on,
           exit_type   = v_exit.exit_type,
           exit_reason = v_exit.reason
     WHERE e.id = p_employee;
END;
$$;

COMMENT ON FUNCTION fn_refresh_employment_status(uuid) IS
    'Recomputes the cached lifecycle columns on employee from the append-only log, as of the '
    'business date. Future-dated events are excluded by construction. Idempotent and '
    'self-healing: calling it repairs a stale or wrong cached value.';

-- -----------------------------------------------------------------------------
-- 2. The trigger now delegates
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_employment_event_apply()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
BEGIN
    PERFORM public.fn_refresh_employment_status(NEW.employee_id);
    RETURN NULL;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. Catch-up for events whose date has arrived
-- -----------------------------------------------------------------------------
--
-- Nothing runs at midnight yet. Until a scheduled job calls this, a future-dated joining or
-- exit stays invisible in the cached columns - stated in the header as a known gap rather than
-- left for somebody to discover. `fn_employment_status_asof` is unaffected and always correct.
--
CREATE OR REPLACE FUNCTION fn_refresh_due_employment_status()
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
DECLARE
    v_today date := public.fn_business_date();
    v_n     integer := 0;
    r       record;
BEGIN
    FOR r IN
        SELECT e.id
          FROM public.employee e
         -- Status has diverged from the log ...
         WHERE e.status <> public.fn_employment_status_asof(e.id, v_today)
         -- ... or an event became effective today, which can change a date column without
         -- changing status at all (a confirmation, for instance).
            OR EXISTS (SELECT 1 FROM public.employment_event ee
                        WHERE ee.employee_id = e.id AND ee.effective_on = v_today)
    LOOP
        PERFORM public.fn_refresh_employment_status(r.id);
        v_n := v_n + 1;
    END LOOP;
    RETURN v_n;
END;
$$;

COMMENT ON FUNCTION fn_refresh_due_employment_status() IS
    'Daily catch-up: materialises lifecycle events whose effective date has arrived. Returns the '
    'number of employees refreshed. Safe to run repeatedly.';

-- -----------------------------------------------------------------------------
-- 4. A new employee row must not claim to be active before joining
-- -----------------------------------------------------------------------------

ALTER TABLE employee ALTER COLUMN status SET DEFAULT 'pre_boarding';

COMMENT ON COLUMN employee.status IS
    'CACHE of the lifecycle log as of the business date, maintained by '
    'fn_refresh_employment_status. Never authoritative for any other date - use '
    'fn_employment_status_asof. Defaults to pre_boarding: a row created before its joining '
    'event has not joined.';

-- -----------------------------------------------------------------------------
-- 5. Repair anything the old trigger already got wrong
-- -----------------------------------------------------------------------------

SELECT fn_refresh_employment_status(e.id) FROM employee e;

COMMIT;
