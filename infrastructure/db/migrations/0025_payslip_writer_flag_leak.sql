-- =============================================================================
-- 0025  Fix: the payslip writer flag leaked, making the whole FSM bypassable
-- =============================================================================
--
-- THE DEFECT, found by running the invariants rather than by reading them.
--
-- `payslip.status` is meant to be unwritable except through `payslip_event`, enforced by
-- `fn_payslip_status_via_event_only` reading a transaction-local flag that the event guard sets
-- around its own UPDATE. The guard set the flag and never cleared it:
--
--     SET LOCAL hrm.payslip_event_writer = 'on';
--     UPDATE public.payslip SET status = 'issued' ...
--     -- ... and it is still 'on' for the rest of the transaction
--
-- `SET LOCAL` is scoped to the TRANSACTION, not to the function. A function with its own `SET`
-- clause - this one has `SET search_path` - restores only THAT parameter on exit; any other
-- parameter it sets stays set until commit or rollback. So after one legitimate transition, this
-- was accepted in the same transaction:
--
--     UPDATE payslip SET status = 'draft' WHERE id = ...;     -- accepted
--
-- and the state machine, the composite FK onto the transition table, the no-self-issue CHECK and
-- the issue-time reconciliation could all be walked straight past by setting the column directly.
--
-- THE BLAST RADIUS WAS WIDER THAN THE COLUMN, which is why this is a fix and not a tidy-up. With
-- the status forced back to `draft`, the two freeze triggers correctly concluded the payslip was
-- still a draft and allowed what follows:
--
--   * `payslip_line` amounts became editable on an ISSUED payslip - so the net could be changed
--     after issue, silently breaking the correspondence with the PDF that the issue guard had
--     just established;
--   * `payslip.document_id` became re-pointable - so an issued payslip could be aimed at a
--     DIFFERENT employee's PDF, which is the exact cross-employee disclosure the guard refuses at
--     issue time.
--
-- Both of those tested as broken and neither trigger was at fault; they were reading a status
-- that had been forged. One leaked GUC undid four separate controls.
--
-- THE FIX is to clear the flag immediately after each UPDATE, so it is 'on' for exactly one
-- statement. Precedent: migration 0007 does the same thing for the leave-ledger writer flag, and
-- its check V6 - "the writer flag does not leak to later statements" - exists because this trap
-- was already found once in this repo. It was not applied here, and the flag was written by hand
-- instead of reusing that shape.
--
-- Forward-only (DEC-011): 0024 is applied and checksum-enforced (DEC-012), so it stays as it
-- shipped and is corrected here - as 0015 corrected 0014, 0021 corrected 0020, and 0023
-- corrected 0022.
--
-- Class C. Verified by testing/db/0024_payslip_records.verify.sql, checks PS12-PS15, which now
-- assert the leak is closed AND that both freeze triggers hold once it is.
-- =============================================================================

BEGIN;

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

    IF p.id IS NULL THEN
        RAISE EXCEPTION 'payslip % does not exist', NEW.payslip_id
            USING ERRCODE = 'restrict_violation';
    END IF;

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

        -- THE DOCUMENT MUST BE ABOUT THE SAME PERSON.
        IF v_doc_emp IS DISTINCT FROM p.employee_id THEN
            RAISE EXCEPTION
                'the attached document belongs to a different employee than payslip %', p.id
                USING ERRCODE = 'restrict_violation';
        END IF;

        IF v_doc_type <> 'payslip' THEN
            RAISE EXCEPTION 'the attached document is a %, not a payslip', v_doc_type
                USING ERRCODE = 'restrict_violation';
        END IF;

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

        /*
         * ON FOR EXACTLY ONE STATEMENT.
         *
         * `SET LOCAL` lasts until the transaction ends, not until this function returns - a
         * function's own `SET` clause restores only the parameter it names (`search_path`). 0024
         * set this and never cleared it, so after one legitimate transition a direct
         * `UPDATE payslip SET status = ...` was accepted for the rest of the transaction, which
         * also handed back write access to the lines and the document link of an ISSUED payslip.
         * Same shape as the leave-ledger writer flag in 0007, whose check V6 exists for this.
         */
        SET LOCAL hrm.payslip_event_writer = 'on';
        UPDATE public.payslip
           SET status = 'issued', issued_at = now(), issued_by = NEW.actor_employee_id,
               updated_at = now()
         WHERE id = p.id;
        SET LOCAL hrm.payslip_event_writer = 'off';

    ELSIF NEW.event_type = 'void' THEN
        SET LOCAL hrm.payslip_event_writer = 'on';
        UPDATE public.payslip
           SET status = 'void', voided_at = now(), voided_by = NEW.actor_employee_id,
               void_reason = NEW.reason, updated_at = now()
         WHERE id = p.id;
        SET LOCAL hrm.payslip_event_writer = 'off';

        /*
         * NO ORPHAN DOCUMENT. Withdrawing the document is what makes "a void payslip cannot leave
         * an accessible document" structural rather than something the API must remember. The
         * bytes survive in MinIO - they are evidence, and 0018 keeps versions append-only - but
         * the row that made them reachable is withdrawn, so every read path that joins through
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

COMMENT ON FUNCTION fn_payslip_event_guard() IS
    'Validates and applies a payslip status transition. Holds the issue-time reconciliation: the '
    'net derived from the lines must equal the net declared on the PDF, the document must be '
    'clean, of type payslip, and about the SAME employee. Clears hrm.payslip_event_writer '
    'immediately after each UPDATE - 0024 left it set, which made payslip.status directly '
    'writable for the rest of the transaction and, through that, re-opened the lines and the '
    'document link of an already-issued payslip (0025).';

COMMIT;
