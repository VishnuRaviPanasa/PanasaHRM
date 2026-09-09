-- =============================================================================
-- Verification for 0029: account activation
--
-- The checks that carry the weight:
--
--   AV3   AN ACTIVATION CANNOT BE ISSUED FOR AN ACCOUNT THAT ALREADY HAS A PASSWORD. This is the
--         one that separates an administrative convenience from an account-takeover primitive:
--         without it, anybody who can issue a token can mint one for the HR Manager's live
--         account and set its password. The rule lives in a trigger because the condition is on
--         another table, and a rule in a trigger needs a test proving it is still there.
--   AV4   break-glass accounts are refused. ADR-0009 seals them and excludes them from bulk
--         administration; an activation flow is exactly the ordinary administration they are
--         excluded from.
--   AV5   at most ONE live token per account. Two live tokens means two people can set the
--         password and the second silently wins, so a reissue must consume its predecessor -
--         enforced by a partial unique index, not by the controller remembering.
--   AV6-7 a token is immutable, and cannot be UN-consumed. Re-pointing token_hash at another
--         user, or pushing expires_at forward on a token already handed over, would turn this
--         table from a rail into a suggestion; clearing consumed_at turns a single-use secret
--         into a multi-use one.
--   AV9   both triggers are ENABLE ALWAYS (DEC-030), so a restore or a bulk load cannot bypass
--         either.
--   AV10  no token is stored in a form that could be replayed - every token_hash is a 64-char
--         SHA-256 hex digest, the same discipline as `session.token_hash`.
--
-- Every deliberate-failure check runs in its own BEGIN/EXCEPTION block. A raised constraint
-- poisons the surrounding transaction, so a suite that lets one propagate reports every later
-- check as passing by never running it.
-- =============================================================================

\set ON_ERROR_STOP on

DO $$
DECLARE
    v_emp     UUID;
    v_emp2    UUID;
    v_user    UUID;
    v_pw_user UUID;
    v_bg      UUID;
    v_act     UUID;
    v_n       INT;
    v_ok      BOOLEAN;
    v_always  INT;
BEGIN
    -- FIXTURES NEED THEIR OWN EMPLOYEES. `ck_app_user_employee_or_break_glass` requires every
    -- non-break-glass account to belong to an employee, and `app_user.employee_id` is UNIQUE, so
    -- the seeded people cannot be borrowed - they already have accounts. Two throwaway employees,
    -- deleted at the end.
    INSERT INTO employee (employee_number, full_name, work_email, joined_on, status)
         VALUES ('ZZAV1', 'Activation Fixture One', 'av-fresh@panasatech.com', DATE '2031-01-06',
                 'pre_boarding')
      RETURNING id INTO v_emp;
    INSERT INTO employee (employee_number, full_name, work_email, joined_on, status)
         VALUES ('ZZAV2', 'Activation Fixture Two', 'av-haspw@panasatech.com', DATE '2031-01-06',
                 'pre_boarding')
      RETURNING id INTO v_emp2;

    -- A fresh credential-less account, which is the state `POST /employees/:id/account` creates.
    INSERT INTO app_user (employee_id, email, role)
         VALUES (v_emp, 'av-fresh@panasatech.com', 'employee')
      RETURNING id INTO v_user;

    -- ---------------------------------------------------------------- AV1
    -- The ordinary case: a token can be issued for an account with no credential.
    BEGIN
        INSERT INTO user_activation (user_id, token_hash, issued_by_user_id, expires_at)
             VALUES (v_user, repeat('a', 64), v_user, now() + INTERVAL '3 days')
          RETURNING id INTO v_act;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'FAIL  AV1 issuing an activation for a credential-less account was '
                        'refused: %', SQLERRM;
    END;

    -- ---------------------------------------------------------------- AV2
    -- An expiry that is not in the future is not an expiry.
    v_ok := false;
    BEGIN
        INSERT INTO user_activation (user_id, token_hash, issued_by_user_id, created_at, expires_at)
            VALUES (v_user, repeat('b', 64), v_user, now(), now() - INTERVAL '1 hour');
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'FAIL  AV2 an activation was accepted with expires_at before created_at';
    END IF;

    -- ---------------------------------------------------------------- AV3
    -- THE IMPORTANT ONE. An account that already has a password may not be handed an activation
    -- token - that would be a password RESET, which belongs to the account holder and is proven
    -- by something they have, not something HR can click.
    INSERT INTO app_user (employee_id, email, role, password_hash, password_algo)
         VALUES (v_emp2, 'av-haspw@panasatech.com', 'hr_admin',
                 'scrypt$16384$8$1$c2FsdA==$aGFzaA==', 'scrypt')
      RETURNING id INTO v_pw_user;

    v_ok := false;
    BEGIN
        INSERT INTO user_activation (user_id, token_hash, issued_by_user_id, expires_at)
            VALUES (v_pw_user, repeat('c', 64), v_user, now() + INTERVAL '3 days');
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'FAIL  AV3 an activation token was issued for an account that ALREADY '
                        'HAS a password - that is an account-takeover path, not a convenience';
    END IF;

    -- ---------------------------------------------------------------- AV4
    -- Break-glass accounts are sealed (ADR-0009).
    INSERT INTO app_user (employee_id, email, role, is_break_glass)
         VALUES (NULL, 'av-bg@panasatech.com', 'hr_admin', true)
      RETURNING id INTO v_bg;

    v_ok := false;
    BEGIN
        INSERT INTO user_activation (user_id, token_hash, issued_by_user_id, expires_at)
            VALUES (v_bg, repeat('d', 64), v_user, now() + INTERVAL '3 days');
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'FAIL  AV4 a break-glass account was accepted into the activation flow';
    END IF;

    -- ---------------------------------------------------------------- AV5
    -- At most one LIVE token per account.
    v_ok := false;
    BEGIN
        INSERT INTO user_activation (user_id, token_hash, issued_by_user_id, expires_at)
            VALUES (v_user, repeat('e', 64), v_user, now() + INTERVAL '3 days');
    EXCEPTION WHEN unique_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'FAIL  AV5 a second LIVE activation token was accepted for one account - '
                        'two people can then set the password and the second one wins silently';
    END IF;

    -- ... and consuming the first one must free the slot, or reissue is impossible.
    UPDATE user_activation SET consumed_at = now(), consumed_reason = 'superseded'
     WHERE id = v_act;
    BEGIN
        INSERT INTO user_activation (user_id, token_hash, issued_by_user_id, expires_at)
            VALUES (v_user, repeat('e', 64), v_user, now() + INTERVAL '3 days')
          RETURNING id INTO v_act;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'FAIL  AV5b consuming a token did not free the slot for a reissue: %',
                        SQLERRM;
    END;

    -- ---------------------------------------------------------------- AV6
    -- Immutable but for its consumption. Re-pointing the hash at another account is the attack.
    v_ok := false;
    BEGIN
        UPDATE user_activation SET user_id = v_pw_user WHERE id = v_act;
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'FAIL  AV6 an activation token was re-pointed at a different account';
    END IF;

    v_ok := false;
    BEGIN
        UPDATE user_activation SET expires_at = now() + INTERVAL '400 days' WHERE id = v_act;
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'FAIL  AV6b an already-issued token had its expiry extended';
    END IF;

    -- ---------------------------------------------------------------- AV7
    -- A spent token cannot be un-spent.
    UPDATE user_activation SET consumed_at = now(), consumed_reason = 'redeemed' WHERE id = v_act;
    v_ok := false;
    BEGIN
        UPDATE user_activation SET consumed_at = NULL, consumed_reason = NULL WHERE id = v_act;
    EXCEPTION WHEN restrict_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'FAIL  AV7 a consumed activation token was un-consumed - a single-use '
                        'secret became multi-use';
    END IF;

    -- ---------------------------------------------------------------- AV8
    -- A consumption must say why, and an unconsumed row must not claim a reason.
    v_ok := false;
    BEGIN
        INSERT INTO user_activation (user_id, token_hash, issued_by_user_id, expires_at,
                                     consumed_at)
            VALUES (v_user, repeat('f', 64), v_user, now() + INTERVAL '1 day', now());
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'FAIL  AV8 a token was consumed with no reason recorded';
    END IF;

    -- ---------------------------------------------------------------- AV9
    -- Both rails are ENABLE ALWAYS, so a restore or a bulk load cannot walk around them.
    SELECT count(*) INTO v_always
      FROM pg_trigger
     WHERE tgrelid = 'user_activation'::regclass
       AND NOT tgisinternal
       AND tgenabled = 'A';
    IF v_always <> 2 THEN
        RAISE EXCEPTION 'FAIL  AV9 expected 2 ENABLE ALWAYS triggers on user_activation, found %',
                        v_always;
    END IF;

    -- ---------------------------------------------------------------- AV10
    -- Nothing replayable is stored. Every token_hash is a SHA-256 hex digest.
    SELECT count(*) INTO v_n
      FROM user_activation
     WHERE token_hash !~ '^[0-9a-f]{64}$';
    IF v_n <> 0 THEN
        RAISE EXCEPTION 'FAIL  AV10 % activation row(s) hold something other than a SHA-256 hex '
                        'digest - a token itself may never be stored', v_n;
    END IF;

    -- ---------------------------------------------------------------- AV11
    -- The seed must not have left a live activation lying around, and no demo account may be
    -- credential-less: both would mean the demo cannot sign in as somebody.
    SELECT count(*) INTO v_n
      FROM app_user
     WHERE password_hash IS NULL
       AND NOT is_break_glass
       AND email NOT LIKE 'av-%@panasatech.com';
    IF v_n <> 0 THEN
        RAISE EXCEPTION 'FAIL  AV11 % non-break-glass account(s) have no credential and no way '
                        'in', v_n;
    END IF;

    -- Clean up the fixtures. This file runs against the seeded dev database, so it must leave it
    -- as it found it - a stray credential-less account would fail AV11 on the next run.
    DELETE FROM user_activation WHERE user_id IN (v_user, v_pw_user, v_bg);
    DELETE FROM app_user WHERE id IN (v_user, v_pw_user, v_bg);
    DELETE FROM employee WHERE id IN (v_emp, v_emp2);

    RAISE NOTICE 'PASS  0029 account activation: 11 checks';
END $$;
