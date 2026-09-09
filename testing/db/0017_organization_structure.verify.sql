-- =============================================================================
-- Verification for 0017: organization structure
--
-- The checks that carry the weight:
--
--   G7  a reorganisation does not rewrite history - last year's structure still resolves to
--       last year's parent, which is the whole reason department_period exists rather than a
--       `parent_id` column on `department`.
--   G9  the subtree walk terminates on a two-department cycle. The EXCLUDE constraint gives one
--       parent per date and a CHECK stops self-parenting, but nothing stops A -> B -> A.
--   G13 a retired designation is refused for a NEW assignment and remains valid for the
--       historical rows that reference it. A boolean could not express that.
--
-- Fixtures are created by the checks that use them. Runs inside a transaction the runner always
-- rolls back (DEC-024).
--
-- NOTE ON BUILDING HISTORY IN A TEST: back-dating a period's `valid_to` is refused by Rule 3 in
-- every case, while a back-dated INSERT is permitted behind the DEC-029 opt-in. So history is
-- built by inserting CLOSED periods directly, never by inserting an open one and closing it.
-- The first draft of this suite got that backwards and the rail correctly refused it.
-- =============================================================================

-- G1: structure is effective-dated, identity is not. Renaming must not need a new period.
DO $$
DECLARE v_missing TEXT := '';
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_attribute
                    WHERE attrelid = 'department_period'::regclass AND attname = 'valid_period') THEN
        v_missing := v_missing || 'department_period.valid_period ';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute
                WHERE attrelid = 'department'::regclass AND attname = 'parent_department_id') THEN
        v_missing := v_missing || 'department still carries a mutable parent column ';
    END IF;
    IF v_missing <> '' THEN RAISE EXCEPTION 'FAIL  G1 %', v_missing; END IF;
    RAISE NOTICE 'PASS  G1 structure is effective-dated; department identity stays mutable';
END $$;

-- G2: the empty-period CHECK is present on every new effective-dated table. A zero-length row
-- slips past the exclusion constraint and then matches no as-of query.
DO $$
DECLARE v_bad TEXT;
BEGIN
    SELECT string_agg(t, ', ') INTO v_bad FROM (
        SELECT t FROM unnest(ARRAY['department_period','team_period','team_membership']) AS t
         WHERE NOT EXISTS (
            SELECT 1 FROM pg_constraint c
             WHERE c.conrelid = t::regclass AND c.contype = 'c'
               AND pg_get_constraintdef(c.oid) ILIKE '%isempty%')) q;
    IF v_bad IS NULL THEN RAISE NOTICE 'PASS  G2 every period table forbids an empty range';
    ELSE RAISE EXCEPTION 'FAIL  G2 missing the isempty CHECK on: %', v_bad; END IF;
END $$;

-- G3: one placement per department per date.
DO $$
DECLARE v_d UUID; v_ok BOOLEAN := false;
BEGIN
    SET LOCAL hrm.allow_backdated_period = 'on';
    INSERT INTO department (code, name) VALUES ('VG3', 'Verify G3') RETURNING id INTO v_d;
    INSERT INTO department_period (department_id, parent_department_id, valid_from)
    VALUES (v_d, NULL, '2024-01-01');
    BEGIN
        INSERT INTO department_period (department_id, parent_department_id, valid_from)
        VALUES (v_d, NULL, '2024-06-01');
    EXCEPTION WHEN exclusion_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  G3 overlapping department placements are refused';
    ELSE RAISE EXCEPTION 'FAIL  G3 a department was placed twice at once'; END IF;
END $$;

-- G4: a department cannot be its own parent.
DO $$
DECLARE v_d UUID; v_ok BOOLEAN := false;
BEGIN
    SET LOCAL hrm.allow_backdated_period = 'on';
    INSERT INTO department (code, name) VALUES ('VG4', 'Verify G4') RETURNING id INTO v_d;
    BEGIN
        INSERT INTO department_period (department_id, parent_department_id, valid_from)
        VALUES (v_d, v_d, '2024-01-01');
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  G4 a department cannot be its own parent';
    ELSE RAISE EXCEPTION 'FAIL  G4 self-parenting accepted'; END IF;
END $$;

-- G5: Rule 3 on a placement. Four behaviours, and the first draft of this check caught none of
-- them: it selected `WHERE valid_to IS NULL LIMIT 1`, drew a ROOT department whose parent was
-- already NULL, and set it to NULL again - a no-op, which fn_block_historical_mutation
-- deliberately permits. It reported the guard as broken when the guard was fine. Own fixture,
-- and a change that is genuinely a change (the L13 lesson, again).
DO $$
DECLARE v_parent UUID; v_child UUID; v_id UUID;
        v_edit BOOLEAN := false; v_backdate BOOLEAN := false;
        v_noop BOOLEAN := false; v_close BOOLEAN := false;
BEGIN
    SET LOCAL hrm.allow_backdated_period = 'on';
    INSERT INTO department (code,name) VALUES ('VG5P','G5 Parent') RETURNING id INTO v_parent;
    INSERT INTO department (code,name) VALUES ('VG5C','G5 Child')  RETURNING id INTO v_child;
    INSERT INTO department_period (department_id, parent_department_id, valid_from)
    VALUES (v_parent, NULL, '2024-01-01');
    INSERT INTO department_period (department_id, parent_department_id, valid_from)
    VALUES (v_child, v_parent, '2024-01-01')
    RETURNING id INTO v_id;

    -- 1. Re-parenting in place is refused. An open period starting in 2024 covers everything
    --    since, so editing it would rewrite two years of structure at once.
    BEGIN UPDATE department_period SET parent_department_id = NULL WHERE id = v_id;
    EXCEPTION WHEN restrict_violation THEN v_edit := true; END;

    -- 2. Back-dating the closure is refused (H-1 / DEC-028).
    BEGIN UPDATE department_period SET valid_to = fn_business_date() - 30 WHERE id = v_id;
    EXCEPTION WHEN restrict_violation THEN v_backdate := true; END;

    -- 3. A no-op UPDATE is PERMITTED, and that is deliberate, not an oversight - it changes no
    --    history. Pinned so nobody "fixes" it into a failure.
    BEGIN
        UPDATE department_period SET parent_department_id = v_parent WHERE id = v_id;
        v_noop := true;
    EXCEPTION WHEN restrict_violation THEN v_noop := false; END;

    -- 4. Closing the open period forward in business time IS the sanctioned path.
    BEGIN
        UPDATE department_period SET valid_to = fn_business_date() WHERE id = v_id;
        v_close := true;
    EXCEPTION WHEN restrict_violation THEN v_close := false; END;

    IF v_edit AND v_backdate AND v_noop AND v_close THEN
        RAISE NOTICE 'PASS  G5 re-parenting and back-dating refused; no-op and forward close allowed';
    ELSE
        RAISE EXCEPTION
            'FAIL  G5 reparent_blocked=% backdate_blocked=% noop_allowed=% forward_close_allowed=%',
            v_edit, v_backdate, v_noop, v_close;
    END IF;
END $$;

-- G6: the hierarchy resolves, with correct depths.
DO $$
DECLARE v_root UUID; v_a UUID; v_b UUID; v_c UUID; v_rows INT; v_depth2 INT;
BEGIN
    SET LOCAL hrm.allow_backdated_period = 'on';
    INSERT INTO department (code,name) VALUES ('VG6R','G6 Root')  RETURNING id INTO v_root;
    INSERT INTO department (code,name) VALUES ('VG6A','G6 A')     RETURNING id INTO v_a;
    INSERT INTO department (code,name) VALUES ('VG6B','G6 B')     RETURNING id INTO v_b;
    INSERT INTO department (code,name) VALUES ('VG6C','G6 C')     RETURNING id INTO v_c;

    INSERT INTO department_period (department_id, parent_department_id, valid_from) VALUES
        (v_root, NULL, '2024-01-01'),
        (v_a, v_root, '2024-01-01'),
        (v_b, v_root, '2024-01-01'),
        (v_c, v_a,    '2024-01-01');

    SELECT count(*) INTO v_rows FROM fn_department_subtree_asof(v_root, '2024-06-01');
    SELECT depth INTO v_depth2 FROM fn_department_subtree_asof(v_root, '2024-06-01')
     WHERE department_id = v_c;

    IF v_rows = 3 AND v_depth2 = 2 THEN
        RAISE NOTICE 'PASS  G6 subtree resolves: 3 units, the grandchild at depth 2';
    ELSE
        RAISE EXCEPTION 'FAIL  G6 rows=% grandchild_depth=%', v_rows, v_depth2;
    END IF;
END $$;

-- G7: A REORGANISATION DOES NOT REWRITE HISTORY. The whole justification for the table.
DO $$
DECLARE v_root UUID; v_x UUID; v_y UUID; v_moved UUID;
        v_before UUID; v_after UUID; v_x_before INT; v_x_after INT;
BEGIN
    SET LOCAL hrm.allow_backdated_period = 'on';
    INSERT INTO department (code,name) VALUES ('VG7R','G7 Root') RETURNING id INTO v_root;
    INSERT INTO department (code,name) VALUES ('VG7X','G7 X')    RETURNING id INTO v_x;
    INSERT INTO department (code,name) VALUES ('VG7Y','G7 Y')    RETURNING id INTO v_y;
    INSERT INTO department (code,name) VALUES ('VG7M','G7 Moved') RETURNING id INTO v_moved;

    INSERT INTO department_period (department_id, parent_department_id, valid_from, valid_to) VALUES
        (v_root, NULL,  '2024-01-01', NULL),
        (v_x,    v_root,'2024-01-01', NULL),
        (v_y,    v_root,'2024-01-01', NULL),
        -- Under X until 2025-07-01, then under Y. Two periods, no UPDATE.
        (v_moved, v_x,  '2024-01-01', '2025-07-01'),
        (v_moved, v_y,  '2025-07-01', NULL);

    v_before := fn_department_parent_asof(v_moved, '2025-06-30');
    v_after  := fn_department_parent_asof(v_moved, '2025-07-02');

    SELECT count(*) INTO v_x_before FROM fn_department_subtree_asof(v_x, '2025-06-30');
    SELECT count(*) INTO v_x_after  FROM fn_department_subtree_asof(v_x, '2025-07-02');

    IF v_before = v_x AND v_after = v_y AND v_x_before = 1 AND v_x_after = 0 THEN
        RAISE NOTICE 'PASS  G7 the reorg is visible from 2025-07-01 and invisible before it';
    ELSE
        RAISE EXCEPTION
            'FAIL  G7 last year''s structure changed under us: parent_before=% parent_after=% '
            'x_subtree %/%', v_before, v_after, v_x_before, v_x_after;
    END IF;
END $$;

-- G8: ancestors resolve upward, and also as-of.
DO $$
DECLARE v_rows INT; v_m UUID;
BEGIN
    SELECT id INTO v_m FROM department WHERE code = 'VG7M';
    SELECT count(*) INTO v_rows FROM fn_department_ancestors_asof(v_m, '2025-06-30');
    IF v_rows = 2 THEN
        RAISE NOTICE 'PASS  G8 ancestors walk to the root (2 levels)';
    ELSE
        RAISE EXCEPTION 'FAIL  G8 expected 2 ancestors, got %', v_rows;
    END IF;
END $$;

-- G9: THE TRAVERSAL'S CYCLE GUARD, which is now a BACKSTOP rather than the primary control.
--
-- This check used to create A -> B -> A through the ordinary INSERT path, because nothing stopped
-- it. Migration 0026 does stop it (G19/G20), so the fixture has to be forced in past the guard -
-- and the check is worth keeping for exactly that reason: the walk must still be safe on data the
-- guard never saw. Two ways that happens in real life:
--
--   * a restore or a bulk load performed by the OWNER with the rail explicitly disabled - the
--     residual power the migration headers concede an owner has, and the reason the application
--     must never connect as the owner;
--   * rows written before 0026 existed, in any database upgraded rather than rebuilt.
--
-- So: disable the guard, plant the cycle, put the guard back, and prove the traversal still
-- terminates and still returns an answer rather than hanging. The depth cap and the path
-- membership test are what make that true, and neither is exercised by any other check.
DO $$
DECLARE v_x UUID; v_y UUID; v_sub INT; v_anc INT; v_t0 TIMESTAMPTZ;
BEGIN
    SET LOCAL hrm.allow_backdated_period = 'on';
    INSERT INTO department (code,name) VALUES ('VG9X','G9 X') RETURNING id INTO v_x;
    INSERT INTO department (code,name) VALUES ('VG9Y','G9 Y') RETURNING id INTO v_y;

    ALTER TABLE department_period DISABLE TRIGGER tg_department_period_no_cycle;
    INSERT INTO department_period (department_id, parent_department_id, valid_from) VALUES
        (v_x, v_y, '2024-01-01'),
        (v_y, v_x, '2024-01-01');
    ALTER TABLE department_period ENABLE ALWAYS TRIGGER tg_department_period_no_cycle;

    v_t0 := clock_timestamp();
    SELECT count(*) INTO v_sub FROM fn_department_subtree_asof(v_x, '2025-01-01');
    SELECT count(*) INTO v_anc FROM fn_department_ancestors_asof(v_x, '2025-01-01');

    IF clock_timestamp() - v_t0 > INTERVAL '2 seconds' THEN
        RAISE EXCEPTION 'FAIL  G9 the cycle walk took %', clock_timestamp() - v_t0;
    END IF;
    IF v_sub <> 1 OR v_anc <> 1 THEN
        RAISE EXCEPTION 'FAIL  G9 cycle produced subtree=% ancestors=%, expected 1 and 1',
            v_sub, v_anc;
    END IF;
    RAISE NOTICE 'PASS  G9 a planted cycle still terminates the walk in % (0026 prevents new ones)',
        clock_timestamp() - v_t0;
END $$;

-- G10: teams exist, are placed in a department, and their membership resolves as-of.
DO $$
DECLARE v_t UUID; v_d UUID; v_e UUID; v_members INT; v_dept UUID;
BEGIN
    SET LOCAL hrm.allow_backdated_period = 'on';
    SELECT id INTO v_d FROM department WHERE code = 'ENG';
    SELECT id INTO v_e FROM employee LIMIT 1;

    INSERT INTO team (code, name) VALUES ('VG10', 'Verify G10') RETURNING id INTO v_t;
    INSERT INTO team_period (team_id, department_id, valid_from) VALUES (v_t, v_d, '2024-01-01');
    INSERT INTO team_membership (team_id, employee_id, role, valid_from)
    VALUES (v_t, v_e, 'lead', '2024-01-01');

    v_dept := fn_team_department_asof(v_t, '2024-06-01');
    SELECT count(*) INTO v_members FROM fn_team_members_asof(v_t, '2024-06-01');

    IF v_dept = v_d AND v_members = 1 THEN
        RAISE NOTICE 'PASS  G10 a team resolves to its department and its members';
    ELSE
        RAISE EXCEPTION 'FAIL  G10 dept=% members=%', v_dept, v_members;
    END IF;

    -- Before the team was formed, it has neither.
    IF fn_team_department_asof(v_t, '2023-01-01') IS NOT NULL THEN
        RAISE EXCEPTION 'FAIL  G10 the team had a department before it existed';
    END IF;
END $$;

-- G11: one person may be on several teams at once, but not twice on the same team.
DO $$
DECLARE v_t1 UUID; v_t2 UUID; v_d UUID; v_e UUID; v_teams INT; v_ok BOOLEAN := false;
BEGIN
    SET LOCAL hrm.allow_backdated_period = 'on';
    SELECT id INTO v_d FROM department WHERE code = 'ENG';
    SELECT id INTO v_e FROM employee LIMIT 1;

    INSERT INTO team (code,name) VALUES ('VG11A','G11 A') RETURNING id INTO v_t1;
    INSERT INTO team (code,name) VALUES ('VG11B','G11 B') RETURNING id INTO v_t2;
    INSERT INTO team_period (team_id, department_id, valid_from) VALUES
        (v_t1, v_d, '2024-01-01'), (v_t2, v_d, '2024-01-01');
    INSERT INTO team_membership (team_id, employee_id, valid_from) VALUES
        (v_t1, v_e, '2024-01-01'), (v_t2, v_e, '2024-01-01');

    SELECT count(*) INTO v_teams FROM fn_employee_teams_asof(v_e, '2024-06-01');
    IF v_teams < 2 THEN
        RAISE EXCEPTION 'FAIL  G11 concurrent team membership was refused (% teams)', v_teams;
    END IF;

    BEGIN
        INSERT INTO team_membership (team_id, employee_id, valid_from)
        VALUES (v_t1, v_e, '2024-06-01');
    EXCEPTION WHEN exclusion_violation THEN v_ok := true;
    END;
    IF v_ok THEN
        RAISE NOTICE 'PASS  G11 concurrent teams allowed (%); duplicate on one team refused', v_teams;
    ELSE
        RAISE EXCEPTION 'FAIL  G11 the same person joined one team twice at once';
    END IF;
END $$;

-- G12: a team code has a shape, so a lowercase or punctuated code cannot creep in.
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
    BEGIN INSERT INTO team (code, name) VALUES ('bad code!', 'Bad');
    EXCEPTION WHEN check_violation THEN v_ok := true; END;
    IF v_ok THEN RAISE NOTICE 'PASS  G12 malformed team codes are refused';
    ELSE RAISE EXCEPTION 'FAIL  G12 team code shape is not constrained'; END IF;
END $$;

-- G13: DESIGNATION RETIREMENT is a date, and it behaves like one.
DO $$
DECLARE v_des UUID; v_emp UUID; v_dept UUID; v_hist INT; v_ok BOOLEAN := false;
BEGIN
    SET LOCAL hrm.allow_backdated_period = 'on';
    SELECT id INTO v_dept FROM department WHERE code = 'ENG';
    SELECT id INTO v_emp FROM employee LIMIT 1;

    INSERT INTO designation (code, name, grade) VALUES ('VG13', 'Verify G13', 2)
    RETURNING id INTO v_des;

    -- A historical assignment made while it was live.
    INSERT INTO employee (employee_number, full_name, work_email, joined_on, status)
    VALUES ('VERIFY-G13','Retiree Holder','verify-g13@example.invalid','2024-01-02','pre_boarding');
    INSERT INTO employment (employee_id, department_id, designation_id, valid_from)
    SELECT id, v_dept, v_des, '2024-01-02' FROM employee WHERE employee_number = 'VERIFY-G13';

    UPDATE designation SET retired_on = fn_business_date() WHERE id = v_des;

    -- A NEW assignment on or after the retirement date is refused ...
    BEGIN
        INSERT INTO employment (employee_id, department_id, designation_id, valid_from)
        VALUES (v_emp, v_dept, v_des, fn_business_date() + 1);
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;

    -- ... while the historical row remains perfectly valid.
    SELECT count(*) INTO v_hist FROM employment WHERE designation_id = v_des;

    IF v_ok AND v_hist = 1 THEN
        RAISE NOTICE 'PASS  G13 a retired designation is closed to new assignments, open to history';
    ELSE
        RAISE EXCEPTION 'FAIL  G13 refused_new=% historical_rows=%', v_ok, v_hist;
    END IF;
END $$;

-- G14: headcount is computed against the structure AND the assignments in force on the date,
-- and the subtree total includes descendants that the direct count excludes.
--
-- FULLY SELF-CONTAINED, at the third attempt. Draft one hardcoded `code = 'PANASA'` and broke
-- when the company was renamed. Draft two found the root structurally - but with `LIMIT 1` and
-- no ORDER BY, so once this file's own earlier checks had created their fixture departments
-- (VG6R has children and no employees) it could pick one of those and report a subtree headcount
-- of zero. A test that depends on which row the planner happens to return first is not a test.
DO $$
DECLARE
    v_root UUID; v_child UUID; v_desig UUID;
    v_emp UUID; v_join DATE := DATE '2024-01-15';
    v_direct INT; v_subtree INT; v_before INT;
BEGIN
    SET LOCAL hrm.allow_backdated_period = 'on';
    SELECT id INTO v_desig FROM designation WHERE retired_on IS NULL LIMIT 1;

    INSERT INTO department (code, name) VALUES ('VG14R', 'G14 Root')  RETURNING id INTO v_root;
    INSERT INTO department (code, name) VALUES ('VG14C', 'G14 Child') RETURNING id INTO v_child;
    INSERT INTO department_period (department_id, parent_department_id, valid_from) VALUES
        (v_root,  NULL,   v_join),
        (v_child, v_root, v_join);

    -- One employee, in the CHILD department, active from v_join.
    INSERT INTO employee (employee_number, full_name, work_email, joined_on, status)
    VALUES ('VERIFY-G14', 'Headcount Fixture', 'verify-g14@example.invalid', v_join, 'pre_boarding')
    RETURNING id INTO v_emp;
    INSERT INTO employment_event (employee_id, event_type, from_status, to_status, effective_on)
    VALUES (v_emp, 'joined', 'pre_boarding', 'active', v_join);
    INSERT INTO employment (employee_id, department_id, designation_id, valid_from)
    VALUES (v_emp, v_child, v_desig, v_join);

    v_direct  := fn_department_headcount_asof(v_root, fn_business_date(), false);
    v_subtree := fn_department_headcount_asof(v_root, fn_business_date(), true);
    -- Before anybody joined, both are zero: the assignment did not exist yet.
    v_before  := fn_department_headcount_asof(v_root, v_join - 1, true);

    IF v_direct = 0 AND v_subtree = 1 AND v_before = 0 THEN
        RAISE NOTICE 'PASS  G14 headcount: root direct=%, root subtree=%, before joining=%',
            v_direct, v_subtree, v_before;
    ELSE
        RAISE EXCEPTION
            'FAIL  G14 direct=% (want 0 - the employee sits in the child) subtree=% (want 1) '
            'before_joining=% (want 0)', v_direct, v_subtree, v_before;
    END IF;
END $$;

-- G15: every rail added here is ENABLE ALWAYS (DEC-030).
DO $$
DECLARE v_weak TEXT;
BEGIN
    SELECT string_agg(format('%s.%s', c.relname, t.tgname), ', ') INTO v_weak
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE NOT t.tgisinternal
       AND c.relname IN ('department_period','team_period','team_membership')
       AND t.tgenabled <> 'A';
    IF v_weak IS NULL THEN
        RAISE NOTICE 'PASS  G15 all organization structure triggers are ENABLE ALWAYS';
    ELSE
        RAISE EXCEPTION 'FAIL  G15 disableable by a session GUC: %', v_weak;
    END IF;
END $$;

-- G16: the resolvers pin search_path (precedent 0013).
DO $$
DECLARE v_bad TEXT;
BEGIN
    SELECT string_agg(p.proname, ', ') INTO v_bad
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('fn_department_parent_asof','fn_department_head_asof',
                         'fn_department_subtree_asof','fn_department_ancestors_asof',
                         'fn_team_department_asof','fn_team_members_asof',
                         'fn_employee_teams_asof','fn_department_headcount_asof',
                         'fn_block_retired_designation')
       AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig,'{}')) cfg
                        WHERE cfg LIKE 'search_path=%');
    IF v_bad IS NULL THEN RAISE NOTICE 'PASS  G16 all organization functions pin search_path';
    ELSE RAISE EXCEPTION 'FAIL  G16 unpinned: %', v_bad; END IF;
END $$;

-- G17: hrm_app may reorganise but never erase. No DELETE on any period table.
DO $$
DECLARE v_bad TEXT;
BEGIN
    SELECT string_agg(format('%s:%s', table_name, privilege_type), ', ') INTO v_bad
      FROM information_schema.role_table_grants
     WHERE grantee = 'hrm_app'
       AND table_name IN ('department_period','team_period','team_membership')
       AND privilege_type IN ('DELETE','TRUNCATE');
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'FAIL  G17 hrm_app can erase organisational history: %', v_bad;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                    WHERE grantee = 'hrm_app' AND table_name = 'department_period'
                      AND privilege_type = 'INSERT') THEN
        RAISE EXCEPTION 'FAIL  G17 hrm_app cannot record a reorganisation';
    END IF;
    RAISE NOTICE 'PASS  G17 hrm_app may reorganise, never erase';
END $$;

-- G18: team membership is NOT an authorization scope graph. ADR-0005 has exactly two, and
-- rbac-rules.md is explicit that merging graphs is how a project lead reads a disciplinary file.
-- This check exists so a later migration cannot quietly wire membership into access.
DO $$
DECLARE v_bad TEXT;
BEGIN
    SELECT string_agg(p.proname, ', ') INTO v_bad
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname LIKE '%team%'
       AND pg_get_functiondef(p.oid) ILIKE '%user_role%';
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION
            'FAIL  G18 a team function now reads user_role: %. Team membership must confer no '
            'access - a third scope graph needs an ADR, not a function', v_bad;
    END IF;
    RAISE NOTICE 'PASS  G18 team membership confers no authorization';
END $$;

-- G19 / G20 / G21 (migration 0026): A DEPARTMENT CANNOT BE PLACED INSIDE ITS OWN SUBTREE.
--
-- 0017 forbade only SELF-parenting, and G9 proves the traversal TERMINATES on a cycle - neither
-- of which says a cycle cannot exist. It could, through exactly the path HR uses: forward-close a
-- placement, then re-parent under a descendant. The cost was not an error but a silently
-- understated headcount, because the subtree walk stops when it re-meets a department and
-- fn_department_headcount_asof rolls that walk up into HR's reports.
DO $$
DECLARE
    a UUID; b UUID; c UUID; d UUID;
    v_two BOOLEAN := false; v_three BOOLEAN := false; v_ok BOOLEAN := false;
BEGIN
    INSERT INTO department (code, name) VALUES ('VG19A', 'Cycle A') RETURNING id INTO a;
    INSERT INTO department (code, name) VALUES ('VG19B', 'Cycle B') RETURNING id INTO b;
    INSERT INTO department (code, name) VALUES ('VG19C', 'Cycle C') RETURNING id INTO c;
    INSERT INTO department (code, name) VALUES ('VG19D', 'Cycle D') RETURNING id INTO d;

    INSERT INTO department_period (department_id, parent_department_id, valid_from)
    VALUES (a, NULL, fn_business_date()),
           (b, a,    fn_business_date()),
           (c, b,    fn_business_date()),
           (d, NULL, fn_business_date());

    -- The close is FORWARD, which is the only kind Rule 3 permits (DEC-029).
    UPDATE department_period SET valid_to = fn_business_date() + 1
     WHERE department_id = a AND valid_to IS NULL;

    -- G19: the two-step loop - A under its own direct child.
    BEGIN
        INSERT INTO department_period (department_id, parent_department_id, valid_from)
        VALUES (a, b, fn_business_date() + 1);
    EXCEPTION WHEN restrict_violation THEN v_two := true; END;

    -- G20: and the three-step loop, so the check is a traversal and not a parent comparison.
    BEGIN
        INSERT INTO department_period (department_id, parent_department_id, valid_from)
        VALUES (a, c, fn_business_date() + 1);
    EXCEPTION WHEN restrict_violation THEN v_three := true; END;

    -- G21: a LEGITIMATE re-parent must still work. Refusing every re-parent would pass G19 and
    -- G20 just as well while making the department master useless.
    BEGIN
        INSERT INTO department_period (department_id, parent_department_id, valid_from)
        VALUES (a, d, fn_business_date() + 1);
        v_ok := true;
    EXCEPTION WHEN others THEN v_ok := false; END;

    IF v_two THEN
        RAISE NOTICE 'PASS  G19 a department cannot be placed under its own direct child';
    ELSE
        RAISE EXCEPTION 'FAIL  G19 a two-step department cycle was accepted - headcount rollups '
                        'will under-report with no error raised';
    END IF;

    IF v_three THEN
        RAISE NOTICE 'PASS  G20 nor under a deeper descendant - the guard walks the subtree';
    ELSE
        RAISE EXCEPTION 'FAIL  G20 a three-step cycle was accepted; the guard is only comparing parents';
    END IF;

    IF v_ok THEN
        RAISE NOTICE 'PASS  G21 a legitimate re-parent onto an unrelated root is still permitted';
    ELSE
        RAISE EXCEPTION 'FAIL  G21 the guard refuses re-parenting outright, which breaks reorganisation';
    END IF;
END $$;
