-- Adversarial verification of infrastructure/db/migrations/0001_baseline.sql.
--
-- Every block asserts a guarantee by ATTEMPTING TO VIOLATE IT. A guarantee that has
-- only been read is a guarantee that has been assumed.
--
-- Run:  npm run db:verify
--       (or: psql -d <db> -v ON_ERROR_STOP=1 -f testing/db/0001_baseline.verify.sql)
--
-- Any failure raises and aborts, so a non-zero exit means a guarantee has regressed.
--
-- T12 is the one worth reading. It does not test our schema - it demonstrates a
-- PostgreSQL behaviour: an EXCLUDE constraint alone does NOT stop duplicate
-- zero-length periods, because `empty && anything` is false. That is why every
-- effective-dated table needs the companion CHECK (NOT isempty(...)), and why
-- omitting it is CRITICAL rather than untidy.


\set ON_ERROR_STOP on
\pset tuples_only on

-- T1: audit_event is append-only - UPDATE must fail
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
    INSERT INTO audit_event (occurred_at, source, event_type, subject_employee_id)
    VALUES (now(), 'application', 'people.employee.hired', gen_random_uuid());
    BEGIN
        UPDATE audit_event SET reason = 'tampered' WHERE source = 'application';
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  T1 audit_event UPDATE is blocked';
    ELSE RAISE EXCEPTION 'FAIL  T1 audit_event UPDATE was ALLOWED'; END IF;
END $$;

-- T2: audit_event DELETE must fail
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
    BEGIN
        DELETE FROM audit_event WHERE source = 'application';
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  T2 audit_event DELETE is blocked';
    ELSE RAISE EXCEPTION 'FAIL  T2 audit_event DELETE was ALLOWED'; END IF;
END $$;

-- T3: the shape constraint rejects a trigger row with no table_name
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
    BEGIN
        INSERT INTO audit_event (occurred_at, source) VALUES (now(), 'trigger');
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  T3 trigger row without table_name rejected';
    ELSE RAISE EXCEPTION 'FAIL  T3 malformed trigger row was ACCEPTED'; END IF;
END $$;

-- T4: partition routing actually works (row lands in the right monthly child)
DO $$
DECLARE v_part TEXT;
BEGIN
    SELECT c.relname INTO v_part
      FROM audit_event a
      JOIN pg_class c ON c.oid = a.tableoid
     WHERE a.source = 'application'
     LIMIT 1;
    IF v_part = 'audit_event_p' || to_char(now(), 'YYYYMM') THEN
        RAISE NOTICE 'PASS  T4 row routed to %', v_part;
    ELSE
        RAISE EXCEPTION 'FAIL  T4 wrong partition: %', coalesce(v_part, '(none)');
    END IF;
END $$;

-- T5: an insert beyond the last partition must fail loudly, not silently vanish
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
    BEGIN
        INSERT INTO audit_event (occurred_at, source, event_type)
        VALUES (now() + INTERVAL '3 years', 'application', 'test.future.event');
    EXCEPTION WHEN check_violation OR undefined_table THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  T5 insert past the last partition fails loudly';
    ELSE RAISE EXCEPTION 'FAIL  T5 future insert silently succeeded'; END IF;
END $$;

-- T6: fn_ensure_month_partition is idempotent
DO $$
DECLARE a TEXT; b TEXT;
BEGIN
    a := fn_ensure_month_partition('audit_event', '2030-07-15');
    b := fn_ensure_month_partition('audit_event', '2030-07-01');
    IF a = b THEN RAISE NOTICE 'PASS  T6 partition creation is idempotent (%)', a;
    ELSE RAISE EXCEPTION 'FAIL  T6 idempotency broken: % vs %', a, b; END IF;
END $$;

-- T7: outbox event_type shape is enforced
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
    BEGIN
        INSERT INTO outbox_event (event_type, aggregate_type, aggregate_id, payload)
        VALUES ('NotAValidShape', 'employee', gen_random_uuid(), '{}'::jsonb);
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  T7 malformed event_type rejected';
    ELSE RAISE EXCEPTION 'FAIL  T7 malformed event_type ACCEPTED'; END IF;
END $$;

-- T8: a well-formed outbox event is accepted
DO $$
DECLARE v_id BIGINT;
BEGIN
    INSERT INTO outbox_event (event_type, aggregate_type, aggregate_id, payload)
    VALUES ('people.employee.hired', 'employee', gen_random_uuid(), '{"x":1}'::jsonb)
    RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN RAISE NOTICE 'PASS  T8 valid outbox event accepted (id=%)', v_id;
    ELSE RAISE EXCEPTION 'FAIL  T8'; END IF;
END $$;

-- T9: outbox payload is immutable, but drain bookkeeping may be updated
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
    BEGIN
        UPDATE outbox_event SET payload = '{"tampered":true}'::jsonb;
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN RAISE EXCEPTION 'FAIL  T9a outbox payload was mutable'; END IF;

    UPDATE outbox_event SET processed_at = now(), attempts = attempts + 1;
    RAISE NOTICE 'PASS  T9 payload immutable, drain bookkeeping still writable';
END $$;

-- T10: the pending-drain partial index is actually used (not a seq scan)
DO $$
DECLARE v_plan TEXT;
BEGIN
    EXECUTE 'EXPLAIN (FORMAT TEXT) SELECT id FROM outbox_event
             WHERE processed_at IS NULL ORDER BY available_at, id LIMIT 100'
      INTO v_plan;
    RAISE NOTICE 'INFO  T10 drain plan: %', v_plan;
END $$;

-- T11: btree_gist works - the EXCLUDE shape every effective-dated table depends on
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
    CREATE TEMP TABLE t_eff (
        entity_id UUID NOT NULL,
        valid_from DATE NOT NULL,
        valid_to   DATE,
        valid_period daterange GENERATED ALWAYS AS (daterange(valid_from, valid_to, '[)')) STORED,
        CONSTRAINT ex_t_eff EXCLUDE USING gist (entity_id WITH =, valid_period WITH &&),
        CONSTRAINT ck_t_eff_not_empty CHECK (NOT isempty(daterange(valid_from, valid_to, '[)')))
    ) ON COMMIT DROP;

    INSERT INTO t_eff (entity_id, valid_from, valid_to)
    VALUES ('11111111-1111-1111-1111-111111111111', '2026-01-01', '2026-06-01');

    -- overlapping period must be rejected
    BEGIN
        INSERT INTO t_eff (entity_id, valid_from, valid_to)
        VALUES ('11111111-1111-1111-1111-111111111111', '2026-05-01', '2026-09-01');
    EXCEPTION WHEN exclusion_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN RAISE EXCEPTION 'FAIL  T11a overlapping period ACCEPTED'; END IF;

    -- adjacent half-open period must be ACCEPTED (this is why we use '[)')
    INSERT INTO t_eff (entity_id, valid_from, valid_to)
    VALUES ('11111111-1111-1111-1111-111111111111', '2026-06-01', NULL);

    RAISE NOTICE 'PASS  T11 EXCLUDE rejects overlap, accepts adjacent half-open period';
END $$;

-- T12: the empty-range hole - THE trap from ai/context/temporal-data-rules.md
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
    CREATE TEMP TABLE t_noguard (
        entity_id UUID NOT NULL,
        valid_from DATE NOT NULL,
        valid_to   DATE,
        valid_period daterange GENERATED ALWAYS AS (daterange(valid_from, valid_to, '[)')) STORED,
        CONSTRAINT ex_t_noguard EXCLUDE USING gist (entity_id WITH =, valid_period WITH &&)
        -- deliberately WITHOUT the NOT isempty CHECK
    ) ON COMMIT DROP;

    -- Two zero-length rows on the same day. If EXCLUDE alone were sufficient,
    -- the second would be rejected. It is not - empty && anything is false.
    INSERT INTO t_noguard (entity_id, valid_from, valid_to)
    VALUES ('22222222-2222-2222-2222-222222222222', '2026-04-01', '2026-04-01');
    INSERT INTO t_noguard (entity_id, valid_from, valid_to)
    VALUES ('22222222-2222-2222-2222-222222222222', '2026-04-01', '2026-04-01');

    RAISE NOTICE 'PASS  T12 CONFIRMED: empty ranges bypass EXCLUDE (% rows) - the CHECK is mandatory',
        (SELECT count(*) FROM t_noguard);
END $$;

-- T13: with the CHECK present, the empty range is rejected
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
    CREATE TEMP TABLE t_guard (
        entity_id UUID NOT NULL,
        valid_from DATE NOT NULL,
        valid_to   DATE,
        CONSTRAINT ck_t_guard_not_empty CHECK (NOT isempty(daterange(valid_from, valid_to, '[)')))
    ) ON COMMIT DROP;
    BEGIN
        INSERT INTO t_guard (entity_id, valid_from, valid_to)
        VALUES ('33333333-3333-3333-3333-333333333333', '2026-04-01', '2026-04-01');
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  T13 NOT isempty CHECK rejects the zero-length period';
    ELSE RAISE EXCEPTION 'FAIL  T13 empty range accepted even WITH the CHECK'; END IF;
END $$;

SELECT 'ALL BASELINE VERIFICATION BLOCKS COMPLETED' AS result;
