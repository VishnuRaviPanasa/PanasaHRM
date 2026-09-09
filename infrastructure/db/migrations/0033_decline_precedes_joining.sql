-- =============================================================================
-- 0033  A declined offer is the one lifecycle event that precedes the joining date
-- =============================================================================
--
-- FOUND BY THE RAIL, WHICH IS WHY IT IS THERE. 0014's guard ends with "Nothing can happen to
-- someone before they joined" and refuses any `employment_event` dated before `employee.joined_on`.
-- That is right for every event it was written for - you cannot be promoted, confirmed or
-- terminated before your first day.
--
-- `offer_declined`, added by 0031, is the exception, and not a marginal one: **declining an offer
-- happens BEFORE the proposed joining date, always.** That is what declining means. The controller
-- dates the event `fn_business_date()`, which for a joiner starting next month is weeks before
-- `joined_on`, so every real decline would have been refused. The verification caught it on the
-- first run with a fixture joining on 2031-06-02 declining on 2031-05-20 - which is exactly the
-- shape of the real case, and would otherwise have shipped and failed the first time somebody
-- turned an offer down.
--
-- THE CARVE-OUT IS ONE EVENT TYPE WIDE, and the rest of the guard is untouched:
--
--   * the event must still start from `pre_boarding` and reach `offer_declined` - the composite
--     foreign key onto `employment_status_transition` decides that, not this function;
--   * events must still be recorded in order relative to each other;
--   * and every OTHER event type still cannot precede the joining date.
--
-- So the loosening is not "back-dating is now allowed for pre-boarding people". It is "the single
-- event whose meaning is *there will be no joining date* is not measured against one".
--
-- 0014 IS NOT EDITED - it is applied and checksum-enforced (DEC-012), and migrations are
-- forward-only (DEC-011). `CREATE OR REPLACE FUNCTION` leaves the existing trigger pointing at the
-- same name, so nothing is re-attached and `tg_employment_event_guard` stays ENABLE ALWAYS.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION fn_employment_event_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
DECLARE
    v_prev_to        text;
    v_prev_effective date;
    v_joined_on      date;
BEGIN
    SELECT ee.to_status, ee.effective_on
      INTO v_prev_to, v_prev_effective
      FROM public.employment_event ee
     WHERE ee.employee_id = NEW.employee_id
     ORDER BY ee.effective_on DESC, ee.recorded_at DESC
     LIMIT 1;

    IF NOT FOUND THEN
        -- An employee's history has to start at the beginning.
        IF NEW.from_status <> 'pre_boarding' THEN
            RAISE EXCEPTION
                USING MESSAGE = format(
                    'the first lifecycle event for an employee must start from pre_boarding, not %L',
                    NEW.from_status),
                      ERRCODE = 'restrict_violation';
        END IF;
    ELSE
        IF NEW.effective_on < v_prev_effective THEN
            RAISE EXCEPTION
                USING MESSAGE = format(
                    'lifecycle events must be recorded in order: %s precedes the previous event on %s',
                    NEW.effective_on, v_prev_effective),
                      ERRCODE = 'restrict_violation';
        END IF;

        IF NEW.from_status <> v_prev_to THEN
            RAISE EXCEPTION
                USING MESSAGE = format(
                    'lifecycle event starts from %L but the employee is currently %L',
                    NEW.from_status, v_prev_to),
                      ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    -- Nothing can happen to someone before they joined - EXCEPT declining the offer, which is the
    -- event that means they never will. See this migration's header.
    IF NEW.event_type <> 'offer_declined' THEN
        SELECT e.joined_on INTO v_joined_on FROM public.employee e WHERE e.id = NEW.employee_id;
        IF NEW.effective_on < v_joined_on THEN
            RAISE EXCEPTION
                USING MESSAGE = format(
                    'lifecycle event effective %s precedes the joining date %s',
                    NEW.effective_on, v_joined_on),
                      ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

COMMIT;
