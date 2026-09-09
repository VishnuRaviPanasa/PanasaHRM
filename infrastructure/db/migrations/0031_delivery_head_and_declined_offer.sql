-- =============================================================================
-- 0031  A delivery-head role, provisionable roles, and a terminal for a declined offer
-- =============================================================================
--
-- Groundwork for the onboarding approval chain: HR prepares a salary annexure, the finance head
-- approves it, the delivery head approves it, and only then does an offer letter go out. Three
-- things had to change before any of that can be expressed, and all three are here because they
-- are the same act - making the people in that chain representable.
--
-- 1. THE DELIVERY HEAD DID NOT EXIST. `ck_user_role_value` permitted six roles and none of them
--    is the person who signs off a joiner from the delivery side. `finance` already existed and
--    is reused as the finance head rather than duplicated - it is allowed almost nothing today
--    (only `org.unit.read` and `org.team.read`), so this is the first time it does real work.
--
--    A FLAT ROLE, not a per-project assignment. ADR-0005 has two scope graphs and a delivery head
--    who approved only for their own unit would naturally be the project graph - but this is one
--    site with a few dozen people and one delivery head, and modelling a hierarchy nobody has
--    would be inventing a requirement. If a second delivery head ever appears with a real
--    boundary between them, that is a scope change with an ADR, not a config flag.
--
-- 2. NO WIDER ROLE COULD BE GIVEN A LOGIN. `ck_app_user_role` on the account row permitted only
--    'employee', 'manager', 'hr_admin' while `ck_user_role_value` on the effective-dated GRANT
--    permitted six. `accounts.ts` therefore refuses to provision `finance`, `hr_ops` or `auditor`
--    at all, which was recorded as a known gap when provisioning shipped (DEC-129) and is now
--    load-bearing: a finance head who cannot be given a login cannot approve anything. The two
--    lists are brought into agreement, which is the fix the gap always needed.
--
-- 3. A DECLINED OFFER HAD NOWHERE TO GO. `pre_boarding -> active` via `joined` was the only way
--    out of pre-boarding, so somebody who turned the offer down would sit in pre-boarding
--    forever, indistinguishable from somebody still deciding. **Creating an employee is
--    irreversible** - `employment_event` is append-only and holds a foreign key to `employee`, so
--    there is no delete to fall back on. The state is therefore added deliberately rather than
--    left as an absence: `offer_declined` is terminal, reached only from `pre_boarding`.
--
--    THE COST IS REAL AND IS ACCEPTED: every count of "our people" must now exclude it. The
--    as-of headcount reports already do, because a non-joiner never opens an employment period -
--    but the directory lists employees directly and will show them until it filters.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. The seventh role
-- -----------------------------------------------------------------------------
ALTER TABLE user_role DROP CONSTRAINT ck_user_role_value;
ALTER TABLE user_role ADD CONSTRAINT ck_user_role_value
    CHECK (role IN ('employee', 'manager', 'hr_admin', 'hr_ops', 'finance', 'auditor',
                    'delivery_head'));

COMMENT ON CONSTRAINT ck_user_role_value ON user_role IS
    'Seven roles. `finance` is the finance head and `delivery_head` the delivery head in the '
    'onboarding approval chain; both are flat roles because there is one of each on one site.';

-- -----------------------------------------------------------------------------
-- 2. The account row may now carry any granted role
-- -----------------------------------------------------------------------------
--
-- `app_user.role` is DENORMALISED - `fn_user_roles` resolves an actor's real roles from the
-- effective-dated `user_role` table - but the login lookup reads the column and provisioning
-- writes it, so a value the column refuses is a role that cannot be provisioned. The two lists
-- disagreeing was the bug, not the column existing.
ALTER TABLE app_user DROP CONSTRAINT ck_app_user_role;
ALTER TABLE app_user ADD CONSTRAINT ck_app_user_role
    CHECK (role IN ('employee', 'manager', 'hr_admin', 'hr_ops', 'finance', 'auditor',
                    'delivery_head'));

-- -----------------------------------------------------------------------------
-- 3. A terminal state for somebody who never joined
-- -----------------------------------------------------------------------------
ALTER TABLE employee DROP CONSTRAINT ck_employee_status;
ALTER TABLE employee ADD CONSTRAINT ck_employee_status
    CHECK (status IN ('pre_boarding', 'active', 'on_notice', 'exited', 'offer_declined'));

-- The transition table's own guards enumerate the states, so they widen too or the row below
-- cannot be inserted.
ALTER TABLE employment_status_transition DROP CONSTRAINT ck_est_from;
ALTER TABLE employment_status_transition ADD CONSTRAINT ck_est_from
    CHECK (from_status IN ('pre_boarding', 'active', 'on_notice', 'exited', 'offer_declined'));
ALTER TABLE employment_status_transition DROP CONSTRAINT ck_est_to;
ALTER TABLE employment_status_transition ADD CONSTRAINT ck_est_to
    CHECK (to_status IN ('pre_boarding', 'active', 'on_notice', 'exited', 'offer_declined'));

-- ONE new move, and only one. `offer_declined` is reachable from `pre_boarding` and from nowhere
-- else, and nothing leads out of it - somebody who declined and later joins is a new hire with a
-- new record, not a resurrected one. `employment_event` carries a composite foreign key onto this
-- whole triple, so that is enforced by the database rather than by whoever writes the endpoint.
INSERT INTO employment_status_transition (event_type, from_status, to_status) VALUES
    ('offer_declined', 'pre_boarding', 'offer_declined');

COMMIT;
