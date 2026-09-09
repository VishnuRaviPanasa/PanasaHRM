-- =============================================================================
-- 0023  Fix: fn_task_status's subject column must be the one the scope graph renders
-- =============================================================================
--
-- THE DEFECT, found by calling the endpoint as three different roles rather than by reading it.
--
-- `GET /reports/tasks` returned 200 for HR and **500 for an employee and a manager**:
--
--     error: column t.assignee_employee_id does not exist
--
-- HR passed because HR's scope predicate is ALLOW_ALL, which renders as literal `true` and names
-- no column at all. Every scoped caller failed. A test that only exercised HR - the role whose
-- report is most interesting to look at - would have declared this feature working.
--
-- THE CAUSE is a contract between two files that nothing was checking. `packages/authz` decides
-- which column identifies the employee a row is about, and for the `task` resource that is
-- `assignee_employee_id`, because that is the column on the `task` TABLE. 0022's function
-- published its subject as `employee_id` instead, copying the shape of the other report functions
-- where the two names happen to coincide. So the predicate composed correctly and referred to a
-- column that did not exist in the function's output.
--
-- The map is right and the function was wrong. Changing `employeeColumn('task')` to `employee_id`
-- would have made this query work and broken every future query against the real table, which
-- has no `employee_id` column. So the function conforms to the resource, not the reverse: the
-- contract for a reporting function is that its subject column is named EXACTLY as the
-- authorization layer renders it, and tasks are the first resource where that is not
-- `employee_id`.
--
-- DROP AND CREATE, NOT CREATE OR REPLACE: replacing a function cannot rename its OUT parameters.
-- Nothing is lost - a function holds no data, no view or constraint depends on this one, and it
-- was introduced in 0022 in this same session. Rule 13's `-- IRREVERSIBLE:` marker is therefore
-- not warranted: no row is destroyed and the previous definition is recoverable from 0022.
--
-- Forward-only (DEC-011): 0022 is applied and checksum-enforced (DEC-012), so it is left exactly
-- as it shipped and corrected here, the same way 0015 corrected 0014 and 0021 corrected 0020.
--
-- Class C. Verified by testing/db/0022_task_reporting.verify.sql, which now asserts the column
-- NAME as well as the counts - the check that was missing.
-- =============================================================================

BEGIN;

DROP FUNCTION IF EXISTS fn_task_status(integer);

CREATE FUNCTION fn_task_status(p_due_within_days integer DEFAULT 7)
RETURNS TABLE (
    -- NAMED FOR THE COLUMN ON `task`, not for the convention the other report functions follow.
    -- `packages/authz` renders `<alias>.assignee_employee_id` for this resource; if this OUT
    -- parameter is renamed, every scoped caller gets a 500 and HR alone keeps working.
    assignee_employee_id uuid,
    open_tasks           integer,
    in_progress          integer,
    blocked              integer,
    done_tasks           integer,
    cancelled_tasks      integer,
    overdue              integer,
    due_soon             integer,
    no_due_date          integer
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
    'governs work logs, because a task assigned to a person is a fact about that person. The '
    'subject column is `assignee_employee_id`, matching the column on `task` that '
    'packages/authz renders; publishing it as `employee_id` (0022) made every SCOPED caller fail '
    'with a missing column while HR, whose predicate is literal `true`, worked fine. Tasks with '
    'no assignee are absent BY CONSTRUCTION: there is no subject to compare against a subtree, '
    'so they are reported by fn_project_task_status instead, under project membership. Overdue is '
    'measured against fn_business_date(), never now(): due_on is a DATE, and comparing it to an '
    'instant would make today''s work overdue at 05:30 local time.';

COMMIT;
