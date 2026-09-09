-- =============================================================================
-- 0022  Task reporting
-- =============================================================================
--
-- Module 14 names "Tasks" as a reporting area, and it was the one item on that list with no
-- report behind it. Writing it turned up something the other reports did not have to face.
--
-- A TASK ANSWERS TO BOTH SCOPE GRAPHS, AND THAT IS WHY THERE ARE TWO FUNCTIONS.
--
-- ADR-0005 has exactly two graphs and DEC-045 records why merging them is dangerous: it is how a
-- project lead ends up reading somebody's disciplinary file. Every resource so far has fallen
-- cleanly on one side - a work log is about a PERSON (`work.log.read` uses the reporting graph),
-- a project is about WORK (`work.project.read` uses project membership). A task is the first
-- resource that is genuinely both: it lives in a project AND is assigned to a person.
--
-- The resolution is not a third graph and not a merged one. It is that "tasks by assignee" and
-- "tasks by project" are two different QUESTIONS, each already answered by an existing graph:
--
--   fn_task_status        keyed on the ASSIGNEE  -> reporting graph, exactly like work logs
--   fn_project_task_status keyed on the PROJECT  -> project membership, exactly like effort
--
-- AND THE SECOND FUNCTION IS NOT OPTIONAL, because of what the data actually looks like.
--
-- Every task in this database has `assignee_employee_id IS NULL`. A per-assignee report alone
-- would therefore have returned zero rows to every caller including HR, while nine real tasks
-- sat in three projects - a report that is empty for a reason nobody can see. Worse, "9 tasks
-- and not one of them assigned to anybody" is precisely the operational finding a manager wants
-- from a task report, so dropping unassigned tasks would discard the most useful row on the
-- screen.
--
-- An unassigned task cannot be attributed to any employee, so the reporting graph LITERALLY
-- cannot answer for it - there is no subject to compare against a subtree. It is not, however,
-- public: an unassigned task in a project the caller cannot see still discloses that the project
-- has work outstanding. So it is reported in the project cut, where membership governs.
--
-- OVERDUE IS COMPUTED AGAINST fn_business_date(), NOT now().
--
-- `due_on` is a DATE (Rule 5) and "overdue" is a question about days, not instants. Comparing a
-- DATE against `now()` would make a task due today flip to overdue at midnight UTC - 05:30 local
-- - so people in Kochi would arrive to find today's work already late. `fn_business_date()` is
-- the same function every attendance and leave derivation uses, so a task's idea of "today"
-- cannot drift from theirs.
--
-- CANCELLED IS NOT DONE, AND NEITHER IS OVERDUE.
--
-- `ck_task_closed_coherent` already ties `closed_at` to the two terminal statuses, so this
-- reports `done` and `cancelled` separately - a cancelled task is not an achievement, and a
-- completion rate that counted it would flatter the numbers. Neither can be overdue: a closed
-- task has stopped consuming time, whatever its due date said.
--
-- Class C. Verified by testing/db/0022_task_reporting.verify.sql.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Per-assignee task posture. Keyed on the employee, so the REPORTING graph filters it.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_task_status(p_due_within_days integer DEFAULT 7)
RETURNS TABLE (
    employee_id     uuid,
    open_tasks      integer,
    in_progress     integer,
    blocked         integer,
    done_tasks      integer,
    cancelled_tasks integer,
    overdue         integer,
    due_soon        integer,
    no_due_date     integer
)
LANGUAGE sql STABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
    -- COUNT(t.id), never COUNT(*): the LEFT JOIN yields one all-NULL row for an employee with no
    -- tasks, and COUNT(*) counts it. That exact mistake shipped in fn_document_compliance and had
    -- to be fixed in 0021, where it reported a pending scan for four documents nobody uploaded.
    SELECT e.id,
           count(t.id) FILTER (WHERE t.status = 'open')::integer,
           count(t.id) FILTER (WHERE t.status = 'in_progress')::integer,
           count(t.id) FILTER (WHERE t.status = 'blocked')::integer,
           count(t.id) FILTER (WHERE t.status = 'done')::integer,
           count(t.id) FILTER (WHERE t.status = 'cancelled')::integer,
           -- Open work only. A closed task has stopped consuming time whatever its due date said.
           count(t.id) FILTER (
                WHERE t.status NOT IN ('done', 'cancelled')
                  AND t.due_on IS NOT NULL
                  AND t.due_on < public.fn_business_date())::integer,
           count(t.id) FILTER (
                WHERE t.status NOT IN ('done', 'cancelled')
                  AND t.due_on IS NOT NULL
                  AND t.due_on >= public.fn_business_date()
                  AND t.due_on <= public.fn_business_date() + p_due_within_days)::integer,
           -- Open work with no date on it at all. Not a failure, but not plannable either, and a
           -- report that showed only overdue and due-soon would imply everything else is fine.
           count(t.id) FILTER (
                WHERE t.status NOT IN ('done', 'cancelled')
                  AND t.due_on IS NULL)::integer
      FROM public.employee e
      LEFT JOIN public.task t ON t.assignee_employee_id = e.id
     GROUP BY e.id;
$$;

COMMENT ON FUNCTION fn_task_status(integer) IS
    'Per-ASSIGNEE task posture, so the reporting scope graph filters it - the same graph that '
    'governs work logs, because a task assigned to a person is a fact about that person. Tasks '
    'with no assignee are absent BY CONSTRUCTION: there is no subject to compare against a '
    'subtree, so they are reported by fn_project_task_status instead, under project membership. '
    'Overdue is measured against fn_business_date(), never now(): due_on is a DATE, and comparing '
    'it to an instant would make today''s work overdue at 05:30 local time.';

-- -----------------------------------------------------------------------------
-- Per-project task posture. Keyed on the project, so PROJECT MEMBERSHIP filters it.
--
-- This is the cut that can see an unassigned task, and the only one that can.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_project_task_status(p_due_within_days integer DEFAULT 7)
RETURNS TABLE (
    project_id      uuid,
    total_tasks     integer,
    unassigned      integer,
    open_tasks      integer,
    in_progress     integer,
    blocked         integer,
    done_tasks      integer,
    cancelled_tasks integer,
    overdue         integer,
    due_soon        integer,
    assignees       integer
)
LANGUAGE sql STABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
    SELECT p.id,
           count(t.id)::integer,
           -- The row this report exists to surface. Every task in the current database is
           -- unassigned, and a per-assignee report alone would have shown nobody nothing.
           count(t.id) FILTER (
                WHERE t.assignee_employee_id IS NULL
                  AND t.status NOT IN ('done', 'cancelled'))::integer,
           count(t.id) FILTER (WHERE t.status = 'open')::integer,
           count(t.id) FILTER (WHERE t.status = 'in_progress')::integer,
           count(t.id) FILTER (WHERE t.status = 'blocked')::integer,
           count(t.id) FILTER (WHERE t.status = 'done')::integer,
           count(t.id) FILTER (WHERE t.status = 'cancelled')::integer,
           count(t.id) FILTER (
                WHERE t.status NOT IN ('done', 'cancelled')
                  AND t.due_on IS NOT NULL
                  AND t.due_on < public.fn_business_date())::integer,
           count(t.id) FILTER (
                WHERE t.status NOT IN ('done', 'cancelled')
                  AND t.due_on IS NOT NULL
                  AND t.due_on >= public.fn_business_date()
                  AND t.due_on <= public.fn_business_date() + p_due_within_days)::integer,
           count(DISTINCT t.assignee_employee_id)::integer
      FROM public.project p
      LEFT JOIN public.task t ON t.project_id = p.id
     GROUP BY p.id;
$$;

COMMENT ON FUNCTION fn_project_task_status(integer) IS
    'Per-PROJECT task posture, filtered by the project membership graph - the same graph that '
    'governs project effort. This is the only cut that can report an UNASSIGNED task: such a task '
    'has no subject, so the reporting graph cannot answer for it, but it is not public either - '
    'an unassigned task discloses that a project has outstanding work. Counts the key, not the '
    'row (0021).';

COMMIT;
