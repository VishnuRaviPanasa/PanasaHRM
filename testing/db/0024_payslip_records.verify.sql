-- =============================================================================
-- Verification for 0024 / 0025: payslip records
--
-- The checks that carry the weight:
--
--   PS4   the PDF and the structured data must agree. Issuing is refused when the net derived
--         from the lines differs from the net declared on the PDF - the one invariant this whole
--         schema exists to enforce.
--   PS8   the attached document must belong to the SAME employee. Without it, HR could serve one
--         person's payslip PDF as another's and every other check here would still pass.
--   PS12  the writer flag does not leak. 0024 left `hrm.payslip_event_writer` set for the rest of
--         the transaction, which made payslip.status directly writable and - through that -
--         re-opened the lines and the document link of an already-ISSUED payslip. One leaked GUC
--         undid four controls. Fixed in 0025.
--   PS16  voiding withdraws the document, so a void payslip leaves no reachable orphan PDF.
--   PS20  `hrm_app` holds NO privilege on any payslip table. This is not decoration: migration
--         0008 line 93 grants SELECT on every NEW table to hrm_app by default, so Tier 1
--         isolation is opt-OUT for the most sensitive class of table in the system.
--   PS21  no payslip function is SECURITY DEFINER, which would hand back exactly the read access
--         PS20 removes.
--
-- EVERY CHECK BUILDS ITS OWN FIXTURE. Five occurrences of the borrowed-fixture trap in this repo
-- so far (0014 L13, 0017 G5, 0012 N8, the task seed, and 0019 W14/W15 - which silently SKIPPED
-- and cost two checks with nothing failing). Nothing below reads a seeded row.
--
-- No payroll arithmetic is asserted, because there is none: ADR-0012 is BLOCKED on
-- build-versus-buy and owns the engine. The only sums checked are totals of what HR typed in.
--
-- Runs inside a transaction the runner always rolls back (DEC-024).
-- =============================================================================

-- PS1: money is integer minor units, never floating point (Rule 4).
DO $$
DECLARE v_bad TEXT;
BEGIN
    SELECT string_agg(format('%s.%s is %s', c.table_name, c.column_name, c.data_type), ', ')
      INTO v_bad
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.table_name IN ('payslip', 'payslip_line')
       AND (c.column_name LIKE '%_minor' OR c.column_name LIKE '%amount%')
       AND c.data_type NOT IN ('bigint', 'integer', 'numeric');

    IF v_bad IS NULL THEN
        RAISE NOTICE 'PASS  PS1 every payslip money column is an integer type (Rule 4)';
    ELSE
        RAISE EXCEPTION 'FAIL  PS1 floating point in a money column: %', v_bad;
    END IF;
END $$;

-- PS2: a pay period is made of DATEs, not timestamps (Rule 5).
DO $$
DECLARE v_bad TEXT;
BEGIN
    SELECT string_agg(format('%s is %s', column_name, data_type), ', ') INTO v_bad
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'payslip'
       AND column_name IN ('period_start', 'period_end', 'pay_date')
       AND data_type <> 'date';

    IF v_bad IS NULL THEN
        RAISE NOTICE 'PASS  PS2 period_start, period_end and pay_date are all DATE (Rule 5)';
    ELSE
        RAISE EXCEPTION 'FAIL  PS2 a pay period column is not a DATE: %', v_bad;
    END IF;
END $$;

-- PS3: the FSM is data, and the log's FK covers the WHOLE triple so history cannot be
-- reinterpreted by a later policy edit (DEC-033).
DO $$
DECLARE v_def TEXT; v_moves INT;
BEGIN
    SELECT pg_get_constraintdef(oid) INTO v_def
      FROM pg_constraint WHERE conname = 'fk_payslip_event_transition';
    SELECT count(*) INTO v_moves FROM payslip_status_transition;

    IF v_def LIKE '%event_type, from_status, to_status%' AND v_moves >= 3 THEN
        RAISE NOTICE 'PASS  PS3 FSM is data (% legal moves), FK covers the whole triple', v_moves;
    ELSE
        RAISE EXCEPTION 'FAIL  PS3 moves=% fk=%', v_moves, v_def;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- PS4..PS19 share one fixture: two employees, two clean payslip PDFs, and one payslip.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_emp UUID; v_other UUID; v_hr UUID; v_dept UUID; v_desig UUID;
    v_join DATE := DATE '2024-04-01';
    v_ps UUID; v_doc UUID; v_ver UUID; v_odoc UUID; v_over UUID; v_wrong UUID; v_wver UUID;
    r RECORD; v_ok BOOLEAN; v_net BIGINT; v_withdrawn BOOLEAN;
BEGIN
    SET LOCAL hrm.allow_backdated_period = 'on';

    SELECT id INTO v_desig FROM designation WHERE retired_on IS NULL LIMIT 1;
    INSERT INTO department (code, name) VALUES ('VPS', 'Payslip Verify') RETURNING id INTO v_dept;
    INSERT INTO department_period (department_id, parent_department_id, valid_from)
    VALUES (v_dept, NULL, v_join);

    INSERT INTO employee (employee_number, full_name, work_email, joined_on, status)
    VALUES ('VERIFY-PS1', 'Payslip Subject', 'verify-ps1@example.invalid', v_join, 'pre_boarding')
    RETURNING id INTO v_emp;
    INSERT INTO employment_event (employee_id, event_type, from_status, to_status, effective_on)
    VALUES (v_emp, 'joined', 'pre_boarding', 'active', v_join);
    INSERT INTO employment (employee_id, department_id, designation_id, valid_from)
    VALUES (v_emp, v_dept, v_desig, v_join);

    INSERT INTO employee (employee_number, full_name, work_email, joined_on, status)
    VALUES ('VERIFY-PS2', 'Somebody Else', 'verify-ps2@example.invalid', v_join, 'pre_boarding')
    RETURNING id INTO v_other;
    INSERT INTO employment_event (employee_id, event_type, from_status, to_status, effective_on)
    VALUES (v_other, 'joined', 'pre_boarding', 'active', v_join);

    INSERT INTO employee (employee_number, full_name, work_email, joined_on, status)
    VALUES ('VERIFY-PSHR', 'Payroll Admin', 'verify-pshr@example.invalid', v_join, 'pre_boarding')
    RETURNING id INTO v_hr;
    INSERT INTO employment_event (employee_id, event_type, from_status, to_status, effective_on)
    VALUES (v_hr, 'joined', 'pre_boarding', 'active', v_join);

    -- A clean payslip PDF for the subject ...
    INSERT INTO employee_document (employee_id, document_type_code, title, uploaded_by)
    VALUES (v_emp, 'payslip', 'Payslip 2024-04', v_hr) RETURNING id INTO v_doc;
    INSERT INTO employee_document_version
        (document_id, version_no, bucket, object_key, content_type, size_bytes, sha256_hex,
         scan_status, scanned_at, uploaded_by)
    VALUES (v_doc, 1, 'hrm-documents', 'verify/ps-ok.pdf', 'application/pdf', 2048,
            repeat('1', 64), 'clean', now(), v_hr) RETURNING id INTO v_ver;
    UPDATE employee_document SET current_version_id = v_ver WHERE id = v_doc;

    -- ... and one belonging to somebody else, which PS8 exists to refuse.
    INSERT INTO employee_document (employee_id, document_type_code, title, uploaded_by)
    VALUES (v_other, 'payslip', 'Payslip 2024-04 (other)', v_hr) RETURNING id INTO v_odoc;
    INSERT INTO employee_document_version
        (document_id, version_no, bucket, object_key, content_type, size_bytes, sha256_hex,
         scan_status, scanned_at, uploaded_by)
    VALUES (v_odoc, 1, 'hrm-documents', 'verify/ps-other.pdf', 'application/pdf', 2048,
            repeat('2', 64), 'clean', now(), v_hr) RETURNING id INTO v_over;
    UPDATE employee_document SET current_version_id = v_over WHERE id = v_odoc;

    INSERT INTO payslip (employee_id, period_start, period_end, pay_date, created_by)
    VALUES (v_emp, DATE '2024-04-01', DATE '2024-04-30', DATE '2024-05-01', v_hr)
    RETURNING id INTO v_ps;

    -- A negative line on purpose: arrears and clawbacks are ordinary payroll events, and a
    -- fixture of only positive amounts cannot tell a signed sum from an unsigned one.
    INSERT INTO payslip_line (payslip_id, component_code, amount_minor) VALUES
        (v_ps, 'basic',            5000000),
        (v_ps, 'hra',              2000000),
        (v_ps, 'arrears',          -100000),   -- a correction against an earlier overpayment
        (v_ps, 'pf_employee',       600000),
        (v_ps, 'professional_tax',   20000);

    SELECT * INTO r FROM fn_payslip_totals(v_ps);
    IF r.gross_minor = 6900000 AND r.deductions_minor = 620000
       AND r.net_minor = 6280000 AND r.line_count = 5 THEN
        RAISE NOTICE 'PASS  PS4a totals derive with a signed line: gross=% deductions=% net=%',
            r.gross_minor, r.deductions_minor, r.net_minor;
    ELSE
        RAISE EXCEPTION 'FAIL  PS4a gross=% (want 6900000) deductions=% (want 620000) net=% (want 6280000)',
            r.gross_minor, r.deductions_minor, r.net_minor;
    END IF;

    -- PS4: THE INVARIANT. A declared net that disagrees with the lines cannot be issued.
    UPDATE payslip SET declared_net_minor = 6280001 WHERE id = v_ps;   -- one paise out
    v_ok := false;
    BEGIN
        INSERT INTO payslip_event (payslip_id, subject_employee_id, event_type, from_status,
                                   to_status, actor_employee_id)
        VALUES (v_ps, v_emp, 'issue', 'draft', 'issued', v_hr);
    EXCEPTION WHEN others THEN v_ok := true; END;

    IF v_ok THEN
        RAISE NOTICE 'PASS  PS4 a ONE PAISE disagreement between the PDF and the lines blocks issue';
    ELSE
        RAISE EXCEPTION 'FAIL  PS4 a payslip issued whose PDF and lines disagree';
    END IF;

    -- PS5: no self-issue. Tested on a payslip that is otherwise perfectly issuable, so it cannot
    -- pass because something earlier refused it first.
    UPDATE payslip SET declared_net_minor = 6280000, document_id = v_doc WHERE id = v_ps;
    v_ok := false;
    BEGIN
        INSERT INTO payslip_event (payslip_id, subject_employee_id, event_type, from_status,
                                   to_status, actor_employee_id)
        VALUES (v_ps, v_emp, 'issue', 'draft', 'issued', v_emp);
    EXCEPTION WHEN check_violation THEN v_ok := true; END;

    IF v_ok THEN
        RAISE NOTICE 'PASS  PS5 nobody issues their own payslip';
    ELSE
        RAISE EXCEPTION 'FAIL  PS5 an employee issued their own payslip';
    END IF;

    -- PS6: the denormalised subject must match its parent, or PS5 could be sidestepped by
    -- mis-stating who the payslip is about.
    v_ok := false;
    BEGIN
        INSERT INTO payslip_event (payslip_id, subject_employee_id, event_type, from_status,
                                   to_status, actor_employee_id)
        VALUES (v_ps, v_other, 'issue', 'draft', 'issued', v_emp);
    EXCEPTION WHEN others THEN v_ok := true; END;

    IF v_ok THEN
        RAISE NOTICE 'PASS  PS6 a mis-stated subject is refused, so PS5 cannot be sidestepped';
    ELSE
        RAISE EXCEPTION 'FAIL  PS6 the subject could be mis-stated';
    END IF;

    -- PS7: an invented transition is refused by the composite FK.
    v_ok := false;
    BEGIN
        INSERT INTO payslip_event (payslip_id, subject_employee_id, event_type, from_status,
                                   to_status, actor_employee_id)
        VALUES (v_ps, v_emp, 'approve', 'draft', 'issued', v_hr);
    EXCEPTION WHEN foreign_key_violation THEN v_ok := true; END;

    IF v_ok THEN
        RAISE NOTICE 'PASS  PS7 an invented transition is refused by the FSM foreign key';
    ELSE
        RAISE EXCEPTION 'FAIL  PS7 an unknown event_type was accepted';
    END IF;

    -- PS8: THE CROSS-EMPLOYEE DOCUMENT.
    UPDATE payslip SET document_id = v_odoc WHERE id = v_ps;
    v_ok := false;
    BEGIN
        INSERT INTO payslip_event (payslip_id, subject_employee_id, event_type, from_status,
                                   to_status, actor_employee_id)
        VALUES (v_ps, v_emp, 'issue', 'draft', 'issued', v_hr);
    EXCEPTION WHEN others THEN v_ok := true; END;

    IF v_ok THEN
        RAISE NOTICE 'PASS  PS8 another employee''s PDF cannot be issued as this payslip';
    ELSE
        RAISE EXCEPTION 'FAIL  PS8 a payslip was issued carrying somebody else''s document';
    END IF;

    -- PS9: the wrong document TYPE is refused.
    INSERT INTO employee_document (employee_id, document_type_code, title, uploaded_by)
    VALUES (v_emp, 'id_proof', 'Aadhaar', v_hr) RETURNING id INTO v_wrong;
    INSERT INTO employee_document_version
        (document_id, version_no, bucket, object_key, content_type, size_bytes, sha256_hex,
         scan_status, scanned_at, uploaded_by)
    VALUES (v_wrong, 1, 'hrm-documents', 'verify/ps-wrong.pdf', 'application/pdf', 10,
            repeat('3', 64), 'clean', now(), v_hr) RETURNING id INTO v_wver;
    UPDATE employee_document SET current_version_id = v_wver WHERE id = v_wrong;

    UPDATE payslip SET document_id = v_wrong WHERE id = v_ps;
    v_ok := false;
    BEGIN
        INSERT INTO payslip_event (payslip_id, subject_employee_id, event_type, from_status,
                                   to_status, actor_employee_id)
        VALUES (v_ps, v_emp, 'issue', 'draft', 'issued', v_hr);
    EXCEPTION WHEN others THEN v_ok := true; END;

    IF v_ok THEN
        RAISE NOTICE 'PASS  PS9 an id_proof cannot stand in for a payslip';
    ELSE
        RAISE EXCEPTION 'FAIL  PS9 the wrong document type was accepted';
    END IF;

    -- PS10: a QUARANTINED document is refused. 0018 check D6 already proves a version cannot be
    -- promoted to current until its scan is clean, so requiring a current version IS requiring a
    -- clean scan - asserted here because that link is not obvious from the column name.
    DECLARE v_q UUID;
    BEGIN
        INSERT INTO employee_document (employee_id, document_type_code, title, uploaded_by)
        VALUES (v_emp, 'payslip', 'Payslip awaiting scan', v_hr) RETURNING id INTO v_q;
        INSERT INTO employee_document_version
            (document_id, version_no, bucket, object_key, content_type, size_bytes, sha256_hex,
             uploaded_by)
        VALUES (v_q, 1, 'hrm-documents', 'verify/ps-pending.pdf', 'application/pdf', 10,
                repeat('4', 64), v_hr);

        UPDATE payslip SET document_id = v_q WHERE id = v_ps;
        v_ok := false;
        BEGIN
            INSERT INTO payslip_event (payslip_id, subject_employee_id, event_type, from_status,
                                       to_status, actor_employee_id)
            VALUES (v_ps, v_emp, 'issue', 'draft', 'issued', v_hr);
        EXCEPTION WHEN others THEN v_ok := true; END;

        IF v_ok THEN
            RAISE NOTICE 'PASS  PS10 a quarantined PDF cannot be issued';
        ELSE
            RAISE EXCEPTION 'FAIL  PS10 an unscanned document was issued';
        END IF;
    END;

    -- PS11: and with everything right, it issues.
    UPDATE payslip SET document_id = v_doc WHERE id = v_ps;
    INSERT INTO payslip_event (payslip_id, subject_employee_id, event_type, from_status,
                               to_status, actor_employee_id)
    VALUES (v_ps, v_emp, 'issue', 'draft', 'issued', v_hr);

    SELECT status, issued_at IS NOT NULL AND issued_by = v_hr AS stamped INTO r
      FROM payslip WHERE id = v_ps;
    IF r.status = 'issued' AND r.stamped THEN
        RAISE NOTICE 'PASS  PS11 a reconciling payslip with a clean, matching PDF issues';
    ELSE
        RAISE EXCEPTION 'FAIL  PS11 status=% stamped=%', r.status, r.stamped;
    END IF;

    -- PS12: THE WRITER FLAG DOES NOT LEAK (0025).
    --
    -- issued -> draft violates no CHECK constraint, so the ONLY thing that can refuse this is the
    -- status trigger. Before 0025 this UPDATE was accepted, because the event guard set
    -- hrm.payslip_event_writer and never cleared it - and `SET LOCAL` lasts for the transaction,
    -- not for the function.
    v_ok := false;
    BEGIN
        UPDATE payslip SET status = 'draft' WHERE id = v_ps;
    EXCEPTION WHEN others THEN v_ok := true; END;

    IF v_ok AND (SELECT status FROM payslip WHERE id = v_ps) = 'issued' THEN
        RAISE NOTICE 'PASS  PS12 the writer flag does not leak - status stays event-only (0025)';
    ELSE
        RAISE EXCEPTION
            'FAIL  PS12 payslip.status was written directly after a legitimate transition. The '
            'FSM, the composite FK, the no-self-issue CHECK and the issue-time reconciliation are '
            'all bypassable this way';
    END IF;

    -- PS13: an issued payslip's lines are frozen - the correspondence PS11 established must not
    -- be editable away afterwards.
    v_ok := false;
    BEGIN
        UPDATE payslip_line SET amount_minor = 1 WHERE payslip_id = v_ps AND component_code = 'basic';
    EXCEPTION WHEN others THEN v_ok := true; END;
    IF NOT v_ok THEN RAISE EXCEPTION 'FAIL  PS13 an issued payslip''s lines were edited'; END IF;

    v_ok := false;
    BEGIN
        DELETE FROM payslip_line WHERE payslip_id = v_ps AND component_code = 'hra';
    EXCEPTION WHEN others THEN v_ok := true; END;
    IF NOT v_ok THEN RAISE EXCEPTION 'FAIL  PS13 an issued payslip''s line was deleted'; END IF;

    SELECT net_minor INTO v_net FROM fn_payslip_totals(v_ps);
    IF v_net = 6280000 THEN
        RAISE NOTICE 'PASS  PS13 an issued payslip''s lines cannot be edited or deleted';
    ELSE
        RAISE EXCEPTION 'FAIL  PS13 the net moved to % after an issued payslip was poked', v_net;
    END IF;

    -- PS14: nor can it be re-pointed at a different document or re-priced.
    v_ok := false;
    BEGIN
        UPDATE payslip SET document_id = v_odoc WHERE id = v_ps;
    EXCEPTION WHEN others THEN v_ok := true; END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'FAIL  PS14 an issued payslip was re-pointed at another employee''s PDF';
    END IF;

    v_ok := false;
    BEGIN
        UPDATE payslip SET declared_net_minor = 1 WHERE id = v_ps;
    EXCEPTION WHEN others THEN v_ok := true; END;
    IF v_ok THEN
        RAISE NOTICE 'PASS  PS14 an issued payslip cannot be re-pointed or re-priced';
    ELSE
        RAISE EXCEPTION 'FAIL  PS14 the declared net of an issued payslip was changed';
    END IF;

    -- PS15: a payslip is never deleted - a deleted row takes its reason with it.
    v_ok := false;
    BEGIN
        DELETE FROM payslip WHERE id = v_ps;
    EXCEPTION WHEN others THEN v_ok := true; END;
    IF v_ok THEN
        RAISE NOTICE 'PASS  PS15 a payslip cannot be deleted';
    ELSE
        RAISE EXCEPTION 'FAIL  PS15 a payslip was deleted';
    END IF;

    -- PS16: voiding withdraws the document, so no reachable orphan is left behind.
    INSERT INTO payslip_event (payslip_id, subject_employee_id, event_type, from_status,
                               to_status, actor_employee_id, reason)
    VALUES (v_ps, v_emp, 'void', 'issued', 'void', v_hr, 'issued against the wrong period');

    SELECT d.withdrawn_at IS NOT NULL INTO v_withdrawn
      FROM employee_document d WHERE d.id = v_doc;

    IF (SELECT status FROM payslip WHERE id = v_ps) = 'void' AND v_withdrawn THEN
        RAISE NOTICE 'PASS  PS16 voiding withdrew the document - no reachable orphan PDF';
    ELSE
        RAISE EXCEPTION 'FAIL  PS16 void left the document reachable (withdrawn=%)', v_withdrawn;
    END IF;

    -- PS17: the event log is append-only.
    v_ok := false;
    BEGIN
        UPDATE payslip_event SET reason = 'rewritten' WHERE payslip_id = v_ps;
    EXCEPTION WHEN others THEN v_ok := true; END;
    IF NOT v_ok THEN RAISE EXCEPTION 'FAIL  PS17 a payslip event was rewritten'; END IF;

    v_ok := false;
    BEGIN
        DELETE FROM payslip_event WHERE payslip_id = v_ps;
    EXCEPTION WHEN others THEN v_ok := true; END;
    IF v_ok THEN
        RAISE NOTICE 'PASS  PS17 payslip_event is append-only';
    ELSE
        RAISE EXCEPTION 'FAIL  PS17 a payslip event was deleted';
    END IF;

    -- PS18: one LIVE payslip per employee per period; adjacent months are fine.
    DECLARE v_p2 UUID;
    BEGIN
        -- The April payslip above is void now, so April is free again - which is the ordinary
        -- reason to void one.
        INSERT INTO payslip (employee_id, period_start, period_end, created_by)
        VALUES (v_emp, DATE '2024-04-01', DATE '2024-04-30', v_hr) RETURNING id INTO v_p2;

        v_ok := false;
        BEGIN
            INSERT INTO payslip (employee_id, period_start, period_end, created_by)
            VALUES (v_emp, DATE '2024-04-15', DATE '2024-05-14', v_hr);
        EXCEPTION WHEN exclusion_violation THEN v_ok := true; END;
        IF NOT v_ok THEN RAISE EXCEPTION 'FAIL  PS18 two overlapping live payslips were accepted'; END IF;

        -- May is adjacent to April, not overlapping: the generated range is half-open.
        INSERT INTO payslip (employee_id, period_start, period_end, created_by)
        VALUES (v_emp, DATE '2024-05-01', DATE '2024-05-31', v_hr);

        RAISE NOTICE 'PASS  PS18 one live payslip per period; adjacent months are permitted';
    END;

    -- PS19: a retired component cannot be used on a new line, but history keeps it (DEC-044).
    DECLARE v_p3 UUID;
    BEGIN
        UPDATE payslip_component_type SET retired_on = fn_business_date() - 1 WHERE code = 'bonus';
        INSERT INTO payslip (employee_id, period_start, period_end, created_by)
        VALUES (v_emp, DATE '2024-06-01', DATE '2024-06-30', v_hr) RETURNING id INTO v_p3;

        v_ok := false;
        BEGIN
            INSERT INTO payslip_line (payslip_id, component_code, amount_minor)
            VALUES (v_p3, 'bonus', 100000);
        EXCEPTION WHEN others THEN v_ok := true; END;

        IF v_ok THEN
            RAISE NOTICE 'PASS  PS19 a retired component is refused for a NEW line';
        ELSE
            RAISE EXCEPTION 'FAIL  PS19 a retired component was used on a new payslip';
        END IF;
    END;
END $$;

-- ---------------------------------------------------------------------------
-- PS20: TIER 1. `hrm_app` must hold NOTHING on any payslip table.
--
-- rbac-rules.md structural integrity item 5: compensation tables sit behind a separate DB role
-- "so a SQL injection in the leave module physically cannot read salary". This check exists
-- because the DEFAULT is the opposite: migration 0008 line 93 runs
--
--     ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO hrm_app;
--
-- so every new table grants SELECT to hrm_app automatically. Tier 1 isolation is therefore
-- opt-OUT for the most sensitive class of table in the system, and 0024's REVOKEs are the
-- control rather than paperwork. If a later migration adds a compensation table without them,
-- this is what says so.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_bad TEXT;
BEGIN
    SELECT string_agg(format('%s:%s', t, p), ', ') INTO v_bad
      FROM (VALUES ('payslip'), ('payslip_line'), ('payslip_event'),
                   ('payslip_component_type'), ('payslip_status_transition')) AS tbl(t)
     CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'),
                        ('REFERENCES'), ('TRIGGER')) AS priv(p)
     WHERE has_table_privilege('hrm_app', tbl.t, priv.p);

    IF v_bad IS NULL THEN
        RAISE NOTICE 'PASS  PS20 hrm_app holds NO privilege on any payslip table (Tier 1)';
    ELSE
        RAISE EXCEPTION
            'FAIL  PS20 hrm_app can reach the salary register: %. 0008 grants SELECT on new '
            'tables by DEFAULT, so a compensation table must REVOKE explicitly', v_bad;
    END IF;
END $$;

-- PS21: and no payslip function is SECURITY DEFINER, which would hand that access straight back.
DO $$
DECLARE v_bad TEXT;
BEGIN
    SELECT string_agg(p.proname, ', ') INTO v_bad
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname LIKE '%payslip%' AND p.prosecdef;

    IF v_bad IS NULL THEN
        RAISE NOTICE 'PASS  PS21 no payslip function is SECURITY DEFINER';
    ELSE
        RAISE EXCEPTION
            'FAIL  PS21 SECURITY DEFINER on %: it would return exactly the read access PS20 '
            'removes, to any role that can call it', v_bad;
    END IF;
END $$;

-- PS22: search_path is pinned on every payslip function (precedent 0013).
DO $$
DECLARE v_bad TEXT;
BEGIN
    SELECT string_agg(p.proname, ', ') INTO v_bad
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname LIKE '%payslip%'
       AND NOT EXISTS (
            SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS c
             WHERE c LIKE 'search_path=%');

    IF v_bad IS NULL THEN
        RAISE NOTICE 'PASS  PS22 all payslip functions pin search_path';
    ELSE
        RAISE EXCEPTION 'FAIL  PS22 search_path not pinned on: %', v_bad;
    END IF;
END $$;

-- PS23: the audit function records the period and status and NEVER an amount. An audit trail
-- holding net pay would be a second, decade-retained salary register in the one table nobody can
-- redact.
DO $$
DECLARE v_src TEXT;
BEGIN
    SELECT prosrc INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_audit_payslip';

    IF v_src !~* 'declared_net|amount_minor|net_minor|gross_minor' THEN
        RAISE NOTICE 'PASS  PS23 the payslip audit trail records no amounts';
    ELSE
        RAISE EXCEPTION 'FAIL  PS23 fn_audit_payslip references a money column';
    END IF;
END $$;

-- PS24: the payslip document type is RESTRICTED and not self-uploadable. RESTRICTED keeps it out
-- of the employee's /documents entirely - their door is the payslip endpoint, which is gated by
-- payroll.payslip.read and admits the subject. Not self-uploadable because an employee producing
-- their own payslip is the fraud that prevents.
DO $$
DECLARE r RECORD;
BEGIN
    SELECT data_class, self_uploadable, retention_years INTO r
      FROM document_type WHERE code = 'payslip';

    IF r.data_class = 'RESTRICTED' AND NOT r.self_uploadable AND r.retention_years >= 8 THEN
        RAISE NOTICE 'PASS  PS24 payslip type: RESTRICTED, not self-uploadable, % year retention',
            r.retention_years;
    ELSE
        RAISE EXCEPTION 'FAIL  PS24 class=% self_uploadable=% retention=%',
            r.data_class, r.self_uploadable, r.retention_years;
    END IF;
END $$;

-- PS25: every payslip rail is ENABLE ALWAYS (DEC-030) - a plain ENABLE trigger is switched off by
-- session_replication_role='replica', which a restore or a replication tool sets.
DO $$
DECLARE v_bad TEXT;
BEGIN
    SELECT string_agg(format('%s.%s', c.relname, t.tgname), ', ') INTO v_bad
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE NOT t.tgisinternal
       AND c.relname IN ('payslip', 'payslip_line', 'payslip_event')
       AND t.tgenabled <> 'A';

    IF v_bad IS NULL THEN
        RAISE NOTICE 'PASS  PS25 all payslip triggers are ENABLE ALWAYS';
    ELSE
        RAISE EXCEPTION 'FAIL  PS25 these are switched off under replica mode: %', v_bad;
    END IF;
END $$;
