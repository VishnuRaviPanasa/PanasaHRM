-- =============================================================================
-- Verification for 0006: outbox retention, dead-letter, full immutability
-- Closes the three ADR-0008 items the first review found specified but unbuilt.
-- =============================================================================

-- O1: a PENDING event is still undeletable. This is the property that must not regress.
DO $$
DECLARE v_id BIGINT; v_ok BOOLEAN := false;
BEGIN
    INSERT INTO outbox_event (event_type, aggregate_type, aggregate_id, payload)
    VALUES ('test.thing.made', 'thing', gen_random_uuid(), '{}'::jsonb) RETURNING id INTO v_id;
    BEGIN
        DELETE FROM outbox_event WHERE id = v_id;
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  O1 a pending outbox event cannot be deleted';
    ELSE RAISE EXCEPTION 'FAIL  O1 an undelivered event was deleted - audit and notifications lost';
    END IF;
END $$;

-- O2: a PROCESSED event inside the retention window is still undeletable.
DO $$
DECLARE v_id BIGINT; v_ok BOOLEAN := false;
BEGIN
    INSERT INTO outbox_event (event_type, aggregate_type, aggregate_id, payload, processed_at)
    VALUES ('test.thing.made', 'thing', gen_random_uuid(), '{}'::jsonb, now())
    RETURNING id INTO v_id;
    BEGIN
        DELETE FROM outbox_event WHERE id = v_id;
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  O2 a recently-processed event is still protected';
    ELSE RAISE EXCEPTION 'FAIL  O2 retention window not enforced'; END IF;
END $$;

-- O3: THE POINT OF THIS MIGRATION. A processed event past the window can be pruned, so the
-- retention sweep ADR-0008 requires is finally possible. Before 0006 there was no DELETE path
-- and no DETACH path - the table could only grow.
DO $$
DECLARE v_id BIGINT; v_gone BOOLEAN;
BEGIN
    INSERT INTO outbox_event (event_type, aggregate_type, aggregate_id, payload, processed_at)
    VALUES ('test.thing.made', 'thing', gen_random_uuid(), '{}'::jsonb, now() - INTERVAL '200 days')
    RETURNING id INTO v_id;
    DELETE FROM outbox_event WHERE id = v_id;
    v_gone := NOT EXISTS (SELECT 1 FROM outbox_event WHERE id = v_id);
    IF v_gone THEN RAISE NOTICE 'PASS  O3 an aged-out processed event can be pruned';
    ELSE RAISE EXCEPTION 'FAIL  O3 retention sweep is still impossible'; END IF;
END $$;

-- O4: the retention window is configuration, not a literal (Must-Know Rule 11).
DO $$
DECLARE v_id BIGINT; v_ok BOOLEAN := false;
BEGIN
    INSERT INTO outbox_event (event_type, aggregate_type, aggregate_id, payload, processed_at)
    VALUES ('test.thing.made', 'thing', gen_random_uuid(), '{}'::jsonb, now() - INTERVAL '10 days')
    RETURNING id INTO v_id;
    BEGIN
        DELETE FROM outbox_event WHERE id = v_id;      -- inside the default 90-day window
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN RAISE EXCEPTION 'FAIL  O4 default retention window not applied'; END IF;
    SET LOCAL hrm.outbox_retention = '5 days';
    DELETE FROM outbox_event WHERE id = v_id;          -- now outside a narrower window
    RESET hrm.outbox_retention;
    RAISE NOTICE 'PASS  O4 the retention window is configurable, not hardcoded';
END $$;

-- O5: dead-letter. A poison message must have somewhere terminal to go.
DO $$
DECLARE v_id BIGINT; v_pending INT;
BEGIN
    INSERT INTO outbox_event (event_type, aggregate_type, aggregate_id, payload, attempts)
    VALUES ('test.thing.poisoned', 'thing', gen_random_uuid(), '{}'::jsonb, 100)
    RETURNING id INTO v_id;
    UPDATE outbox_event
       SET dead_lettered_at = now(), dead_letter_reason = 'subscriber rejects it permanently'
     WHERE id = v_id;
    SELECT count(*) INTO v_pending FROM outbox_event
     WHERE id = v_id AND processed_at IS NULL AND dead_lettered_at IS NULL;
    IF v_pending = 0 THEN
        RAISE NOTICE 'PASS  O5 an event at the attempts ceiling can be dead-lettered out of pending';
    ELSE
        RAISE EXCEPTION 'FAIL  O5 a poison message is still trapped in the pending set';
    END IF;
END $$;

-- O6: a dead-lettered event cannot masquerade as delivered.
DO $$
DECLARE v_id BIGINT; v_ok BOOLEAN := false;
BEGIN
    INSERT INTO outbox_event (event_type, aggregate_type, aggregate_id, payload)
    VALUES ('test.thing.made', 'thing', gen_random_uuid(), '{}'::jsonb) RETURNING id INTO v_id;
    BEGIN
        UPDATE outbox_event
           SET dead_lettered_at = now(), dead_letter_reason = 'x', processed_at = now()
         WHERE id = v_id;
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  O6 dead-lettered and processed are mutually exclusive';
    ELSE RAISE EXCEPTION 'FAIL  O6 an undelivered event could claim delivery'; END IF;
END $$;

-- O7: THE ACCOUNTABILITY COLUMNS. Test T9 passed while these were freely rewritable, because it
-- only ever tested `payload`. ADR-0008 calls these the event's "by whom, in which request".
DO $$
DECLARE v_id BIGINT; v_actor BOOLEAN := false; v_corr BOOLEAN := false; v_agg BOOLEAN := false;
BEGIN
    INSERT INTO outbox_event (event_type, aggregate_type, aggregate_id, payload,
                              actor_user_id, correlation_id)
    VALUES ('test.thing.made', 'thing', gen_random_uuid(), '{}'::jsonb,
            gen_random_uuid(), gen_random_uuid())
    RETURNING id INTO v_id;

    BEGIN UPDATE outbox_event SET actor_user_id = gen_random_uuid() WHERE id = v_id;
    EXCEPTION WHEN restrict_violation THEN v_actor := true; END;
    BEGIN UPDATE outbox_event SET correlation_id = gen_random_uuid() WHERE id = v_id;
    EXCEPTION WHEN restrict_violation THEN v_corr := true; END;
    BEGIN UPDATE outbox_event SET aggregate_type = 'other' WHERE id = v_id;
    EXCEPTION WHEN restrict_violation THEN v_agg := true; END;

    IF v_actor AND v_corr AND v_agg THEN
        RAISE NOTICE 'PASS  O7 actor_user_id, correlation_id and aggregate_type are immutable';
    ELSE
        RAISE EXCEPTION 'FAIL  O7 accountability columns rewritable (actor=%, corr=%, agg=%)',
            v_actor, v_corr, v_agg;
    END IF;
END $$;

-- O8: drain bookkeeping must stay writable, or the worker cannot function.
DO $$
DECLARE v_id BIGINT; v_ok BOOLEAN := true;
BEGIN
    INSERT INTO outbox_event (event_type, aggregate_type, aggregate_id, payload)
    VALUES ('test.thing.made', 'thing', gen_random_uuid(), '{}'::jsonb) RETURNING id INTO v_id;
    BEGIN
        UPDATE outbox_event
           SET processed_at = now(), attempts = attempts + 1, last_error = NULL,
               available_at = now() + INTERVAL '1 minute'
         WHERE id = v_id;
    EXCEPTION WHEN OTHERS THEN v_ok := false;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  O8 drain bookkeeping columns remain writable';
    ELSE RAISE EXCEPTION 'FAIL  O8 the drain worker cannot record its own progress'; END IF;
END $$;

SELECT 'OUTBOX RETENTION VERIFICATION COMPLETE' AS result;
