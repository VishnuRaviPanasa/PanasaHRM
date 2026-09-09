-- =============================================================================
-- Verification for 0031: the delivery-head role, provisionable roles, declined offers
--
-- The checks that carry the weight:
--
--   DH3  `app_user.role` and `user_role.role` accept THE SAME set. They disagreed before - three
--        values on the account row against six on the effective-dated grant - which is why
--        provisioning a finance head was impossible. A future role added to one and not the other
--        reproduces exactly that bug, silently, so the two lists are compared rather than each
--        being spot-checked.
--   DH5  `offer_declined` is TERMINAL and reachable only from `pre_boarding`. A path out of it
--        would mean a person who declined could be walked into `active` without ever being hired;
--        a path in from `active` would mean an employee could be retired into a state that reads
--        as "never joined".
--   DH6  no existing employee was moved by this migration. Widening a CHECK must not rewrite data.
-- =============================================================================

\set ON_ERROR_STOP on

DO $$
DECLARE
    v_e      UUID;
    v_u      UUID;
    v_n      INT;
    v_ok     BOOLEAN;
    v_user   TEXT[];
    v_acct   TEXT[];
BEGIN
    -- ---------------------------------------------------------------- DH1
    -- The role exists on the effective-dated grant.
    SELECT id INTO v_e FROM employee WHERE employee_number = 'EMP001';
    SELECT id INTO v_u FROM app_user WHERE employee_id = v_e;

    -- The probe UNDOES ITSELF by aborting its own subtransaction, because `user_role` is
    -- effective-dated and Rule 3 refuses a DELETE - closing a period is allowed, removing one is
    -- not. A PL/pgSQL BEGIN/EXCEPTION block is a subtransaction, so raising inside it discards the
    -- INSERT while the variable assignment survives (variables are not transactional).
    v_ok := false;
    BEGIN
        INSERT INTO user_role (user_id, role, valid_from, reason)
             VALUES (v_u, 'delivery_head', DATE '2031-01-01', 'DH1 probe');
        v_ok := true;
        RAISE EXCEPTION 'undo the probe' USING ERRCODE = 'ZZ999';
    EXCEPTION
        WHEN sqlstate 'ZZ999' THEN NULL;
        WHEN OTHERS THEN
            RAISE EXCEPTION 'FAIL  DH1 delivery_head is not an accepted role grant: %', SQLERRM;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'FAIL  DH1 the delivery_head grant did not insert';
    END IF;

    -- ... and it really was discarded.
    SELECT count(*) INTO v_n FROM user_role WHERE reason = 'DH1 probe';
    IF v_n <> 0 THEN
        RAISE EXCEPTION 'FAIL  DH1b the probe left % row(s) behind in user_role', v_n;
    END IF;

    -- ---------------------------------------------------------------- DH2
    -- An invented role is still refused - the CHECK was widened, not removed.
    v_ok := false;
    BEGIN
        INSERT INTO user_role (user_id, role, valid_from, reason)
             VALUES (v_u, 'chief_wizard', DATE '2031-01-01', 'DH2 probe');
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'FAIL  DH2 an arbitrary role name was accepted - the CHECK is gone';
    END IF;

    -- ---------------------------------------------------------------- DH3
    -- THE IMPORTANT ONE. Both role lists must be identical.
    SELECT regexp_split_to_array(
             (SELECT string_agg(DISTINCT m[1], ',' ORDER BY m[1])
                FROM regexp_matches(pg_get_constraintdef(oid), '''([a-z_]+)''', 'g') AS m),
             ',')
      INTO v_user
      FROM pg_constraint WHERE conname = 'ck_user_role_value';

    SELECT regexp_split_to_array(
             (SELECT string_agg(DISTINCT m[1], ',' ORDER BY m[1])
                FROM regexp_matches(pg_get_constraintdef(oid), '''([a-z_]+)''', 'g') AS m),
             ',')
      INTO v_acct
      FROM pg_constraint WHERE conname = 'ck_app_user_role';

    IF v_user IS DISTINCT FROM v_acct THEN
        RAISE EXCEPTION 'FAIL  DH3 the account row and the role grant accept DIFFERENT roles: '
                        'account=% grant=% - a role in one and not the other cannot be '
                        'provisioned', v_acct, v_user;
    END IF;
    IF array_length(v_user, 1) <> 7 THEN
        RAISE EXCEPTION 'FAIL  DH3b expected 7 roles, found %: %', array_length(v_user, 1), v_user;
    END IF;

    -- ---------------------------------------------------------------- DH4
    -- The employee status accepts the new terminal, and still refuses nonsense.
    v_ok := false;
    BEGIN
        INSERT INTO employee (employee_number, full_name, work_email, joined_on, status)
             VALUES ('ZZDH1', 'Declined Probe', 'zzdh1@panasatech.com', DATE '2031-02-01',
                     'not_a_status');
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'FAIL  DH4 an invented employee status was accepted';
    END IF;

    -- ---------------------------------------------------------------- DH5
    -- `offer_declined` is terminal, and only pre_boarding leads to it.
    SELECT count(*) INTO v_n FROM employment_status_transition
     WHERE to_status = 'offer_declined' AND from_status <> 'pre_boarding';
    IF v_n <> 0 THEN
        RAISE EXCEPTION 'FAIL  DH5 % transition(s) reach offer_declined from somewhere other than '
                        'pre_boarding', v_n;
    END IF;

    SELECT count(*) INTO v_n FROM employment_status_transition WHERE from_status = 'offer_declined';
    IF v_n <> 0 THEN
        RAISE EXCEPTION 'FAIL  DH5b offer_declined is not terminal - % way(s) out of it', v_n;
    END IF;

    SELECT count(*) INTO v_n FROM employment_status_transition
     WHERE event_type = 'offer_declined' AND from_status = 'pre_boarding'
       AND to_status = 'offer_declined';
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'FAIL  DH5c the pre_boarding -> offer_declined move is missing';
    END IF;

    -- ---------------------------------------------------------------- DH6
    -- Widening a CHECK must not have moved anybody.
    SELECT count(*) INTO v_n FROM employee WHERE status = 'offer_declined';
    IF v_n <> 0 THEN
        RAISE EXCEPTION 'FAIL  DH6 % employee(s) are already offer_declined - this migration '
                        'should have changed no data', v_n;
    END IF;

    -- ---------------------------------------------------------------- DH7
    -- The declined path, end to end. A pre-boarding person can be walked to `offer_declined` and
    -- then nowhere else. The runner wraps every verify file in BEGIN/ROLLBACK (finding D-14), so
    -- this fixture never lands.
    INSERT INTO employee (employee_number, full_name, work_email, joined_on, status)
         VALUES ('ZZDH2', 'Declined Fixture', 'zzdh2@panasatech.com', DATE '2031-06-02',
                 'pre_boarding')
      RETURNING id INTO v_e;

    INSERT INTO employment_event
        (employee_id, event_type, from_status, to_status, effective_on, reason)
         VALUES (v_e, 'offer_declined', 'pre_boarding', 'offer_declined', DATE '2031-05-20',
                 'took another role');
    UPDATE employee SET status = 'offer_declined' WHERE id = v_e;

    SELECT count(*) INTO v_n FROM employee WHERE id = v_e AND status = 'offer_declined';
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'FAIL  DH7 a pre-boarding employee could not be recorded as declined';
    END IF;

    -- ... and there is no way onward. `joined` from `offer_declined` is not a triple that exists,
    -- so the composite FK refuses it - somebody who declined cannot be quietly walked into active.
    v_ok := false;
    BEGIN
        INSERT INTO employment_event
            (employee_id, event_type, from_status, to_status, effective_on, reason)
             VALUES (v_e, 'joined', 'offer_declined', 'active', DATE '2031-06-02', 'sneak in');
    EXCEPTION WHEN foreign_key_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'FAIL  DH7b somebody who declined was walked into active';
    END IF;

    -- ---------------------------------------------------------------- DH8
    -- 0033's carve-out is ONE EVENT TYPE WIDE. Every other lifecycle event still cannot precede
    -- the joining date - otherwise the fix for declining would have quietly legalised back-dating
    -- a promotion, which is the rail 0014 was written for.
    INSERT INTO employee (employee_number, full_name, work_email, joined_on, status)
         VALUES ('ZZDH3', 'Carve-out Fixture', 'zzdh3@panasatech.com', DATE '2031-06-02',
                 'pre_boarding')
      RETURNING id INTO v_e;

    v_ok := false;
    BEGIN
        INSERT INTO employment_event
            (employee_id, event_type, from_status, to_status, effective_on, reason)
             VALUES (v_e, 'joined', 'pre_boarding', 'active', DATE '2031-05-01', 'early start');
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'FAIL  DH8 0033 widened the carve-out beyond offer_declined - a joining '
                        'event was accepted before the joining date';
    END IF;

    RAISE NOTICE 'PASS  0031 delivery head, provisionable roles, declined offers: 12 checks';
END $$;
