-- =============================================================================
-- Verification for 0037: the assistant's `pay` routing domain (ADR-0021)
--
--   C1  `pay` is ACCEPTED - without it a turn routed there answers the user and then fails its
--       own transcript INSERT, which is the worst-shaped failure available.
--   C2  `payroll` is STILL REFUSED. ADR-0021 relaxes the LOOKUP of a figure somebody may already
--       read; it does not touch ADR-0014's prohibition on AI input to a compensation DECISION,
--       which is what check A6 of the assistant verification pins to that value. Widening a
--       closed set is exactly when it stops being closed, so this is asserted here too - in the
--       file that changed the constraint, rather than only in one nobody re-reads.
--   C3  every domain accepted before is accepted still, enumerated one by one. "It only adds a
--       value" is a claim about a DROP followed by an ADD, and the DROP is the half that loses.
--   C4  the money columns ADR-0021 makes readable still EXIST under the names the field registry
--       keys on. The registry is TypeScript and unreachable from here; what this can prove is
--       that a rename has not silently turned a registered column into a dead entry, which would
--       read as "no pay is visible" while the real column went unguarded.
-- =============================================================================

DO $$
DECLARE
    v_user uuid;
    v_conv uuid;
    v_seq  int := 200;
    v_dom  text;
    v_col  text;
BEGIN
    SELECT id INTO v_user FROM app_user LIMIT 1;
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'FAIL  C0 fixtures missing - at least one app_user must exist';
    END IF;

    INSERT INTO assistant_conversation (user_id) VALUES (v_user) RETURNING id INTO v_conv;

    -- ------------------------------------------------------------------ C1  pay accepted
    BEGIN
        INSERT INTO assistant_message
            (conversation_id, seq, question_text, route_domain, tool_name, row_count)
        VALUES (v_conv, v_seq, 'what is my net pay for august?', 'pay',
                'pay_my_payslip_amounts', 1);
        RAISE NOTICE 'PASS  C1 route_domain accepts pay';
        v_seq := v_seq + 1;
    EXCEPTION WHEN check_violation THEN
        RAISE EXCEPTION
            'FAIL  C1 route_domain REFUSED pay - a turn routed there would answer the user and '
            'then fail its own transcript INSERT';
    END;

    -- ------------------------------------------------------------------ C2  payroll still refused
    BEGIN
        INSERT INTO assistant_message
            (conversation_id, seq, question_text, route_domain, tool_name, row_count)
        VALUES (v_conv, v_seq, 'q', 'payroll', 'leave_balance', 1);
        RAISE EXCEPTION
            'FAIL  C2 the widening also accepted "payroll". ADR-0021 permits reporting a figure '
            'somebody may already read; it does not permit a catalogue that routes to payroll '
            'DECISIONS, which ADR-0014 forbids';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS  C2 payroll is still refused after the pay widening';
    END;

    -- ------------------------------------------------------------------ C3  nothing was lost
    FOREACH v_dom IN ARRAY ARRAY['me', 'leave', 'attendance', 'work', 'people', 'documents',
                                 'cross', 'meta', 'onboarding']
    LOOP
        BEGIN
            INSERT INTO assistant_message
                (conversation_id, seq, question_text, route_domain, tool_name, row_count)
            VALUES (v_conv, v_seq, 'q', v_dom, 'leave_balance', 1);
            v_seq := v_seq + 1;
        EXCEPTION WHEN check_violation THEN
            RAISE EXCEPTION
                'FAIL  C3 the DROP/ADD lost an existing domain: %L is no longer accepted', v_dom;
        END;
    END LOOP;
    RAISE NOTICE 'PASS  C3 all nine pre-existing routing domains are still accepted';

    -- ------------------------------------------------------------------ C4  the columns exist
    FOREACH v_col IN ARRAY ARRAY['declared_annual_ctc_minor', 'proposed_joining_on']
    LOOP
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'salary_annexure' AND column_name = v_col) THEN
            RAISE EXCEPTION
                'FAIL  C4 salary_annexure.%s is gone - the field registry keys on that name, so '
                'a rename leaves a dead entry and an unguarded column', v_col;
        END IF;
    END LOOP;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'salary_annexure_component' AND column_name = 'amount_minor')
    THEN
        RAISE EXCEPTION 'FAIL  C4 salary_annexure_component.amount_minor is gone';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'payslip' AND column_name = 'currency_code') THEN
        RAISE EXCEPTION
            'FAIL  C4 payslip.currency_code is gone - a pay sentence states a currency and must '
            'read it rather than assume rupees';
    END IF;

    RAISE NOTICE 'PASS  C4 every money column the registry names still exists';

    RAISE NOTICE 'PASS  0037 assistant pay domain: 4 checks';
END $$;
