-- =============================================================================
-- 0027  The work hierarchy: sub-projects, sub-tasks, and combinations that cannot be wrong
-- =============================================================================
--
-- WHAT THIS ADDS. Work could previously be logged against a project and, optionally, a task.
-- The requested shape is four levels:
--
--     Project -> Sub-project -> Task -> Sub-task
--
-- so this migration adds `sub_project` and `sub_task`, hangs `task` off a sub-project when it has
-- one, and gives every level below `project` an `active` flag for the master-data lifecycle.
--
-- THE GAP IT CLOSES ON THE WAY, which matters more than the new levels.
--
-- `work_log_entry` carries `project_id` and `task_id` as two INDEPENDENT foreign keys. Each is
-- valid on its own, and nothing has ever required them to agree - so an entry could name project
-- CPRT and a task belonging to MOBL, and the database would accept it. The API did not check
-- either: `POST /work-log` inserted `body.projectId` and `body.taskId` straight through. Every
-- effort report then groups by project, so one such row silently moves somebody's hours onto the
-- wrong client's total. Nothing raises; the report just disagrees with reality.
--
-- Verified clean before adding the constraint - 37 entries, 0 mismatches - so this is closing a
-- door rather than repairing damage.
--
-- WHY COMPOSITE FOREIGN KEYS RATHER THAN VALIDATION IN THE CONTROLLER. The requirement is that
-- "arbitrary IDs must not be combinable into invalid relationships". A check in the API answers
-- that for one code path. A composite FK answers it for every path there will ever be - the next
-- controller, a bulk import, a migration, a hand-run UPDATE at 2am:
--
--     FOREIGN KEY (task_id, project_id)   REFERENCES task     (id, project_id)
--     FOREIGN KEY (sub_task_id, task_id)  REFERENCES sub_task (id, task_id)
--
-- The task now has to belong to the stated project, and the sub-task to the stated task, as a
-- property of the schema. These are MATCH SIMPLE (the default), so a NULL in either column skips
-- the check - which is exactly the behaviour wanted, because `task_id` and `sub_task_id` are both
-- optional. `task_id IS NULL` still means "logged against the project as a whole".
--
-- WHY THE ENTRY DOES NOT STORE `sub_project_id`. This was the real design question. Storing all
-- four identifiers would reintroduce the very problem above one level up: a fourth column that
-- can disagree with the other three, needing a third constraint to keep it honest. But a
-- sub-project is not an independent choice - it is a PROPERTY OF THE TASK. Given the task, the
-- sub-project and the project are both determined:
--
--     sub_task -> task -> sub_project -> project
--
-- So the entry stores what is actually chosen (project, task, optional sub-task) and the
-- sub-project is recovered by joining, through `v_work_hierarchy` below. The UI still cascades
-- Project -> Sub-project -> Task, because that is how a person narrows a long list; the cascade
-- is a navigation aid, not four independent facts to persist. One fewer column, one fewer
-- constraint, and an incoherent sub-project becomes unrepresentable instead of merely rejected.
-- See docs/governance/decisions.md, DEC-113.
--
-- LIFECYCLE, AND WHY `project` IS LEFT ALONE. `project` already answers "may this be used" with
-- `status IN ('active','on_hold','closed')`. Adding `active` beside it would create two competing
-- notions on the same row, which is how a record ends up active and closed at once. The three new
-- levels have no such column, so they get `active BOOLEAN`. `task.status` is NOT that column:
-- 'done' means the work finished, `active = false` means the master record is retired and should
-- not appear in new selection. A completed task still needs to be selectable while somebody logs
-- the last of their time against it.
--
-- HISTORY SURVIVES DEACTIVATION, which is the whole reason this is a flag and not a delete.
-- Deactivating changes nothing about existing rows: `work_log_entry` holds the identifier, the
-- label is read by joining, and the join does not care about `active`. A work log from March keeps
-- naming the sub-task it was filed against forever. Hard deletion of a referenced master is
-- refused by the foreign keys themselves - there is deliberately no ON DELETE CASCADE anywhere
-- below, so `DELETE FROM project` where effort exists raises rather than quietly erasing a
-- quarter of somebody's timesheet.
--
-- NOT DESTRUCTIVE. Two new tables, four new columns, six new constraints, one view. No column is
-- dropped, no data rewritten, no default backfilled into existing rows beyond `active = true`,
-- which is the only value that preserves current behaviour.

-- Atomic, like every migration from 0017 onward. Without this the runner autocommits
-- each statement (scripts/migrate.mjs: "The migration file supplies its own
-- BEGIN/COMMIT when it wants one"), so a failure part-way leaves the schema changed
-- and schema_migration with no row - and the next run then fails on "already exists".
BEGIN;

-- ---------------------------------------------------------------- sub-project

CREATE TABLE sub_project (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id   UUID NOT NULL REFERENCES project(id),
    code         TEXT,
    name         TEXT NOT NULL,
    active       BOOLEAN NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_sub_project_name    CHECK (btrim(name) <> ''),
    CONSTRAINT uq_sub_project_code    UNIQUE (project_id, code),
    -- The FK target for task.(sub_project_id, project_id). `id` is already unique on its own;
    -- this pair exists so a task cannot claim a sub-project from a different project.
    CONSTRAINT uq_sub_project_project UNIQUE (id, project_id)
);

CREATE INDEX ix_sub_project_project ON sub_project (project_id);

COMMENT ON TABLE sub_project IS
    'A division of a project - phase, workstream or module. Optional: a task may hang directly '
    'off its project (task.sub_project_id IS NULL), which is what every task did before 0027.';

COMMENT ON COLUMN sub_project.active IS
    'Master-data lifecycle. false = retired, not selectable for NEW work logs. Existing work logs '
    'that reference it stay readable and keep displaying this name - see the header.';

-- ---------------------------------------------------------------- task: parent + lifecycle

ALTER TABLE task ADD COLUMN sub_project_id UUID;
ALTER TABLE task ADD COLUMN active BOOLEAN NOT NULL DEFAULT true;

-- The composite FK is what stops a task being attached to an unrelated parent. MATCH SIMPLE, so
-- a NULL sub_project_id skips it and the task belongs directly to its project.
ALTER TABLE task
    ADD CONSTRAINT fk_task_sub_project
        FOREIGN KEY (sub_project_id, project_id)
        REFERENCES sub_project (id, project_id);

-- FK targets for work_log_entry. Both pairs are trivially unique because `id` is the primary key;
-- PostgreSQL still requires the constraint to exist before it will accept the reference.
ALTER TABLE task ADD CONSTRAINT uq_task_project     UNIQUE (id, project_id);
ALTER TABLE task ADD CONSTRAINT uq_task_sub_project UNIQUE (id, sub_project_id);

CREATE INDEX ix_task_sub_project ON task (sub_project_id);

COMMENT ON COLUMN task.sub_project_id IS
    'The sub-project this task belongs to, or NULL for a task directly under the project. '
    'Constrained by fk_task_sub_project to a sub-project OF THE SAME project.';

COMMENT ON COLUMN task.active IS
    'Master-data lifecycle, distinct from `status`. status = done means the work finished; '
    'active = false means the record is retired and must not appear in new work-log selection. '
    'A done task can still be active while the last effort is logged against it.';

-- ---------------------------------------------------------------- sub-task

CREATE TABLE sub_task (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id      UUID NOT NULL REFERENCES task(id),
    code         TEXT,
    title        TEXT NOT NULL,
    active       BOOLEAN NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_sub_task_title  CHECK (btrim(title) <> ''),
    CONSTRAINT uq_sub_task_code   UNIQUE (task_id, code),
    -- FK target for work_log_entry.(sub_task_id, task_id).
    CONSTRAINT uq_sub_task_task   UNIQUE (id, task_id)
);

CREATE INDEX ix_sub_task_task ON sub_task (task_id);

COMMENT ON TABLE sub_task IS
    'The finest unit effort can be logged against. Optional on a work log entry: entries created '
    'before 0027 have sub_task_id IS NULL and remain valid.';

-- ---------------------------------------------------------------- the entry itself

ALTER TABLE work_log_entry ADD COLUMN sub_task_id UUID;

-- Closes the pre-existing gap: the task must belong to the project the entry names.
ALTER TABLE work_log_entry
    ADD CONSTRAINT fk_work_log_entry_task_project
        FOREIGN KEY (task_id, project_id)
        REFERENCES task (id, project_id);

-- And the sub-task must belong to the task the entry names.
ALTER TABLE work_log_entry
    ADD CONSTRAINT fk_work_log_entry_sub_task
        FOREIGN KEY (sub_task_id, task_id)
        REFERENCES sub_task (id, task_id);

-- MATCH SIMPLE means the FK above is not checked when task_id IS NULL, which would let an entry
-- name a sub-task while naming no task. The hierarchy has no such shape.
ALTER TABLE work_log_entry
    ADD CONSTRAINT ck_work_log_entry_sub_task_needs_task
        CHECK (sub_task_id IS NULL OR task_id IS NOT NULL);

CREATE INDEX ix_work_log_entry_sub_task ON work_log_entry (sub_task_id);

COMMENT ON COLUMN work_log_entry.sub_task_id IS
    'Optional finest-grained attribution. There is deliberately no sub_project_id column: the '
    'sub-project is a property of the task and is recovered through v_work_hierarchy, so it '
    'cannot disagree with the task. See 0027 header and DEC-113.';

-- ---------------------------------------------------------------- the hierarchy, flattened

-- One place that knows how the four levels join and what "selectable" means, so the cascading
-- selectors, the master-data screen and the effort reports cannot drift apart on either question.
CREATE VIEW v_work_hierarchy AS
SELECT p.id                AS project_id,
       p.code              AS project_code,
       p.name              AS project_name,
       p.status            AS project_status,
       sp.id               AS sub_project_id,
       sp.code             AS sub_project_code,
       sp.name             AS sub_project_name,
       sp.active           AS sub_project_active,
       t.id                AS task_id,
       t.code              AS task_code,
       t.title             AS task_title,
       t.status            AS task_status,
       t.active            AS task_active,
       st.id               AS sub_task_id,
       st.code             AS sub_task_code,
       st.title            AS sub_task_title,
       st.active           AS sub_task_active,
       -- Selectable for NEW effort: every level on the path has to be usable. A retired
       -- sub-project retires the tasks beneath it without each one having to be touched.
       (p.status = 'active'
        AND coalesce(sp.active, true)
        AND coalesce(t.active, true)
        AND coalesce(st.active, true)) AS selectable
-- Driven from `task`, with the sub-project reached THROUGH it. The obvious alternative - joining
-- sub_project to the project and task to both - is wrong: a task sitting directly under a project
-- (sub_project_id IS NULL) then matches no sub-project row, so it disappears from the view
-- entirely for any project that also happens to have sub-projects. Which is precisely the case
-- the nullable parent exists to support.
  FROM project p
  LEFT JOIN task        t  ON t.project_id = p.id
  LEFT JOIN sub_project sp ON sp.id = t.sub_project_id
  LEFT JOIN sub_task    st ON st.task_id = t.id;

COMMENT ON VIEW v_work_hierarchy IS
    'Project -> Sub-project -> Task -> Sub-task flattened for effort attribution and for the '
    'cascading work-log selectors, with one authoritative `selectable` column. Task-centric: a '
    'project with no tasks appears with NULL task columns, but a SUB-PROJECT with no tasks does '
    'not appear - the master-data screen composes its tree from the four tables directly, because '
    'it must show empty branches and this view must not duplicate tasks.';

COMMIT;
