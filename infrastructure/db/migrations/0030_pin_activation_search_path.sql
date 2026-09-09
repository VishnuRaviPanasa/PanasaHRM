-- =============================================================================
-- 0030  Pin search_path on the activation functions
-- =============================================================================
--
-- FOUND BY N11, and it is not a lint. 0013 established that every `fn_*` in `public` must pin its
-- `search_path`, and N10 in the same verify file DEMONSTRATES the attack it prevents: a temporary
-- table in `pg_temp` shadows a real one, and an unpinned function resolves to the fake.
--
-- 0029's two functions were unpinned, and one of them is the account-takeover rail. Unpinned,
-- `fn_user_activation_requires_no_credential` resolves `app_user` through the caller's
-- `search_path` - so anyone able to run
--
--     CREATE TEMP TABLE app_user (id uuid, password_hash text, is_break_glass boolean);
--     INSERT INTO app_user VALUES ('<the HR admin>', NULL, false);
--
-- would have the trigger read a row saying "no credential, not break-glass", and the check that
-- stops an activation code being minted for a live account would pass. The rail that migration
-- 0029 exists to provide would be gone, silently, with every other constraint still in place.
--
-- Both functions are recreated with `SET search_path TO 'pg_catalog', 'pg_temp'`, matching
-- `fn_user_roles` and the rest of the pinned set. `public` is deliberately NOT on that path, so
-- every reference is schema-qualified - which is the point: an unqualified name is exactly what
-- the shadowing attack needs.
--
-- 0029 IS NOT EDITED. It is applied and its checksum is enforced (DEC-012), and migrations are
-- forward-only (DEC-011). CREATE OR REPLACE FUNCTION keeps the existing triggers pointing at the
-- same names, so nothing has to be re-attached.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION fn_user_activation_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
BEGIN
    IF NEW.id                <> OLD.id
       OR NEW.user_id           <> OLD.user_id
       OR NEW.token_hash        <> OLD.token_hash
       OR NEW.issued_by_user_id <> OLD.issued_by_user_id
       OR NEW.created_at        <> OLD.created_at
       OR NEW.expires_at        <> OLD.expires_at THEN
        RAISE EXCEPTION
            'an activation token is immutable; only its consumption may be recorded'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NULL THEN
        RAISE EXCEPTION 'an activation token cannot be un-consumed'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION fn_user_activation_requires_no_credential()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
DECLARE
    v_has_password BOOLEAN;
    v_break_glass  BOOLEAN;
BEGIN
    -- `public.app_user`, qualified. Unqualified, this is the shadowing target - see the header.
    SELECT password_hash IS NOT NULL, is_break_glass
      INTO v_has_password, v_break_glass
      FROM public.app_user
     WHERE id = NEW.user_id;

    IF v_has_password THEN
        RAISE EXCEPTION
            'this account already has a password; issuing an activation token would be a reset, '
            'which is a different action with different authorization'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF v_break_glass THEN
        RAISE EXCEPTION 'break-glass accounts are sealed and cannot be activated through this flow'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

COMMIT;
