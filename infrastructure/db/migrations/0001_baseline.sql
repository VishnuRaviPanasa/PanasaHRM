-- 0001_baseline.sql
--
-- Extensions, shared conventions, and the two cross-cutting tables that must exist
-- BEFORE any module writes data: the transactional outbox and the audit log.
--
-- Retrofitting an audit trail leaves a permanent hole, and a hole in an audit trail is
-- indistinguishable from a cover-up. So this migration comes first. (ADR-0008)

BEGIN;

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------

-- btree_gist lets an EXCLUDE constraint mix equality on a uuid with range overlap,
-- which is what every effective-dated table needs. (ADR-0002)
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Trigram search for employee name lookup.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Digest/HMAC for the audit hash chain and blind indexes on Tier 1 fields.
CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- ---------------------------------------------------------------------------
-- Migration bookkeeping
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS schema_migration (
    version      TEXT        PRIMARY KEY,
    checksum     TEXT        NOT NULL,
    applied_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_by   TEXT        NOT NULL DEFAULT current_user,
    duration_ms  INTEGER
);

COMMENT ON TABLE schema_migration IS
    'Applied migrations. checksum detects a migration edited after it was applied - '
    'which is how two environments silently diverge.';


-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_set_updated_at() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

-- Blocks UPDATE and DELETE. Used on every append-only table.
-- This is a floor, not a ceiling: a superuser can drop the trigger. It stops the
-- application, and anything injecting through it, from rewriting history.
CREATE OR REPLACE FUNCTION fn_block_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION
        USING MESSAGE = format('%s is append-only; %s is not permitted', TG_TABLE_NAME, TG_OP),
              ERRCODE = 'restrict_violation';
END;
$$;

COMMENT ON FUNCTION fn_block_mutation() IS
    'Append-only guard. Attach as BEFORE UPDATE OR DELETE on ledgers, audit and transition logs.';


-- ---------------------------------------------------------------------------
-- Transactional outbox
--
-- Written in the SAME transaction as the domain change. A worker drains it and fans
-- out to audit and notifications. This is what guarantees "state changed => audit
-- recorded" cannot diverge. (ADR-0008)
-- ---------------------------------------------------------------------------

CREATE TABLE outbox_event (
    id               BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_type       TEXT        NOT NULL,
    aggregate_type   TEXT        NOT NULL,
    aggregate_id     UUID        NOT NULL,
    payload          JSONB       NOT NULL,

    -- Correlation. Lets a notification be traced back to the request that caused it.
    correlation_id   UUID,
    causation_id     BIGINT,
    actor_user_id    UUID,

    occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    available_at     TIMESTAMPTZ NOT NULL DEFAULT now(),   -- delay / backoff
    processed_at     TIMESTAMPTZ,
    attempts         SMALLINT    NOT NULL DEFAULT 0,
    last_error       TEXT,

    CONSTRAINT ck_outbox_event_type_shape CHECK (event_type ~ '^[a-z_]+\.[a-z_]+\.[a-z_]+$'),
    CONSTRAINT ck_outbox_attempts_sane    CHECK (attempts >= 0 AND attempts <= 100)
);

COMMENT ON COLUMN outbox_event.event_type IS
    'domain.entity.action, e.g. people.employee.hired. Shape enforced so a typo fails at '
    'write time rather than silently creating an event nobody subscribes to.';

-- The drain query. Partial index keeps it proportional to the backlog, not the table.
CREATE INDEX ix_outbox_event_pending
    ON outbox_event (available_at, id)
    WHERE processed_at IS NULL;

CREATE INDEX ix_outbox_event_aggregate
    ON outbox_event (aggregate_type, aggregate_id, occurred_at DESC);

-- Outbox rows are immutable except for the drain bookkeeping columns.
CREATE OR REPLACE FUNCTION fn_outbox_immutable_payload() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.event_type   IS DISTINCT FROM OLD.event_type
    OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
    OR NEW.payload      IS DISTINCT FROM OLD.payload
    OR NEW.occurred_at  IS DISTINCT FROM OLD.occurred_at THEN
        RAISE EXCEPTION 'outbox_event content is immutable; only drain bookkeeping may change'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_outbox_immutable_payload
    BEFORE UPDATE ON outbox_event
    FOR EACH ROW EXECUTE FUNCTION fn_outbox_immutable_payload();

CREATE TRIGGER tg_outbox_no_delete
    BEFORE DELETE ON outbox_event
    FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();


-- ---------------------------------------------------------------------------
-- Audit log
--
-- Partitioned monthly FROM CREATION. Both conditions that force partitioning are
-- already met: 10-20M rows/year, and a retention requirement that needs DETACH
-- rather than DELETE - deleting 5M rows is an autovacuum and bloat disaster, while
-- detaching a partition is a catalog operation measured in milliseconds.
-- ---------------------------------------------------------------------------

CREATE TABLE audit_event (
    id                   BIGINT      GENERATED ALWAYS AS IDENTITY,
    occurred_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Source. Trigger rows are the floor (what changed); application rows are the
    -- ceiling (why, by whom, in which request). Both exist deliberately: ADR-0003
    -- permits raw SQL, which would bypass an application-only interceptor.
    source               TEXT        NOT NULL,
    event_type           TEXT,
    table_name           TEXT,
    row_pk               TEXT,
    operation            CHAR(1),

    -- Actor
    actor_user_id        UUID,
    actor_employee_id    UUID,
    actor_kind           TEXT        NOT NULL DEFAULT 'user',
    actor_roles          TEXT[],
    on_behalf_of_user_id UUID,

    -- Request context
    correlation_id       UUID,
    session_id           UUID,
    source_ip            INET,

    -- Subject. WHOSE data was involved - indexed, and distinct from row_pk.
    -- Without this, two things are impossible: answering "show everyone who accessed
    -- employee X's record" during an investigation, and enumerating affected data
    -- principals during a breach within the notification window.
    subject_employee_id  UUID,
    subject_type         TEXT,

    -- Purpose binding. Turns a security log into an accountability artifact.
    purpose_id           TEXT,
    legal_basis_tag      TEXT,

    -- Payload. DELTA ONLY - never the whole row. Full before/after across 100-200M
    -- rows over ten years would exceed 200GB.
    changed_columns      TEXT[],
    before               JSONB,
    after                JSONB,
    field_classes        TEXT[],
    reason               TEXT,

    -- Integrity
    outbox_event_id      BIGINT,
    prev_hash            BYTEA,
    row_hash             BYTEA,
    txid                 BIGINT      NOT NULL DEFAULT txid_current(),

    PRIMARY KEY (occurred_at, id),

    CONSTRAINT ck_audit_source     CHECK (source IN ('trigger', 'application')),
    CONSTRAINT ck_audit_actor_kind CHECK (actor_kind IN ('user', 'system', 'service', 'migration')),
    CONSTRAINT ck_audit_operation  CHECK (operation IS NULL OR operation IN ('I', 'U', 'D')),
    -- A trigger row must say which table; an application row must say which event.
    CONSTRAINT ck_audit_shape CHECK (
        (source = 'trigger'     AND table_name IS NOT NULL AND operation IS NOT NULL)
     OR (source = 'application' AND event_type IS NOT NULL)
    )
) PARTITION BY RANGE (occurred_at);

COMMENT ON TABLE audit_event IS
    'Append-only, partitioned monthly. Retention drives partitioning more than size does.';
COMMENT ON COLUMN audit_event.subject_employee_id IS
    'Whose data was involved. Required for investigation and for DPDP breach-scope '
    'enumeration. Distinct from row_pk, which identifies the changed row.';

CREATE TRIGGER tg_audit_append_only
    BEFORE UPDATE OR DELETE ON audit_event
    FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();


-- Partition management --------------------------------------------------------
--
-- A missing future partition means every INSERT fails at 00:00 on the 1st. That is a
-- guaranteed 2am page and it is entirely preventable, so partitions are created ahead
-- and a monitoring check asserts the newest bound stays >60 days out.

CREATE OR REPLACE FUNCTION fn_ensure_month_partition(p_parent TEXT, p_month DATE)
RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
    v_start DATE := date_trunc('month', p_month)::date;
    v_end   DATE := (date_trunc('month', p_month) + INTERVAL '1 month')::date;
    v_name  TEXT := format('%s_p%s', p_parent, to_char(v_start, 'YYYYMM'));
BEGIN
    IF to_regclass(v_name) IS NULL THEN
        EXECUTE format(
            'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
            v_name, p_parent, v_start, v_end);
    END IF;
    RETURN v_name;
END;
$$;

COMMENT ON FUNCTION fn_ensure_month_partition(TEXT, DATE) IS
    'Idempotent monthly partition creation. Call from a scheduled job with premake >= 3.';

-- Current month plus three ahead.
DO $$
DECLARE i INT;
BEGIN
    FOR i IN 0..3 LOOP
        PERFORM fn_ensure_month_partition('audit_event',
                    (date_trunc('month', now()) + (i || ' month')::interval)::date);
    END LOOP;
END;
$$;

-- Local indexes. Created on the parent so every partition inherits them.
CREATE INDEX ix_audit_event_subject
    ON audit_event (subject_employee_id, occurred_at DESC)
    WHERE subject_employee_id IS NOT NULL;

CREATE INDEX ix_audit_event_actor
    ON audit_event (actor_user_id, occurred_at DESC)
    WHERE actor_user_id IS NOT NULL;

CREATE INDEX ix_audit_event_correlation
    ON audit_event (correlation_id)
    WHERE correlation_id IS NOT NULL;

-- At-least-once delivery dedupe: the drain may retry, and the audit subscriber must
-- be idempotent. Partial, because trigger rows have no outbox id.
CREATE UNIQUE INDEX uq_audit_event_outbox
    ON audit_event (occurred_at, outbox_event_id)
    WHERE outbox_event_id IS NOT NULL;


-- ---------------------------------------------------------------------------
-- PII classification policy for audit payloads
--
-- Data-driven so legal can change a classification without a schema migration,
-- and so audit never becomes a second, less-protected copy of the PII estate.
-- ---------------------------------------------------------------------------

CREATE TABLE audit_column_policy (
    table_name  TEXT NOT NULL,
    column_name TEXT NOT NULL,
    mode        TEXT NOT NULL,
    rationale   TEXT,
    PRIMARY KEY (table_name, column_name),
    CONSTRAINT ck_audit_column_policy_mode
        CHECK (mode IN ('full', 'redact', 'fingerprint', 'omit'))
);

COMMENT ON TABLE audit_column_policy IS
    'full=store value; redact=store [redacted]; fingerprint=keyed HMAC (proves a change '
    'without holding the value); omit=absent from changed_columns entirely.';


-- ---------------------------------------------------------------------------
-- Post-migration assertions
--
-- Every migration proves it did what it claimed. A migration that silently did
-- nothing is worse than one that failed loudly.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF to_regclass('outbox_event') IS NULL THEN
        RAISE EXCEPTION 'assertion failed: outbox_event was not created';
    END IF;

    IF to_regclass('audit_event') IS NULL THEN
        RAISE EXCEPTION 'assertion failed: audit_event was not created';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_partitioned_table pt
                    JOIN pg_class c ON c.oid = pt.partrelid
                   WHERE c.relname = 'audit_event') THEN
        RAISE EXCEPTION 'assertion failed: audit_event is not partitioned';
    END IF;

    IF (SELECT count(*) FROM pg_inherits i
         JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = 'audit_event') < 4 THEN
        RAISE EXCEPTION 'assertion failed: expected >= 4 audit partitions (current + 3 ahead)';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') THEN
        RAISE EXCEPTION 'assertion failed: btree_gist is required for effective-dated tables';
    END IF;
END;
$$;

COMMIT;
