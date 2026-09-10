-- =============================================================================
-- Verification for 0035: assistant transcripts
--
-- Named 0029 until 2026-09-10. The migration was drafted as 0029 on the `feature/chatbot` branch,
-- but 0029-0034 had been taken by account activation and the offer chain by the time it merged,
-- so commit cddf1bd renamed the MIGRATION to 0035 and left this file behind - sitting next to
-- 0029_account_activation.verify.sql and describing a migration six numbers away.
--
-- The checks that carry the weight:
--
--   A7   THE COLUMN LIST IS EXACT. This is the whole point of the file. ADR-0020 and DEC-133 say
--        no result row is ever stored, and "we did not add that column" is not a control - it
--        decays the first time somebody adds conversation history in a hurry. Enumerating the
--        columns makes the addition FAIL instead of passing review.
--   A8   tool_args must be a JSON OBJECT and
--   A9   must fit in 2 KB. Together these are what stop `tool_args` quietly becoming the result
--        column that A7 forbids by name.
--   A2   a transcript inside the retention window cannot be deleted, and
--   A3   one past it can. This table is the only append-only table here that PERMITS delete, and
--        both directions have to be proven or the rail is decoration.
--   A11  the audit row records the tool and the row COUNT and NOT the question text. The question
--        is PERSONAL and audit_event has decade retention with no selective erasure, so leaking
--        it into audit would permanently defeat the 90-day window DEC-130 sets.
--   A12  audit_column_policy coverage is TOTAL, per ADR-0005 amendment (c) - "the absence of an
--        entry is never permission".
--
-- Every deliberate failure runs inside its own BEGIN/EXCEPTION block. A raised constraint aborts
-- the whole transaction otherwise, and the remaining checks then "pass" because they never
-- execute - which is how three payslip checks passed for the wrong reason earlier in this repo.
--
-- Fixtures are created here rather than borrowed from the seed. Four checks in this repository
-- have gone vacuous against seed state they did not create (0014 L13, 0017 G5, 0012 N8, and the
-- task report), and a transcript table the seed never populates would be the fifth.
-- =============================================================================

\set ON_ERROR_STOP on

DO $$
DECLARE
    v_user      UUID;
    v_emp       UUID;
    v_conv      UUID;
    v_msg       UUID;
    v_old_msg   UUID;
    v_audit     BIGINT;
    v_after     JSONB;
    v_reason    TEXT;
    v_n         INT;
    v_ok        BOOLEAN;
    v_cols      TEXT[];
    v_want      TEXT[];
    v_big       JSONB;
    v_enabled   "char";
    v_question  TEXT := 'How much casual leave does Priya have left this year?';
BEGIN
    -- ---------------------------------------------------------------- fixtures

    -- ORDER BY, not a bare LIMIT 1. Trap 11 in the handoff: whichever row the planner reaches
    -- first is not a stable choice, and it has bitten this repo three times.
    SELECT u.id, u.employee_id INTO v_user, v_emp
      FROM app_user u
     WHERE u.employee_id IS NOT NULL
     ORDER BY u.email
     LIMIT 1;

    IF v_user IS NULL THEN
        RAISE EXCEPTION 'FAIL  A0 no seeded app_user with an employee - fixtures cannot be built';
    END IF;

    INSERT INTO assistant_conversation (user_id, employee_id, locale)
    VALUES (v_user, v_emp, 'en')
    RETURNING id INTO v_conv;

    INSERT INTO assistant_message
        (conversation_id, seq, question_text, route_domain, tool_name, tool_args,
         row_count, model, prompt_tokens, completion_tokens, latency_ms)
    VALUES
        (v_conv, 1, v_question, 'leave', 'leave_balance',
         jsonb_build_object('employeeNumber', 'EMP006', 'leaveYear', 2026),
         3, 'gpt-4o-mini', 812, 41, 940)
    RETURNING id INTO v_msg;

    RAISE NOTICE 'PASS  A0 a conversation and a turn can be recorded';

    -- ---------------------------------------------------------------- A1  no UPDATE
    BEGIN
        UPDATE assistant_message SET question_text = 'something else' WHERE id = v_msg;
        RAISE EXCEPTION 'FAIL  A1 a transcript row was UPDATEd - it must be append-only';
    EXCEPTION WHEN restrict_violation THEN
        RAISE NOTICE 'PASS  A1 assistant_message refuses UPDATE';
    END;

    -- ---------------------------------------------------------------- A2  no DELETE in window
    BEGIN
        DELETE FROM assistant_message WHERE id = v_msg;
        RAISE EXCEPTION
            'FAIL  A2 a transcript inside the retention window was deleted';
    EXCEPTION WHEN restrict_violation THEN
        RAISE NOTICE 'PASS  A2 a transcript inside the retention window cannot be deleted';
    END;

    -- ---------------------------------------------------------------- A3  DELETE past the window
    -- The other direction. Without this, A2 would be satisfied by a table that simply forbids
    -- delete outright, which is NOT what DEC-130 asks for - a chat log kept forever is the harm.
    INSERT INTO assistant_message
        (conversation_id, seq, asked_at, question_text, tool_name, row_count)
    VALUES
        (v_conv, 2, now() - INTERVAL '200 days', 'an expired question', 'leave_balance', 0)
    RETURNING id INTO v_old_msg;

    DELETE FROM assistant_message WHERE id = v_old_msg;

    SELECT count(*) INTO v_n FROM assistant_message WHERE id = v_old_msg;
    IF v_n <> 0 THEN
        RAISE EXCEPTION 'FAIL  A3 a transcript past the retention window survived deletion';
    END IF;
    RAISE NOTICE 'PASS  A3 a transcript past the retention window can be deleted';

    -- ---------------------------------------------------------------- A4  a turn needs an outcome
    BEGIN
        INSERT INTO assistant_message (conversation_id, seq, question_text)
        VALUES (v_conv, 3, 'no tool and no refusal');
        RAISE EXCEPTION
            'FAIL  A4 a turn was recorded with neither a tool nor a refusal code';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS  A4 a turn must record an outcome';
    END;

    -- ---------------------------------------------------------------- A5  refusal code closed set
    BEGIN
        INSERT INTO assistant_message (conversation_id, seq, question_text, refusal_code)
        VALUES (v_conv, 4, 'q', 'because_i_said_so');
        RAISE EXCEPTION 'FAIL  A5 an unknown refusal_code was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS  A5 refusal_code is a closed set';
    END;

    -- ---------------------------------------------------------------- A6  route domain closed set
    BEGIN
        INSERT INTO assistant_message
            (conversation_id, seq, question_text, route_domain, tool_name, row_count)
        VALUES (v_conv, 5, 'q', 'payroll', 'leave_balance', 1);
        RAISE EXCEPTION
            'FAIL  A6 route_domain accepted "payroll" - there is no payroll domain, and a tool '
            'catalogue that could route there is exactly what ADR-0014 forbids';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS  A6 route_domain is a closed set and excludes payroll';
    END;

    -- ---------------------------------------------------------------- A7  NO RESULT COLUMN
    -- The load-bearing check. If somebody adds `result_rows`, `answer`, `rows` or `response_json`
    -- to hold conversation history, this fails and they read DEC-133 instead of shipping it.
    v_want := ARRAY[
        'asked_at', 'completion_tokens', 'conversation_id', 'id', 'latency_ms', 'model',
        'prompt_tokens', 'question_text', 'refusal_code', 'route_domain', 'row_count',
        'seq', 'tool_args', 'tool_name'
    ];

    SELECT array_agg(column_name ORDER BY column_name) INTO v_cols
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'assistant_message';

    IF v_cols IS DISTINCT FROM v_want THEN
        RAISE EXCEPTION
            'FAIL  A7 assistant_message column list changed. Got %, want %. A new column here '
            'needs DEC-133 read first: this table must not be able to hold a result row, and it '
            'must be registered in audit_column_policy (A12).', v_cols, v_want;
    END IF;
    RAISE NOTICE 'PASS  A7 assistant_message holds no column capable of storing a result row';

    -- ---------------------------------------------------------------- A8  tool_args is an object
    BEGIN
        INSERT INTO assistant_message
            (conversation_id, seq, question_text, tool_name, tool_args, row_count)
        VALUES (v_conv, 6, 'q', 'leave_balance',
                jsonb_build_array(jsonb_build_object('employee', 'EMP006', 'available', 7)), 1);
        RAISE EXCEPTION
            'FAIL  A8 tool_args accepted a JSON ARRAY - which is the shape a result set has, and '
            'is how this column would become the result store A7 forbids';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS  A8 tool_args must be a JSON object, not an array';
    END;

    -- ---------------------------------------------------------------- A9  tool_args is bounded
    -- md5 hex rather than repeat('x', n): a compressible payload would understate its own size.
    SELECT jsonb_object_agg('k' || g, md5(g::text) || md5((g * 7)::text))
      INTO v_big
      FROM generate_series(1, 120) g;

    IF pg_column_size(v_big) <= 2048 THEN
        RAISE EXCEPTION
            'FAIL  A9 the oversize fixture is only % bytes - it cannot prove the 2 KB cap',
            pg_column_size(v_big);
    END IF;

    BEGIN
        INSERT INTO assistant_message
            (conversation_id, seq, question_text, tool_name, tool_args, row_count)
        VALUES (v_conv, 7, 'q', 'leave_balance', v_big, 1);
        RAISE EXCEPTION 'FAIL  A9 tool_args accepted % bytes, over the 2 KB cap',
            pg_column_size(v_big);
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS  A9 tool_args is capped at 2 KB';
    END;

    -- ---------------------------------------------------------------- A10 question text bounded
    BEGIN
        INSERT INTO assistant_message (conversation_id, seq, question_text, tool_name, row_count)
        VALUES (v_conv, 8, repeat('q', 2001), 'leave_balance', 1);
        RAISE EXCEPTION 'FAIL  A10 an unbounded question was stored - this column is PERSONAL '
                        'and is the one that leaves the jurisdiction';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO assistant_message (conversation_id, seq, question_text, tool_name, row_count)
        VALUES (v_conv, 9, '', 'leave_balance', 1);
        RAISE EXCEPTION 'FAIL  A10 an empty question was stored';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS  A10 question_text is bounded at both ends (1..2000)';
    END;

    -- ---------------------------------------------------------------- A11 audit records shape,
    --                                                                       never the question
    v_audit := fn_audit_assistant(
        'assistant.query', v_msg, v_user, v_emp, v_emp, 'leave_balance',
        NULL, NULL, NULL, 'assistant.query:allow', ARRAY['employee']);

    SELECT after, reason INTO v_after, v_reason FROM audit_event WHERE id = v_audit;

    IF v_after IS NULL THEN
        RAISE EXCEPTION 'FAIL  A11 fn_audit_assistant wrote no payload';
    END IF;

    IF v_after ->> 'tool' IS DISTINCT FROM 'leave_balance' THEN
        RAISE EXCEPTION 'FAIL  A11 the audit row does not name the tool (got %)',
            v_after ->> 'tool';
    END IF;

    IF (v_after ->> 'row_count')::INT IS DISTINCT FROM 3 THEN
        RAISE EXCEPTION 'FAIL  A11 the audit row lost the row count (got %)',
            v_after ->> 'row_count';
    END IF;

    -- The whole point. The question must not be reachable from audit_event by any route.
    IF v_after::TEXT LIKE '%Priya%'
       OR coalesce(v_reason, '') LIKE '%Priya%'
       OR v_after ? 'question_text'
       OR v_after ? 'question' THEN
        RAISE EXCEPTION
            'FAIL  A11 the question text reached audit_event. audit_event has decade retention '
            'and no selective erasure, so this permanently defeats the 90-day transcript window '
            '(DEC-130). after=%, reason=%', v_after, v_reason;
    END IF;

    -- Nor the argument values, which can carry an employee number the user typed.
    IF v_after::TEXT LIKE '%EMP006%' THEN
        RAISE EXCEPTION 'FAIL  A11 a tool ARGUMENT value reached audit_event: %', v_after;
    END IF;

    RAISE NOTICE 'PASS  A11 audit records the tool and the row count, never the question or args';

    -- ---------------------------------------------------------------- A12 audit policy coverage
    SELECT count(*) INTO v_n
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.table_name IN ('assistant_message', 'assistant_conversation')
       AND NOT EXISTS (
            SELECT 1 FROM audit_column_policy p
             WHERE p.table_name = c.table_name AND p.column_name = c.column_name);

    IF v_n <> 0 THEN
        RAISE EXCEPTION
            'FAIL  A12 % assistant column(s) have no audit_column_policy entry. ADR-0005 (c): '
            'both registries default closed and the absence of an entry is never permission', v_n;
    END IF;
    RAISE NOTICE 'PASS  A12 every assistant column is registered in audit_column_policy';

    -- ---------------------------------------------------------------- A13 unknown window refuses
    -- Fail closed. If the retention setting is missing, deletion is guessing - and the guess
    -- would be made against the one table holding the column that leaves the jurisdiction.
    INSERT INTO assistant_message
        (conversation_id, seq, asked_at, question_text, tool_name, row_count)
    VALUES (v_conv, 10, now() - INTERVAL '300 days', 'another expired question',
            'leave_balance', 0)
    RETURNING id INTO v_old_msg;

    DELETE FROM org_setting WHERE key = 'assistant.transcript_retention_days';

    BEGIN
        DELETE FROM assistant_message WHERE id = v_old_msg;
        RAISE EXCEPTION
            'FAIL  A13 a transcript was deleted while the retention window was unconfigured';
    EXCEPTION WHEN restrict_violation THEN
        RAISE NOTICE 'PASS  A13 deletion fails closed when the retention window is unknown';
    END;

    -- ---------------------------------------------------------------- A14 no floating point
    SELECT count(*) INTO v_n
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name IN ('assistant_message', 'assistant_conversation')
       AND data_type IN ('real', 'double precision');

    IF v_n <> 0 THEN
        RAISE EXCEPTION 'FAIL  A14 % floating-point column(s) on the assistant tables', v_n;
    END IF;
    RAISE NOTICE 'PASS  A14 no floating-point column on the assistant tables';

    -- ---------------------------------------------------------------- A15 rail survives a restore
    SELECT tgenabled INTO v_enabled
      FROM pg_trigger
     WHERE tgrelid = 'assistant_message'::regclass
       AND tgname = 'trg_assistant_message_immutable';

    IF v_enabled IS DISTINCT FROM 'A' THEN
        RAISE EXCEPTION
            'FAIL  A15 trg_assistant_message_immutable is tgenabled=% not A. DEC-030: the rail '
            'must survive a restore or a bulk load, not only ordinary traffic',
            coalesce(v_enabled::TEXT, 'MISSING');
    END IF;
    RAISE NOTICE 'PASS  A15 the append-only rail is ENABLE ALWAYS';

END $$;
