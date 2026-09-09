-- =============================================================================
-- Verification for 0032: the salary annexure and its approval chain
--
-- The checks that carry the weight:
--
--   SA4  APPROVED FIGURES CANNOT MOVE. This is what the migration exists for. If components stay
--        editable after finance has approved them, the approval is decorative and the offer letter
--        can carry numbers nobody signed. Tested on all three of INSERT, UPDATE and DELETE,
--        because a rail that blocks two of them is not a rail.
--   SA3  THE COMPONENTS AND THE TYPED CTC MUST AGREE AT SUBMISSION. The failure this catches - a
--        component out by a factor of ten - is completely silent otherwise, and it is the figure
--        the offer letter will quote.
--   SA5  NOBODY APPROVES THEIR OWN PACKAGE. The structural rule payslip issuance already carries.
--   SA6  A MOVE NOBODY DESIGNED IS REFUSED. Skipping finance and going straight to the delivery
--        head is the interesting case: it is not a missing permission check, it is a triple that
--        does not exist in the transition table, so the composite FK refuses it.
--   SA7  a concurrent second decision cannot land on a stale status.
--   SA9  ONE LIVE ANNEXURE PER PERSON, but a declined or withdrawn one does not block a new offer.
--   SA10 the event log is append-only and its triggers are ENABLE ALWAYS.
-- =============================================================================

\set ON_ERROR_STOP on

-- THIS FILE LEAVES NO FIXTURES, AND WRITES NO CLEANUP TO DO SO.
--
-- `scripts/migrate.mjs` already runs every verify file as `BEGIN; -f file; ROLLBACK;` (added by
-- ADR-review finding D-14), so nothing here is committed. That matters more for this file than
-- most: the event log under test is append-only and `salary_annexure_event` holds a foreign key
-- to `salary_annexure`, so a cleanup DELETE is refused outright - the rail working, not an
-- obstacle - and SA9 asserts only one live annexure may exist per person, so a fixture surviving
-- the run would fail the NEXT one. An explicit BEGIN here only nests inside the runner's and
-- warns; the rollback is already guaranteed.

DO $$
DECLARE
    v_e     UUID;
    v_hr    UUID;
    v_a     UUID;
    v_b     UUID;
    v_n     INT;
    v_ok    BOOLEAN;
    v_status TEXT;
BEGIN
    SELECT id INTO v_e  FROM employee WHERE employee_number = 'EMP006';
    SELECT id INTO v_hr FROM employee WHERE employee_number = 'EMP005';
    IF v_e IS NULL OR v_hr IS NULL THEN
        RAISE EXCEPTION 'FAIL  SA0 fixtures missing - EMP006 and EMP005 must both be seeded';
    END IF;

    -- ---------------------------------------------------------------- SA1
    INSERT INTO salary_annexure (employee_id, declared_annual_ctc_minor, proposed_joining_on,
                                 prepared_by)
         VALUES (v_e, 120000000, DATE '2031-10-01', v_hr)
      RETURNING id INTO v_a;

    INSERT INTO salary_annexure_component (annexure_id, kind, component_code, label, amount_minor)
         VALUES (v_a, 'earning', 'BASIC', 'Basic', 60000000),
                (v_a, 'earning', 'HRA',   'HRA',   40000000);

    -- ---------------------------------------------------------------- SA2
    -- Money is minor units and nothing is zero or negative.
    v_ok := false;
    BEGIN
        INSERT INTO salary_annexure_component (annexure_id, kind, component_code, label,
                                               amount_minor)
             VALUES (v_a, 'earning', 'ZERO', 'Nothing', 0);
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN RAISE EXCEPTION 'FAIL  SA2 a zero component was accepted'; END IF;

    -- ---------------------------------------------------------------- SA3
    -- Components total 100000000, the CTC says 120000000. Submission must refuse.
    v_ok := false;
    BEGIN
        INSERT INTO salary_annexure_event (annexure_id, event_type, from_status, to_status,
                                           actor_employee_id, subject_employee_id)
             VALUES (v_a, 'submit', 'draft', 'finance_review', v_hr, v_e);
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'FAIL  SA3 an annexure whose components do not match its CTC was sent to '
                        'finance - the fat-fingered component this exists to catch would pass';
    END IF;

    -- Make them agree and submit for real.
    INSERT INTO salary_annexure_component (annexure_id, kind, component_code, label, amount_minor)
         VALUES (v_a, 'earning', 'SPECIAL', 'Special allowance', 20000000);
    INSERT INTO salary_annexure_event (annexure_id, event_type, from_status, to_status,
                                       actor_employee_id, subject_employee_id)
         VALUES (v_a, 'submit', 'draft', 'finance_review', v_hr, v_e);

    SELECT status INTO v_status FROM salary_annexure WHERE id = v_a;
    IF v_status <> 'finance_review' THEN
        RAISE EXCEPTION 'FAIL  SA3b the status did not follow the event: %', v_status;
    END IF;

    -- ---------------------------------------------------------------- SA4
    -- THE CENTRAL RAIL. All three write shapes, once it has left draft.
    v_ok := false;
    BEGIN
        UPDATE salary_annexure_component SET amount_minor = 1 WHERE annexure_id = v_a;
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'FAIL  SA4 a submitted annexure had its figures UPDATED';
    END IF;

    v_ok := false;
    BEGIN
        INSERT INTO salary_annexure_component (annexure_id, kind, component_code, label,
                                               amount_minor)
             VALUES (v_a, 'earning', 'SNEAK', 'Added after approval', 100);
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'FAIL  SA4b a component was ADDED to a submitted annexure';
    END IF;

    v_ok := false;
    BEGIN
        DELETE FROM salary_annexure_component WHERE annexure_id = v_a AND component_code = 'HRA';
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'FAIL  SA4c a component was DELETED from a submitted annexure';
    END IF;

    -- ---------------------------------------------------------------- SA5
    -- Nobody approves their own package.
    v_ok := false;
    BEGIN
        INSERT INTO salary_annexure_event (annexure_id, event_type, from_status, to_status,
                                           actor_employee_id, subject_employee_id)
             VALUES (v_a, 'finance_approve', 'finance_review', 'delivery_review', v_e, v_e);
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'FAIL  SA5 somebody approved their own salary annexure';
    END IF;

    -- ---------------------------------------------------------------- SA6
    -- A move that is not in the transition table. Skipping finance entirely.
    v_ok := false;
    BEGIN
        INSERT INTO salary_annexure_event (annexure_id, event_type, from_status, to_status,
                                           actor_employee_id, subject_employee_id)
             VALUES (v_a, 'issue_offer', 'finance_review', 'offer_issued', v_hr, v_e);
    EXCEPTION WHEN foreign_key_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'FAIL  SA6 an offer was issued straight from finance review - the chain '
                        'can be skipped';
    END IF;

    -- ---------------------------------------------------------------- SA7
    -- A decision that names a stale `from_status` must lose, not overwrite.
    v_ok := false;
    BEGIN
        INSERT INTO salary_annexure_event (annexure_id, event_type, from_status, to_status,
                                           actor_employee_id, subject_employee_id)
             VALUES (v_a, 'submit', 'draft', 'finance_review', v_hr, v_e);
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'FAIL  SA7 an event was applied from a status the annexure is no longer in';
    END IF;

    -- ---------------------------------------------------------------- SA8
    -- A rejection must carry a reason.
    v_ok := false;
    BEGIN
        INSERT INTO salary_annexure_event (annexure_id, event_type, from_status, to_status,
                                           actor_employee_id, subject_employee_id)
             VALUES (v_a, 'finance_reject', 'finance_review', 'draft', v_hr, v_e);
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN RAISE EXCEPTION 'FAIL  SA8 a rejection was recorded with no reason'; END IF;

    -- Walk the rest of the chain properly.
    INSERT INTO salary_annexure_event (annexure_id, event_type, from_status, to_status,
                                       actor_employee_id, subject_employee_id,
                                       ctc_at_decision_minor)
         VALUES (v_a, 'finance_approve', 'finance_review', 'delivery_review', v_hr, v_e, 120000000);
    INSERT INTO salary_annexure_event (annexure_id, event_type, from_status, to_status,
                                       actor_employee_id, subject_employee_id,
                                       ctc_at_decision_minor)
         VALUES (v_a, 'delivery_approve', 'delivery_review', 'delivery_approved', v_hr, v_e,
                 120000000);
    INSERT INTO salary_annexure_event (annexure_id, event_type, from_status, to_status,
                                       actor_employee_id, subject_employee_id)
         VALUES (v_a, 'issue_offer', 'delivery_approved', 'offer_issued', v_hr, v_e);

    SELECT status INTO v_status FROM salary_annexure WHERE id = v_a;
    IF v_status <> 'offer_issued' THEN
        RAISE EXCEPTION 'FAIL  SA8b the full chain did not reach offer_issued: %', v_status;
    END IF;

    -- ---------------------------------------------------------------- SA9
    -- One live annexure per person...
    v_ok := false;
    BEGIN
        INSERT INTO salary_annexure (employee_id, declared_annual_ctc_minor, proposed_joining_on,
                                     prepared_by)
             VALUES (v_e, 99000000, DATE '2031-11-01', v_hr);
    EXCEPTION WHEN unique_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'FAIL  SA9 a second live annexure was accepted for one person';
    END IF;

    -- ... but a declined one must not block a fresh offer.
    INSERT INTO salary_annexure_event (annexure_id, event_type, from_status, to_status,
                                       actor_employee_id, subject_employee_id, reason)
         VALUES (v_a, 'decline_offer', 'offer_issued', 'offer_declined', v_hr, v_e,
                 'took another role');
    BEGIN
        INSERT INTO salary_annexure (employee_id, declared_annual_ctc_minor, proposed_joining_on,
                                     prepared_by)
             VALUES (v_e, 99000000, DATE '2031-11-01', v_hr)
          RETURNING id INTO v_b;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'FAIL  SA9b a declined offer blocks a new one: %', SQLERRM;
    END;

    -- ---------------------------------------------------------------- SA10
    -- The log is append-only.
    v_ok := false;
    BEGIN
        UPDATE salary_annexure_event SET reason = 'rewritten' WHERE annexure_id = v_a;
    EXCEPTION WHEN OTHERS THEN v_ok := true;
    END;
    IF NOT v_ok THEN RAISE EXCEPTION 'FAIL  SA10 a decision in the log was rewritten'; END IF;

    v_ok := false;
    BEGIN
        DELETE FROM salary_annexure_event WHERE annexure_id = v_a;
    EXCEPTION WHEN OTHERS THEN v_ok := true;
    END;
    IF NOT v_ok THEN RAISE EXCEPTION 'FAIL  SA10b a decision was deleted from the log'; END IF;

    -- ---------------------------------------------------------------- SA11
    -- Every rail is ENABLE ALWAYS (DEC-030), so a restore cannot walk around it.
    SELECT count(*) INTO v_n
      FROM pg_trigger
     WHERE tgrelid IN ('salary_annexure_component'::regclass, 'salary_annexure_event'::regclass)
       AND NOT tgisinternal AND tgenabled <> 'A';
    IF v_n <> 0 THEN
        RAISE EXCEPTION 'FAIL  SA11 % trigger(s) on the annexure tables are not ENABLE ALWAYS', v_n;
    END IF;

    -- ---------------------------------------------------------------- SA12
    -- An offer letter cannot be attached before there is an offer.
    v_ok := false;
    BEGIN
        UPDATE salary_annexure
           SET offer_document_id = (SELECT id FROM employee_document LIMIT 1)
         WHERE id = v_b;
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF NOT v_ok AND (SELECT count(*) FROM employee_document) > 0 THEN
        RAISE EXCEPTION 'FAIL  SA12 an offer letter was attached to a draft annexure';
    END IF;

    -- ---------------------------------------------------------------- SA13
    -- 0034: an ISSUED offer can be retracted. Without this a candidate who never answers freezes
    -- that person's onboarding forever, because the one-live index counts `offer_issued` and
    -- blocks a replacement.
    SELECT count(*) INTO v_n FROM salary_annexure_status_transition
     WHERE from_status = 'offer_issued' AND event_type = 'withdraw' AND to_status = 'withdrawn';
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'FAIL  SA13 an issued offer cannot be withdrawn - a silent candidate '
                        'would freeze this person permanently';
    END IF;

    -- ... and withdrawing is NOT declining. Retracting says nothing about what the candidate
    -- would have answered, and only `decline_offer` reaches the terminal that claims they did.
    SELECT count(*) INTO v_n FROM salary_annexure_status_transition
     WHERE to_status = 'offer_declined' AND event_type <> 'decline_offer';
    IF v_n <> 0 THEN
        RAISE EXCEPTION 'FAIL  SA13b % move(s) other than decline_offer reach offer_declined - a '
                        'retraction must not be recorded as the candidate refusing', v_n;
    END IF;

    RAISE NOTICE 'PASS  0032 salary annexure: 17 checks';
END $$;
