-- =============================================================================
-- Verification for 0016: identity, roles and revocation
--
-- The two checks that carry the most weight:
--
--   I11 - a future-dated exit must revoke NOTHING today. The revocation trigger hangs off
--         `employee.status`, not off `employment_event`, precisely so it fires when the exit
--         TAKES EFFECT rather than when HR types the date. Hanging it off the event would
--         reproduce the 0014 defect as an access-control bug.
--   I13 - a revoked role stops applying NOW but is still readable as history, and cannot be
--         re-acquired by asking for a past date. ADR-0005(b) calls that "privilege escalation
--         with a date picker as its interface".
--
-- Fixtures are created by the checks that use them. Runs inside a transaction the runner always
-- rolls back (DEC-024).
-- =============================================================================

-- I1: UNIQUE (tenant_id, subject) exists. ADR-0009's account-takeover control.
DO $$
DECLARE v_def TEXT;
BEGIN
    SELECT pg_get_constraintdef(oid) INTO v_def
      FROM pg_constraint WHERE conname = 'uq_user_identity_subject';
    IF v_def IS NULL OR v_def NOT ILIKE '%tenant_id%' OR v_def NOT ILIKE '%subject%' THEN
        RAISE EXCEPTION 'FAIL  I1 no UNIQUE (tenant_id, subject) on user_identity: %', v_def;
    END IF;
    RAISE NOTICE 'PASS  I1 %', v_def;
END $$;

-- I2: two rows cannot claim the same Entra oid.
DO $$
DECLARE v_a UUID; v_b UUID; v_ok BOOLEAN := false;
BEGIN
    SET LOCAL hrm.allow_backdated_period = 'on';
    INSERT INTO employee (employee_number, full_name, work_email, joined_on, status)
    VALUES ('VERIFY-I2A','Fed A','verify-i2a@example.invalid','2024-01-02','pre_boarding');
    INSERT INTO employee (employee_number, full_name, work_email, joined_on, status)
    VALUES ('VERIFY-I2B','Fed B','verify-i2b@example.invalid','2024-01-02','pre_boarding');

    INSERT INTO app_user (employee_id, email, role)
    SELECT id, work_email, 'employee' FROM employee WHERE employee_number = 'VERIFY-I2A'
    RETURNING id INTO v_a;
    INSERT INTO app_user (employee_id, email, role)
    SELECT id, work_email, 'employee' FROM employee WHERE employee_number = 'VERIFY-I2B'
    RETURNING id INTO v_b;

    INSERT INTO user_identity (user_id, tenant_id, subject) VALUES (v_a, 'tid-v', 'oid-v-1');
    BEGIN
        INSERT INTO user_identity (user_id, tenant_id, subject) VALUES (v_b, 'tid-v', 'oid-v-1');
    EXCEPTION WHEN unique_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  I2 a second account cannot claim an existing Entra oid';
    ELSE RAISE EXCEPTION 'FAIL  I2 two accounts share one oid - account takeover on next sign-in'; END IF;
END $$;

-- I3: an email can never be the subject. Identity linked on a mutable display attribute is the
-- exact failure ADR-0009 forbids, so the shape is constrained rather than trusted.
DO $$
DECLARE v_u UUID; v_ok BOOLEAN := false;
BEGIN
    SELECT id INTO v_u FROM app_user WHERE email = 'verify-i2b@example.invalid';
    BEGIN
        INSERT INTO user_identity (user_id, tenant_id, subject)
        VALUES (v_u, 'tid-v', 'someone@panasatech.com');
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  I3 an email address cannot be used as the Entra subject';
    ELSE RAISE EXCEPTION 'FAIL  I3 identity was linked on an email'; END IF;
END $$;

-- I4: MFA downgrade, forward direction. Linking Entra to an account that still holds a password
-- would leave the password route open as a way past conditional access.
DO $$
DECLARE v_u UUID; v_ok BOOLEAN := false;
BEGIN
    SELECT id INTO v_u FROM app_user WHERE password_hash IS NOT NULL LIMIT 1;
    BEGIN
        INSERT INTO user_identity (user_id, tenant_id, subject) VALUES (v_u, 'tid-v', 'oid-v-mfa');
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  I4 cannot federate an account that still holds a password hash';
    ELSE RAISE EXCEPTION 'FAIL  I4 MFA-downgrade path is open'; END IF;
END $$;

-- I5: and the reverse direction, which a flag-based constraint would have missed.
DO $$
DECLARE v_u UUID; v_ok BOOLEAN := false;
BEGIN
    SELECT id INTO v_u FROM app_user WHERE email = 'verify-i2a@example.invalid';
    BEGIN
        UPDATE app_user SET password_hash = 'scrypt$1$1$1$aa$bb', password_algo = 'scrypt'
         WHERE id = v_u;
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  I5 cannot set a local password on a federated account';
    ELSE RAISE EXCEPTION 'FAIL  I5 a password was re-armed on a federated account'; END IF;
END $$;

-- I6: a hash must declare its algorithm, so a scrypt row cannot masquerade as argon2id during
-- the rehash-on-login migration.
DO $$
DECLARE v_u UUID; v_ok BOOLEAN := false;
BEGIN
    SELECT id INTO v_u FROM app_user WHERE email = 'verify-i2b@example.invalid';
    BEGIN
        UPDATE app_user SET password_hash = 'scrypt$1$1$1$aa$bb' WHERE id = v_u;
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  I6 a password hash with no recorded algorithm is refused';
    ELSE RAISE EXCEPTION 'FAIL  I6 hash stored with no algorithm'; END IF;
END $$;

-- I7: only a break-glass account may exist with no employee behind it (ADR-0009's named
-- exception), and it must still be possible - both halves matter.
DO $$
DECLARE v_denied BOOLEAN := false; v_allowed BOOLEAN := false;
BEGIN
    BEGIN
        INSERT INTO app_user (employee_id, email, role, password_hash, password_algo)
        VALUES (NULL, 'verify-ghost@example.invalid', 'hr_admin', 'scrypt$1$1$1$aa$bb', 'scrypt');
    EXCEPTION WHEN check_violation THEN v_denied := true;
    END;

    INSERT INTO app_user (employee_id, email, role, password_hash, password_algo, is_break_glass)
    VALUES (NULL, 'verify-bg@example.invalid', 'hr_admin', 'scrypt$1$1$1$aa$bb', 'scrypt', true);
    v_allowed := true;

    IF v_denied AND v_allowed THEN
        RAISE NOTICE 'PASS  I7 non-employee accounts require is_break_glass, and are then permitted';
    ELSE
        RAISE EXCEPTION 'FAIL  I7 denied=% allowed=%', v_denied, v_allowed;
    END IF;
END $$;

-- I8: a disabled account records when and why. `is_enabled = false` with no reason is an
-- unexplained lockout nobody can audit afterwards.
DO $$
DECLARE v_u UUID; v_ok BOOLEAN := false;
BEGIN
    SELECT id INTO v_u FROM app_user WHERE email = 'verify-i2b@example.invalid';
    BEGIN
        UPDATE app_user SET is_enabled = false WHERE id = v_u;
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  I8 an account cannot be disabled without a recorded reason';
    ELSE RAISE EXCEPTION 'FAIL  I8 silent lockout permitted'; END IF;
END $$;

-- I9: roles are MULTI-valued. Different roles may overlap; that is the point of the table.
DO $$
DECLARE v_u UUID; v_roles TEXT[];
BEGIN
    SELECT u.id INTO v_u FROM app_user u
     WHERE array_length(fn_user_roles(u.id), 1) > 1 LIMIT 1;
    IF v_u IS NULL THEN
        RAISE EXCEPTION 'FAIL  I9 no account holds more than one role - the backfill did not '
                        'make manager/hr_admin additive with employee';
    END IF;
    v_roles := fn_user_roles(v_u);
    RAISE NOTICE 'PASS  I9 concurrent roles resolve together: %', v_roles;
END $$;

-- I10: the SAME role may not be granted twice over overlapping periods.
DO $$
DECLARE v_u UUID; v_role TEXT; v_ok BOOLEAN := false;
BEGIN
    SELECT r.user_id, r.role INTO v_u, v_role
      FROM user_role r WHERE r.valid_to IS NULL LIMIT 1;
    BEGIN
        INSERT INTO user_role (user_id, role, valid_from)
        VALUES (v_u, v_role, fn_business_date());
    EXCEPTION WHEN exclusion_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  I10 a duplicate overlapping grant of the same role is refused';
    ELSE RAISE EXCEPTION 'FAIL  I10 the same role was granted twice at once'; END IF;
END $$;

-- I11: a historical grant cannot be rewritten (Rule 3). Closing an open period is allowed.
DO $$
DECLARE v_user UUID; v_emp UUID; v_grant UUID; v_ok BOOLEAN := false; v_closed BOOLEAN := false;
BEGIN
    /*
     * OWN FIXTURE, because the previous version picked a row at random:
     *
     *     SELECT id INTO v_id FROM user_role WHERE valid_to IS NULL LIMIT 1;
     *
     * `LIMIT 1` with no ORDER BY returns whichever row the planner reaches first, and that is not
     * a stable choice - it moves as the table grows, as statistics change, and as earlier checks
     * in this same file insert their own grants. Running `punch:test` before `db:verify` was
     * enough to flip it, and the check then failed on correct code and aborted the file, costing
     * ten more checks after it.
     *
     * Third occurrence of this exact shape: 0017's G14 had `LIMIT 1` pick one of the file's own
     * fixture departments, and 0012's N8 and N9 borrowed seeded employees. A test that depends on
     * which row comes back first is not a test.
     *
     * It also now asserts BOTH halves of the rule. Refusing the in-place edit alone would pass
     * just as well against a trigger that refused every UPDATE, which would break the sanctioned
     * close-then-supersede path that Rule 3 exists to permit.
     */
    INSERT INTO employee (employee_number, full_name, work_email, joined_on, status)
    VALUES ('VERIFY-I11', 'Grant Fixture', 'verify-i11@example.invalid',
            fn_business_date() - 400, 'pre_boarding')
    RETURNING id INTO v_emp;

    INSERT INTO app_user (employee_id, email, is_enabled)
    VALUES (v_emp, 'verify-i11@example.invalid', true)
    RETURNING id INTO v_user;

    INSERT INTO user_role (user_id, role, valid_from, reason)
    VALUES (v_user, 'employee', fn_business_date(), 'i11 fixture')
    RETURNING id INTO v_grant;

    -- Rewriting the grant in place is refused: a role somebody HELD is history.
    BEGIN
        UPDATE user_role SET role = 'hr_admin' WHERE id = v_grant;
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;

    -- Closing the open period is the sanctioned way to end it.
    BEGIN
        UPDATE user_role SET valid_to = fn_business_date() + 1 WHERE id = v_grant;
        v_closed := true;
    EXCEPTION WHEN others THEN v_closed := false;
    END;

    IF v_ok AND v_closed THEN
        RAISE NOTICE 'PASS  I11 a grant cannot be edited in place, but its period can be closed';
    ELSE
        RAISE EXCEPTION
            'FAIL  I11 in_place_edit_refused=% forward_close_allowed=% (want true/true)',
            v_ok, v_closed;
    END IF;
END $$;

-- I12: revoking a role takes effect NOW, stays visible as history, and CANNOT be re-acquired by
-- asking for a past date. ADR-0005(b) - the date picker must not be a privilege-escalation tool.
DO $$
DECLARE v_u UUID; v_before TEXT[]; v_now TEXT[]; v_then TEXT[];
BEGIN
    SELECT r.user_id INTO v_u FROM user_role r
     WHERE r.role = 'manager' AND r.valid_to IS NULL LIMIT 1;
    IF v_u IS NULL THEN
        RAISE NOTICE 'INFO  I12 no open manager grant in this dataset';
        RETURN;
    END IF;

    v_before := fn_user_roles(v_u);
    UPDATE user_role SET valid_to = fn_business_date()
     WHERE user_id = v_u AND role = 'manager' AND valid_to IS NULL;

    v_now  := fn_user_roles(v_u);
    v_then := fn_user_roles_asof(v_u, fn_business_date() - 1);

    IF 'manager' = ANY (v_now) THEN
        RAISE EXCEPTION 'FAIL  I12 a revoked role still resolves now: %', v_now;
    END IF;
    IF NOT ('manager' = ANY (v_then)) THEN
        RAISE EXCEPTION 'FAIL  I12 history lost the revoked role: %', v_then;
    END IF;
    RAISE NOTICE 'PASS  I12 revocation immediate (% -> %), history intact (%)',
        v_before, v_now, v_then;
END $$;

-- I13: OFFBOARDING. An exit taking effect today ends every live session and disables the
-- account, with a reason on both.
DO $$
DECLARE v_emp UUID; v_user UUID; v_live_before INT; v_live_after INT; r RECORD;
BEGIN
    SET LOCAL hrm.allow_backdated_period = 'on';
    INSERT INTO employee (employee_number, full_name, work_email, joined_on, status)
    VALUES ('VERIFY-I13','Leaver Now','verify-i13@example.invalid','2023-01-02','pre_boarding')
    RETURNING id INTO v_emp;
    INSERT INTO employment_event (employee_id, event_type, from_status, to_status, effective_on)
    VALUES (v_emp, 'joined', 'pre_boarding', 'active', '2023-01-02');

    INSERT INTO app_user (employee_id, email, role, password_hash, password_algo)
    VALUES (v_emp, 'verify-i13@example.invalid', 'employee', 'scrypt$1$1$1$aa$bb', 'scrypt')
    RETURNING id INTO v_user;

    INSERT INTO session (token_hash, user_id, expires_at, absolute_expires_at)
    VALUES ('verify-i13-token', v_user, now() + INTERVAL '12 hours', now() + INTERVAL '7 days');

    SELECT count(*) INTO v_live_before FROM session
     WHERE user_id = v_user AND revoked_at IS NULL;

    INSERT INTO employment_event
        (employee_id, event_type, from_status, to_status, effective_on, exit_type, reason)
    VALUES (v_emp, 'exited', 'active', 'exited', fn_business_date(), 'resignation', 'left today');

    SELECT count(*) INTO v_live_after FROM session
     WHERE user_id = v_user AND revoked_at IS NULL;
    SELECT is_enabled, disabled_reason INTO r FROM app_user WHERE id = v_user;

    IF v_live_before = 1 AND v_live_after = 0 AND r.is_enabled = false
       AND r.disabled_reason IS NOT NULL THEN
        RAISE NOTICE 'PASS  I13 exit revoked % session(s) and disabled the account (%)',
            v_live_before, r.disabled_reason;
    ELSE
        RAISE EXCEPTION 'FAIL  I13 before=% after=% enabled=% reason=%',
            v_live_before, v_live_after, r.is_enabled, r.disabled_reason;
    END IF;
END $$;

-- I14: THE ONE THAT MATTERS MOST. A future-dated exit must revoke NOTHING today. The trigger is
-- on `employee.status` so it fires when the exit TAKES EFFECT (0015), not when it is recorded.
DO $$
DECLARE v_emp UUID; v_user UUID; v_live INT; r RECORD; v_status TEXT;
BEGIN
    SET LOCAL hrm.allow_backdated_period = 'on';
    INSERT INTO employee (employee_number, full_name, work_email, joined_on, status)
    VALUES ('VERIFY-I14','Leaver Later','verify-i14@example.invalid','2023-02-02','pre_boarding')
    RETURNING id INTO v_emp;
    INSERT INTO employment_event (employee_id, event_type, from_status, to_status, effective_on)
    VALUES (v_emp, 'joined', 'pre_boarding', 'active', '2023-02-02');

    INSERT INTO app_user (employee_id, email, role, password_hash, password_algo)
    VALUES (v_emp, 'verify-i14@example.invalid', 'employee', 'scrypt$1$1$1$aa$bb', 'scrypt')
    RETURNING id INTO v_user;

    INSERT INTO session (token_hash, user_id, expires_at, absolute_expires_at)
    VALUES ('verify-i14-token', v_user, now() + INTERVAL '12 hours', now() + INTERVAL '7 days');

    -- Notice served today, leaving in 30 days.
    INSERT INTO employment_event
        (employee_id, event_type, from_status, to_status, effective_on, last_working_day)
    VALUES (v_emp, 'resigned', 'active', 'on_notice', fn_business_date(), fn_business_date() + 30);
    INSERT INTO employment_event
        (employee_id, event_type, from_status, to_status, effective_on, exit_type, reason)
    VALUES (v_emp, 'exited', 'on_notice', 'exited', fn_business_date() + 30,
            'resignation', 'serving notice');

    SELECT count(*) INTO v_live FROM session WHERE user_id = v_user AND revoked_at IS NULL;
    SELECT is_enabled INTO r FROM app_user WHERE id = v_user;
    SELECT status INTO v_status FROM employee WHERE id = v_emp;

    IF v_live = 1 AND r.is_enabled AND v_status = 'on_notice' THEN
        RAISE NOTICE 'PASS  I14 a scheduled exit revokes nothing today (status=%, session live)',
            v_status;
    ELSE
        RAISE EXCEPTION
            'FAIL  I14 an employee serving notice was locked out early: status=% live=% enabled=% '
            '- somebody still working cannot sign in', v_status, v_live, r.is_enabled;
    END IF;
END $$;

-- I15: a revocation must state a reason. An unexplained mass logout is unauditable.
DO $$
DECLARE v_u UUID; v_ok BOOLEAN := false;
BEGIN
    SELECT id INTO v_u FROM app_user LIMIT 1;
    BEGIN
        PERFORM fn_revoke_sessions_for_user(v_u, NULL);
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    IF v_ok THEN RAISE NOTICE 'PASS  I15 revocation without a reason is refused';
    ELSE RAISE EXCEPTION 'FAIL  I15 sessions revoked with no reason recorded'; END IF;
END $$;

-- I16: security audit emission produces a row that satisfies audit_event's own shape CHECK.
DO $$
DECLARE v_id BIGINT; r RECORD;
BEGIN
    v_id := fn_audit_security(
        'identity.session.created',
        (SELECT id FROM app_user WHERE employee_id IS NOT NULL LIMIT 1),
        (SELECT employee_id FROM app_user WHERE employee_id IS NOT NULL LIMIT 1),
        NULL, gen_random_uuid(), gen_random_uuid(), '203.0.113.9'::inet,
        'verification', ARRAY['employee']);

    SELECT source, event_type, actor_kind, actor_roles, subject_type
      INTO r FROM audit_event WHERE id = v_id;

    IF r.source = 'application' AND r.event_type = 'identity.session.created'
       AND r.actor_kind = 'user' AND r.actor_roles = ARRAY['employee'] THEN
        RAISE NOTICE 'PASS  I16 security audit row written (id %)', v_id;
    ELSE
        RAISE EXCEPTION 'FAIL  I16 malformed audit row: %', r;
    END IF;
END $$;

-- I17: an audit row with no event_type is refused by the emitter, not silently written as a
-- shapeless row that no query will ever find.
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
    BEGIN PERFORM fn_audit_security(NULL);
    EXCEPTION WHEN restrict_violation THEN v_ok := true; END;
    IF v_ok THEN RAISE NOTICE 'PASS  I17 an audit row with no event_type is refused';
    ELSE RAISE EXCEPTION 'FAIL  I17 shapeless audit row accepted'; END IF;
END $$;

-- I18: every rail added here is ENABLE ALWAYS (DEC-030).
DO $$
DECLARE v_weak TEXT;
BEGIN
    SELECT string_agg(format('%s.%s', c.relname, t.tgname), ', ') INTO v_weak
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE NOT t.tgisinternal
       AND t.tgname IN ('tg_user_identity_no_password','tg_app_user_no_password_when_federated',
                        'tg_user_role_immutable_history','tg_user_role_no_backdate',
                        'tg_user_role_no_truncate','tg_employee_revoke_on_exit')
       AND t.tgenabled <> 'A';
    IF v_weak IS NULL THEN
        RAISE NOTICE 'PASS  I18 all identity and revocation triggers are ENABLE ALWAYS';
    ELSE
        RAISE EXCEPTION 'FAIL  I18 disableable by a session GUC: %', v_weak;
    END IF;
END $$;

-- I19: the resolvers pin search_path (precedent 0013).
DO $$
DECLARE v_bad TEXT;
BEGIN
    SELECT string_agg(p.proname, ', ') INTO v_bad
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('fn_user_roles','fn_user_roles_asof','fn_revoke_sessions_for_user',
                         'fn_revoke_access_on_exit','fn_audit_security',
                         'fn_block_federated_with_password','fn_block_password_on_federated')
       AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig,'{}')) cfg
                        WHERE cfg LIKE 'search_path=%');
    IF v_bad IS NULL THEN RAISE NOTICE 'PASS  I19 all identity functions pin search_path';
    ELSE RAISE EXCEPTION 'FAIL  I19 unpinned: %', v_bad; END IF;
END $$;

-- I20: hrm_app can grant and revoke, but never erase. No DELETE on identity or role tables.
DO $$
DECLARE v_bad TEXT;
BEGIN
    SELECT string_agg(format('%s:%s', table_name, privilege_type), ', ') INTO v_bad
      FROM information_schema.role_table_grants
     WHERE grantee = 'hrm_app'
       AND table_name IN ('user_role','user_identity')
       AND privilege_type IN ('DELETE','TRUNCATE');
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'FAIL  I20 hrm_app can erase identity history: %', v_bad;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                    WHERE grantee = 'hrm_app' AND table_name = 'user_role'
                      AND privilege_type = 'UPDATE') THEN
        RAISE EXCEPTION 'FAIL  I20 hrm_app cannot close a role period, so it cannot revoke a role';
    END IF;
    RAISE NOTICE 'PASS  I20 hrm_app may grant and revoke roles, never delete them';
END $$;

-- I21: the session token column holds a hash, and nothing in the schema invites the raw token
-- into audit_event. ADR-0010: audit_event.session_id is a non-secret surrogate.
DO $$
DECLARE v_type TEXT;
BEGIN
    SELECT format_type(a.atttypid, a.atttypmod) INTO v_type
      FROM pg_attribute a
     WHERE a.attrelid = 'audit_event'::regclass AND a.attname = 'session_id';
    IF v_type <> 'uuid' THEN
        RAISE EXCEPTION
            'FAIL  I21 audit_event.session_id is %, not uuid. ADR-0010 forbids resolving the '
            'width mismatch by widening this column to fit a 256-bit token', v_type;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_attribute
                    WHERE attrelid = 'session'::regclass AND attname = 'token_hash') THEN
        RAISE EXCEPTION 'FAIL  I21 session.token_hash is gone';
    END IF;
    RAISE NOTICE 'PASS  I21 audit_event.session_id stays uuid; the surrogate is session.id';
END $$;
