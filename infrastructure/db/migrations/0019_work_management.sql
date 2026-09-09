-- =============================================================================
-- 0019  Daily work management: project membership over time, and the timesheet FSM
-- =============================================================================
--
-- Module 9. Most of this module already existed (0010): projects, tasks, work logs with effort
-- in INTEGER MINUTES (ADR-0016), timesheet periods with a database-level write lock, and
-- `v_work_attendance_variance` which flags a mismatch between attended hours and logged effort
-- WITHOUT correcting either side (ADR-0015). Those parts stay untouched.
--
-- What was missing splits into two real problems and some smaller ones.
--
-- PROBLEM 1: PROJECT-LEVEL AUTHORIZATION HAD NO TIME DIMENSION.  (closes OR-17)
--
-- `ai/context/rbac-rules.md` names `project_member` as one of the two authorization scope graphs
-- and asserts it is effective-dated. It was not: `UNIQUE (project_id, employee_id)` and a
-- `created_at`, nothing more. So there were exactly two possible behaviours, and both are wrong:
--
--   * leave the row      -> a contributor rolled off a project keeps access to it forever;
--   * delete the row     -> they lose access to the effort THEY logged, and last quarter's
--                           project report silently changes because a member vanished from it.
--
-- `packages/authz` had to document this as a known gap and ignore the as-of date it was handed.
-- Now membership is a period, the project graph decays like the reporting graph, and
-- `fn_is_project_member_asof` answers the question the authorization layer was already asking.
--
-- PROBLEM 2: THE TIMESHEET STATUS WAS A BARE `text` COLUMN.
--
-- Exactly the weakness `employee.status` had before 0014: four legal values, a CHECK, and
-- nothing governing the moves between them. So the same fix, deliberately the same shape - a
-- transition table as DATA with a composite foreign key, plus an append-only log. The states
-- the module needs are draft / submitted / under_review / approved / returned, and the
-- review-and-correct cycle the requirement describes as
--
--     SUBMITTED -> REJECTED -> CORRECTED -> RESUBMITTED
--
-- is modelled as EVENTS over those states rather than as four more states: `return`, `correct`,
-- then `submit` again. A resubmitted timesheet is not in a different condition from a submitted
-- one - it IS submitted - and the transition log is what records that it happened twice. Adding
-- `corrected` and `resubmitted` as states would mean every downstream query had to know that
-- three different values all mean "waiting for a manager".
--
-- NO SELF-APPROVAL, STRUCTURALLY. `ai/context/rbac-rules.md` structural-integrity item 1 asks
-- for `CHECK (decided_by <> subject)` "backed by a trigger asserting the denormalised subject
-- still matches its parent". Both are here. The application also refuses it, but a service check
-- is bypassed by the next code path, a job or an admin script.
--
-- APPROVED IS TERMINAL. There is no transition out of it. The existing lock already says why:
-- "a submitted or approved period is corrected by an adjustment, never by editing history in
-- place." Re-opening an approved period would make that promise false.
--
-- TASKS DELIBERATELY GET NO FSM. They gain an assignee, a description, a due date and closure
-- coherence, but their status stays a CHECK. A task moving from open to done carries no
-- approval, no audit obligation and no money - the machinery that earns its place on employment
-- lifecycle and timesheets would be ceremony here.
--
-- Class C. Verified by testing/db/0019_work_management.verify.sql.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Project membership becomes effective-dated  (OR-17)
-- -----------------------------------------------------------------------------

ALTER TABLE project_member
    ADD COLUMN valid_from date,
    ADD COLUMN valid_to   date,
    ADD COLUMN reason     text;

-- Backfill: membership began when the row was created, or when the project started if that is
-- earlier. Without this the generated period column cannot be added NOT NULL.
UPDATE project_member pm
   SET valid_from = LEAST(
         pm.created_at::date,
         COALESCE((SELECT p.started_on FROM project p WHERE p.id = pm.project_id),
                  pm.created_at::date))
 WHERE pm.valid_from IS NULL;

ALTER TABLE project_member
    ALTER COLUMN valid_from SET NOT NULL,
    ADD COLUMN valid_period daterange GENERATED ALWAYS AS
        (daterange(valid_from, valid_to, '[)')) STORED;

ALTER TABLE project_member
    -- Mandatory, never optional (temporal-data-rules rule 1): a zero-length period slips past
    -- the exclusion constraint because `empty && anything` is false, then matches no as-of
    -- query - so the member silently disappears from every project report.
    ADD CONSTRAINT ck_project_member_not_empty
        CHECK (NOT isempty(daterange(valid_from, valid_to, '[)')));

-- The old uniqueness was "one row per person per project, ever". That is exactly what made
-- roll-off unrepresentable. Replaced by "no OVERLAPPING membership periods", which permits
-- somebody leaving a project and rejoining it later.
ALTER TABLE project_member DROP CONSTRAINT uq_project_member;

ALTER TABLE project_member
    ADD CONSTRAINT ex_project_member_no_overlap EXCLUDE USING gist (
        project_id WITH =, employee_id WITH =, valid_period WITH &&);

CREATE INDEX ix_project_member_asof ON project_member (project_id, valid_period);
CREATE INDEX ix_project_member_employee ON project_member (employee_id, valid_period);

COMMENT ON TABLE project_member IS
    'Effective-dated project membership - one of ADR-0005''s two authorization scope graphs. '
    'Rolling somebody off a project CLOSES their period; it never deletes the row, because the '
    'effort they logged is attributed through it and last quarter''s report must not change.';

-- Rule 3 rails. Closing an open membership is allowed; rewriting a past one is not.
CREATE TRIGGER tg_project_member_immutable_history
    BEFORE UPDATE OR DELETE ON project_member
    FOR EACH ROW EXECUTE FUNCTION fn_block_historical_mutation();
ALTER TABLE project_member ENABLE ALWAYS TRIGGER tg_project_member_immutable_history;

CREATE TRIGGER tg_project_member_no_backdate
    BEFORE INSERT ON project_member
    FOR EACH ROW EXECUTE FUNCTION fn_block_backdated_period();
ALTER TABLE project_member ENABLE ALWAYS TRIGGER tg_project_member_no_backdate;

CREATE TRIGGER tg_project_member_no_truncate
    BEFORE TRUNCATE ON project_member
    FOR EACH STATEMENT EXECUTE FUNCTION fn_block_mutation();
ALTER TABLE project_member ENABLE ALWAYS TRIGGER tg_project_member_no_truncate;

-- The resolvers the authorization layer needs. `packages/authz` already reserved the date
-- parameter for these.
CREATE OR REPLACE FUNCTION fn_project_members_asof(p_project uuid, p_on date)
RETURNS TABLE (employee_id uuid, role text)
LANGUAGE sql STABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
    SELECT pm.employee_id, pm.role
      FROM public.project_member pm
     WHERE pm.project_id = p_project AND pm.valid_period @> p_on;
$$;

CREATE OR REPLACE FUNCTION fn_employee_projects_asof(p_employee uuid, p_on date)
RETURNS TABLE (project_id uuid, role text)
LANGUAGE sql STABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
    SELECT pm.project_id, pm.role
      FROM public.project_member pm
     WHERE pm.employee_id = p_employee AND pm.valid_period @> p_on;
$$;

/**
 * Was this person a member of this project on this date, optionally in one of these roles?
 *
 * This is the project scope graph's whole question. `p_roles` NULL means any role - the caller
 * passes ARRAY['lead','project_manager'] where a lead-only privilege is meant.
 */
CREATE OR REPLACE FUNCTION fn_is_project_member_asof(
    p_employee uuid, p_project uuid, p_on date, p_roles text[] DEFAULT NULL)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.project_member pm
         WHERE pm.employee_id = p_employee
           AND pm.project_id = p_project
           AND pm.valid_period @> p_on
           AND (p_roles IS NULL OR pm.role = ANY (p_roles)));
$$;

-- -----------------------------------------------------------------------------
-- 2. Projects and tasks gain the fields the module asks for
-- -----------------------------------------------------------------------------

ALTER TABLE project
    ADD COLUMN description text,
    ADD COLUMN owner_employee_id uuid REFERENCES employee(id),
    ADD COLUMN ended_on date,
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE project
    ADD CONSTRAINT ck_project_dates
        CHECK (ended_on IS NULL OR started_on IS NULL OR ended_on >= started_on),
    -- A closed project has an end date. Without this, "closed" is a label with no date behind
    -- it and no report can say when the work stopped.
    ADD CONSTRAINT ck_project_closed_has_date
        CHECK (status <> 'closed' OR ended_on IS NOT NULL);

CREATE TRIGGER tg_project_updated_at
    BEFORE UPDATE ON project
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

COMMENT ON COLUMN project.owner_employee_id IS
    'Accountable for the project commercially. `manager_id` runs it day to day. They are often '
    'the same person and sometimes deliberately not, which is why there are two columns.';

ALTER TABLE task
    ADD COLUMN description text,
    ADD COLUMN assignee_employee_id uuid REFERENCES employee(id),
    ADD COLUMN created_by uuid REFERENCES employee(id),
    ADD COLUMN due_on date,
    ADD COLUMN closed_at timestamptz,
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- BACKFILL BEFORE CONSTRAINING. Existing rows already carry status='done' with no closure
-- time, so ck_task_closed_coherent below would refuse to apply. (Third time this pattern has
-- bitten: 0016 and 0017 both failed first on exactly this.)
--
-- `created_at` is the only timestamp these rows have, so it stands in for a closure time that
-- was never recorded. It is a backfill approximation, not a fact - which is why the column is
-- NOT NULL only by way of the coherence CHECK rather than by default.
UPDATE task SET closed_at = created_at
 WHERE status IN ('done', 'cancelled') AND closed_at IS NULL;

-- Widen the status set: a task that is stuck or abandoned is neither open nor done, and
-- recording it as either loses the distinction a manager view needs.
ALTER TABLE task DROP CONSTRAINT ck_task_status;
ALTER TABLE task
    ADD CONSTRAINT ck_task_status CHECK (status IN
        ('open', 'in_progress', 'blocked', 'done', 'cancelled')),
    -- Closure coherence: a terminal task has a closure time, a live one does not.
    ADD CONSTRAINT ck_task_closed_coherent
        CHECK ((status IN ('done', 'cancelled')) = (closed_at IS NOT NULL));

CREATE INDEX ix_task_assignee ON task (assignee_employee_id)
    WHERE assignee_employee_id IS NOT NULL AND status NOT IN ('done', 'cancelled');
CREATE INDEX ix_task_due ON task (due_on)
    WHERE due_on IS NOT NULL AND status NOT IN ('done', 'cancelled');

CREATE TRIGGER tg_task_updated_at
    BEFORE UPDATE ON task
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

/**
 * A task may only be assigned to somebody who is on the project on the day of assignment.
 *
 * Enforced here rather than in a service method because a task assigned to a non-member is the
 * kind of row that makes a project report inexplicable, and every write path would otherwise
 * have to remember the rule.
 */
CREATE OR REPLACE FUNCTION fn_task_assignee_is_member()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
BEGIN
    IF NEW.assignee_employee_id IS NULL THEN RETURN NEW; END IF;
    IF NOT public.fn_is_project_member_asof(
            NEW.assignee_employee_id, NEW.project_id, public.fn_business_date()) THEN
        RAISE EXCEPTION
            'the assignee is not a member of this project today'
            USING ERRCODE = 'restrict_violation',
                  HINT = 'Add them to the project first; membership is effective-dated.';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_task_assignee_member
    BEFORE INSERT OR UPDATE OF assignee_employee_id, project_id ON task
    FOR EACH ROW EXECUTE FUNCTION fn_task_assignee_is_member();
ALTER TABLE task ENABLE ALWAYS TRIGGER tg_task_assignee_member;

-- -----------------------------------------------------------------------------
-- 3. The timesheet state machine, as data
-- -----------------------------------------------------------------------------

CREATE TABLE timesheet_status_transition (
    event_type  text NOT NULL,
    from_status text NOT NULL,
    to_status   text NOT NULL,

    /** Decision events must be taken by somebody other than the subject. */
    is_decision boolean NOT NULL DEFAULT false,

    PRIMARY KEY (event_type, from_status),
    CONSTRAINT uq_tst_triple UNIQUE (event_type, from_status, to_status),
    CONSTRAINT ck_tst_from CHECK (from_status IN
        ('draft', 'submitted', 'under_review', 'approved', 'returned')),
    CONSTRAINT ck_tst_to CHECK (to_status IN
        ('draft', 'submitted', 'under_review', 'approved', 'returned'))
);

COMMENT ON TABLE timesheet_status_transition IS
    'Legal timesheet moves, as data (Rule 11). Same shape as employment_status_transition in '
    '0014, deliberately: timesheet_transition carries a composite FK here, so an illegal move '
    'cannot be inserted rather than being refused by a service method somebody forgets to call.';

INSERT INTO timesheet_status_transition (event_type, from_status, to_status, is_decision) VALUES
    -- The employee's own moves.
    ('submit',       'draft',        'submitted',    false),
    ('correct',      'returned',     'draft',        false),
    -- Submitting again after a correction. The SAME target as `submit`; the log is what records
    -- that this was a resubmission rather than a first attempt.
    ('submit',       'returned',     'submitted',    false),

    -- The reviewer's moves. `under_review` is optional - a manager may approve or return
    -- straight from `submitted` - because forcing a review step on a one-line timesheet is
    -- ceremony that gets worked around.
    ('start_review', 'submitted',    'under_review', true),
    ('approve',      'submitted',    'approved',     true),
    ('approve',      'under_review', 'approved',     true),
    ('return',       'submitted',    'returned',     true),
    ('return',       'under_review', 'returned',     true);

/*
 * The append-only transition log.
 *
 * `subject_employee_id` is denormalised from the parent SO THAT the no-self-approval rule can be
 * a CHECK. rbac-rules structural-integrity item 1 asks for exactly this, plus a trigger
 * asserting the denormalised value still matches its parent - because a denormalised column that
 * nothing verifies is a constraint on a lie.
 */
CREATE TABLE timesheet_transition (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    timesheet_period_id uuid NOT NULL REFERENCES timesheet_period(id),

    event_type          text NOT NULL,
    from_status         text NOT NULL,
    to_status           text NOT NULL,

    actor_employee_id   uuid NOT NULL REFERENCES employee(id),
    subject_employee_id uuid NOT NULL REFERENCES employee(id),

    note                text,
    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT fk_timesheet_transition_move
        FOREIGN KEY (event_type, from_status, to_status)
        REFERENCES timesheet_status_transition (event_type, from_status, to_status),

    -- NO SELF-APPROVAL. Applies to any decision event, so a manager cannot approve or return
    -- their own timesheet whatever roles they also hold.
    CONSTRAINT ck_timesheet_no_self_decision CHECK (
        event_type IN ('submit', 'correct') OR actor_employee_id <> subject_employee_id),

    -- The employee's own moves must be made BY the employee.
    CONSTRAINT ck_timesheet_own_moves CHECK (
        event_type NOT IN ('submit', 'correct') OR actor_employee_id = subject_employee_id),

    -- A return should say why. An unexplained rejection is unactionable.
    CONSTRAINT ck_timesheet_return_note CHECK (event_type <> 'return' OR note IS NOT NULL)
);

CREATE INDEX ix_timesheet_transition_period
    ON timesheet_transition (timesheet_period_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- 4. Guards on the transition log
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_timesheet_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
DECLARE v_status text; v_subject uuid;
BEGIN
    SELECT tp.status, tp.employee_id INTO v_status, v_subject
      FROM public.timesheet_period tp WHERE tp.id = NEW.timesheet_period_id;

    -- The denormalised subject must still match its parent (rbac-rules item 1). Without this the
    -- no-self-approval CHECK constrains whatever the caller chose to write.
    IF NEW.subject_employee_id <> v_subject THEN
        RAISE EXCEPTION
            'subject_employee_id does not match the timesheet''s owner'
            USING ERRCODE = 'restrict_violation',
                  HINT = 'The no-self-approval CHECK relies on this column being true.';
    END IF;

    -- The move must start from where the timesheet actually is.
    IF NEW.from_status <> v_status THEN
        RAISE EXCEPTION
            'this timesheet is %, so a transition from % cannot apply', v_status, NEW.from_status
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_timesheet_transition_guard
    BEFORE INSERT ON timesheet_transition
    FOR EACH ROW EXECUTE FUNCTION fn_timesheet_transition_guard();
ALTER TABLE timesheet_transition ENABLE ALWAYS TRIGGER tg_timesheet_transition_guard;

/** Materialise the new status onto the period, so nothing reads the log to find the state. */
CREATE OR REPLACE FUNCTION fn_timesheet_transition_apply()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
BEGIN
    UPDATE public.timesheet_period tp
       SET status = NEW.to_status,
           submitted_at = CASE WHEN NEW.to_status = 'submitted' THEN now()
                               WHEN NEW.to_status = 'draft' THEN NULL
                               ELSE tp.submitted_at END,
           decided_at = CASE WHEN NEW.to_status IN ('approved', 'returned') THEN now()
                             WHEN NEW.to_status IN ('draft', 'submitted') THEN NULL
                             ELSE tp.decided_at END,
           decided_by = CASE WHEN NEW.to_status IN ('approved', 'returned')
                                 THEN NEW.actor_employee_id
                             WHEN NEW.to_status IN ('draft', 'submitted') THEN NULL
                             ELSE tp.decided_by END,
           return_note = CASE WHEN NEW.event_type = 'return' THEN NEW.note
                              WHEN NEW.to_status = 'submitted' THEN NULL
                              ELSE tp.return_note END
     WHERE tp.id = NEW.timesheet_period_id;
    RETURN NULL;
END;
$$;

CREATE TRIGGER tg_timesheet_transition_apply
    AFTER INSERT ON timesheet_transition
    FOR EACH ROW EXECUTE FUNCTION fn_timesheet_transition_apply();
ALTER TABLE timesheet_transition ENABLE ALWAYS TRIGGER tg_timesheet_transition_apply;

-- Append-only.
CREATE TRIGGER tg_timesheet_transition_immutable
    BEFORE UPDATE OR DELETE ON timesheet_transition
    FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();
ALTER TABLE timesheet_transition ENABLE ALWAYS TRIGGER tg_timesheet_transition_immutable;

CREATE TRIGGER tg_timesheet_transition_no_truncate
    BEFORE TRUNCATE ON timesheet_transition
    FOR EACH STATEMENT EXECUTE FUNCTION fn_block_mutation();
ALTER TABLE timesheet_transition ENABLE ALWAYS TRIGGER tg_timesheet_transition_no_truncate;

-- -----------------------------------------------------------------------------
-- 5. The new state has to lock like the others
-- -----------------------------------------------------------------------------

ALTER TABLE timesheet_period DROP CONSTRAINT ck_timesheet_status;
ALTER TABLE timesheet_period
    ADD CONSTRAINT ck_timesheet_status CHECK (status IN
        ('draft', 'submitted', 'under_review', 'approved', 'returned'));

/*
 * `under_review` MUST lock. The original guard named 'submitted' and 'approved' only, so adding
 * a state between them would have quietly opened a window where an employee could edit effort
 * while their manager was reading it.
 *
 * `returned` deliberately does NOT lock: the whole point of returning a timesheet is that the
 * employee can fix it.
 */
CREATE OR REPLACE FUNCTION fn_work_log_period_lock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
DECLARE v_status TEXT; v_log UUID;
BEGIN
    v_log := CASE WHEN TG_OP = 'DELETE' THEN OLD.work_log_id ELSE NEW.work_log_id END;

    SELECT tp.status INTO v_status
      FROM public.work_log wl
      JOIN public.timesheet_period tp ON tp.id = wl.timesheet_period_id
     WHERE wl.id = v_log;

    IF v_status IN ('submitted', 'under_review', 'approved') THEN
        RAISE EXCEPTION
            'the timesheet period for this work log is % and is locked', v_status
            USING ERRCODE = 'restrict_violation',
                  HINT = 'A submitted, under-review or approved period is corrected by an '
                         'adjustment, never by editing history in place. A RETURNED period is '
                         'editable - that is what returning it is for.';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

-- -----------------------------------------------------------------------------
-- 6. Reporting: weekly, monthly, per project, per team
-- -----------------------------------------------------------------------------
--
-- All of these return INTEGER MINUTES (ADR-0016 / Rule 4). Conversion to hours is a display
-- concern and happens once, in the UI - never in storage and never in an aggregate, because
-- rounding minutes to hours and then summing loses time that payroll would later look for.

CREATE OR REPLACE FUNCTION fn_effort_by_project(
    p_employee uuid, p_from date, p_to date)
RETURNS TABLE (project_id uuid, project_code text, project_name text, minutes bigint)
LANGUAGE sql STABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
    SELECT p.id, p.code, p.name, sum(wle.minutes)::bigint
      FROM public.work_log wl
      JOIN public.work_log_entry wle ON wle.work_log_id = wl.id
      JOIN public.project p ON p.id = wle.project_id
     WHERE wl.employee_id = p_employee
       AND wl.work_date >= p_from AND wl.work_date <= p_to
     GROUP BY p.id, p.code, p.name;
$$;

CREATE OR REPLACE FUNCTION fn_monthly_effort(p_employee uuid, p_year int, p_month int)
RETURNS TABLE (work_date date, minutes bigint)
LANGUAGE sql STABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
    SELECT wl.work_date, sum(wle.minutes)::bigint
      FROM public.work_log wl
      JOIN public.work_log_entry wle ON wle.work_log_id = wl.id
     WHERE wl.employee_id = p_employee
       AND wl.work_date >= make_date(p_year, p_month, 1)
       AND wl.work_date < (make_date(p_year, p_month, 1) + INTERVAL '1 month')::date
     GROUP BY wl.work_date;
$$;

/**
 * Effort on a project over a window, attributed per contributor.
 *
 * Reads membership AS OF each work date, so somebody who left the project mid-window still
 * appears for the days they were on it. Attributing today's membership to last quarter's effort
 * is precisely the error effective-dating exists to prevent.
 */
CREATE OR REPLACE FUNCTION fn_project_effort(p_project uuid, p_from date, p_to date)
RETURNS TABLE (employee_id uuid, minutes bigint, was_member boolean)
LANGUAGE sql STABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
    SELECT wl.employee_id,
           sum(wle.minutes)::bigint,
           bool_or(public.fn_is_project_member_asof(wl.employee_id, p_project, wl.work_date))
      FROM public.work_log wl
      JOIN public.work_log_entry wle ON wle.work_log_id = wl.id
     WHERE wle.project_id = p_project
       AND wl.work_date >= p_from AND wl.work_date <= p_to
     GROUP BY wl.employee_id;
$$;

COMMENT ON FUNCTION fn_project_effort(uuid, date, date) IS
    '`was_member` is false when effort was logged against a project the person was not a member '
    'of on that date. It is REPORTED, not corrected - the same principle as ADR-0015''s '
    'attendance-versus-effort variance: a reconciliation finding is not a licence to rewrite '
    'either dataset.';

-- -----------------------------------------------------------------------------
-- 7. Grants
-- -----------------------------------------------------------------------------

GRANT INSERT, UPDATE ON project                     TO hrm_app;
GRANT INSERT, UPDATE ON task                        TO hrm_app;
GRANT INSERT, UPDATE ON project_member              TO hrm_app;  -- close a period, never delete
GRANT INSERT         ON timesheet_transition        TO hrm_app;
GRANT SELECT         ON timesheet_status_transition TO hrm_app;

COMMIT;
