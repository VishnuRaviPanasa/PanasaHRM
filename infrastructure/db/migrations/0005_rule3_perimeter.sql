-- =============================================================================
-- 0005  Must-Know Rule 3: close the perimeter around 0004
-- =============================================================================
--
-- WHY THIS EXISTS
--   Migration 0004 enforced Rule 3 against in-place UPDATE and DELETE, and its core logic
--   survived an adversarial pass: twenty distinct mutation forms (MERGE both ways, upsert,
--   UPDATE..FROM, DELETE..USING, data-modifying CTEs, identity-column rewrites, multi-column
--   smuggles) were all refused. What the review broke was everything AROUND that logic.
--
--   This migration is forward-only (DEC-011): 0004 is not edited. Where a statement in 0004's
--   header is wrong, it is corrected here and 0004 stands as the historical record of what was
--   actually applied.
--
-- WHAT THIS FIXES, and what each finding was
--
--   H-1  The guard compared against CURRENT_DATE, which is the SESSION's date. The container
--        runs TimeZone=UTC and the business runs in Kochi (UTC+05:30). Measured during review:
--        db CURRENT_DATE = 2026-09-07 while the business date was 2026-09-08. For 5h30m of every
--        day the trigger therefore ACCEPTED a retroactive closure at yesterday-in-Kochi - the
--        precise operation it exists to refuse, and the same timezone bug ADR-0011 opens by
--        rejecting. Fixed by fn_business_date(), which resolves the configured company timezone.
--
--   H-2  0004's header claimed a retroactive correction "has NO legal path ... by design".
--        THAT WAS FALSE, and this is the correction of record: UPDATE and DELETE were guarded,
--        but INSERT never was. A back-dated INSERT changed what a past date resolves to -
--        demonstrated live, moving 2021-06-15 from grace 15 to grace 0. Back-dated inserts are
--        now refused unless a caller opts in explicitly and visibly (see below), which turns an
--        accident into a deliberate, greppable act.
--
--   H-3  TRUNCATE fires no row-level trigger. `TRUNCATE attendance_policy` emptied the table
--        with every Rule 3 protection in place. TRUNCATE is separately grantable, so the
--        "application role is not the owner" mitigation does not cover it. Now blocked by
--        statement-level triggers, on the audit and outbox tables too - they had the same hole.
--
--   H-4  Triggers were created ENABLE (tgenabled='O'), so `SET session_replication_role =
--        'replica'` silently disabled all of them - a session GUC, no lock, no catalogue trace.
--        PGOPTIONS carries it into any client, including the migration runner. Now ENABLE ALWAYS.
--
--   Also: every function here pins search_path. A review demonstrated that an unpinned
--   search_path plus a hostile schema lets an attacker shadow the `<@` operator the Rule 3
--   trigger decides on, and walk an UPDATE straight through. Objects outside pg_catalog are
--   schema-qualified because the pinned path cannot see `public`.
--
-- WHAT REMAINS OUT OF REACH, honestly
--   A table OWNER can still `ALTER TABLE ... DISABLE TRIGGER` or `DROP TRIGGER`. No trigger can
--   prevent that. Two things now make it harder rather than impossible: ENABLE ALWAYS removes the
--   session-GUC route, and guard-commit.mjs treats DROP/DISABLE TRIGGER as destructive DDL
--   requiring an `-- IRREVERSIBLE:` marker. Real mitigation is grant separation, and the
--   application role still does not exist.
--
-- Change class: C (schema, effective-dating). Non-destructive: adds functions and triggers,
-- alters no data, drops nothing.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- H-1: the business date
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_business_date() RETURNS DATE
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT (now() AT TIME ZONE COALESCE(
              (SELECT s.value #>> '{}' FROM public.org_setting s WHERE s.key = 'company.timezone'),
              'Asia/Kolkata'))::date;
$$;

COMMENT ON FUNCTION fn_business_date() IS
    'Today, in the company timezone (org_setting company.timezone, default Asia/Kolkata). '
    'Never use CURRENT_DATE for a business-date decision: the server runs UTC and is up to '
    '5h30m behind Kochi, so CURRENT_DATE is the PREVIOUS business day every night.';

-- ---------------------------------------------------------------------------
-- H-1 + search_path: replace the Rule 3 trigger function
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_block_historical_mutation() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_old       jsonb;
    v_new       jsonb;
    v_changed   text[];
    v_generated text[];
    v_old_to    date;
    v_new_to    date;
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

    -- GENERATED columns are excluded: PostgreSQL computes them AFTER before-row triggers, so
    -- NEW.valid_period is always NULL here and comparing it would mark every UPDATE as changed.
    -- Nothing is lost - a generated column is a function of columns that ARE compared.
    SELECT coalesce(array_agg(a.attname), '{}')
      INTO v_generated
      FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = TG_RELID
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND a.attgenerated <> '';

    SELECT coalesce(array_agg(e.k ORDER BY e.k), '{}')
      INTO v_changed
      FROM pg_catalog.jsonb_each(v_old) AS e(k, v)
     WHERE NOT (e.k = ANY (v_generated))
       AND e.v IS DISTINCT FROM v_new -> e.k;

    IF cardinality(v_changed) = 0 THEN
        RETURN NEW;                       -- a no-op UPDATE changes no history
    END IF;

    -- Permitted: badge metadata only. Recorded as a deliberate Rule 3 narrowing (DEC-027).
    IF v_changed OPERATOR(pg_catalog.<@) ARRAY['unconfirmed_fields'] THEN
        RETURN NEW;
    END IF;

    -- Permitted: closing the currently-open period, forward in BUSINESS time (H-1).
    v_old_to := (v_old ->> 'valid_to')::date;
    v_new_to := (v_new ->> 'valid_to')::date;

    IF v_changed OPERATOR(pg_catalog.<@) ARRAY['valid_to', 'reason']
       AND v_old_to IS NULL
       AND v_new_to IS NOT NULL
       AND v_new_to >= public.fn_business_date()
    THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'effective-dated row in %.% may not be modified in place (Must-Know Rule 3); '
        'attempted change to: %',
        TG_TABLE_SCHEMA, TG_TABLE_NAME, array_to_string(v_changed, ', ')
        USING ERRCODE = 'restrict_violation',
              HINT = 'Close the current period (valid_to >= the business date) and INSERT a new '
                     'one. Re-opening a closed period and back-dating valid_to are forbidden.';
END;
$$;

-- ---------------------------------------------------------------------------
-- H-2: back-dated INSERT
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_block_backdated_period() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_from date;
BEGIN
    v_from := (to_jsonb(NEW) ->> 'valid_from')::date;
    IF v_from IS NULL OR v_from >= public.fn_business_date() THEN
        RETURN NEW;                      -- today or future-dated: the normal case (ADR-0019)
    END IF;

    -- Seeding and genuine historical backfill are legitimate, but must be deliberate and
    -- greppable rather than accidental. A migration or an audited admin path sets:
    --     SET LOCAL hrm.allow_backdated_period = 'on';
    IF coalesce(current_setting('hrm.allow_backdated_period', true), 'off')
       IN ('on', 'true', '1') THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'back-dated period in %.%: valid_from % is before the business date % (Must-Know Rule 3)',
        TG_TABLE_SCHEMA, TG_TABLE_NAME, v_from, public.fn_business_date()
        USING ERRCODE = 'restrict_violation',
              HINT = 'Inserting a period that starts in the past changes what an already-'
                     'resolved date returns. If that is genuinely intended (seeding, backfill), '
                     'set hrm.allow_backdated_period = ''on'' for the transaction and say why '
                     'in the reason column.';
END;
$$;

-- ---------------------------------------------------------------------------
-- H-3: TRUNCATE. Row triggers never fire for it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_block_mutation() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION
        USING MESSAGE = format('%s is append-only; %s is not permitted', TG_TABLE_NAME, TG_OP),
              ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER tg_attendance_policy_no_truncate
    BEFORE TRUNCATE ON attendance_policy
    FOR EACH STATEMENT EXECUTE FUNCTION fn_block_mutation();
CREATE TRIGGER tg_employment_policy_no_truncate
    BEFORE TRUNCATE ON employment_policy
    FOR EACH STATEMENT EXECUTE FUNCTION fn_block_mutation();
CREATE TRIGGER tg_leave_policy_no_truncate
    BEFORE TRUNCATE ON leave_policy
    FOR EACH STATEMENT EXECUTE FUNCTION fn_block_mutation();
CREATE TRIGGER tg_audit_event_no_truncate
    BEFORE TRUNCATE ON audit_event
    FOR EACH STATEMENT EXECUTE FUNCTION fn_block_mutation();
CREATE TRIGGER tg_outbox_event_no_truncate
    BEFORE TRUNCATE ON outbox_event
    FOR EACH STATEMENT EXECUTE FUNCTION fn_block_mutation();

-- H-2 triggers
CREATE TRIGGER tg_attendance_policy_no_backdate
    BEFORE INSERT ON attendance_policy
    FOR EACH ROW EXECUTE FUNCTION fn_block_backdated_period();
CREATE TRIGGER tg_employment_policy_no_backdate
    BEFORE INSERT ON employment_policy
    FOR EACH ROW EXECUTE FUNCTION fn_block_backdated_period();
CREATE TRIGGER tg_leave_policy_no_backdate
    BEFORE INSERT ON leave_policy
    FOR EACH ROW EXECUTE FUNCTION fn_block_backdated_period();

-- ---------------------------------------------------------------------------
-- H-4: survive session_replication_role = 'replica'
-- ---------------------------------------------------------------------------
ALTER TABLE attendance_policy ENABLE ALWAYS TRIGGER tg_attendance_policy_immutable_history;
ALTER TABLE employment_policy ENABLE ALWAYS TRIGGER tg_employment_policy_immutable_history;
ALTER TABLE leave_policy      ENABLE ALWAYS TRIGGER tg_leave_policy_immutable_history;

ALTER TABLE attendance_policy ENABLE ALWAYS TRIGGER tg_attendance_policy_no_truncate;
ALTER TABLE employment_policy ENABLE ALWAYS TRIGGER tg_employment_policy_no_truncate;
ALTER TABLE leave_policy      ENABLE ALWAYS TRIGGER tg_leave_policy_no_truncate;
ALTER TABLE audit_event       ENABLE ALWAYS TRIGGER tg_audit_event_no_truncate;
ALTER TABLE outbox_event      ENABLE ALWAYS TRIGGER tg_outbox_event_no_truncate;

ALTER TABLE attendance_policy ENABLE ALWAYS TRIGGER tg_attendance_policy_no_backdate;
ALTER TABLE employment_policy ENABLE ALWAYS TRIGGER tg_employment_policy_no_backdate;
ALTER TABLE leave_policy      ENABLE ALWAYS TRIGGER tg_leave_policy_no_backdate;

-- The append-only rails from 0001 had the same session_replication_role hole.
ALTER TABLE audit_event  ENABLE ALWAYS TRIGGER tg_audit_append_only;
ALTER TABLE outbox_event ENABLE ALWAYS TRIGGER tg_outbox_no_delete;
ALTER TABLE outbox_event ENABLE ALWAYS TRIGGER tg_outbox_immutable_payload;

COMMIT;
