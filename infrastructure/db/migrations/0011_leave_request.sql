-- =============================================================================
-- 0011  Leave request - the approvable unit
-- =============================================================================
--
-- TRACK A. The request is what a human submits; the LEDGER is what moves the balance. The two
-- are linked so the demo can show that an approval is not a status flip - it posts a real ledger
-- entry, and the balance is a consequence.
--
--   apply   -> leave_request(pending) + leave_ledger 'hold'    => available drops immediately
--   approve -> leave_request(approved) + leave_ledger 'take'   => hold becomes consumption
--   reject  -> leave_request(rejected) + leave_ledger 'release'=> the hold is returned
--
-- That is why the demo's 8 -> 5 is arithmetic rather than a number in a template: holding 3 days
-- reduces `available` the moment the request is submitted, which is also the correct behaviour
-- (two overlapping requests cannot both be funded by the same balance).
--
-- DEMO-GRADE, FLAGGED FOR TRACK B:
--   * `status` is a column with a CHECK. ADR-0007 requires the approval flow to be table-driven
--     workflow data so a new flow is configuration, not code. This is code. TRACK B.
--   * The approver is resolved as "the employee's current manager". ADR-0007 requires an actor
--     rule resolved at submission and frozen into a task row, with a mandatory fallback chain.
--     TRACK B.
--   * No overlap check against existing approved leave, no sandwich rule, no notice-period
--     validation. Those are Phase 6 leave arithmetic and OR-06/OR-08 are still open.
--
-- Change class: C (schema, leave arithmetic).
-- =============================================================================

BEGIN;

CREATE TABLE leave_request (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id     UUID NOT NULL REFERENCES employee(id),
    leave_type_id   UUID NOT NULL REFERENCES leave_type(id),

    from_date       DATE NOT NULL,                 -- Rule 5
    to_date         DATE NOT NULL,
    working_days    NUMERIC(5,2) NOT NULL,         -- Rule 4: numeric, never float
    reason          TEXT,

    status          TEXT NOT NULL DEFAULT 'pending',

    -- The ledger entries this request caused. Provenance in both directions.
    hold_ledger_id     BIGINT REFERENCES leave_ledger(id),
    settle_ledger_id   BIGINT REFERENCES leave_ledger(id),

    submitted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at      TIMESTAMPTZ,
    decided_by      UUID REFERENCES employee(id),
    decision_note   TEXT,

    CONSTRAINT ck_leave_request_range   CHECK (to_date >= from_date),
    CONSTRAINT ck_leave_request_days    CHECK (working_days > 0),
    CONSTRAINT ck_leave_request_status  CHECK (status IN ('pending','approved','rejected','cancelled')),
    CONSTRAINT ck_leave_request_decision_coherent
        CHECK ((status IN ('approved','rejected','cancelled')) = (decided_at IS NOT NULL))
);

CREATE INDEX ix_leave_request_employee ON leave_request (employee_id, submitted_at DESC);
CREATE INDEX ix_leave_request_pending  ON leave_request (status) WHERE status = 'pending';

COMMENT ON TABLE leave_request IS
    'The approvable unit. It does NOT hold a balance - leave_ledger does. An approval posts a '
    'ledger entry; the balance is derived. TRACK B: the status column must become ADR-0007 '
    'workflow data.';

COMMIT;
