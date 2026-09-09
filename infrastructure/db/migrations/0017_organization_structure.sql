-- =============================================================================
-- 0017  Organization structure: unit hierarchy, teams, effective-dated reorgs
-- =============================================================================
--
-- Module 3. What existed before this migration:
--
--   * `org_setting` and the settings screen - company settings, done (0002/0003).
--   * `department` and `designation` - FLAT tables with a code and a name. No hierarchy, no
--     parent, no head, no validity period, no way to close one.
--   * The PEOPLE hierarchy - `employment.manager_id`, effective-dated, resolved by
--     `fn_reporting_subtree_asof` (0014). That part was already right.
--   * `team` - did not exist at all.
--
-- So "effective-dated organizational changes" was true of who reports to whom and false of
-- everything structural. A department could be renamed, re-parented or abandoned with an UPDATE,
-- and last year's cost allocation would silently re-attribute itself to this year's structure.
--
-- THE SPLIT, and it follows `ai/context/temporal-data-rules.md` rather than inventing anything:
--
--   IDENTITY + LABEL stays mutable. `department.name`, `designation.name`, `team.name`. The
--   rules file names "a designation's display name" as the canonical example of mutable
--   reference data. Correcting a typo in a department name must not require a new period.
--
--   STRUCTURE becomes effective-dated. Who a department reports into, who heads it, which
--   department a team belongs to, who leads it, and who is on it. Every one of those is a fact
--   that was true for a range of dates, and every one is an input to a historical report.
--
-- WHY TWO PERIOD TABLES RATHER THAN ONE `org_unit_period`
--
-- A single polymorphic table would need a generated key to hang the EXCLUDE constraint on, and a
-- CHECK to keep the discriminator honest. It also models the domain worse: departments NEST
-- (a department's parent is a department) while a team's parent is a department and never
-- another team. Two tables state that in the foreign keys instead of in a comment.
--
-- CYCLE GUARDS, AGAIN
--
-- `fn_department_subtree_asof` is depth-capped and path-guarded for the same reason
-- `fn_reporting_subtree_asof` is: the EXCLUDE constraint gives one parent per department per
-- date, so the graph is a forest at any instant UNLESS two departments are each other's parent,
-- which the schema alone does not prevent. A self-parent IS prevented by CHECK; a two-cycle is
-- not, so the walk guards against it rather than trusting the data.
--
-- DESIGNATION RETIREMENT is `retired_on`, not a delete and not a boolean. A retired designation
-- must stay usable by the historical `employment` rows that reference it while being refused for
-- a NEW assignment - so the question is "was it retired on the date being assigned", which needs
-- a date rather than a flag.
--
-- Class C. Verified by testing/db/0017_organization_structure.verify.sql.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Departments gain identity metadata; structure moves to its own table
-- -----------------------------------------------------------------------------

ALTER TABLE department
    ADD COLUMN description text,
    ADD COLUMN updated_at  timestamptz NOT NULL DEFAULT now();

CREATE TRIGGER tg_department_updated_at
    BEFORE UPDATE ON department
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

COMMENT ON TABLE department IS
    'Department IDENTITY and label - mutable reference data (temporal-data-rules). Its position '
    'in the hierarchy, its head and its closure live in department_period, which is '
    'effective-dated. Renaming a department is an UPDATE here; re-parenting one is a new period '
    'there.';

/*
 * The department hierarchy over time.
 *
 * A department with no period row has no place in the structure and no head - which is a
 * legitimate state for one that has been created but not yet placed, so it is not an error.
 * `parent_department_id IS NULL` means a top-level unit.
 */
CREATE TABLE department_period (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id        uuid NOT NULL REFERENCES department(id),
    parent_department_id uuid REFERENCES department(id),
    head_employee_id     uuid REFERENCES employee(id),

    valid_from           date NOT NULL,
    valid_to             date,
    valid_period         daterange GENERATED ALWAYS AS
                             (daterange(valid_from, valid_to, '[)')) STORED,

    reason               text,
    created_at           timestamptz NOT NULL DEFAULT now(),

    -- Mandatory, never optional (temporal-data-rules rule 1). A zero-length period slips past
    -- the exclusion constraint because `empty && anything` is false, then matches no as-of
    -- query - so the department vanishes from every report for reasons nobody can reproduce.
    CONSTRAINT ck_department_period_not_empty
        CHECK (NOT isempty(daterange(valid_from, valid_to, '[)'))),

    -- A department cannot be its own parent. A LONGER cycle is not prevented here, which is why
    -- the subtree walk is path-guarded.
    CONSTRAINT ck_department_period_not_self_parent
        CHECK (parent_department_id IS NULL OR parent_department_id <> department_id),

    -- One placement per department per date.
    CONSTRAINT ex_department_period_no_overlap EXCLUDE USING gist (
        department_id WITH =, valid_period WITH &&)
);

CREATE INDEX ix_department_period_asof ON department_period (department_id, valid_period);
CREATE INDEX ix_department_period_parent
    ON department_period (parent_department_id, valid_period)
    WHERE parent_department_id IS NOT NULL;
CREATE INDEX ix_department_period_head
    ON department_period (head_employee_id) WHERE head_employee_id IS NOT NULL;

COMMENT ON TABLE department_period IS
    'Effective-dated department placement and leadership. A reorganisation closes the open period '
    'and opens a new one (Rule 3); it never rewrites the old one, because last year''s cost '
    'allocation reads through it.';

-- -----------------------------------------------------------------------------
-- 2. Teams
-- -----------------------------------------------------------------------------

CREATE TABLE team (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code        text NOT NULL UNIQUE,
    name        text NOT NULL,
    description text,
    -- Archiving is not deletion: work logs, timesheets and reports reference a team forever.
    archived_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT ck_team_code CHECK (code ~ '^[A-Z][A-Z0-9_-]*$')
);

CREATE TRIGGER tg_team_updated_at
    BEFORE UPDATE ON team
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

COMMENT ON TABLE team IS
    'Team identity and label - mutable reference data. Which department it belongs to and who '
    'leads it live in team_period. A team is ARCHIVED, never deleted: effort history references '
    'it indefinitely.';

/*
 * A team's home department and its lead, over time. A team moving between departments is an
 * organisational change and gets a new period, exactly like a department re-parenting.
 */
CREATE TABLE team_period (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id          uuid NOT NULL REFERENCES team(id),
    department_id    uuid NOT NULL REFERENCES department(id),
    lead_employee_id uuid REFERENCES employee(id),

    valid_from       date NOT NULL,
    valid_to         date,
    valid_period     daterange GENERATED ALWAYS AS
                         (daterange(valid_from, valid_to, '[)')) STORED,

    reason           text,
    created_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT ck_team_period_not_empty
        CHECK (NOT isempty(daterange(valid_from, valid_to, '[)'))),

    CONSTRAINT ex_team_period_no_overlap EXCLUDE USING gist (
        team_id WITH =, valid_period WITH &&)
);

CREATE INDEX ix_team_period_asof ON team_period (team_id, valid_period);
CREATE INDEX ix_team_period_dept ON team_period (department_id, valid_period);

/*
 * Team membership, effective-dated.
 *
 * Note what this deliberately does NOT do: it is not a second authorization scope graph.
 * ADR-0005 has exactly two - the reporting hierarchy for HR resources and project membership for
 * work resources - and `ai/context/rbac-rules.md` is explicit that merging graphs is how a
 * project lead ends up reading somebody's disciplinary file. A team is an organisational grouping
 * for structure and reporting; it confers no access. If team membership ever needs to grant
 * anything, that is a third graph and needs an ADR.
 */
CREATE TABLE team_membership (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id      uuid NOT NULL REFERENCES team(id),
    employee_id  uuid NOT NULL REFERENCES employee(id),
    role         text NOT NULL DEFAULT 'member',

    valid_from   date NOT NULL,
    valid_to     date,
    valid_period daterange GENERATED ALWAYS AS
                     (daterange(valid_from, valid_to, '[)')) STORED,

    reason       text,
    created_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT ck_team_membership_role CHECK (role IN ('member', 'lead')),

    CONSTRAINT ck_team_membership_not_empty
        CHECK (NOT isempty(daterange(valid_from, valid_to, '[)'))),

    -- One membership per person per team per date. Different teams may overlap - somebody can
    -- be on two teams at once, which is the normal case in an IT services organisation.
    CONSTRAINT ex_team_membership_no_overlap EXCLUDE USING gist (
        team_id WITH =, employee_id WITH =, valid_period WITH &&)
);

CREATE INDEX ix_team_membership_team ON team_membership (team_id, valid_period);
CREATE INDEX ix_team_membership_employee ON team_membership (employee_id, valid_period);

COMMENT ON TABLE team_membership IS
    'Effective-dated team membership. NOT an authorization scope graph - ADR-0005 has exactly '
    'two, and merging them is the failure rbac-rules.md warns about. Membership here grants '
    'nothing.';

-- -----------------------------------------------------------------------------
-- 3. Designation retirement
-- -----------------------------------------------------------------------------

ALTER TABLE designation
    ADD COLUMN retired_on  date,
    ADD COLUMN description text,
    ADD COLUMN updated_at  timestamptz NOT NULL DEFAULT now();

CREATE TRIGGER tg_designation_updated_at
    BEFORE UPDATE ON designation
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

COMMENT ON COLUMN designation.retired_on IS
    'A DATE, not a boolean, and not a delete. Historical employment rows referencing a retired '
    'designation stay valid; a NEW assignment on or after this date is refused. The question is '
    '"was it retired on the date being assigned", which a flag cannot answer.';

/*
 * Refuse a new assignment to a designation that was already retired on the date it takes effect.
 * Enforced by trigger rather than by the service layer, because a migration, a backfill script
 * or a later code path would each have to remember the rule independently.
 */
CREATE OR REPLACE FUNCTION fn_block_retired_designation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
DECLARE v_retired date; v_code text;
BEGIN
    SELECT d.retired_on, d.code INTO v_retired, v_code
      FROM public.designation d WHERE d.id = NEW.designation_id;

    IF v_retired IS NOT NULL AND NEW.valid_from >= v_retired THEN
        RAISE EXCEPTION
            USING MESSAGE = format(
                'designation %s was retired on %s and cannot be assigned from %s',
                v_code, v_retired, NEW.valid_from),
                  ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_employment_designation_active
    BEFORE INSERT ON employment
    FOR EACH ROW EXECUTE FUNCTION fn_block_retired_designation();

ALTER TABLE employment ENABLE ALWAYS TRIGGER tg_employment_designation_active;

-- -----------------------------------------------------------------------------
-- 4. Rule 3 rails on every new effective-dated table
-- -----------------------------------------------------------------------------

CREATE TRIGGER tg_department_period_immutable_history
    BEFORE UPDATE OR DELETE ON department_period
    FOR EACH ROW EXECUTE FUNCTION fn_block_historical_mutation();
ALTER TABLE department_period ENABLE ALWAYS TRIGGER tg_department_period_immutable_history;

CREATE TRIGGER tg_department_period_no_backdate
    BEFORE INSERT ON department_period
    FOR EACH ROW EXECUTE FUNCTION fn_block_backdated_period();
ALTER TABLE department_period ENABLE ALWAYS TRIGGER tg_department_period_no_backdate;

CREATE TRIGGER tg_department_period_no_truncate
    BEFORE TRUNCATE ON department_period
    FOR EACH STATEMENT EXECUTE FUNCTION fn_block_mutation();
ALTER TABLE department_period ENABLE ALWAYS TRIGGER tg_department_period_no_truncate;

CREATE TRIGGER tg_team_period_immutable_history
    BEFORE UPDATE OR DELETE ON team_period
    FOR EACH ROW EXECUTE FUNCTION fn_block_historical_mutation();
ALTER TABLE team_period ENABLE ALWAYS TRIGGER tg_team_period_immutable_history;

CREATE TRIGGER tg_team_period_no_backdate
    BEFORE INSERT ON team_period
    FOR EACH ROW EXECUTE FUNCTION fn_block_backdated_period();
ALTER TABLE team_period ENABLE ALWAYS TRIGGER tg_team_period_no_backdate;

CREATE TRIGGER tg_team_period_no_truncate
    BEFORE TRUNCATE ON team_period
    FOR EACH STATEMENT EXECUTE FUNCTION fn_block_mutation();
ALTER TABLE team_period ENABLE ALWAYS TRIGGER tg_team_period_no_truncate;

CREATE TRIGGER tg_team_membership_immutable_history
    BEFORE UPDATE OR DELETE ON team_membership
    FOR EACH ROW EXECUTE FUNCTION fn_block_historical_mutation();
ALTER TABLE team_membership ENABLE ALWAYS TRIGGER tg_team_membership_immutable_history;

CREATE TRIGGER tg_team_membership_no_backdate
    BEFORE INSERT ON team_membership
    FOR EACH ROW EXECUTE FUNCTION fn_block_backdated_period();
ALTER TABLE team_membership ENABLE ALWAYS TRIGGER tg_team_membership_no_backdate;

CREATE TRIGGER tg_team_membership_no_truncate
    BEFORE TRUNCATE ON team_membership
    FOR EACH STATEMENT EXECUTE FUNCTION fn_block_mutation();
ALTER TABLE team_membership ENABLE ALWAYS TRIGGER tg_team_membership_no_truncate;

-- -----------------------------------------------------------------------------
-- 5. Resolvers - all as-of, all pinned, all cycle-safe
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_department_parent_asof(p_department uuid, p_on date)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
    SELECT dp.parent_department_id
      FROM public.department_period dp
     WHERE dp.department_id = p_department
       AND dp.valid_period @> p_on
     LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION fn_department_head_asof(p_department uuid, p_on date)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
    SELECT dp.head_employee_id
      FROM public.department_period dp
     WHERE dp.department_id = p_department
       AND dp.valid_period @> p_on
     LIMIT 1;
$$;

/*
 * Every department beneath one, as of a date. Depth 1 = immediate children.
 *
 * Path-guarded because ck_department_period_not_self_parent stops A -> A but nothing stops
 * A -> B -> A. Same reasoning as fn_reporting_subtree_asof (0014), and the guard was written
 * before the data could contain a cycle rather than after somebody created one.
 */
CREATE OR REPLACE FUNCTION fn_department_subtree_asof(p_department uuid, p_on date)
RETURNS TABLE (department_id uuid, depth integer)
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
    WITH RECURSIVE walk AS (
        SELECT dp.department_id,
               1 AS depth,
               ARRAY[p_department, dp.department_id] AS path
          FROM public.department_period dp
         WHERE dp.parent_department_id = p_department
           AND dp.valid_period @> p_on

        UNION ALL

        SELECT dp.department_id,
               w.depth + 1,
               w.path || dp.department_id
          FROM walk w
          JOIN public.department_period dp
            ON dp.parent_department_id = w.department_id
           AND dp.valid_period @> p_on
         WHERE w.depth < 10
           AND NOT (dp.department_id = ANY (w.path))
    )
    SELECT w.department_id, min(w.depth)::integer
      FROM walk w
     GROUP BY w.department_id;
$$;

/** The chain from a department up to its top-level unit, as of a date. */
CREATE OR REPLACE FUNCTION fn_department_ancestors_asof(p_department uuid, p_on date)
RETURNS TABLE (department_id uuid, depth integer)
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
    WITH RECURSIVE walk AS (
        SELECT dp.parent_department_id AS department_id,
               1 AS depth,
               ARRAY[p_department, dp.parent_department_id] AS path
          FROM public.department_period dp
         WHERE dp.department_id = p_department
           AND dp.valid_period @> p_on
           AND dp.parent_department_id IS NOT NULL

        UNION ALL

        SELECT dp.parent_department_id,
               w.depth + 1,
               w.path || dp.parent_department_id
          FROM walk w
          JOIN public.department_period dp
            ON dp.department_id = w.department_id
           AND dp.valid_period @> p_on
         WHERE dp.parent_department_id IS NOT NULL
           AND w.depth < 10
           AND NOT (dp.parent_department_id = ANY (w.path))
    )
    SELECT w.department_id, min(w.depth)::integer
      FROM walk w
     WHERE w.department_id IS NOT NULL
     GROUP BY w.department_id;
$$;

CREATE OR REPLACE FUNCTION fn_team_department_asof(p_team uuid, p_on date)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
    SELECT tp.department_id
      FROM public.team_period tp
     WHERE tp.team_id = p_team AND tp.valid_period @> p_on
     LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION fn_team_members_asof(p_team uuid, p_on date)
RETURNS TABLE (employee_id uuid, role text)
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
    SELECT tm.employee_id, tm.role
      FROM public.team_membership tm
     WHERE tm.team_id = p_team AND tm.valid_period @> p_on;
$$;

CREATE OR REPLACE FUNCTION fn_employee_teams_asof(p_employee uuid, p_on date)
RETURNS TABLE (team_id uuid, role text)
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
    SELECT tm.team_id, tm.role
      FROM public.team_membership tm
     WHERE tm.employee_id = p_employee AND tm.valid_period @> p_on;
$$;

/**
 * Headcount attributed to a department as of a date, optionally including its subtree.
 *
 * Reads `employment` as of the same date, so a historical figure is computed against the
 * structure AND the assignments that were in force then - which is the whole reason both are
 * effective-dated. A report that mixed today's structure with last year's assignments would be
 * confidently wrong.
 */
CREATE OR REPLACE FUNCTION fn_department_headcount_asof(
    p_department uuid, p_on date, p_include_subtree boolean DEFAULT false)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
    SELECT count(DISTINCT em.employee_id)::integer
      FROM public.employment em
      JOIN public.employee e ON e.id = em.employee_id
     WHERE em.valid_period @> p_on
       AND public.fn_employment_status_asof(em.employee_id, p_on) = 'active'
       AND (em.department_id = p_department
            OR (p_include_subtree AND em.department_id IN
                 (SELECT s.department_id
                    FROM public.fn_department_subtree_asof(p_department, p_on) s)));
$$;

-- -----------------------------------------------------------------------------
-- 6. Backfill - place the existing departments so the resolvers are total
-- -----------------------------------------------------------------------------
--
-- Without a period row a department has no place in the structure, which is a legitimate state
-- but makes every as-of query return nothing for the seeded data. Both existing departments
-- become top-level as of the earliest joining date in the system - the earliest point at which
-- the structure demonstrably existed.

SET LOCAL hrm.allow_backdated_period = 'on';

INSERT INTO department_period (department_id, parent_department_id, valid_from, reason)
SELECT d.id, NULL,
       COALESCE((SELECT min(e.joined_on) FROM employee e), DATE '2020-01-01'),
       'backfilled by migration 0017: existing departments placed at the top level'
  FROM department d
 WHERE NOT EXISTS (SELECT 1 FROM department_period dp WHERE dp.department_id = d.id);

-- -----------------------------------------------------------------------------
-- 7. Grants
-- -----------------------------------------------------------------------------
--
-- No DELETE on any period table: they are effective-dated (Rule 3). UPDATE is safe because
-- fn_block_historical_mutation is ENABLE ALWAYS and permits only closing an open period.

GRANT INSERT, UPDATE ON department        TO hrm_app;
GRANT INSERT, UPDATE ON designation       TO hrm_app;
GRANT INSERT, UPDATE ON team              TO hrm_app;
GRANT INSERT, UPDATE ON department_period TO hrm_app;
GRANT INSERT, UPDATE ON team_period       TO hrm_app;
GRANT INSERT, UPDATE ON team_membership   TO hrm_app;

COMMIT;
