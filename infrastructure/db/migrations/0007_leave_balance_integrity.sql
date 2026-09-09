-- =============================================================================
-- 0007  ADR-0006: leave balance integrity - ledger plus a constrained account row
-- =============================================================================
--
-- WHY THIS ARRIVES NOW, AHEAD OF PHASE 6
--   ADR-0006 carries an acceptance precondition: it must not be accepted until the database
--   anti-overdraw mechanism is implemented and concurrency-tested. The mechanism IS the decision -
--   accepting it while it exists only on paper would ratify a guarantee nothing provides. This
--   migration therefore builds exactly what ADR-0006 specifies and nothing else: no leave_request,
--   no accrual engine, no encashment workflow. Those remain Phase 6.
--
-- THE MECHANISM, and why each half is needed
--   `leave_ledger` is append-only and AUTHORITATIVE. It gives reversal, provenance and
--   reconstruction, and append-only is enforceable by trigger.
--
--   `leave_account` is a DERIVED projection whose only purpose is to host a constraint an
--   aggregate cannot host. A CHECK is per-row and cannot reference a SUM, so a pure ledger fold
--   cannot prevent write skew: two concurrent transactions both read a balance of 2, both insert
--   -2, neither sees the other, and the inserts do not conflict.
--
--   The BEFORE INSERT trigger on leave_ledger does THREE things, and the order matters:
--     1. materialise the account row (INSERT ... ON CONFLICT DO NOTHING), THEN lock it.
--        `SELECT ... FOR UPDATE` on a row that does not exist locks NOTHING - which would leave
--        the serialisation point absent at exactly a first-ever request and at every new leave
--        year, the two moments this is most likely to be hit.
--     2. UPDATE the projection. This is the step that causes the CHECK to be evaluated; a lock
--        alone raises nothing, because a CHECK on leave_account fires only when leave_account is
--        written. The original ADR text specified the lock and omitted this, so the 23514 it
--        promised could never have occurred.
--     3. let the constraint decide. Overdraw rolls back the whole transaction, ledger row included.
--
-- THE RULE 6 EXCEPTION IS MECHANICALLY ENFORCED
--   Must-Know Rule 6 forbids mutating a balance directly. `leave_account` is written ONLY by this
--   trigger: it sets a transaction-local flag immediately before its UPDATE and clears it
--   immediately after, and a guard trigger on leave_account refuses any UPDATE without the flag.
--   That makes "exactly one writer, whose only input is the ledger" a property of the schema
--   rather than a convention, which is what the exception recorded in ADR-0006 claims.
--
-- Change class: C (schema, leave arithmetic). Non-destructive: creates tables and triggers.
-- =============================================================================

BEGIN;

CREATE TABLE leave_account (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id        UUID     NOT NULL,
    leave_type_id      UUID     NOT NULL REFERENCES leave_type(id),
    leave_year         SMALLINT NOT NULL,

    -- The seven components of the balance, all NUMERIC. Must-Know Rule 4: never floating point.
    accrued            NUMERIC(8,2) NOT NULL DEFAULT 0,
    carried_in         NUMERIC(8,2) NOT NULL DEFAULT 0,
    adjusted           NUMERIC(8,2) NOT NULL DEFAULT 0,
    taken              NUMERIC(8,2) NOT NULL DEFAULT 0,
    pending            NUMERIC(8,2) NOT NULL DEFAULT 0,
    encashed           NUMERIC(8,2) NOT NULL DEFAULT 0,
    lapsed             NUMERIC(8,2) NOT NULL DEFAULT 0,

    -- Denormalised from the effective-dated policy. Refreshed only when a ledger entry is written
    -- under a newer policy version, so it can never silently lag behind the value being enforced.
    allowed_negative   NUMERIC(8,2) NOT NULL DEFAULT 0,

    available          NUMERIC(8,2) GENERATED ALWAYS AS
                           (accrued + carried_in + adjusted - taken - pending - encashed - lapsed)
                           STORED,

    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_leave_account UNIQUE (employee_id, leave_type_id, leave_year),

    -- THE constraint. Verified legal on PostgreSQL 18: a CHECK may reference a stored generated
    -- column. Written against the generated column rather than repeating the expression so the
    -- two can never drift apart.
    CONSTRAINT ck_leave_account_no_overdraw CHECK (available >= -allowed_negative),

    CONSTRAINT ck_leave_account_components_sane
        CHECK (accrued >= 0 AND carried_in >= 0 AND taken >= 0
           AND pending >= 0 AND encashed >= 0 AND lapsed >= 0
           AND allowed_negative >= 0)
);

COMMENT ON TABLE leave_account IS
    'DERIVED projection of leave_ledger. Never a source of truth: if the two disagree the ledger '
    'is right by definition. Exists solely to host ck_leave_account_no_overdraw, which an '
    'aggregate cannot host.';

CREATE TABLE leave_ledger (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    employee_id        UUID     NOT NULL,
    leave_type_id      UUID     NOT NULL REFERENCES leave_type(id),
    leave_year         SMALLINT NOT NULL,

    entry_type         TEXT     NOT NULL,
    days               NUMERIC(8,2) NOT NULL,

    -- §9 amendment: the resolved policy VERSION, not the leave type and not a read-time lookup.
    -- Without it, "why is my balance 12 and not 15" is unanswerable the moment policy changes,
    -- and a re-run under a newer policy cannot be told apart from a genuine correction.
    leave_policy_id    UUID     REFERENCES leave_policy(id),

    -- FIFO lot tracking: expiring lots are consumed before fresh accrual, which is what prevents
    -- "my leave lapsed even though I took it".
    consumes_ledger_id BIGINT   REFERENCES leave_ledger(id),

    reason             TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by_user_id UUID,

    CONSTRAINT ck_leave_ledger_entry_type CHECK (entry_type IN
        ('accrual', 'carry_in', 'adjust', 'hold', 'release', 'take', 'encash', 'lapse')),
    CONSTRAINT ck_leave_ledger_days_nonzero CHECK (days <> 0)
);

CREATE INDEX ix_leave_ledger_account
    ON leave_ledger (employee_id, leave_type_id, leave_year, id);

COMMENT ON TABLE leave_ledger IS
    'Append-only and AUTHORITATIVE. Balance is a fold of this table; leave_account is a cache of '
    'that fold carrying the anti-overdraw constraint.';

-- ---------------------------------------------------------------------------
-- The trigger: materialise, lock, project, let the constraint decide
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_leave_ledger_apply() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_id      uuid;
    v_allowed numeric(8,2);
BEGIN
    -- 1. MATERIALISE, then lock. The insert must come first: FOR UPDATE on a non-existent row
    --    locks nothing, so without this the serialisation point vanishes exactly at a first-ever
    --    request and at the first request of a new leave year.
    INSERT INTO public.leave_account (employee_id, leave_type_id, leave_year)
    VALUES (NEW.employee_id, NEW.leave_type_id, NEW.leave_year)
    ON CONFLICT ON CONSTRAINT uq_leave_account DO NOTHING;

    SELECT id INTO v_id
      FROM public.leave_account
     WHERE employee_id = NEW.employee_id
       AND leave_type_id = NEW.leave_type_id
       AND leave_year = NEW.leave_year
       FOR UPDATE;

    IF v_id IS NULL THEN
        -- A concurrent inserter won the race and has not committed yet; ON CONFLICT DO NOTHING
        -- returns no row and the subsequent SELECT cannot see theirs. Block on their lock.
        PERFORM 1 FROM public.leave_account
          WHERE employee_id = NEW.employee_id
            AND leave_type_id = NEW.leave_type_id
            AND leave_year = NEW.leave_year
          FOR UPDATE;
        SELECT id INTO v_id
          FROM public.leave_account
         WHERE employee_id = NEW.employee_id
           AND leave_type_id = NEW.leave_type_id
           AND leave_year = NEW.leave_year
           FOR UPDATE;
        IF v_id IS NULL THEN
            RAISE EXCEPTION 'leave_account could not be materialised for (%, %, %)',
                NEW.employee_id, NEW.leave_type_id, NEW.leave_year
                USING ERRCODE = 'internal_error';
        END IF;
    END IF;

    -- Refresh the denormalised limit from the policy version this entry was written under, so it
    -- cannot enforce a stale allowance.
    IF NEW.leave_policy_id IS NOT NULL THEN
        SELECT CASE WHEN p.allow_negative_balance THEN p.max_negative_days ELSE 0 END
          INTO v_allowed
          FROM public.leave_policy p WHERE p.id = NEW.leave_policy_id;
    END IF;

    -- 2. PROJECT. This write is what causes the CHECK to be evaluated - a lock alone raises
    --    nothing. The flag makes this the only sanctioned writer (Rule 6 exception).
    PERFORM set_config('hrm.leave_account_writer', 'on', true);

    UPDATE public.leave_account SET
        accrued          = accrued    + CASE WHEN NEW.entry_type = 'accrual'  THEN NEW.days ELSE 0 END,
        carried_in       = carried_in + CASE WHEN NEW.entry_type = 'carry_in' THEN NEW.days ELSE 0 END,
        adjusted         = adjusted   + CASE WHEN NEW.entry_type = 'adjust'   THEN NEW.days ELSE 0 END,
        pending          = pending    + CASE WHEN NEW.entry_type = 'hold'     THEN NEW.days
                                             WHEN NEW.entry_type = 'release'  THEN -NEW.days
                                             WHEN NEW.entry_type = 'take'     THEN -NEW.days
                                             ELSE 0 END,
        taken            = taken      + CASE WHEN NEW.entry_type = 'take'     THEN NEW.days ELSE 0 END,
        encashed         = encashed   + CASE WHEN NEW.entry_type = 'encash'   THEN NEW.days ELSE 0 END,
        lapsed           = lapsed     + CASE WHEN NEW.entry_type = 'lapse'    THEN NEW.days ELSE 0 END,
        allowed_negative = coalesce(v_allowed, allowed_negative),
        updated_at       = now()
     WHERE id = v_id;

    PERFORM set_config('hrm.leave_account_writer', 'off', true);

    -- 3. The CHECK has now either passed or aborted the transaction.
    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_leave_ledger_apply
    BEFORE INSERT ON leave_ledger
    FOR EACH ROW EXECUTE FUNCTION fn_leave_ledger_apply();

-- The ledger is append-only.
CREATE TRIGGER tg_leave_ledger_no_update
    BEFORE UPDATE OR DELETE ON leave_ledger
    FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();
CREATE TRIGGER tg_leave_ledger_no_truncate
    BEFORE TRUNCATE ON leave_ledger
    FOR EACH STATEMENT EXECUTE FUNCTION fn_block_mutation();

-- ---------------------------------------------------------------------------
-- Rule 6, enforced rather than promised: exactly one writer of leave_account
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_leave_account_writer_guard() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF coalesce(current_setting('hrm.leave_account_writer', true), 'off') <> 'on' THEN
        RAISE EXCEPTION
            'leave_account is derived and may only be written by the leave_ledger trigger '
            '(Must-Know Rule 6)'
            USING ERRCODE = 'restrict_violation',
                  HINT = 'Append a leave_ledger entry. The balance is a consequence, never an '
                         'input. Direct UPDATE would let a balance be set independently of the '
                         'ledger, which is the exact failure Rule 6 exists to prevent.';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_leave_account_writer_guard
    BEFORE UPDATE ON leave_account
    FOR EACH ROW EXECUTE FUNCTION fn_leave_account_writer_guard();

CREATE TRIGGER tg_leave_account_no_delete
    BEFORE DELETE ON leave_account
    FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();
CREATE TRIGGER tg_leave_account_no_truncate
    BEFORE TRUNCATE ON leave_account
    FOR EACH STATEMENT EXECUTE FUNCTION fn_block_mutation();

ALTER TABLE leave_ledger  ENABLE ALWAYS TRIGGER tg_leave_ledger_apply;
ALTER TABLE leave_ledger  ENABLE ALWAYS TRIGGER tg_leave_ledger_no_update;
ALTER TABLE leave_ledger  ENABLE ALWAYS TRIGGER tg_leave_ledger_no_truncate;
ALTER TABLE leave_account ENABLE ALWAYS TRIGGER tg_leave_account_writer_guard;
ALTER TABLE leave_account ENABLE ALWAYS TRIGGER tg_leave_account_no_delete;
ALTER TABLE leave_account ENABLE ALWAYS TRIGGER tg_leave_account_no_truncate;

COMMIT;
