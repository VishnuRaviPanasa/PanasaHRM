-- =============================================================================
-- 0008  Privilege separation: the application role
-- =============================================================================
--
-- WHY
--   Every enforcement rail in this schema carries the same caveat: a trigger cannot stop the
--   table OWNER from running `ALTER TABLE ... DISABLE TRIGGER` or `DROP TRIGGER`. Migrations
--   0004-0007 all say so honestly, and all name the same mitigation - grant separation - while
--   admitting "the application role does not exist yet". That admission has been true for four
--   migrations. This creates the role, so the mitigation is real rather than promised.
--
-- WHAT THIS ACTUALLY BUYS, precisely
--   It does NOT make the rails un-removable. Nothing can. What it does is separate two things
--   that are currently the same principal:
--
--     * `hrm` owns every object. It can disable any trigger, drop any constraint, truncate any
--       table. It is a migration/DBA identity and should be used only for migrations and incidents.
--     * `hrm_app` owns nothing. It cannot DISABLE or DROP a trigger, cannot TRUNCATE, cannot ALTER
--       a table, cannot change a default. An SQL-injection flaw or a careless repository running
--       as `hrm_app` therefore cannot remove the protection - it can only run into it.
--
--   That is the whole claim. It converts "the rails hold unless the application is compromised"
--   into "the rails hold unless a DBA credential is compromised", which is a materially smaller
--   and more auditable surface.
--
-- WHAT IT DOES NOT FIX, stated plainly so no one over-reads it
--   * A compromised `hrm` credential still defeats everything. Ownership is the real boundary and
--     it cannot be delegated away while migrations must alter these tables.
--   * `session_replication_role` is a superuser-only GUC here, so `hrm_app` cannot use it - but a
--     superuser still can. ENABLE ALWAYS (migration 0005) is what blunts that, not this role.
--   * It does nothing about application-level authorization. ADR-0005 governs that, and
--     `packages/authz` still does not exist.
--
-- NO LOGIN IS CREATED HERE
--   The role is NOLOGIN and passwordless. Deployment attaches credentials out of band; a password
--   in a migration is a secret in git history. `CLAUDE.md` forbids writing secrets, and a
--   migration file is the worst possible place for one.
--
-- Change class: C (authorization/grants). Non-destructive: creates a role and grants; alters no
-- data, drops nothing, and changes no existing object's ownership.
-- =============================================================================

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrm_app') THEN
        CREATE ROLE hrm_app NOLOGIN;
    END IF;
END $$;

COMMENT ON ROLE hrm_app IS
    'The application identity. Owns nothing, so it cannot disable or drop the triggers that '
    'enforce Must-Know Rules 2, 3 and 6. Deployment attaches login credentials out of band.';

-- Nothing should reach these tables by accident.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;

GRANT CONNECT ON DATABASE hrm TO hrm_app;
GRANT USAGE ON SCHEMA public TO hrm_app;

-- Read everything the application legitimately reads.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO hrm_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hrm_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO hrm_app;

-- Effective-dated policy: INSERT a new period, and UPDATE only so the Rule 3 trigger can
-- adjudicate a closure. DELETE is not granted at all - belt as well as the trigger's braces.
GRANT INSERT, UPDATE ON attendance_policy, employment_policy, leave_policy TO hrm_app;

-- Mutable settings.
GRANT INSERT, UPDATE ON org_setting TO hrm_app;
GRANT INSERT, UPDATE ON leave_type TO hrm_app;

-- Append-only surfaces: INSERT only. The triggers already refuse the rest; withholding the grant
-- means a bug never even reaches them.
GRANT INSERT ON audit_event TO hrm_app;
GRANT INSERT ON outbox_event TO hrm_app;
GRANT INSERT ON leave_ledger TO hrm_app;

-- The drain needs to record its own bookkeeping, and only that. The immutability trigger
-- (migration 0006) constrains WHICH columns may change; this constrains whether it may write.
GRANT UPDATE ON outbox_event TO hrm_app;

-- leave_account is DERIVED. Must-Know Rule 6: the application never writes it, the ledger trigger
-- does. Deliberately NO INSERT, UPDATE or DELETE - the trigger runs with the invoker's rights, but
-- the writer-guard flag is what authorises it, not a grant to the caller.
-- (SELECT is granted above, because reading a balance is the normal case.)

-- Future tables must not silently arrive ungranted-and-then-over-granted. Default privileges keep
-- the read side automatic and leave every write grant a deliberate act.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO hrm_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO hrm_app;

COMMIT;
