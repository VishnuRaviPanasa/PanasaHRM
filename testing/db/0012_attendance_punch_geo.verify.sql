-- =============================================================================
-- Verification for 0012 (geolocation punches) and 0013 (pinned resolver search_path)
-- =============================================================================

-- N1: distance maths. A known offset must come back as a known distance.
DO $$
DECLARE v_near INT; v_km INT; v_far INT;
BEGIN
    v_near := fn_distance_m(10.010400, 76.361500, 10.010450, 76.361530);
    -- 0.009 degrees of latitude is almost exactly 1 km anywhere on Earth.
    v_km   := fn_distance_m(10.010400, 76.361500, 10.019400, 76.361500);
    v_far  := fn_distance_m(10.010400, 76.361500, 12.971600, 77.594600);   -- Kochi -> Bengaluru
    IF v_near <= 10 AND v_km BETWEEN 995 AND 1005 AND v_far BETWEEN 340000 AND 370000 THEN
        RAISE NOTICE 'PASS  N1 haversine sane (%m, %m, %m)', v_near, v_km, v_far;
    ELSE
        RAISE EXCEPTION 'FAIL  N1 distances wrong (%, %, %)', v_near, v_km, v_far;
    END IF;
END $$;

-- N2: the geofence verdict. Inside is inside; outside is outside.
DO $$
DECLARE v_in RECORD; v_out RECORD;
BEGIN
    SELECT * INTO v_in  FROM fn_nearest_location(10.010450, 76.361530);
    SELECT * INTO v_out FROM fn_nearest_location(10.019400, 76.361500);
    IF v_in.distance_m <= v_in.radius_m AND v_out.distance_m > v_out.radius_m THEN
        RAISE NOTICE 'PASS  N2 geofence: %m inside %m, and %m outside it',
            v_in.distance_m, v_in.radius_m, v_out.distance_m;
    ELSE
        RAISE EXCEPTION 'FAIL  N2 geofence verdict wrong (in=%m/%m, out=%m/%m)',
            v_in.distance_m, v_in.radius_m, v_out.distance_m, v_out.radius_m;
    END IF;
END $$;

-- N3: the nearest office wins, not the first one.
DO $$
DECLARE v_code TEXT;
BEGIN
    SELECT code INTO v_code FROM fn_nearest_location(9.993050, 76.298050);
    IF v_code = 'KOCHI-ANNEX' THEN RAISE NOTICE 'PASS  N3 nearest office resolves (KOCHI-ANNEX)';
    ELSE RAISE EXCEPTION 'FAIL  N3 wrong office matched: %', v_code; END IF;
END $$;

-- N4: a punch is a FACT. It cannot be edited, deleted or truncated away (ADR-0011).
DO $$
DECLARE v_emp UUID; v_u BOOLEAN := false; v_d BOOLEAN := false; v_t TEXT := 'ALLOWED';
BEGIN
    SELECT id INTO v_emp FROM employee WHERE employee_number = 'EMP001';
    INSERT INTO attendance_punch (employee_id, business_date, direction, location_source)
    VALUES (v_emp, fn_business_date(), 'in', 'manual');

    BEGIN UPDATE attendance_punch SET direction = 'out' WHERE employee_id = v_emp;
    EXCEPTION WHEN restrict_violation THEN v_u := true; END;
    BEGIN DELETE FROM attendance_punch WHERE employee_id = v_emp;
    EXCEPTION WHEN restrict_violation THEN v_d := true; END;
    BEGIN TRUNCATE attendance_punch;
    EXCEPTION WHEN restrict_violation THEN v_t := 'trigger';
              WHEN feature_not_supported THEN v_t := 'foreign key'; END;

    IF v_u AND v_d AND v_t <> 'ALLOWED' THEN
        RAISE NOTICE 'PASS  N4 punches are append-only (truncate blocked by %)', v_t;
    ELSE
        RAISE EXCEPTION 'FAIL  N4 (update=%, delete=%, truncate=%)', v_u, v_d, v_t;
    END IF;
END $$;

-- N5: a punch cannot CLAIM verification without a fix and a matched office.
DO $$
DECLARE v_emp UUID; v_ok BOOLEAN := false;
BEGIN
    SELECT id INTO v_emp FROM employee WHERE employee_number = 'EMP001';
    BEGIN
        INSERT INTO attendance_punch (employee_id, business_date, direction, location_verified)
        VALUES (v_emp, fn_business_date(), 'in', true);       -- no coordinates, no office
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  N5 location_verified requires a fix and a matched office';
    ELSE RAISE EXCEPTION 'FAIL  N5 a punch claimed verification with no location'; END IF;
END $$;

-- N6: coordinates must be on Earth, and accuracy must be plausible.
DO $$
DECLARE v_emp UUID; v_lat BOOLEAN := false; v_acc BOOLEAN := false;
BEGIN
    SELECT id INTO v_emp FROM employee WHERE employee_number = 'EMP001';
    BEGIN
        INSERT INTO attendance_punch (employee_id, business_date, direction, latitude, longitude)
        VALUES (v_emp, fn_business_date(), 'in', 91, 0);
    EXCEPTION WHEN check_violation THEN v_lat := true; END;
    BEGIN
        INSERT INTO attendance_punch (employee_id, business_date, direction, accuracy_m)
        VALUES (v_emp, fn_business_date(), 'in', -5);
    EXCEPTION WHEN check_violation THEN v_acc := true; END;
    IF v_lat AND v_acc THEN RAISE NOTICE 'PASS  N6 impossible coordinates and accuracy rejected';
    ELSE RAISE EXCEPTION 'FAIL  N6 (lat=%, accuracy=%)', v_lat, v_acc; END IF;
END $$;

-- N7: a geofence radius smaller than phone error, or larger than a suburb, is refused.
DO $$
DECLARE v_small BOOLEAN := false; v_huge BOOLEAN := false;
BEGIN
    BEGIN
        INSERT INTO work_location (code, name, latitude, longitude, radius_m)
        VALUES ('T1', 'too tight', 10, 76, 5);
    EXCEPTION WHEN check_violation THEN v_small := true; END;
    BEGIN
        INSERT INTO work_location (code, name, latitude, longitude, radius_m)
        VALUES ('T2', 'too loose', 10, 76, 50000);
    EXCEPTION WHEN check_violation THEN v_huge := true; END;
    IF v_small AND v_huge THEN RAISE NOTICE 'PASS  N7 absurd geofence radii rejected';
    ELSE RAISE EXCEPTION 'FAIL  N7 (5m=%, 50km=%)', v_small, v_huge; END IF;
END $$;

-- N8: attendance_day is DERIVED from punches, and the derivation snapshots the policy version.
DO $$
DECLARE v_emp UUID; v_day attendance_day; v_pol UUID;
BEGIN
    /*
     * OWN FIXTURE, and this check did not have one.
     *
     * It used to borrow EMP003 and clear only `attendance_day`. But punches are APPEND-ONLY, so
     * any punch already recorded for that employee today survives - and `punch:test` signs in as
     * anu.krishnan, who IS EMP003. Run db:verify after punch:test and the derivation spanned
     * both sets of punches: 563 minutes instead of 545, and the check failed on correct code.
     *
     * Worse, the failure aborted this file, silently costing N9..N12 as well - which is exactly
     * the 185-versus-181 discrepancy that looked like a counting artifact earlier in the day.
     *
     * A brand-new employee has no punch history by construction, so the fixture cannot be
     * polluted by whatever ran before. Same lesson as 0014's L13 and 0017's G5.
     */
    INSERT INTO employee (employee_number, full_name, work_email, joined_on, status)
    VALUES ('VERIFY-N8', 'Derivation Fixture', 'verify-n8@example.invalid',
            fn_business_date() - 400, 'pre_boarding')
    RETURNING id INTO v_emp;

    INSERT INTO attendance_punch (employee_id, business_date, direction, punched_at, location_source)
    VALUES (v_emp, fn_business_date(),
            'in',  (fn_business_date() + TIME '09:05') AT TIME ZONE 'Asia/Kolkata', 'manual');
    INSERT INTO attendance_punch (employee_id, business_date, direction, punched_at, location_source)
    VALUES (v_emp, fn_business_date(),
            'out', (fn_business_date() + TIME '18:10') AT TIME ZONE 'Asia/Kolkata', 'manual');

    v_day := fn_derive_attendance_day(v_emp, fn_business_date());
    SELECT id INTO v_pol FROM attendance_policy WHERE valid_period @> fn_business_date();

    IF v_day.worked_minutes BETWEEN 540 AND 550
       AND v_day.status = 'present'
       AND v_day.attendance_policy_id = v_pol THEN
        RAISE NOTICE 'PASS  N8 derived % min, status=%, policy version snapshotted',
            v_day.worked_minutes, v_day.status;
    ELSE
        RAISE EXCEPTION 'FAIL  N8 derivation wrong (min=%, status=%, policy=%)',
            v_day.worked_minutes, v_day.status, v_day.attendance_policy_id;
    END IF;
END $$;

-- N9: a LATE arrival is judged against the grace period in the policy in force that day.
DO $$
DECLARE v_emp UUID; v_day attendance_day; v_grace INT;
BEGIN
    /*
     * OWN FIXTURE - and this is the SECOND check in this file to need that fix, for the identical
     * reason N8 did.
     *
     * It borrowed EMP004 and cleared only `attendance_day`. Punches are APPEND-ONLY, so any punch
     * already recorded for that employee today survives the DELETE and the derivation reads it:
     * one manual check-in at 00:15 while testing the dashboard was enough to make first_in 00:15
     * instead of 09:16, and the day came back `present` on completely correct code. The failure
     * then aborted the file and took N10..N13 with it.
     *
     * DEC-059 recorded this exact trap when N8 hit it, and N8 was fixed alone - the neighbour
     * sharing the same weakness was left in place. Fixing the instance rather than the pattern is
     * how a trap gets three occurrences.
     *
     * A brand-new employee has no punch history by construction. Note this is not about clearing
     * MORE state: punches cannot be cleared, which is the whole point of an append-only log.
     */
    INSERT INTO employee (employee_number, full_name, work_email, joined_on, status)
    VALUES ('VERIFY-N9', 'Late Arrival Fixture', 'verify-n9@example.invalid',
            fn_business_date() - 400, 'pre_boarding')
    RETURNING id INTO v_emp;

    v_grace := (fn_attendance_policy_asof(fn_business_date())).grace_period_minutes;

    -- Arrive one minute beyond 09:00 + grace.
    INSERT INTO attendance_punch (employee_id, business_date, direction, punched_at, location_source)
    VALUES (v_emp, fn_business_date(),
            'in', (fn_business_date() + TIME '09:00'
                   + make_interval(mins => v_grace + 1)) AT TIME ZONE 'Asia/Kolkata', 'manual');
    INSERT INTO attendance_punch (employee_id, business_date, direction, punched_at, location_source)
    VALUES (v_emp, fn_business_date(),
            'out', (fn_business_date() + TIME '18:30') AT TIME ZONE 'Asia/Kolkata', 'manual');

    v_day := fn_derive_attendance_day(v_emp, fn_business_date());
    IF v_day.status = 'late' THEN
        RAISE NOTICE 'PASS  N9 arrival beyond the % minute grace is late', v_grace;
    ELSE
        RAISE EXCEPTION
            'FAIL  N9 expected late, got % (first_in %). If an earlier punch exists for this '
            'employee today the derivation spans both - which is what owning the fixture prevents',
            v_day.status, to_char(v_day.first_in_at, 'HH24:MI');
    END IF;
END $$;

-- N10: 0013. The pg_temp resolver hijack must be closed.
--
-- Before pinning, a temp table named attendance_policy made the resolver return whatever the
-- attacker liked, with the real table untouched and nothing audited.
DO $$
DECLARE v_grace INT; v_real INT;
BEGIN
    SELECT grace_period_minutes INTO v_real
      FROM attendance_policy WHERE valid_period @> fn_business_date();

    CREATE TEMP TABLE attendance_policy AS
      SELECT * FROM public.attendance_policy WHERE valid_period @> fn_business_date();
    UPDATE pg_temp.attendance_policy SET grace_period_minutes = 999;

    v_grace := (public.fn_attendance_policy_asof(fn_business_date())).grace_period_minutes;
    DROP TABLE pg_temp.attendance_policy;

    IF v_grace = v_real THEN
        RAISE NOTICE 'PASS  N10 pg_temp cannot hijack the policy resolver (still %m)', v_grace;
    ELSE
        RAISE EXCEPTION 'FAIL  N10 resolver hijacked: returned %m instead of %m', v_grace, v_real;
    END IF;
END $$;

-- N11: 0013. Every function reachable by a low-privilege role pins search_path.
DO $$
DECLARE v_unpinned TEXT;
BEGIN
    SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_unpinned
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname LIKE 'fn\_%'
       AND p.proconfig IS NULL
       -- fn_ensure_month_partition executes dynamic DDL against public and is called only from
       -- migrations and a future scheduled job, never from a request path. Pinning it needs its
       -- own change; it is named here so it cannot be forgotten.
       AND p.proname <> 'fn_ensure_month_partition';
    IF v_unpinned IS NULL THEN
        RAISE NOTICE 'PASS  N11 all request-path functions pin search_path';
    ELSE
        RAISE EXCEPTION 'FAIL  N11 unpinned: %', v_unpinned;
    END IF;
END $$;

-- N12: the privacy classification the Forbidden Actions require actually exists.
-- Cheap, and it is the check that would have blocked this migration.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'attendance_punch') THEN
        RAISE NOTICE 'INFO  N12 attendance_punch holds SENSITIVE location data - classified in '
                     'docs/privacy/data-inventory.md (coordinates nulled at 12 months)';
    END IF;
END $$;

SELECT 'PUNCH + GEOFENCE VERIFICATION COMPLETE' AS result;

-- N13: TODAY'S DERIVED VERDICT MUST HAVE PUNCHES BEHIND IT.
--
-- `attendance_day` is a DERIVATION - fn_derive_attendance_day computes it from attendance_punch.
-- The seed used to write a row for the CURRENT business date with plausible in/out times and no
-- punches at all, and the dashboard then rendered three contradictory facts at once: "8h 15m, in
-- 09:12, out 18:30" beside "No punches yet" beside a "Check in" button. Every one of those was a
-- truthful reading of the data. The data was the lie, and no test said so.
--
-- SCOPED TO THE BUSINESS DATE ON PURPOSE. Historical seeded days legitimately have no punches -
-- the attendance history predates the punch log, and back-filling fake punches for it would be a
-- worse fiction than the summary it supports. It is only TODAY that a live screen offers to
-- punch into, so it is only today that the two must agree.
DO $$
DECLARE v_bad TEXT;
BEGIN
    SELECT string_agg(format('%s (%s min, in %s)',
                             e.employee_number, d.worked_minutes,
                             to_char(d.first_in_at, 'HH24:MI')), ', ')
      INTO v_bad
      FROM attendance_day d
      JOIN employee e ON e.id = d.employee_id
     WHERE d.business_date = fn_business_date()
       AND NOT EXISTS (
            SELECT 1 FROM attendance_punch p
             WHERE p.employee_id = d.employee_id
               AND p.business_date = d.business_date);

    IF v_bad IS NULL THEN
        RAISE NOTICE 'PASS  N13 no verdict is derived for today without punches behind it';
    ELSE
        RAISE EXCEPTION
            'FAIL  N13 attendance_day exists for today with NO punches: %. The dashboard will '
            'show a finished day next to a Check in button, and both will be truthful', v_bad;
    END IF;
END $$;
