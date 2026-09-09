-- =============================================================================
-- 0032  The salary annexure, and the approval chain that ends in an offer letter
-- =============================================================================
--
-- HR prepares the compensation for a joiner, the finance head approves it, the delivery head
-- approves it, and only then is an offer letter issued. This is that aggregate.
--
-- IT IS AN ANNEXURE, NOT A PAYSLIP, and the distinction was worth settling before any table
-- existed. A payslip is a statement of what was PAID: it carries a pay period, an 8-year
-- retention class, and 0024's invariant that the summed net reconciles against a net typed in
-- separately from the printed document. Before somebody joins, nothing has been paid and there is
-- no document to reconcile against. Reusing `payslip` would have meant a payslip with no pay
-- period for a person who has not worked a day, and the approval chain bolted onto a table whose
-- own lifecycle (`draft -> issued -> void`) means something else entirely.
--
-- NOTHING HERE IS CALCULATED, which is the same promise the payslip screen already makes. ADR-0012
-- is "Proposed - BLOCKED, do not accept", so no statutory or gross-to-net computation may exist in
-- this system yet. Components are ENTERED by HR from a figure a human settled; the total is a SUM
-- of what was typed, which is arithmetic over given numbers rather than payroll calculation. And
-- the annual CTC is typed a SECOND time, independently, and must agree with the sum - the same
-- reconciliation trick 0024 uses, because the failure it catches (a component fat-fingered by a
-- factor of ten) is silent otherwise and is the number the offer letter will carry.
--
-- THE CENTRAL RAIL IS THAT APPROVED FIGURES CANNOT MOVE. Finance approves specific numbers. If the
-- components can be edited afterwards, the approval means nothing and the offer letter can carry
-- figures nobody signed off - which is the whole risk this chain exists to remove. Components are
-- therefore writable ONLY while the annexure is in `draft`, enforced by an ENABLE ALWAYS trigger
-- rather than by the endpoint remembering. Changing an approved annexure means sending it back to
-- draft, which is an event, which is recorded, and which loses both approvals.
--
-- Money is `bigint` minor units (paise) throughout - Must-Know Rule 4 - matching `payslip_line`.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. The FSM, as data (the DEC-033 pattern, as `payslip_status_transition` has it)
-- -----------------------------------------------------------------------------
CREATE TABLE salary_annexure_status_transition (
    event_type  text NOT NULL,
    from_status text NOT NULL,
    to_status   text NOT NULL,
    PRIMARY KEY (event_type, from_status),
    CONSTRAINT uq_sast_triple UNIQUE (event_type, from_status, to_status)
);

COMMENT ON TABLE salary_annexure_status_transition IS
    'The onboarding approval chain as data. salary_annexure_event carries a composite FK onto the '
    'whole triple, so a move nobody designed - approving something that was never submitted, or '
    'issuing an offer finance never saw - is refused by the database.';

INSERT INTO salary_annexure_status_transition (event_type, from_status, to_status) VALUES
    ('submit',          'draft',             'finance_review'),
    -- Finance approving sends it STRAIGHT to the delivery head. A separate "now submit it to
    -- delivery" step would be a click that can only be made one way, and a queue somebody forgets.
    ('finance_approve', 'finance_review',    'delivery_review'),
    ('delivery_approve','delivery_review',   'delivery_approved'),
    ('issue_offer',     'delivery_approved', 'offer_issued'),
    ('accept_offer',    'offer_issued',      'offer_accepted'),
    ('decline_offer',   'offer_issued',      'offer_declined'),
    -- A rejection returns it to HR to redo, and BOTH approvals are lost with it. Finance rejecting
    -- after delivery approved cannot happen (delivery only sees it once finance passed it), but
    -- delivery rejecting discards finance's approval too - deliberately, because the figures are
    -- about to change and the approval was of those figures.
    ('finance_reject',  'finance_review',    'draft'),
    ('delivery_reject', 'delivery_review',   'draft'),
    -- Withdrawal, from anywhere before the offer has gone out.
    ('withdraw',        'draft',             'withdrawn'),
    ('withdraw',        'finance_review',    'withdrawn'),
    ('withdraw',        'delivery_review',   'withdrawn'),
    ('withdraw',        'delivery_approved', 'withdrawn');

-- -----------------------------------------------------------------------------
-- 2. The annexure
-- -----------------------------------------------------------------------------
CREATE TABLE salary_annexure (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id            uuid NOT NULL REFERENCES employee (id),
    status                 text NOT NULL DEFAULT 'draft',

    -- What the offer says the person will be paid, per year, typed independently of the
    -- components. `ck_salary_annexure_reconciles` is enforced at submission time by the trigger
    -- below rather than as a CHECK, because a draft is allowed to be half-entered.
    declared_annual_ctc_minor bigint NOT NULL,

    -- The date the offer assumes they start. Not `employee.joined_on`, which is what actually
    -- happened; these disagree whenever somebody starts late, and the offer letter must quote what
    -- was offered.
    proposed_joining_on    date NOT NULL,

    prepared_by            uuid NOT NULL REFERENCES employee (id),
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),

    -- The issued letter, once there is one. `employee_document` already owns storage, scanning,
    -- versioning and retention, so the offer letter is one of those rather than a second file
    -- store (ADR-0020's "reuse rather than re-grow" point, made concrete).
    offer_document_id      uuid REFERENCES employee_document (id),

    CONSTRAINT ck_salary_annexure_status CHECK (status IN (
        'draft', 'finance_review', 'delivery_review', 'delivery_approved',
        'offer_issued', 'offer_accepted', 'offer_declined', 'withdrawn')),

    CONSTRAINT ck_salary_annexure_ctc_positive CHECK (declared_annual_ctc_minor > 0),

    -- An offer letter may only be attached once there is an offer.
    CONSTRAINT ck_salary_annexure_document_after_issue
        CHECK (offer_document_id IS NULL
               OR status IN ('offer_issued', 'offer_accepted', 'offer_declined'))
);

-- ONE LIVE ANNEXURE PER PERSON. Two in flight means two sets of figures and two approvals, and
-- whichever endpoint reads "the" annexure picks one arbitrarily. Terminal states are excluded, so
-- a withdrawn or declined offer does not block a fresh one.
CREATE UNIQUE INDEX ux_salary_annexure_one_live
    ON salary_annexure (employee_id)
    WHERE status NOT IN ('offer_declined', 'withdrawn', 'offer_accepted');

CREATE INDEX ix_salary_annexure_status ON salary_annexure (status, created_at DESC);
CREATE INDEX ix_salary_annexure_employee ON salary_annexure (employee_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- 3. The components
-- -----------------------------------------------------------------------------
CREATE TABLE salary_annexure_component (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    annexure_id     uuid NOT NULL REFERENCES salary_annexure (id) ON DELETE CASCADE,
    kind            text NOT NULL,
    component_code  text NOT NULL,
    label           text NOT NULL,
    -- Annual, in paise. Deductions are entered POSITIVE and subtracted, exactly as the payslip
    -- screen already asks for them - one convention, not two.
    amount_minor    bigint NOT NULL,
    sort_order      int NOT NULL DEFAULT 0,

    CONSTRAINT ck_sac_kind CHECK (kind IN ('earning', 'deduction')),
    CONSTRAINT ck_sac_amount_positive CHECK (amount_minor > 0),
    CONSTRAINT uq_sac_component UNIQUE (annexure_id, component_code)
);

CREATE INDEX ix_sac_annexure ON salary_annexure_component (annexure_id, sort_order);

-- ON DELETE CASCADE is deliberate and is the ONLY cascade here: a component has no meaning apart
-- from its annexure, and an annexure is never deleted once it has left draft (the event log holds
-- the history and is append-only). A draft abandoned before submission takes its lines with it.

-- -----------------------------------------------------------------------------
-- 4. The event log
-- -----------------------------------------------------------------------------
CREATE TABLE salary_annexure_event (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    annexure_id         uuid NOT NULL REFERENCES salary_annexure (id),
    event_type          text NOT NULL,
    from_status         text NOT NULL,
    to_status           text NOT NULL,

    actor_employee_id   uuid REFERENCES employee (id),
    actor_roles         text[],
    subject_employee_id uuid NOT NULL REFERENCES employee (id),
    reason              text,
    -- What the figures were AT THE MOMENT OF THE DECISION. Finance approved a number, and that
    -- number must remain readable even after a rejection sends the annexure back to draft and the
    -- components are rewritten. Without this the audit trail says "finance approved" and cannot
    -- say what.
    ctc_at_decision_minor bigint,
    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT fk_sae_transition
        FOREIGN KEY (event_type, from_status, to_status)
        REFERENCES salary_annexure_status_transition (event_type, from_status, to_status),

    -- NOBODY APPROVES THEIR OWN PACKAGE. The same structural rule payslip issuance carries
    -- (`ck_payslip_no_self_issue`, rbac-rules structural integrity item 1). An HR admin who is
    -- also the joiner, or a finance head hired into a new grade, cannot sign their own annexure.
    CONSTRAINT ck_sae_no_self_approval
        CHECK (actor_employee_id IS NULL OR actor_employee_id <> subject_employee_id),

    -- A rejection or a withdrawal without a reason is unreviewable later.
    CONSTRAINT ck_sae_reason_required
        CHECK (event_type NOT IN ('finance_reject', 'delivery_reject', 'withdraw', 'decline_offer')
               OR (reason IS NOT NULL AND btrim(reason) <> ''))
);

CREATE INDEX ix_sae_annexure ON salary_annexure_event (annexure_id, created_at);

-- -----------------------------------------------------------------------------
-- 5. Approved figures cannot move
-- -----------------------------------------------------------------------------
--
-- THE RAIL THIS MIGRATION EXISTS FOR. Finance approves specific numbers; if the components can be
-- edited afterwards the approval is decorative and the offer letter can carry figures nobody
-- signed. Components are writable only while the parent is in `draft`.
CREATE OR REPLACE FUNCTION fn_salary_annexure_component_draft_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
DECLARE
    v_annexure UUID;
    v_status   TEXT;
BEGIN
    v_annexure := COALESCE(NEW.annexure_id, OLD.annexure_id);
    SELECT status INTO v_status FROM public.salary_annexure WHERE id = v_annexure;

    -- No parent means the annexure itself is being deleted and the cascade is running.
    IF v_status IS NULL THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    IF v_status <> 'draft' THEN
        RAISE EXCEPTION
            'this annexure is % and its figures are what was approved; send it back to draft to '
            'change them', v_status
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_sac_draft_only
    BEFORE INSERT OR UPDATE OR DELETE ON salary_annexure_component
    FOR EACH ROW EXECUTE FUNCTION fn_salary_annexure_component_draft_only();

ALTER TABLE salary_annexure_component
    ENABLE ALWAYS TRIGGER trg_sac_draft_only;

-- -----------------------------------------------------------------------------
-- 6. Submission reconciles, and the status follows the log
-- -----------------------------------------------------------------------------
--
-- Two jobs, one trigger on the event log, so `salary_annexure.status` can never disagree with the
-- events that produced it - the divergence 0014's lifecycle log exists to prevent, applied here.
CREATE OR REPLACE FUNCTION fn_salary_annexure_apply_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
DECLARE
    v_current  TEXT;
    v_sum      BIGINT;
    v_declared BIGINT;
    v_subject  UUID;
BEGIN
    SELECT status, declared_annual_ctc_minor, employee_id
      INTO v_current, v_declared, v_subject
      FROM public.salary_annexure WHERE id = NEW.annexure_id
       FOR UPDATE;

    IF v_current IS DISTINCT FROM NEW.from_status THEN
        RAISE EXCEPTION 'this annexure is %, not % - somebody else moved it first',
                        v_current, NEW.from_status
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.subject_employee_id IS DISTINCT FROM v_subject THEN
        RAISE EXCEPTION 'the event names a different employee than the annexure it belongs to'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- RECONCILE AT SUBMISSION, not before: a draft may be half-entered, but the moment it goes to
    -- finance the components and the independently-typed CTC must agree. Catching a component
    -- fat-fingered by a factor of ten here is the entire point - it is silent otherwise, and it is
    -- the number the offer letter will carry.
    IF NEW.event_type = 'submit' THEN
        SELECT COALESCE(SUM(CASE WHEN kind = 'earning' THEN amount_minor
                                 ELSE -amount_minor END), 0)
          INTO v_sum
          FROM public.salary_annexure_component WHERE annexure_id = NEW.annexure_id;

        IF v_sum <> v_declared THEN
            RAISE EXCEPTION
                'the components total % but the annual CTC is entered as % - they must agree '
                'before this goes to finance', v_sum, v_declared
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    UPDATE public.salary_annexure
       SET status = NEW.to_status, updated_at = now()
     WHERE id = NEW.annexure_id;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sae_apply
    BEFORE INSERT ON salary_annexure_event
    FOR EACH ROW EXECUTE FUNCTION fn_salary_annexure_apply_event();

ALTER TABLE salary_annexure_event ENABLE ALWAYS TRIGGER trg_sae_apply;

-- The log is append-only, like every other decision log here.
CREATE TRIGGER trg_sae_append_only
    BEFORE UPDATE OR DELETE ON salary_annexure_event
    FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();

ALTER TABLE salary_annexure_event ENABLE ALWAYS TRIGGER trg_sae_append_only;

COMMIT;
