-- =============================================================================
-- 0013  Pin search_path on the policy resolvers
-- =============================================================================
--
-- Closes the live half of pass-3 finding P3-8.
--
-- THE SECURITY PROBLEM
--   The three `fn_*_asof` resolvers referenced their tables unqualified and pinned no
--   search_path. A reviewer demonstrated the consequence: any role that can create a temp table
--   makes `fn_attendance_policy_asof()` return whatever it likes -
--
--       CREATE TEMP TABLE attendance_policy AS SELECT * FROM public.attendance_policy;
--       UPDATE pg_temp.attendance_policy SET grace_period_minutes = 999;
--       SELECT * FROM fn_attendance_policy_asof(CURRENT_DATE);   -- returns 999
--
--   The real table is untouched and nothing is audited, so attendance silently classifies
--   against fabricated thresholds. `REVOKE ALL ON SCHEMA public FROM PUBLIC` does not help:
--   database-level TEMP is a separate grant. Migration 0005 pinned its own functions against
--   exactly this attack and left the older ones reachable.
--
-- THE FUNCTIONAL PROBLEM, which is how it surfaced
--   The geolocation punch feature (0012) added `fn_derive_attendance_day`, which correctly pins
--   `search_path = pg_catalog, pg_temp` and calls `public.fn_attendance_policy_asof(...)`. The
--   resolver gets INLINED into the caller, its unqualified `attendance_policy` is then resolved
--   against the caller's pinned path, `public` is not on it, and every punch failed with
--   `relation "attendance_policy" does not exist`.
--
--   So an unpinned search_path is not only a vulnerability - it makes a hardened caller
--   impossible to write. The security fix and the feature needed the same change.
--
-- Bodies are otherwise unchanged: same predicates, same NULLS LAST precedence so an
-- entity-specific row still wins over the group default.
--
-- Change class: C (touches how every policy read resolves).
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION fn_attendance_policy_asof(
    p_as_of DATE, p_legal_entity_id UUID DEFAULT NULL
) RETURNS attendance_policy
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT *
      FROM public.attendance_policy
     WHERE valid_period @> p_as_of
       AND (legal_entity_id = p_legal_entity_id OR legal_entity_id IS NULL)
     ORDER BY legal_entity_id NULLS LAST   -- entity-specific row wins over the group default
     LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION fn_employment_policy_asof(
    p_as_of DATE, p_legal_entity_id UUID DEFAULT NULL
) RETURNS employment_policy
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT *
      FROM public.employment_policy
     WHERE valid_period @> p_as_of
       AND (legal_entity_id = p_legal_entity_id OR legal_entity_id IS NULL)
     ORDER BY legal_entity_id NULLS LAST
     LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION fn_leave_policy_asof(
    p_leave_type_code TEXT, p_as_of DATE, p_legal_entity_id UUID DEFAULT NULL
) RETURNS leave_policy
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT lp.*
      FROM public.leave_policy lp
      JOIN public.leave_type lt ON lt.id = lp.leave_type_id
     WHERE lower(lt.code) = lower(p_leave_type_code)
       AND lp.valid_period @> p_as_of
       AND (lp.legal_entity_id = p_legal_entity_id OR lp.legal_entity_id IS NULL)
     ORDER BY lp.legal_entity_id NULLS LAST
     LIMIT 1;
$$;

-- The remaining unpinned functions from P3-8. Neither is a policy resolver, but both are
-- reachable by any role and both reference public tables unqualified.
CREATE OR REPLACE FUNCTION fn_set_updated_at() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION fn_validate_unconfirmed_fields() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE bad TEXT;
BEGIN
    IF NEW.unconfirmed_fields IS NULL OR cardinality(NEW.unconfirmed_fields) = 0 THEN
        RETURN NEW;
    END IF;
    SELECT f INTO bad
      FROM unnest(NEW.unconfirmed_fields) AS f
     WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = TG_TABLE_NAME AND column_name = f)
     LIMIT 1;
    IF bad IS NOT NULL THEN
        RAISE EXCEPTION 'unconfirmed_fields references a column that does not exist on %: %',
            TG_TABLE_NAME, bad USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

COMMIT;
