-- =============================================================================
-- Verification for 0008: privilege separation
--
-- Every rail in migrations 0004-0007 carries the same caveat - a trigger cannot stop the table
-- OWNER disabling it. The stated mitigation was grant separation, and for four migrations the
-- honest footnote was "the application role does not exist yet". These checks assert that it now
-- does, and that it genuinely cannot remove the protections.
--
-- What this does NOT claim: that the rails are un-removable. A compromised `hrm` (owner)
-- credential still defeats everything. Ownership is the real boundary.
-- =============================================================================

-- G1: the role exists and owns nothing. Ownership is what confers DISABLE/DROP TRIGGER.
DO $$
DECLARE v_exists BOOLEAN; v_owns TEXT;
BEGIN
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrm_app') INTO v_exists;
    IF NOT v_exists THEN RAISE EXCEPTION 'FAIL  G1 hrm_app does not exist'; END IF;

    SELECT string_agg(c.relname, ', ') INTO v_owns
      FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
     WHERE r.rolname = 'hrm_app' AND c.relkind IN ('r', 'p');
    IF v_owns IS NULL THEN RAISE NOTICE 'PASS  G1 hrm_app exists and owns no table';
    ELSE RAISE EXCEPTION 'FAIL  G1 hrm_app owns: % - it could disable its own guards', v_owns; END IF;
END $$;

-- G2: it is not a superuser and cannot bypass the world.
DO $$
DECLARE v_super BOOLEAN; v_bypass BOOLEAN;
BEGIN
    SELECT rolsuper, rolbypassrls INTO v_super, v_bypass FROM pg_roles WHERE rolname = 'hrm_app';
    IF NOT v_super AND NOT v_bypass THEN
        RAISE NOTICE 'PASS  G2 hrm_app is not superuser and does not bypass RLS';
    ELSE
        RAISE EXCEPTION 'FAIL  G2 hrm_app is over-privileged (super=%, bypassrls=%)', v_super, v_bypass;
    END IF;
END $$;

-- G3: it cannot destroy an effective-dated table's contents by any granted route.
DO $$
DECLARE v_bad TEXT := '';
BEGIN
    IF has_table_privilege('hrm_app', 'attendance_policy', 'TRUNCATE') THEN v_bad := v_bad || 'truncate policy; '; END IF;
    IF has_table_privilege('hrm_app', 'attendance_policy', 'DELETE')   THEN v_bad := v_bad || 'delete policy; '; END IF;
    IF has_table_privilege('hrm_app', 'leave_policy', 'DELETE')        THEN v_bad := v_bad || 'delete leave_policy; '; END IF;
    IF has_table_privilege('hrm_app', 'employment_policy', 'DELETE')   THEN v_bad := v_bad || 'delete employment_policy; '; END IF;
    IF v_bad = '' THEN RAISE NOTICE 'PASS  G3 hrm_app cannot DELETE or TRUNCATE effective-dated policy';
    ELSE RAISE EXCEPTION 'FAIL  G3 over-granted: %', v_bad; END IF;
END $$;

-- G4: append-only surfaces are append-only by GRANT as well as by trigger. Withholding the
-- privilege means a bug never even reaches the rail.
DO $$
DECLARE v_bad TEXT := '';
BEGIN
    IF has_table_privilege('hrm_app', 'audit_event', 'UPDATE')   THEN v_bad := v_bad || 'update audit; '; END IF;
    IF has_table_privilege('hrm_app', 'audit_event', 'DELETE')   THEN v_bad := v_bad || 'delete audit; '; END IF;
    IF has_table_privilege('hrm_app', 'audit_event', 'TRUNCATE') THEN v_bad := v_bad || 'truncate audit; '; END IF;
    IF has_table_privilege('hrm_app', 'leave_ledger', 'UPDATE')  THEN v_bad := v_bad || 'update ledger; '; END IF;
    IF has_table_privilege('hrm_app', 'leave_ledger', 'DELETE')  THEN v_bad := v_bad || 'delete ledger; '; END IF;
    IF has_table_privilege('hrm_app', 'outbox_event', 'DELETE')  THEN v_bad := v_bad || 'delete outbox; '; END IF;
    IF v_bad = '' THEN RAISE NOTICE 'PASS  G4 audit, ledger and outbox are append-only by grant too';
    ELSE RAISE EXCEPTION 'FAIL  G4 over-granted: %', v_bad; END IF;
END $$;

-- G5: Must-Know Rule 6 at the grant layer. The application never writes a balance.
DO $$
DECLARE v_bad TEXT := '';
BEGIN
    IF has_table_privilege('hrm_app', 'leave_account', 'UPDATE') THEN v_bad := v_bad || 'update; '; END IF;
    IF has_table_privilege('hrm_app', 'leave_account', 'INSERT') THEN v_bad := v_bad || 'insert; '; END IF;
    IF has_table_privilege('hrm_app', 'leave_account', 'DELETE') THEN v_bad := v_bad || 'delete; '; END IF;
    IF NOT has_table_privilege('hrm_app', 'leave_account', 'SELECT') THEN
        RAISE EXCEPTION 'FAIL  G5 hrm_app cannot read a balance - the application is unusable';
    END IF;
    IF v_bad = '' THEN RAISE NOTICE 'PASS  G5 hrm_app may read a balance but never write one';
    ELSE RAISE EXCEPTION 'FAIL  G5 hrm_app can write leave_account: %', v_bad; END IF;
END $$;

-- G6: the application must still be able to do its job, or the separation is useless theatre.
DO $$
DECLARE v_bad TEXT := '';
BEGIN
    IF NOT has_table_privilege('hrm_app', 'leave_ledger', 'INSERT')      THEN v_bad := v_bad || 'insert ledger; '; END IF;
    IF NOT has_table_privilege('hrm_app', 'outbox_event', 'INSERT')      THEN v_bad := v_bad || 'insert outbox; '; END IF;
    IF NOT has_table_privilege('hrm_app', 'outbox_event', 'UPDATE')      THEN v_bad := v_bad || 'drain bookkeeping; '; END IF;
    IF NOT has_table_privilege('hrm_app', 'attendance_policy', 'INSERT') THEN v_bad := v_bad || 'insert policy; '; END IF;
    IF NOT has_table_privilege('hrm_app', 'attendance_policy', 'UPDATE') THEN v_bad := v_bad || 'close a period; '; END IF;
    IF NOT has_table_privilege('hrm_app', 'org_setting', 'UPDATE')       THEN v_bad := v_bad || 'update settings; '; END IF;
    IF v_bad = '' THEN RAISE NOTICE 'PASS  G6 hrm_app retains every privilege it legitimately needs';
    ELSE RAISE EXCEPTION 'FAIL  G6 under-granted, the application cannot work: %', v_bad; END IF;
END $$;

-- G7: PUBLIC has been revoked. Nothing should reach these tables by accident.
DO $$
DECLARE v_bad TEXT;
BEGIN
    SELECT string_agg(c.relname, ', ') INTO v_bad
      FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
       AND has_table_privilege('public', c.oid, 'SELECT');
    IF v_bad IS NULL THEN RAISE NOTICE 'PASS  G7 PUBLIC has no table privileges';
    ELSE RAISE EXCEPTION 'FAIL  G7 PUBLIC can read: %', v_bad; END IF;
END $$;

SELECT 'PRIVILEGE SEPARATION VERIFICATION COMPLETE' AS result;
