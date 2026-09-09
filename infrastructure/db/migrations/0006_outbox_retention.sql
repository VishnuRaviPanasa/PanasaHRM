-- =============================================================================
-- 0006  Outbox: retention, dead-letter, and full accountability immutability
-- =============================================================================
--
-- Closes the three ADR-0008 items the verification found specified but unbuilt (OR-10 / OR-11a).
--
--   1. RETENTION WAS STRUCTURALLY IMPOSSIBLE. ADR-0008 says the outbox "needs a retention sweep
--      or it grows without bound", but `tg_outbox_no_delete` blocked every DELETE and the table
--      is not partitioned. There was no DELETE path and no DETACH path - the table could only
--      ever grow. `audit_event` was partitioned specifically to make this tractable; the outbox
--      got the append-only trigger without the partitioning.
--
--   2. A POISON MESSAGE HAD NOWHERE TO GO. `CHECK (attempts <= 100)` meant that at attempt 100
--      the worker's own error-handling UPDATE raised 23514, so a permanently failing event could
--      neither advance nor be marked done. It sat in the pending partial index forever,
--      corrupting the drain-lag metric that is the only alert on this path.
--
--   3. IMMUTABILITY OMITTED THE ACCOUNTABILITY COLUMNS. The trigger guarded event_type,
--      aggregate_id, payload and occurred_at - but `actor_user_id` and `correlation_id`, which
--      ADR-0008 calls the event's "by whom, in which request", were freely rewritable. Test T9
--      passed because it only ever tested `payload`.
--
-- WHY DELETION RATHER THAN PARTITIONING
--   Partitioning would mean recreating the table, which is a destructive migration on an object
--   other rows already reference by id. The property that actually matters is *an event cannot
--   be removed before it has been dealt with* - not that rows live forever. So the blanket
--   no-DELETE trigger is replaced by one that permits deletion ONLY of rows that are terminal
--   (processed or dead-lettered) AND older than a retention window. A live or pending event is
--   as undeletable as it was before. If volume later justifies partitioning, that is a separate
--   decision and this constraint does not block it.
--
-- Change class: C (schema, audit/outbox). Adds columns and a function; replaces two triggers and
-- one partial index. No row is deleted by this migration.
--
-- IRREVERSIBLE: drops ix_outbox_event_pending and recreates it immediately below with
-- dead-lettered rows excluded, and drops tg_outbox_no_delete in favour of the retention-aware
-- tg_outbox_delete_guard. No data is lost by either - the marker is required because the commit
-- guard correctly treats DROP INDEX and DROP TRIGGER as destructive DDL and demands that any
-- such change be acknowledged rather than slipped through.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 2. Dead-letter state
-- ---------------------------------------------------------------------------
ALTER TABLE outbox_event ADD COLUMN dead_lettered_at TIMESTAMPTZ;
ALTER TABLE outbox_event ADD COLUMN dead_letter_reason TEXT;

COMMENT ON COLUMN outbox_event.dead_lettered_at IS
    'Terminal failure. The event was NOT delivered, so everything downstream of it is missing - '
    'a non-zero count here is an incident, not a cleanup queue.';

-- A dead-lettered event must have a reason, and must not also claim to have been processed.
ALTER TABLE outbox_event ADD CONSTRAINT ck_outbox_dead_letter_coherent
    CHECK ( (dead_lettered_at IS NULL AND dead_letter_reason IS NULL)
         OR (dead_lettered_at IS NOT NULL AND dead_letter_reason IS NOT NULL
             AND processed_at IS NULL) );

-- The attempts ceiling stays as a sanity bound, but a worker at the ceiling must now have a
-- terminal state available to move the row into, rather than being trapped by its own CHECK.
COMMENT ON CONSTRAINT ck_outbox_attempts_sane ON outbox_event IS
    'A bound on retries, not a trap: on reaching it the drain must set dead_lettered_at rather '
    'than incrementing further. Before migration 0006 there was no terminal state to move to.';

-- The pending index must not retain dead-lettered rows, or the backlog metric is permanently
-- wrong and the drain re-reads rows it has already given up on.
DROP INDEX ix_outbox_event_pending;
CREATE INDEX ix_outbox_event_pending
    ON outbox_event (available_at, id)
    WHERE processed_at IS NULL AND dead_lettered_at IS NULL;

-- Finding a poison message must be cheap.
CREATE INDEX ix_outbox_event_dead_lettered
    ON outbox_event (dead_lettered_at DESC)
    WHERE dead_lettered_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Immutability now covers who and which request
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_outbox_immutable_payload() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF NEW.event_type      IS DISTINCT FROM OLD.event_type
    OR NEW.aggregate_type  IS DISTINCT FROM OLD.aggregate_type
    OR NEW.aggregate_id    IS DISTINCT FROM OLD.aggregate_id
    OR NEW.payload         IS DISTINCT FROM OLD.payload
    OR NEW.occurred_at     IS DISTINCT FROM OLD.occurred_at
    OR NEW.actor_user_id   IS DISTINCT FROM OLD.actor_user_id
    OR NEW.correlation_id  IS DISTINCT FROM OLD.correlation_id
    OR NEW.causation_id    IS DISTINCT FROM OLD.causation_id THEN
        RAISE EXCEPTION
            'outbox_event content is immutable; only drain bookkeeping may change '
            '(processed_at, available_at, attempts, last_error, dead_lettered_at, '
            'dead_letter_reason)'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 1. Retention
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_outbox_delete_guard() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_retention INTERVAL;
BEGIN
    -- Deliberately read per-statement rather than hardcoded: the retention window is policy
    -- (Must-Know Rule 11), and a sweep must not be able to widen it by passing an argument.
    v_retention := coalesce(
        current_setting('hrm.outbox_retention', true), '90 days')::interval;

    IF OLD.processed_at IS NOT NULL AND OLD.processed_at < now() - v_retention THEN
        RETURN OLD;                       -- delivered, and aged out
    END IF;
    IF OLD.dead_lettered_at IS NOT NULL AND OLD.dead_lettered_at < now() - v_retention THEN
        RETURN OLD;                       -- terminally failed, investigated, aged out
    END IF;

    RAISE EXCEPTION
        'outbox_event % may not be deleted: it is % (retention window %)',
        OLD.id,
        CASE WHEN OLD.processed_at IS NULL AND OLD.dead_lettered_at IS NULL
             THEN 'still pending delivery'
             ELSE 'terminal but inside the retention window' END,
        v_retention
        USING ERRCODE = 'restrict_violation',
              HINT = 'Only a delivered or dead-lettered event older than the retention window '
                     'may be pruned. A pending event is undeletable by design - removing one '
                     'silently drops the audit record and every notification it would produce.';
END;
$$;

DROP TRIGGER tg_outbox_no_delete ON outbox_event;

CREATE TRIGGER tg_outbox_delete_guard
    BEFORE DELETE ON outbox_event
    FOR EACH ROW EXECUTE FUNCTION fn_outbox_delete_guard();

ALTER TABLE outbox_event ENABLE ALWAYS TRIGGER tg_outbox_delete_guard;

COMMENT ON FUNCTION fn_outbox_delete_guard() IS
    'Replaces the blanket no-DELETE rail. A pending event stays undeletable; a terminal one '
    'becomes prunable once it is older than hrm.outbox_retention (default 90 days). This is what '
    'makes the retention sweep ADR-0008 requires actually possible.';

COMMIT;
