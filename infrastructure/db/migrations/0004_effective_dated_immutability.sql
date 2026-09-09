-- =============================================================================
-- 0004  Must-Know Rule 3 enforcement: effective-dated rows are immutable
-- =============================================================================
--
-- WHY THIS EXISTS
--   Must-Know Rule 3: "Never overwrite effective-dated data. Changes create a new period.
--   Closing a period is allowed; mutating a historical one is not."
--
--   Until this migration that rule was enforced by NOTHING. ADR-0002 promised "a historical
--   period is never updated in place" and ADR-0019 exists to prevent exactly that outcome, but
--   the only triggers on the three effective-dated policy tables were the unconfirmed_fields
--   validators. `UPDATE attendance_policy SET grace_period_minutes = 20 WHERE valid_from =
--   '2020-01-01'` was accepted by the database. So was deleting a policy version outright.
--
--   fn_block_mutation() already existed and was already applied to outbox_event and
--   audit_event. It was simply never applied here. Found by the 2026-09-08 ADR verification
--   (report finding D-1 / C-9), which also observed that the verification scripts' own restore
--   blocks re-opened a closed period - i.e. the suite demonstrated the hole while passing.
--
-- WHAT IS FORBIDDEN
--   * DELETE of any row, on any of the three tables. A period is closed, never removed.
--   * UPDATE of any policy value in place, on a current OR historical row.
--   * Re-opening a closed period (valid_to -> NULL). This is the specific mutation the old
--     verify scripts performed, and it silently rewrites what every past date resolves to.
--   * Closing a period retroactively (valid_to < today), which rewrites history rather than
--     ending it. See KNOWN GAP below - this is deliberate, not an oversight.
--
-- WHAT REMAINS POSSIBLE
--   * INSERT of a new period. This is the sanctioned way to change policy.
--   * Closing the currently-open period: valid_to NULL -> a date >= today, optionally with a
--     `reason`. Together with INSERT this is the full replacement mechanism.
--   * Updating `unconfirmed_fields` alone. That column records how much confidence we have in
--     a value (DEC-020); it does not change what any date resolves to, and HR confirming a
--     badged default must not require a new policy period.
--
-- KNOWN GAP, recorded rather than papered over
--   A genuine retroactive correction - "the grace period was always 15, the row saying 20 was
--   typed wrong" - has NO legal path under this trigger, by design. Rule 3 forbids it and no
--   audited correction mechanism exists yet. The ADR verification raised this against ADR-0011
--   and ADR-0019; it needs a decision (a correction table, or a supersede-with-annotation
--   pattern), not a quiet exception here. Until then such a correction requires a migration,
--   which is reviewable.
--
-- ENFORCEMENT LEVEL AND ITS LIMIT
--   This is a database trigger, so it holds for psql, a DBA session, a migration, Drizzle, or
--   any future application code - not merely for the NestJS layer. It does NOT hold against the
--   table OWNER running `ALTER TABLE ... DISABLE TRIGGER`, which no trigger can prevent. The
--   mitigation is grant separation: the application role must not own these tables. That role
--   does not exist yet (packages/authz and the app arrive later in Phase 2), so today the dev
--   superuser can still bypass this. Stated here so it is not mistaken for a guarantee it
--   cannot give.
--
-- Change class: C (schema, effective-dating). Non-destructive: adds a function and three
-- triggers, alters no data, drops nothing.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION fn_block_historical_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_old       JSONB;
    v_new       JSONB;
    v_changed   TEXT[];
    v_generated TEXT[];
    v_old_to    DATE;
    v_new_to    DATE;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
            'effective-dated row in %.% may not be DELETEd (Must-Know Rule 3)',
            TG_TABLE_SCHEMA, TG_TABLE_NAME
            USING ERRCODE = 'restrict_violation',
                  HINT = 'A period is closed, never removed. Set valid_to on the open period '
                         'and INSERT the replacement.';
    END IF;

    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);

    -- GENERATED columns must be excluded from the comparison, and this is not cosmetic.
    -- PostgreSQL computes a generated column AFTER all BEFORE-row triggers have run, so inside
    -- this trigger NEW.valid_period is always NULL while OLD.valid_period holds the stored
    -- value. Comparing them would mark valid_period as "changed" on EVERY update, which
    -- silently blocks the two mutations this function is supposed to permit. Excluding them
    -- loses nothing: a generated column is a pure function of columns that ARE compared, so if
    -- no input changed, the output cannot have.
    SELECT coalesce(array_agg(a.attname), '{}')
      INTO v_generated
      FROM pg_attribute a
     WHERE a.attrelid = TG_RELID
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND a.attgenerated <> '';

    -- Which columns actually changed. Done generically so one function serves every
    -- effective-dated table, present and future, without listing columns it would drift from.
    SELECT coalesce(array_agg(e.k ORDER BY e.k), '{}')
      INTO v_changed
      FROM jsonb_each(v_old) AS e(k, v)
     WHERE NOT (e.k = ANY (v_generated))
       AND e.v IS DISTINCT FROM v_new -> e.k;

    IF cardinality(v_changed) = 0 THEN
        RETURN NEW;                       -- a no-op UPDATE changes no history
    END IF;

    -- Permitted: badge metadata only.
    IF v_changed <@ ARRAY['unconfirmed_fields'] THEN
        RETURN NEW;
    END IF;

    -- Permitted: closing the currently-open period, forward in time.
    v_old_to := (v_old ->> 'valid_to')::DATE;
    v_new_to := (v_new ->> 'valid_to')::DATE;

    IF v_changed <@ ARRAY['valid_to', 'reason']
       AND v_old_to IS NULL
       AND v_new_to IS NOT NULL
       AND v_new_to >= CURRENT_DATE
    THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'effective-dated row in %.% may not be modified in place (Must-Know Rule 3); '
        'attempted change to: %',
        TG_TABLE_SCHEMA, TG_TABLE_NAME, array_to_string(v_changed, ', ')
        USING ERRCODE = 'restrict_violation',
              HINT = 'Close the current period (valid_to >= today) and INSERT a new one. '
                     'Re-opening a closed period and back-dating valid_to are both forbidden.';
END;
$$;

COMMENT ON FUNCTION fn_block_historical_mutation() IS
    'Must-Know Rule 3 enforcement for effective-dated tables. Blocks DELETE and in-place '
    'UPDATE; permits INSERT of a new period, forward-dated closure of the open period, and '
    'unconfirmed_fields badge changes. Generic across tables via to_jsonb(OLD/NEW).';

-- Trigger names sort BEFORE the existing tg_*_unconfirmed validators ('i' < 'u'), so this
-- fires first. That ordering matters: an unconfirmed_fields-only UPDATE must reach the
-- validator (which raises check_violation on a bad column name) rather than being rejected
-- here first with a different error code.
CREATE TRIGGER tg_attendance_policy_immutable_history
    BEFORE UPDATE OR DELETE ON attendance_policy
    FOR EACH ROW EXECUTE FUNCTION fn_block_historical_mutation();

CREATE TRIGGER tg_employment_policy_immutable_history
    BEFORE UPDATE OR DELETE ON employment_policy
    FOR EACH ROW EXECUTE FUNCTION fn_block_historical_mutation();

CREATE TRIGGER tg_leave_policy_immutable_history
    BEFORE UPDATE OR DELETE ON leave_policy
    FOR EACH ROW EXECUTE FUNCTION fn_block_historical_mutation();

COMMIT;
