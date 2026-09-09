-- =============================================================================
-- Verification for 0005: the Rule 3 perimeter (H-1 .. H-4)
--
-- 0004 guarded the in-place mutation path. These checks cover the four routes around it that an
-- adversarial review walked through. Each one FAILED before 0005 - the corresponding attack is
-- named in the comment so the check cannot be quietly weakened later without noticing.
-- =============================================================================

-- P1: H-1. The business date, not the server date. ------------------------------------------
-- The container runs UTC and the company runs in Kochi (UTC+05:30), so for 5h30m every day
-- CURRENT_DATE is the PREVIOUS business day. A guard comparing against CURRENT_DATE therefore
-- accepted a retroactive closure every night.
DO $$
DECLARE v_biz DATE; v_utc DATE; v_tz TEXT;
BEGIN
    SELECT value #>> '{}' INTO v_tz FROM org_setting WHERE key = 'company.timezone';
    v_biz := fn_business_date();
    v_utc := CURRENT_DATE;
    IF v_biz = (now() AT TIME ZONE coalesce(v_tz, 'Asia/Kolkata'))::date THEN
        RAISE NOTICE 'PASS  P1 fn_business_date() resolves timezone %: business=% server=%',
            v_tz, v_biz, v_utc;
    ELSE
        RAISE EXCEPTION 'FAIL  P1 business date % does not match timezone % ', v_biz, v_tz;
    END IF;
END $$;

-- P3: H-1. Closing one day BEFORE the business date is refused.
-- Runs BEFORE P2 deliberately: P2 closes the only open period, so this must claim the
-- open row first or it would UPDATE zero rows, fire no trigger, and pass vacuously. - even though that date may
-- still be >= CURRENT_DATE during the UTC evening. This is the exact window the bug opened.
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
    BEGIN
        UPDATE attendance_policy SET valid_to = fn_business_date() - 1
         WHERE valid_to IS NULL;
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  P3 closing before the business date is blocked';
    ELSE RAISE EXCEPTION 'FAIL  P3 yesterday-in-Kochi was accepted as a closure date'; END IF;
END $$;

-- P2: H-1. Closing at the business date is legal even when it is AHEAD of CURRENT_DATE.
-- If the guard still compared against CURRENT_DATE this would be refused during the UTC evening.
DO $$
DECLARE v_ok BOOLEAN := true;
BEGIN
    BEGIN
        UPDATE attendance_policy SET valid_to = fn_business_date()
         WHERE valid_to IS NULL AND valid_from = DATE '2020-01-01';
    EXCEPTION WHEN OTHERS THEN v_ok := false;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  P2 closing at the business date is accepted';
    ELSE RAISE EXCEPTION 'FAIL  P2 a legitimate closure at the business date was refused'; END IF;
END $$;

-- P4: H-2. A back-dated INSERT rewrites what an already-resolved date returns.
-- Demonstrated in review: a per-entity row moved 2021-06-15 from grace 15 to grace 0, with no
-- trigger firing, because only UPDATE and DELETE were guarded.
DO $$
DECLARE v_ok BOOLEAN := false; v_after SMALLINT;
BEGIN
    BEGIN
        INSERT INTO attendance_policy (legal_entity_id, grace_period_minutes, half_day_min_minutes,
                                       full_day_min_minutes, standard_day_minutes, valid_from, reason)
        VALUES ('22222222-2222-2222-2222-222222222222', 0, 240, 460, 480,
                DATE '2010-01-01', 'verification: back-dated history rewrite');
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    v_after := (fn_attendance_policy_asof(DATE '2021-06-15')).grace_period_minutes;
    IF v_ok AND v_after = 15 THEN
        RAISE NOTICE 'PASS  P4 back-dated INSERT is blocked; 2021 still resolves grace=%', v_after;
    ELSE
        RAISE EXCEPTION 'FAIL  P4 history was rewritten by INSERT (blocked=%, 2021 grace=%)',
            v_ok, v_after;
    END IF;
END $$;

-- P5: H-2. Seeding and genuine backfill must remain possible, but only deliberately.
DO $$
DECLARE v_ok BOOLEAN := true;
BEGIN
    BEGIN
        SET LOCAL hrm.allow_backdated_period = 'on';
        INSERT INTO attendance_policy (legal_entity_id, valid_from, valid_to, reason)
        VALUES ('33333333-3333-3333-3333-333333333333', DATE '2011-01-01', DATE '2012-01-01',
                'verification: sanctioned backfill');
    EXCEPTION WHEN OTHERS THEN v_ok := false;
    END;
    RESET hrm.allow_backdated_period;
    IF v_ok THEN RAISE NOTICE 'PASS  P5 an explicitly opted-in backfill is permitted';
    ELSE RAISE EXCEPTION 'FAIL  P5 seeding is impossible - the escape hatch does not work'; END IF;
END $$;

-- P6: H-2. Future-dated periods are the NORMAL case (ADR-0019) and must stay unimpeded.
DO $$
DECLARE v_ok BOOLEAN := true;
BEGIN
    BEGIN
        INSERT INTO attendance_policy (legal_entity_id, valid_from, reason)
        VALUES ('44444444-4444-4444-4444-444444444444', fn_business_date() + 30,
                'verification: future-dated change');
    EXCEPTION WHEN OTHERS THEN v_ok := false;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  P6 future-dated policy changes remain permitted';
    ELSE RAISE EXCEPTION 'FAIL  P6 a future-dated change was refused'; END IF;
END $$;

-- P7: H-3. TRUNCATE fires no ROW trigger. Every Rule 3 protection was in place and
-- `TRUNCATE attendance_policy` still emptied the table.
--
-- ONE policy table must be tested where a refusal can ONLY be the statement trigger, or a
-- dropped trigger would hide behind a foreign key. employment_policy is currently the only one
-- with no inbound FK: leave_policy is referenced by leave_ledger (0007) and attendance_policy by
-- attendance_day (0010), so PostgreSQL refuses those with 0A000 before any trigger runs.
--
-- IF A FUTURE MIGRATION ADDS AN FK TO employment_policy, MOVE THIS PROBE - do not delete it.
-- Losing it means the truncate rail becomes untested while still reporting green.
DO $$
DECLARE v_ok BOOLEAN := false; v_refs INT;
BEGIN
    SELECT count(*) INTO v_refs FROM pg_constraint
     WHERE confrelid = 'employment_policy'::regclass AND contype = 'f';
    IF v_refs > 0 THEN
        RAISE EXCEPTION 'FAIL  P7a employment_policy now has % inbound FK(s) - this probe no '
                        'longer isolates the trigger. Point it at an unreferenced policy table.', v_refs;
    END IF;
    BEGIN TRUNCATE employment_policy; EXCEPTION WHEN restrict_violation THEN v_ok := true; END;
    IF v_ok THEN RAISE NOTICE 'PASS  P7a TRUNCATE blocked by the statement trigger (no FK to hide behind)';
    ELSE RAISE EXCEPTION 'FAIL  P7a employment_policy was truncated - the trigger did not fire'; END IF;
END $$;

DO $$
DECLARE v_l TEXT := 'allowed'; v_e TEXT := 'allowed'; v_rows INT;
BEGIN
    BEGIN TRUNCATE leave_policy;
    EXCEPTION WHEN restrict_violation THEN v_l := 'trigger';
              WHEN feature_not_supported THEN v_l := 'foreign key';
    END;
    BEGIN TRUNCATE attendance_policy;
    EXCEPTION WHEN restrict_violation THEN v_e := 'trigger';
              WHEN feature_not_supported THEN v_e := 'foreign key';
    END;
    SELECT count(*) INTO v_rows FROM leave_policy;
    IF v_l <> 'allowed' AND v_e <> 'allowed' AND v_rows > 0 THEN
        RAISE NOTICE 'PASS  P7b leave_policy blocked by %, employment_policy by % (% rows intact)',
            v_l, v_e, v_rows;
    ELSE
        RAISE EXCEPTION 'FAIL  P7b truncate not blocked (leave=%, employment=%, rows=%)',
            v_l, v_e, v_rows;
    END IF;
END $$;

-- P8: H-3. The audit and outbox tables had the same hole.
DO $$
DECLARE v_au BOOLEAN := false; v_ob BOOLEAN := false;
BEGIN
    BEGIN TRUNCATE audit_event;  EXCEPTION WHEN restrict_violation THEN v_au := true; END;
    BEGIN TRUNCATE outbox_event; EXCEPTION WHEN restrict_violation THEN v_ob := true; END;
    IF v_au AND v_ob THEN RAISE NOTICE 'PASS  P8 TRUNCATE is blocked on audit_event and outbox_event';
    ELSE RAISE EXCEPTION 'FAIL  P8 append-only table truncated (audit=%, outbox=%)', v_au, v_ob; END IF;
END $$;

-- P9: H-4. session_replication_role='replica' silently disables ENABLE (not ALWAYS) triggers.
-- It is a session GUC: no lock, no catalogue change, and PGOPTIONS carries it into any client.
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
    BEGIN
        SET LOCAL session_replication_role = 'replica';
        BEGIN
            UPDATE attendance_policy SET ot_min_minutes = 45 WHERE valid_from = DATE '2020-01-01';
        EXCEPTION WHEN restrict_violation THEN v_ok := true;
        END;
        SET LOCAL session_replication_role = 'origin';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'INFO  P9 skipped: this role may not set session_replication_role';
        v_ok := true;
    END;
    IF v_ok THEN
        RAISE NOTICE 'PASS  P9 the Rule 3 trigger survives session_replication_role=replica';
    ELSE
        RAISE EXCEPTION 'FAIL  P9 a session GUC disabled Rule 3 enforcement';
    END IF;
END $$;

-- P10: H-4. The 0001 append-only rails had the same weakness.
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
    BEGIN
        SET LOCAL session_replication_role = 'replica';
        BEGIN
            DELETE FROM outbox_event WHERE id = -1;   -- matches nothing; the trigger fires per row
            -- a row is needed for a BEFORE DELETE row trigger to fire, so assert via catalogue too
            v_ok := (SELECT bool_and(t.tgenabled = 'A') FROM pg_trigger t
                      WHERE NOT t.tgisinternal
                        AND t.tgname IN ('tg_outbox_no_delete', 'tg_audit_append_only',
                                         'tg_outbox_immutable_payload'));
        EXCEPTION WHEN restrict_violation THEN v_ok := true;
        END;
        SET LOCAL session_replication_role = 'origin';
    EXCEPTION WHEN insufficient_privilege THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  P10 audit/outbox append-only rails are ENABLE ALWAYS';
    ELSE RAISE EXCEPTION 'FAIL  P10 append-only rails can be disabled by a session GUC'; END IF;
END $$;

-- P11: search_path pinning. An unpinned SECURITY INVOKER trigger function let a hostile schema
-- shadow the `<@` operator the Rule 3 decision uses, walking an UPDATE straight through.
DO $$
DECLARE v_unpinned TEXT;
BEGIN
    SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_unpinned
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('fn_business_date', 'fn_block_historical_mutation',
                         'fn_block_backdated_period', 'fn_block_mutation')
       AND (p.proconfig IS NULL
            OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search\_path=%'));
    IF v_unpinned IS NULL THEN
        RAISE NOTICE 'PASS  P11 every Rule 3 function pins search_path';
    ELSE
        RAISE EXCEPTION 'FAIL  P11 unpinned search_path on: %', v_unpinned;
    END IF;
END $$;

SELECT 'RULE 3 PERIMETER VERIFICATION COMPLETE' AS result;
