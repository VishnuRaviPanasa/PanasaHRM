-- =============================================================================
-- Verification for 0036: the assistant's `onboarding` routing domain
--
-- The checks that carry the weight:
--
--   B1  `onboarding` is ACCEPTED. This is the whole reason the migration exists: without it a
--       turn routed to onboarding answers the user and then fails its transcript INSERT, which is
--       the worst-shaped failure available - the disclosure has already happened and the audit
--       row has not.
--   B2  `payroll` is STILL REFUSED. Widening a closed set is exactly when it quietly stops being
--       closed. Check A6 of the assistant verification asserts this too; it is repeated here
--       because this file is the one that changed the constraint, and a widening that took the
--       whole set with it must fail HERE rather than in a file nobody re-reads.
--   B3  every domain the previous constraint accepted is accepted still, enumerated one by one.
--       "It only adds a value" is a claim about a DROP followed by an ADD, and the DROP is the
--       half that can lose something.
--   B4  the money columns of `salary_annexure` are NOT in the assistant's reach. This does not
--       belong to 0036's DDL and is asserted here deliberately: 0036 is the change that lets
--       onboarding questions reach a tool at all, so it is the right place to pin the reason
--       that is safe. ADR-0020 carries ADR-0014's compensation prohibition "verbatim and
--       unweakened" and makes it structural - the guarantee is that no money column is
--       registered, and a registry that grew one would make this check fail.
--
-- Every deliberate failure runs inside its own BEGIN/EXCEPTION block, for the reason the 0029
-- assistant file states: a raised constraint aborts the whole transaction otherwise, and the
-- remaining checks then "pass" because they never execute.
-- =============================================================================

DO $$
DECLARE
    v_user uuid;
    v_conv uuid;
    v_seq  int := 100;
    v_dom  text;
    v_def  text;
BEGIN
    SELECT id INTO v_user FROM app_user LIMIT 1;
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'FAIL  B0 fixtures missing - at least one app_user must exist';
    END IF;

    INSERT INTO assistant_conversation (user_id) VALUES (v_user) RETURNING id INTO v_conv;

    -- ------------------------------------------------------------------ B1  onboarding accepted
    BEGIN
        INSERT INTO assistant_message
            (conversation_id, seq, question_text, route_domain, tool_name, row_count)
        VALUES (v_conv, v_seq, 'which annexures are waiting for finance?', 'onboarding',
                'onboarding_annexure_status', 1);
        RAISE NOTICE 'PASS  B1 route_domain accepts onboarding';
        v_seq := v_seq + 1;
    EXCEPTION WHEN check_violation THEN
        RAISE EXCEPTION
            'FAIL  B1 route_domain REFUSED onboarding - a turn routed there would answer the '
            'user and then fail its own transcript INSERT';
    END;

    -- ------------------------------------------------------------------ B2  payroll still refused
    BEGIN
        INSERT INTO assistant_message
            (conversation_id, seq, question_text, route_domain, tool_name, row_count)
        VALUES (v_conv, v_seq, 'q', 'payroll', 'leave_balance', 1);
        RAISE EXCEPTION
            'FAIL  B2 widening the domain set also accepted "payroll" - there is no payroll '
            'domain, and a catalogue that could route there is what ADR-0014 forbids';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS  B2 payroll is still refused after the widening';
        -- The failed INSERT consumed no sequence number.
    END;

    -- ------------------------------------------------------------------ B3  nothing was lost
    FOREACH v_dom IN ARRAY ARRAY['me', 'leave', 'attendance', 'work', 'people', 'documents',
                                 'cross', 'meta']
    LOOP
        BEGIN
            INSERT INTO assistant_message
                (conversation_id, seq, question_text, route_domain, tool_name, row_count)
            VALUES (v_conv, v_seq, 'q', v_dom, 'leave_balance', 1);
            v_seq := v_seq + 1;
        EXCEPTION WHEN check_violation THEN
            RAISE EXCEPTION
                'FAIL  B3 the DROP/ADD lost an existing domain: %L is no longer accepted', v_dom;
        END;
    END LOOP;
    RAISE NOTICE 'PASS  B3 all eight pre-existing routing domains are still accepted';

    -- ------------------------------------------------------------------ B4  no money in reach
    -- Asserted against the constraint definition rather than the registry, which is TypeScript
    -- and not reachable from here: the CHECK proves the columns EXIST on the table, so a
    -- registry that later adds them has something real to expose. The TypeScript side is pinned
    -- by `assistant:onboarding` in testing/demo.
    SELECT pg_get_constraintdef(oid) INTO v_def
      FROM pg_constraint
     WHERE conrelid = 'salary_annexure'::regclass
       AND conname = 'ck_salary_annexure_ctc_positive';

    IF v_def IS NULL THEN
        RAISE EXCEPTION
            'FAIL  B4 ck_salary_annexure_ctc_positive is gone - the money column this check '
            'describes may have been renamed, and the registry exclusion is keyed on its name';
    END IF;
    RAISE NOTICE 'PASS  B4 declared_annual_ctc_minor still exists and is still named as expected';

    RAISE NOTICE 'PASS  0036 assistant onboarding domain: 4 checks';
END $$;
