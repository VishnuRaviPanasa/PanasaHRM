-- =============================================================================
-- 0012  Attendance punches with location verification
-- =============================================================================
--
-- Daily check-in / check-out from the browser, with the location captured at the moment the
-- employee chooses to punch.
--
-- THIS IS THE MOST SENSITIVE DATA IN THE SYSTEM. Three deliberate choices, all recorded in
-- docs/privacy/data-inventory.md (written for this migration, because CLAUDE.md's Forbidden
-- Actions bar adding a personal-data column without a classification and that file did not
-- exist):
--
--   1. PURPOSE-BOUND. Location is recorded ONLY on a punch the employee initiated. No background
--      collection, no continuous tracking, no location column on any other table.
--
--   2. THE VERDICT IS STORED, NOT ONLY THE COORDINATES. `matched_location_id`, `distance_m` and
--      `location_verified` answer the real question - "was this at the office?" - so nothing
--      downstream needs to re-derive it from raw coordinates. Only an audit of a disputed punch
--      needs the coordinates at all.
--
--   3. COORDINATES ARE CAPPED AT numeric(9,6). Enough to confirm an office match and audit a
--      dispute; not enough to become a higher-resolution movement trace than the purpose needs.
--      Retention nulls them at 12 months while keeping the punch (data-inventory.md).
--
-- REFUSING LOCATION DOES NOT BLOCK A PUNCH. `location_source = 'denied'` with
-- `location_verified = false`, and the UI says so. Forcing a location grant to record attendance
-- makes consent meaningless, and an employee on a device without GPS could not work.
--
-- ARCHITECTURE (ADR-0011): raw punches are immutable facts; `attendance_day` is DERIVED from
-- them. `business_date` is computed at ingest and STORED, never derived at query time - a
-- `date_trunc` in UTC misattributes every punch before 05:30 IST, which for an early shift is
-- the first punch of every day.
--
-- TRACK B: ADR-0011 also requires monthly partitioning of `attendance_punch`, an idempotent
-- nightly derivation job with `input_fingerprint`, and device-id dedup for biometric ingest.
-- None of that is here. The derivation below runs synchronously on punch, which is correct for
-- a demo and wrong for 5,000 employees.
--
-- Change class: C (schema, attendance, personal data).
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Office geofences. Company premises - not personal data.
-- The radius is CONFIGURATION, not a constant (Must-Know Rule 11).
-- ---------------------------------------------------------------------------
CREATE TABLE work_location (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    address     TEXT,
    latitude    NUMERIC(9,6) NOT NULL,
    longitude   NUMERIC(9,6) NOT NULL,
    radius_m    INTEGER NOT NULL DEFAULT 200,
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_work_location_lat    CHECK (latitude  BETWEEN -90 AND 90),
    CONSTRAINT ck_work_location_lon    CHECK (longitude BETWEEN -180 AND 180),
    -- A radius under 25 m is smaller than a phone's own error and would reject genuine punches;
    -- over 5 km stops meaning "at the office" at all.
    CONSTRAINT ck_work_location_radius CHECK (radius_m BETWEEN 25 AND 5000)
);

COMMENT ON TABLE work_location IS
    'Office geofences. The radius is configuration because a 200m default is an engineering '
    'guess about GPS error in a built-up area, not a decision anyone has made.';

-- ---------------------------------------------------------------------------
-- Raw punches. Immutable facts.
-- ---------------------------------------------------------------------------
CREATE TABLE attendance_punch (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    employee_id         UUID        NOT NULL REFERENCES employee(id),

    punched_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Stored, never derived at query time. See the header.
    business_date       DATE        NOT NULL,
    direction           TEXT        NOT NULL,

    -- SENSITIVE. Nulled at 12 months by retention while the punch is kept.
    latitude            NUMERIC(9,6),
    longitude           NUMERIC(9,6),
    accuracy_m          INTEGER,

    -- The verdict. This is what every downstream reader should use.
    matched_location_id UUID        REFERENCES work_location(id),
    distance_m          INTEGER,
    location_verified   BOOLEAN     NOT NULL DEFAULT false,
    location_source     TEXT        NOT NULL DEFAULT 'browser',

    note                TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_punch_direction CHECK (direction IN ('in', 'out')),
    CONSTRAINT ck_punch_source
        CHECK (location_source IN ('browser', 'denied', 'unavailable', 'manual', 'biometric')),
    CONSTRAINT ck_punch_lat CHECK (latitude  IS NULL OR latitude  BETWEEN -90 AND 90),
    CONSTRAINT ck_punch_lon CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
    CONSTRAINT ck_punch_accuracy CHECK (accuracy_m IS NULL OR accuracy_m BETWEEN 0 AND 100000),
    -- A punch cannot claim to be location-verified without a location and a matched office.
    CONSTRAINT ck_punch_verified_needs_fix
        CHECK (NOT location_verified
               OR (latitude IS NOT NULL AND longitude IS NOT NULL AND matched_location_id IS NOT NULL))
);

CREATE INDEX ix_punch_employee_day ON attendance_punch (employee_id, business_date, punched_at);
CREATE INDEX ix_punch_day ON attendance_punch (business_date);

COMMENT ON COLUMN attendance_punch.latitude IS
    'SENSITIVE (data-inventory.md). Presence verification only. Nulled at 12 months.';
COMMENT ON COLUMN attendance_punch.location_verified IS
    'The verdict downstream reads. Prefer this over re-deriving from coordinates.';

-- A punch is a fact. It is never edited or removed.
CREATE TRIGGER tg_punch_append_only
    BEFORE UPDATE OR DELETE ON attendance_punch
    FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();
CREATE TRIGGER tg_punch_no_truncate
    BEFORE TRUNCATE ON attendance_punch
    FOR EACH STATEMENT EXECUTE FUNCTION fn_block_mutation();

ALTER TABLE attendance_punch ENABLE ALWAYS TRIGGER tg_punch_append_only;
ALTER TABLE attendance_punch ENABLE ALWAYS TRIGGER tg_punch_no_truncate;

-- ---------------------------------------------------------------------------
-- Distance on a sphere. Haversine, in metres.
--
-- Deliberately not PostGIS: one distance calculation does not justify an extension, and
-- ADR-0018's spirit is to avoid dependencies that are not carrying weight. If geofencing grows
-- (polygons, multiple sites per employee, routes) revisit that.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_distance_m(
    lat1 NUMERIC, lon1 NUMERIC, lat2 NUMERIC, lon2 NUMERIC
) RETURNS INTEGER
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT round(
        6371000 * 2 * asin(sqrt(
            power(sin(radians(lat2 - lat1) / 2), 2)
          + cos(radians(lat1)) * cos(radians(lat2))
          * power(sin(radians(lon2 - lon1) / 2), 2)
        ))
    )::int;
$$;

/**
 * Nearest active office to a fix, with the distance. Returns no row when there is no fix.
 */
CREATE OR REPLACE FUNCTION fn_nearest_location(p_lat NUMERIC, p_lon NUMERIC)
RETURNS TABLE (location_id UUID, code TEXT, name TEXT, distance_m INTEGER, radius_m INTEGER)
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT w.id, w.code, w.name,
           public.fn_distance_m(p_lat, p_lon, w.latitude, w.longitude), w.radius_m
      FROM public.work_location w
     WHERE w.is_active AND p_lat IS NOT NULL AND p_lon IS NOT NULL
     ORDER BY public.fn_distance_m(p_lat, p_lon, w.latitude, w.longitude)
     LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- Derive attendance_day from the punches for one employee-day (ADR-0011).
--
-- Resolves the attendance policy AS OF the date being computed, never "current", and snapshots
-- which policy version produced the verdict so the result stays explainable.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_derive_attendance_day(p_employee UUID, p_date DATE)
RETURNS attendance_day
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_pol        public.attendance_policy;
    v_first      timestamptz;
    v_last       timestamptz;
    v_minutes    int;
    v_status     text;
    v_fraction   numeric(3,2);
    v_verified   boolean;
    v_row        public.attendance_day;
    v_tz         text;
BEGIN
    SELECT * INTO v_pol FROM public.fn_attendance_policy_asof(p_date);

    SELECT value #>> '{}' INTO v_tz FROM public.org_setting WHERE key = 'company.timezone';
    v_tz := coalesce(v_tz, 'Asia/Kolkata');

    SELECT min(punched_at) FILTER (WHERE direction = 'in'),
           max(punched_at) FILTER (WHERE direction = 'out'),
           bool_or(location_verified)
      INTO v_first, v_last, v_verified
      FROM public.attendance_punch
     WHERE employee_id = p_employee AND business_date = p_date;

    IF v_first IS NULL THEN
        -- No in-punch: leave any existing row alone rather than inventing an absence. Absence is
        -- a nightly-job decision (it needs to know the day is over), not a punch-time one.
        SELECT * INTO v_row FROM public.attendance_day
         WHERE employee_id = p_employee AND business_date = p_date;
        RETURN v_row;
    END IF;

    -- Still checked in: measure to now, so the UI can show time accruing.
    v_minutes := greatest(0, (extract(epoch FROM (coalesce(v_last, now()) - v_first)) / 60)::int);

    IF extract(isodow FROM p_date) >= 6 THEN
        v_status := 'week_off';
    ELSIF EXISTS (SELECT 1 FROM public.holiday h
                   WHERE h.holiday_on = p_date AND NOT h.is_optional) THEN
        v_status := 'holiday';
    ELSIF v_minutes >= v_pol.full_day_min_minutes THEN
        -- Late is about the ARRIVAL time against the shift start plus the grace period, which is
        -- a different question from how long they stayed.
        v_status := CASE
            WHEN (v_first AT TIME ZONE v_tz)::time
                 > (TIME '09:00' + make_interval(mins => v_pol.grace_period_minutes))
            THEN 'late' ELSE 'present' END;
    ELSIF v_minutes >= v_pol.half_day_min_minutes THEN
        v_status := 'half_day';
    ELSE
        v_status := 'present';   -- still in progress; too early to classify as a half day
    END IF;

    v_fraction := CASE v_status
        WHEN 'week_off' THEN 0 WHEN 'holiday' THEN 0
        WHEN 'half_day' THEN 0.5 ELSE 1 END;

    INSERT INTO public.attendance_day (
        employee_id, business_date, status, first_in_at, last_out_at, worked_minutes,
        payable_day_fraction, attendance_policy_id, note)
    VALUES (p_employee, p_date, v_status, v_first, v_last, least(v_minutes, 1440),
            v_fraction, v_pol.id,
            CASE WHEN v_verified IS FALSE THEN 'location not verified' END)
    ON CONFLICT (employee_id, business_date) DO UPDATE SET
        status               = EXCLUDED.status,
        first_in_at          = EXCLUDED.first_in_at,
        last_out_at          = EXCLUDED.last_out_at,
        worked_minutes       = EXCLUDED.worked_minutes,
        payable_day_fraction = EXCLUDED.payable_day_fraction,
        attendance_policy_id = EXCLUDED.attendance_policy_id,
        note                 = EXCLUDED.note
    RETURNING * INTO v_row;

    RETURN v_row;
END;
$$;

COMMENT ON FUNCTION fn_derive_attendance_day(UUID, DATE) IS
    'ADR-0011: attendance_day is DERIVED from punches, never written directly by a caller. '
    'Resolves the policy as of the date being computed and snapshots which version was used.';

-- ---------------------------------------------------------------------------
-- The office. Demo coordinates - REPLACE with the surveyed location before real use.
-- ---------------------------------------------------------------------------
INSERT INTO work_location (code, name, address, latitude, longitude, radius_m) VALUES
  ('KOCHI-HQ', 'Kochi Office', 'Infopark, Kakkanad, Kochi, Kerala', 10.010400, 76.361500, 250),
  ('KOCHI-ANNEX', 'Kochi Annex', 'Kaloor, Kochi, Kerala', 9.993000, 76.298000, 150);

COMMIT;
