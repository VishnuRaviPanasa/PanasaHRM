-- =============================================================================
-- 0024  Payslip records
-- =============================================================================
--
-- WHAT THIS IS NOT: A PAYROLL ENGINE.
--
-- ADR-0012 (a versioned statutory rules engine) is **Proposed - BLOCKED, do not accept**, held by
-- plan question Q10: is payroll built here, or bought? This migration deliberately makes no bet
-- on that answer. HR enters a payroll result that has ALREADY been finalised somewhere else and
-- attaches the PDF that was issued from it. There is no PF, ESI, PT or TDS logic here, no rate
-- table, no rounding rule - all four are named in ADR-0012 as still-unresolved amendments, and
-- inventing any of them here would pre-empt a decision that is explicitly a human's.
--
-- `payslip.source` exists precisely to keep that boundary legible. Every row written today says
-- `manual_entry`. When an engine does land, its rows will say something else, and ADR-0012's
-- requirement to record the resolved rule version per line will apply to those rows and not to
-- these - so nobody will ever mistake a hand-typed figure for a rule-derived one.
--
-- THE ONE INVARIANT THIS SCHEMA EXISTS TO ENFORCE.
--
-- A payslip is two things that must agree: a PDF that somebody will treat as the authoritative
-- statement of pay, and structured rows that the application will show, total and report on. If
-- those two disagree, the product is actively lying to an employee about their wages.
--
-- So `declared_net_minor` is *what the PDF says*, typed in by HR, and the line items are the
-- structured data. `fn_payslip_totals` derives the net from the lines. A payslip **cannot be
-- issued** unless the derived net equals the declared net, the document is attached, its scan is
-- clean, and it belongs to the same employee. Correspondence is a constraint, not a convention -
-- which matters because the failure mode is silent and the reader has no way to detect it.
--
-- MONEY IS INTEGER PAISE (Rule 4). `bigint`, never a float and never a double dressed up as
-- `real`. Minor units rather than `numeric` because these values are summed constantly and an
-- integer sum has no rounding behaviour to reason about at all.
--
-- AMOUNTS MAY BE NEGATIVE, AND THAT IS DELIBERATE. Arrears, clawbacks and a refunded deduction
-- are ordinary payroll events; a `CHECK (amount_minor > 0)` would force HR to fake them as a
-- component of the opposite kind, which corrupts the earning/deduction split that gross and total
-- deductions are derived from. Zero is refused, because a zero line is noise pretending to be
-- information.
--
-- STATUS MOVES ONLY THROUGH THE EVENT LOG, and the legal moves are DATA (DEC-033, DEC-058).
-- `payslip.status` is not directly writable: an INSERT into `payslip_event` is what moves it, the
-- log carries a composite FK onto the whole (event_type, from_status, to_status) triple, and the
-- triple is STORED on the event so a later edit to the transition table cannot reinterpret
-- recorded history.
--
-- NOBODY ISSUES THEIR OWN PAYSLIP. `ck_payslip_no_self_issue`, plus a trigger asserting the
-- denormalised subject still matches its parent - rbac-rules structural integrity item 1, both
-- halves, because a denormalised column that nothing verifies is a constraint on a lie.
--
-- VOIDING WITHDRAWS THE DOCUMENT, so a void payslip cannot leave a reachable orphan PDF. That is
-- the whole reason a payslip is never DELETEd: a deleted row takes its reason with it, and the
-- object in MinIO would outlive the only record that explained who was allowed to read it.
--
-- TIER 1: `hrm_app` IS REVOKED FROM EVERY TABLE HERE, AND THAT REVOKE IS LOAD-BEARING.
--
-- `rbac-rules.md` structural integrity item 5 requires compensation tables to sit behind a
-- separate DB role, "so a SQL injection in the leave module physically cannot read salary". That
-- is not the default here and the default is the dangerous direction: migration 0008 line 93 set
--
--     ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO hrm_app;
--
-- so **every new table grants SELECT to `hrm_app` automatically**. Left alone, these five tables
-- would have been readable by the same role that serves the leave module - Tier 1 isolation
-- silently opt-out rather than opt-in, for the single most sensitive class of table in the
-- system. The REVOKEs below are therefore the control, not paperwork, and check PS20 asserts
-- them so the next compensation table cannot quietly inherit the default.
--
-- Every function here is SECURITY INVOKER (the default, stated explicitly in the comments and
-- asserted by PS21). A SECURITY DEFINER function over these tables would hand back exactly the
-- read access the REVOKE just removed.
--
-- Class C - money, authorization, a new document class. Full gate.
-- Verified by testing/db/0024_payslip_records.verify.sql.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. The component catalogue: CONFIGURATION, not code (Rule 11)
-- -----------------------------------------------------------------------------
--
-- Rule 11 forbids hardcoding policy, and "the set of things that can appear on a payslip" is
-- policy of exactly the kind that changes without a deployment. `retired_on` is a DATE and not a
-- boolean for the reason DEC-044 gives about designations: a withdrawn component must stay valid
-- for the historical payslips that reference it while being refused for a NEW line, and only a
-- date can answer "was this retired when that payslip was drawn".

CREATE TABLE payslip_component_type (
    code            text PRIMARY KEY,
    name            text NOT NULL,
    kind            text NOT NULL,
    -- Marks a component whose rules a future payroll engine will own (ADR-0012). Today it is
    -- descriptive only: it changes no arithmetic, it just stops anybody reading the catalogue and
    -- concluding this system computed the figure.
    is_statutory    boolean NOT NULL DEFAULT false,
    display_order   smallint NOT NULL DEFAULT 100,
    retired_on      date,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT ck_psct_code CHECK (code ~ '^[a-z][a-z0-9_]*$'),
    CONSTRAINT ck_psct_kind CHECK (kind IN ('earning', 'deduction'))
);

COMMENT ON TABLE payslip_component_type IS
    'What may appear as a line on a payslip. Configuration (Rule 11), not an enum in code. '
    'is_statutory is descriptive only - no rule, rate or formula lives in this database; '
    'ADR-0012 is BLOCKED and owns that decision.';

INSERT INTO payslip_component_type (code, name, kind, is_statutory, display_order) VALUES
    ('basic',             'Basic',                        'earning',   false, 10),
    ('hra',              'House rent allowance',          'earning',   false, 20),
    ('conveyance',       'Conveyance allowance',          'earning',   false, 30),
    ('special_allowance','Special allowance',             'earning',   false, 40),
    ('bonus',            'Bonus',                         'earning',   false, 50),
    ('arrears',          'Arrears',                       'earning',   false, 60),
    ('pf_employee',      'Provident fund (employee)',     'deduction', true, 110),
    ('esi_employee',     'ESI (employee)',                'deduction', true, 120),
    ('professional_tax', 'Professional tax',              'deduction', true, 130),
    ('tds',              'Income tax deducted at source', 'deduction', true, 140),
    ('lwp_recovery',     'Loss of pay recovery',          'deduction', false, 150),
    ('advance_recovery', 'Salary advance recovery',       'deduction', false, 160);

-- -----------------------------------------------------------------------------
-- 2. The legal status moves, held as DATA
-- -----------------------------------------------------------------------------

CREATE TABLE payslip_status_transition (
    event_type  text NOT NULL,
    from_status text NOT NULL,
    to_status   text NOT NULL,
    PRIMARY KEY (event_type, from_status),
    CONSTRAINT uq_pst_triple UNIQUE (event_type, from_status, to_status)
);

COMMENT ON TABLE payslip_status_transition IS
    'The FSM as data (DEC-033). payslip_event carries a composite FK onto the whole triple, so an '
    'illegal move is refused by the database rather than by a service method a later code path '
    'forgets to call.';

INSERT INTO payslip_status_transition (event_type, from_status, to_status) VALUES
    ('issue', 'draft',  'issued'),
    -- Void from either state. A draft was a mistake; an issued payslip was wrong. Both are
    -- recorded rather than deleted, because the reason is the part that matters later.
    ('void',  'draft',  'void'),
    ('void',  'issued', 'void');

-- -----------------------------------------------------------------------------
-- 3. The payslip
-- -----------------------------------------------------------------------------

CREATE TABLE payslip (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id         uuid NOT NULL REFERENCES employee(id),

    -- Rule 5: a pay period is made of DATES. Stored as HR selects them - inclusive, "1 to 30
    -- September" - because that is what the PDF says and what a person recognises.
    period_start        date NOT NULL,
    period_end          date NOT NULL,
    -- ... and normalised to the repo's half-open convention for the overlap constraint, so a
    -- period ending the 30th and one starting the 1st are adjacent rather than overlapping.
    period              daterange GENERATED ALWAYS AS
                            (daterange(period_start, (period_end + 1), '[)')) STORED,
    pay_date            date,

    currency_code       text NOT NULL DEFAULT 'INR',

    status              text NOT NULL DEFAULT 'draft',

    -- THE FIGURE PRINTED ON THE PDF, typed in by HR. Not the total of the lines - that is
    -- derived by fn_payslip_totals. Keeping them apart is the entire point: two independently
    -- captured values that must agree before the payslip may be issued.
    declared_net_minor  bigint,

    -- Where these numbers came from. See the header: this keeps the ADR-0012 boundary legible.
    source              text NOT NULL DEFAULT 'manual_entry',

    -- The PDF. UNIQUE, so one document can never be the evidence for two payslips.
    document_id         uuid UNIQUE REFERENCES employee_document(id),

    note                text,

    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES employee(id),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    issued_at           timestamptz,
    issued_by           uuid REFERENCES employee(id),
    voided_at           timestamptz,
    voided_by           uuid REFERENCES employee(id),
    void_reason         text,

    CONSTRAINT ck_payslip_status   CHECK (status IN ('draft', 'issued', 'void')),
    CONSTRAINT ck_payslip_source   CHECK (source IN ('manual_entry')),
    CONSTRAINT ck_payslip_currency CHECK (currency_code ~ '^[A-Z]{3}$'),
    CONSTRAINT ck_payslip_period   CHECK (period_end >= period_start),
    -- Mandatory alongside every daterange in this schema: T12 proved an EMPTY range slips past an
    -- EXCLUDE constraint entirely, so the CHECK is what makes the EXCLUDE mean anything.
    CONSTRAINT ck_payslip_not_empty CHECK (NOT isempty(period)),
    CONSTRAINT ck_payslip_pay_date CHECK (pay_date IS NULL OR pay_date >= period_start),

    -- Issued and void bookkeeping must be coherent with the status, in BOTH directions - a status
    -- that says issued with no timestamp is not a record of anything.
    CONSTRAINT ck_payslip_issued_coherent
        CHECK ((status = 'issued') <= (issued_at IS NOT NULL AND issued_by IS NOT NULL)),
    CONSTRAINT ck_payslip_void_coherent
        CHECK ((status = 'void') = (voided_at IS NOT NULL AND void_reason IS NOT NULL)),
    -- An issued payslip must have its PDF and its declared figure. Enforced here as well as in
    -- the issue guard so the row cannot be left half-issued by any path at all.
    CONSTRAINT ck_payslip_issued_complete
        CHECK (status <> 'issued' OR (document_id IS NOT NULL AND declared_net_minor IS NOT NULL))
);

-- One live payslip per employee per period. Void ones are excluded so a corrected payslip can be
-- re-drawn for the same month, which is the ordinary reason to void one.
CREATE INDEX ix_payslip_employee ON payslip (employee_id, period_start DESC);
ALTER TABLE payslip ADD CONSTRAINT ex_payslip_one_live_per_period
    EXCLUDE USING gist (employee_id WITH =, period WITH &&) WHERE (status <> 'void');

COMMENT ON TABLE payslip IS
    'One payslip for one employee for one pay period. NOT a payroll computation: HR enters a '
    'result finalised elsewhere and attaches the issued PDF (ADR-0012 is BLOCKED on build-vs-buy '
    'and owns the engine decision). declared_net_minor is what the PDF says; the net derived from '
    'payslip_line must equal it before the payslip can be issued.';

COMMENT ON COLUMN payslip.declared_net_minor IS
    'Integer paise (Rule 4). The net pay PRINTED ON THE PDF, captured separately from the line '
    'items so the two can be required to agree - if they silently diverge the product is telling '
    'an employee the wrong thing about their wages.';

-- -----------------------------------------------------------------------------
-- 4. The lines
-- -----------------------------------------------------------------------------

CREATE TABLE payslip_line (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    payslip_id      uuid NOT NULL REFERENCES payslip(id) ON DELETE CASCADE,
    component_code  text NOT NULL REFERENCES payslip_component_type(code),
    amount_minor    bigint NOT NULL,
    note            text,
    created_at      timestamptz NOT NULL DEFAULT now(),

    -- One line per component. Two "Basic" rows on one payslip is a data-entry error, not a
    -- legitimate shape, and allowing it would make the derived gross unexplainable.
    CONSTRAINT uq_payslip_line UNIQUE (payslip_id, component_code),
    -- Negative is legal (arrears, clawback, a refunded deduction); zero is not. See the header.
    CONSTRAINT ck_payslip_line_amount CHECK (amount_minor <> 0)
);

CREATE INDEX ix_payslip_line_payslip ON payslip_line (payslip_id);

COMMENT ON COLUMN payslip_line.amount_minor IS
    'Integer paise (Rule 4), signed. The sign is an adjustment, not the earning/deduction split - '
    'that comes from payslip_component_type.kind, so a negative deduction is a refund and still '
    'counts against total deductions rather than silently becoming an earning.';

-- -----------------------------------------------------------------------------
-- 5. The append-only status log
-- -----------------------------------------------------------------------------

CREATE TABLE payslip_event (
    id                  bigserial PRIMARY KEY,
    payslip_id          uuid NOT NULL REFERENCES payslip(id),
    -- Denormalised so the no-self-issue rule can be a CHECK. Verified against the parent by
    -- tg_payslip_event_guard, because a denormalised column nothing checks is a constraint on a lie.
    subject_employee_id uuid NOT NULL REFERENCES employee(id),
    event_type          text NOT NULL,
    from_status         text NOT NULL,
    to_status           text NOT NULL,
    actor_employee_id   uuid REFERENCES employee(id),
    reason              text,
    occurred_at         timestamptz NOT NULL DEFAULT now(),

    -- The whole triple, so editing the transition table later cannot reinterpret this history.
    CONSTRAINT fk_payslip_event_transition
        FOREIGN KEY (event_type, from_status, to_status)
        REFERENCES payslip_status_transition (event_type, from_status, to_status),

    -- NOBODY ISSUES OR VOIDS THEIR OWN PAYSLIP. rbac-rules structural integrity item 1.
    CONSTRAINT ck_payslip_no_self_issue
        CHECK (actor_employee_id IS NULL OR actor_employee_id <> subject_employee_id),

    CONSTRAINT ck_payslip_event_void_reason
        CHECK (event_type <> 'void' OR (reason IS NOT NULL AND btrim(reason) <> ''))
);

CREATE INDEX ix_payslip_event_payslip ON payslip_event (payslip_id, id);

COMMENT ON TABLE payslip_event IS
    'Append-only. The ONLY way payslip.status moves. Carries the transition triple so a later '
    'policy edit cannot rewrite what happened, and forbids acting on your own payslip.';

-- -----------------------------------------------------------------------------
-- 6. Derived totals - the arithmetic lives in ONE place
-- -----------------------------------------------------------------------------
--
-- SECURITY INVOKER (the default, and deliberately not DEFINER): under the Tier 1 REVOKE below, a
-- DEFINER function over these tables would hand back exactly the read access that was removed.

CREATE OR REPLACE FUNCTION fn_payslip_totals(p_payslip_id uuid)
RETURNS TABLE (
    gross_minor      bigint,
    deductions_minor bigint,
    net_minor        bigint,
    line_count       integer
)
LANGUAGE sql STABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
    SELECT
        coalesce(sum(l.amount_minor) FILTER (WHERE t.kind = 'earning'), 0)::bigint,
        coalesce(sum(l.amount_minor) FILTER (WHERE t.kind = 'deduction'), 0)::bigint,
        (coalesce(sum(l.amount_minor) FILTER (WHERE t.kind = 'earning'), 0)
         - coalesce(sum(l.amount_minor) FILTER (WHERE t.kind = 'deduction'), 0))::bigint,
        count(l.id)::integer
      FROM public.payslip_line l
      JOIN public.payslip_component_type t ON t.code = l.component_code
     WHERE l.payslip_id = p_payslip_id;
$$;

COMMENT ON FUNCTION fn_payslip_totals(uuid) IS
    'Gross, total deductions and net, derived from the lines in integer paise. The single '
    'definition of that arithmetic: a stored total that disagreed with its own lines would be a '
    'lie the database was helping to tell. SECURITY INVOKER on purpose - see 0024 header.';

-- -----------------------------------------------------------------------------
-- 7. A retired component cannot be used on a NEW line
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_payslip_line_component_active()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
DECLARE v_retired date;
BEGIN
    SELECT retired_on INTO v_retired
      FROM public.payslip_component_type WHERE code = NEW.component_code;

    IF v_retired IS NOT NULL AND v_retired <= public.fn_business_date() THEN
        RAISE EXCEPTION 'payslip component % was retired on %', NEW.component_code, v_retired
            USING HINT = 'Historical payslips keep it; new lines cannot use it.',
                  ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_payslip_line_component_active
    BEFORE INSERT ON payslip_line
    FOR EACH ROW EXECUTE FUNCTION fn_payslip_line_component_active();
ALTER TABLE payslip_line ENABLE ALWAYS TRIGGER tg_payslip_line_component_active;

-- -----------------------------------------------------------------------------
-- 8. An ISSUED payslip is frozen
-- -----------------------------------------------------------------------------
--
-- Lines are editable while the payslip is a draft and immutable afterwards. Without this the
-- correspondence enforced at issue time would last exactly until somebody edited a line.

CREATE OR REPLACE FUNCTION fn_payslip_line_frozen()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
DECLARE v_status text; v_id uuid;
BEGIN
    v_id := coalesce(NEW.payslip_id, OLD.payslip_id);
    SELECT status INTO v_status FROM public.payslip WHERE id = v_id;

    IF v_status IS DISTINCT FROM 'draft' THEN
        RAISE EXCEPTION 'payslip % is % - its lines cannot be changed', v_id, v_status
            USING HINT = 'Void it and draw a corrected payslip for the period.',
                  ERRCODE = 'restrict_violation';
    END IF;
    RETURN coalesce(NEW, OLD);
END;
$$;

CREATE TRIGGER tg_payslip_line_frozen
    BEFORE INSERT OR UPDATE OR DELETE ON payslip_line
    FOR EACH ROW EXECUTE FUNCTION fn_payslip_line_frozen();
ALTER TABLE payslip_line ENABLE ALWAYS TRIGGER tg_payslip_line_frozen;

-- The payslip row itself: identity and money are frozen once it leaves draft.
CREATE OR REPLACE FUNCTION fn_payslip_frozen()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
BEGIN
    IF OLD.status = 'draft' THEN
        RETURN NEW;                      -- a draft is still being prepared
    END IF;

    IF NEW.employee_id        IS DISTINCT FROM OLD.employee_id
       OR NEW.period_start    IS DISTINCT FROM OLD.period_start
       OR NEW.period_end      IS DISTINCT FROM OLD.period_end
       OR NEW.declared_net_minor IS DISTINCT FROM OLD.declared_net_minor
       OR NEW.currency_code   IS DISTINCT FROM OLD.currency_code
       OR NEW.document_id     IS DISTINCT FROM OLD.document_id
       OR NEW.source          IS DISTINCT FROM OLD.source THEN
        RAISE EXCEPTION 'payslip % is % - it cannot be re-pointed or re-priced', OLD.id, OLD.status
            USING HINT = 'Void it and draw a corrected payslip for the period.',
                  ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_payslip_frozen
    BEFORE UPDATE ON payslip
    FOR EACH ROW EXECUTE FUNCTION fn_payslip_frozen();
ALTER TABLE payslip ENABLE ALWAYS TRIGGER tg_payslip_frozen;

-- -----------------------------------------------------------------------------
-- 9. status is not directly writable
-- -----------------------------------------------------------------------------
--
-- The whole FSM is worthless if a stray UPDATE can set status='issued'. This refuses any change
-- to status that did not come from an event, using a transaction-local flag the event trigger
-- sets - the same shape as the leave ledger's writer flag (0007, check V6).

CREATE OR REPLACE FUNCTION fn_payslip_status_via_event_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status
       AND coalesce(current_setting('hrm.payslip_event_writer', true), '') <> 'on' THEN
        RAISE EXCEPTION 'payslip.status is derived from payslip_event, not set directly'
            USING HINT = 'INSERT the transition into payslip_event instead.',
                  ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_payslip_status_via_event_only
    BEFORE UPDATE OF status ON payslip
    FOR EACH ROW EXECUTE FUNCTION fn_payslip_status_via_event_only();
ALTER TABLE payslip ENABLE ALWAYS TRIGGER tg_payslip_status_via_event_only;

-- -----------------------------------------------------------------------------
-- 10. The event guard: the correspondence check, and the state machine
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_payslip_event_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
DECLARE
    p            public.payslip;
    v_net        bigint;
    v_lines      integer;
    v_doc_emp    uuid;
    v_doc_type   text;
    v_scan       text;
    v_current    uuid;
BEGIN
    SELECT * INTO p FROM public.payslip WHERE id = NEW.payslip_id FOR UPDATE;

    -- The denormalised subject must be the truth (rbac structural integrity item 1, half two).
    IF NEW.subject_employee_id IS DISTINCT FROM p.employee_id THEN
        RAISE EXCEPTION 'payslip_event.subject_employee_id does not match payslip %', p.id
            USING HINT = 'The no-self-issue CHECK is meaningless if the subject can be mis-stated.',
                  ERRCODE = 'restrict_violation';
    END IF;

    -- from_status must be where the payslip actually is. The composite FK proves the MOVE is
    -- legal; this proves it is legal FROM HERE.
    IF NEW.from_status IS DISTINCT FROM p.status THEN
        RAISE EXCEPTION 'payslip % is %, not % - transition refused', p.id, p.status, NEW.from_status
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.event_type = 'issue' THEN
        SELECT t.net_minor, t.line_count INTO v_net, v_lines
          FROM public.fn_payslip_totals(p.id) t;

        IF v_lines = 0 THEN
            RAISE EXCEPTION 'payslip % has no lines - there is nothing to issue', p.id
                USING ERRCODE = 'restrict_violation';
        END IF;

        IF p.declared_net_minor IS NULL THEN
            RAISE EXCEPTION 'payslip % has no declared net pay from the PDF', p.id
                USING HINT = 'Record what the PDF states, so it can be checked against the lines.',
                      ERRCODE = 'restrict_violation';
        END IF;

        -- THE INVARIANT. The PDF and the structured data must agree.
        IF v_net <> p.declared_net_minor THEN
            RAISE EXCEPTION
                'payslip % does not reconcile: lines net to % paise, the PDF declares % paise',
                p.id, v_net, p.declared_net_minor
                USING HINT = 'Correct the lines or the declared figure. They must match exactly.',
                      ERRCODE = 'restrict_violation';
        END IF;

        IF p.document_id IS NULL THEN
            RAISE EXCEPTION 'payslip % has no document - a payslip without its PDF is not issuable', p.id
                USING ERRCODE = 'restrict_violation';
        END IF;

        SELECT d.employee_id, d.document_type_code, d.current_version_id
          INTO v_doc_emp, v_doc_type, v_current
          FROM public.employee_document d WHERE d.id = p.document_id;

        -- THE DOCUMENT MUST BE ABOUT THE SAME PERSON. Without this, HR could attach one
        -- employee's PDF to another's payslip and the product would serve it as authoritative.
        IF v_doc_emp IS DISTINCT FROM p.employee_id THEN
            RAISE EXCEPTION
                'the attached document belongs to a different employee than payslip %', p.id
                USING ERRCODE = 'restrict_violation';
        END IF;

        IF v_doc_type <> 'payslip' THEN
            RAISE EXCEPTION 'the attached document is a %, not a payslip', v_doc_type
                USING ERRCODE = 'restrict_violation';
        END IF;

        -- A version is only promotable to current if its scan came back clean (0018, check D6),
        -- so requiring a current version IS requiring a clean scan - stated here because it is
        -- not obvious from the column name alone.
        IF v_current IS NULL THEN
            RAISE EXCEPTION 'the attached document has no clean version - it is still quarantined'
                USING ERRCODE = 'restrict_violation';
        END IF;

        SELECT scan_status INTO v_scan
          FROM public.employee_document_version WHERE id = v_current;
        IF v_scan <> 'clean' THEN
            RAISE EXCEPTION 'the attached document version is %, not clean', v_scan
                USING ERRCODE = 'restrict_violation';
        END IF;

        SET LOCAL hrm.payslip_event_writer = 'on';
        UPDATE public.payslip
           SET status = 'issued', issued_at = now(), issued_by = NEW.actor_employee_id,
               updated_at = now()
         WHERE id = p.id;

    ELSIF NEW.event_type = 'void' THEN
        SET LOCAL hrm.payslip_event_writer = 'on';
        UPDATE public.payslip
           SET status = 'void', voided_at = now(), voided_by = NEW.actor_employee_id,
               void_reason = NEW.reason, updated_at = now()
         WHERE id = p.id;

        /*
         * NO ORPHAN DOCUMENT.
         *
         * Withdrawing the document is what makes "a void payslip cannot leave an accessible
         * document" true structurally rather than by the API remembering to check. The bytes
         * survive in MinIO - they are evidence, and 0018 keeps versions append-only - but the
         * row that made them reachable is withdrawn, so every read path that joins through
         * employee_document stops returning it.
         */
        IF p.document_id IS NOT NULL THEN
            UPDATE public.employee_document
               SET withdrawn_at = now(), withdrawn_by = NEW.actor_employee_id,
                   withdrawn_reason = 'payslip voided: ' || NEW.reason, updated_at = now()
             WHERE id = p.document_id AND withdrawn_at IS NULL;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_payslip_event_guard
    BEFORE INSERT ON payslip_event
    FOR EACH ROW EXECUTE FUNCTION fn_payslip_event_guard();
ALTER TABLE payslip_event ENABLE ALWAYS TRIGGER tg_payslip_event_guard;

-- Append-only, like every other event log here.
CREATE OR REPLACE FUNCTION fn_payslip_event_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
BEGIN
    RAISE EXCEPTION 'payslip_event is append-only (attempted %)', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER tg_payslip_event_append_only
    BEFORE UPDATE OR DELETE ON payslip_event
    FOR EACH ROW EXECUTE FUNCTION fn_payslip_event_append_only();
ALTER TABLE payslip_event ENABLE ALWAYS TRIGGER tg_payslip_event_append_only;

CREATE OR REPLACE FUNCTION fn_payslip_event_no_truncate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
BEGIN
    RAISE EXCEPTION 'payslip_event cannot be truncated'
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER tg_payslip_event_no_truncate
    BEFORE TRUNCATE ON payslip_event
    FOR EACH STATEMENT EXECUTE FUNCTION fn_payslip_event_no_truncate();
ALTER TABLE payslip_event ENABLE ALWAYS TRIGGER tg_payslip_event_no_truncate;

-- A payslip is never deleted. Void carries the reason; DELETE takes it away, and would leave the
-- MinIO object with no record of who was ever allowed to read it.
CREATE OR REPLACE FUNCTION fn_payslip_no_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
BEGIN
    RAISE EXCEPTION 'a payslip is voided, never deleted (id %)', OLD.id
        USING HINT = 'INSERT a void event with a reason.', ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER tg_payslip_no_delete
    BEFORE DELETE ON payslip
    FOR EACH ROW EXECUTE FUNCTION fn_payslip_no_delete();
ALTER TABLE payslip ENABLE ALWAYS TRIGGER tg_payslip_no_delete;

-- -----------------------------------------------------------------------------
-- 11. The payslip document type
-- -----------------------------------------------------------------------------
--
-- RESTRICTED, which in the documents module means HR-only: `isSelfAndNotRestricted` fails for the
-- subject, so a payslip PDF is NOT reachable through /documents by the employee it is about.
-- Their door is the payslip endpoint, gated by `payroll.payslip.read`, which admits the subject
-- because a wage slip is something an employee is entitled to. Two doors, deliberately, and the
-- payroll one is narrower in every respect except adding the subject themselves - which is never
-- a disclosure to a third party.
--
-- Not self_uploadable: an employee producing their own payslip is the fraud this prevents.

INSERT INTO document_type (code, name, description, data_class, tracks_expiry,
                           self_uploadable, retention_years, display_order)
VALUES ('payslip', 'Payslip',
        'The issued payslip PDF for one pay period. Attached to a payslip record, which is the '
        'authority for who may read it.',
        'RESTRICTED', false, false, 8, 200);

-- -----------------------------------------------------------------------------
-- 12. Audit (Rule 2)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_audit_payslip(
    p_event_type     text,
    p_payslip_id     uuid,
    p_actor_user     uuid   DEFAULT NULL,
    p_actor_employee uuid   DEFAULT NULL,
    p_session        uuid   DEFAULT NULL,
    p_correlation    uuid   DEFAULT NULL,
    p_source_ip      inet   DEFAULT NULL,
    p_reason         text   DEFAULT NULL,
    p_roles          text[] DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
DECLARE v_id bigint; v_subject uuid; v_status text; v_period daterange;
BEGIN
    IF p_event_type IS NULL OR btrim(p_event_type) = '' THEN
        RAISE EXCEPTION 'a payslip audit row needs an event_type'
            USING ERRCODE = 'restrict_violation';
    END IF;

    SELECT employee_id, status, period INTO v_subject, v_status, v_period
      FROM public.payslip WHERE id = p_payslip_id;

    INSERT INTO public.audit_event (
        source, event_type, actor_kind, actor_user_id, actor_employee_id, actor_roles,
        subject_employee_id, subject_type, session_id, correlation_id, source_ip, reason,
        row_pk, table_name, field_classes, after)
    VALUES (
        'application', p_event_type,
        CASE WHEN p_actor_user IS NULL THEN 'system' ELSE 'user' END,
        p_actor_user, p_actor_employee, p_roles,
        v_subject, 'payslip', p_session, p_correlation, p_source_ip, p_reason,
        p_payslip_id::text, 'payslip',
        -- The CLASS touched, never an amount. An audit trail that logged net pay would become a
        -- second, decade-retained copy of the salary register.
        ARRAY['RESTRICTED'],
        jsonb_build_object('status', v_status, 'period', v_period::text))
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

COMMENT ON FUNCTION fn_audit_payslip IS
    'Emits a payslip audit row. Records the period and the resulting status and NEVER an amount - '
    'audit_event is append-only with decade retention, so logging net pay would create a second '
    'permanent salary register in the one table nobody can redact.';

-- -----------------------------------------------------------------------------
-- 13. Grants - TIER 1
-- -----------------------------------------------------------------------------
--
-- Read the header. `ALTER DEFAULT PRIVILEGES` in 0008 grants SELECT on every new table to
-- `hrm_app`, so without these REVOKEs the role that serves the leave module would be able to
-- read the salary register. rbac-rules structural integrity item 5 requires the opposite.

REVOKE ALL ON payslip                    FROM hrm_app;
REVOKE ALL ON payslip_line               FROM hrm_app;
REVOKE ALL ON payslip_event              FROM hrm_app;
REVOKE ALL ON payslip_component_type     FROM hrm_app;
REVOKE ALL ON payslip_status_transition  FROM hrm_app;

-- The role that IS allowed to. Created now, unused until the API stops connecting as the owner
-- (see apps/api/src/db.ts, and the open risk it references) - exactly as 0008 created `hrm_app`
-- before anything used it. Making the switch a configuration change rather than a migration is
-- the point.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrm_payroll') THEN
        CREATE ROLE hrm_payroll NOLOGIN;
    END IF;
END $$;

GRANT CONNECT ON DATABASE hrm TO hrm_payroll;
GRANT USAGE ON SCHEMA public TO hrm_payroll;

GRANT SELECT, INSERT, UPDATE ON payslip                   TO hrm_payroll;
GRANT SELECT, INSERT, UPDATE, DELETE ON payslip_line      TO hrm_payroll;
-- INSERT only: the log is append-only, and the grant says so as well as the trigger.
GRANT SELECT, INSERT ON payslip_event                     TO hrm_payroll;
GRANT USAGE, SELECT ON SEQUENCE payslip_event_id_seq      TO hrm_payroll;
GRANT SELECT ON payslip_component_type                    TO hrm_payroll;
GRANT SELECT ON payslip_status_transition                 TO hrm_payroll;
-- It needs the document rows to attach and withdraw a PDF, the employee row to name the subject,
-- and audit_event to satisfy Rule 2 in the same transaction as its writes.
GRANT SELECT, INSERT, UPDATE ON employee_document         TO hrm_payroll;
GRANT SELECT, INSERT, UPDATE ON employee_document_version TO hrm_payroll;
GRANT SELECT ON document_type, employee, employment       TO hrm_payroll;
GRANT INSERT ON audit_event                               TO hrm_payroll;
GRANT INSERT ON outbox_event                              TO hrm_payroll;

COMMIT;
