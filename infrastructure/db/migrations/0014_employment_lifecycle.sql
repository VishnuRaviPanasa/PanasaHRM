-- =============================================================================
-- 0014  Employment lifecycle
-- =============================================================================
--
-- Module 1 (Employee & Core HR) asks for: joining, probation, confirmation, transfer,
-- promotion, resignation, termination, employee status/history and organization hierarchy.
--
-- Before this migration the system had `employee.status` with four legal values and NOTHING
-- that moved between them, no record of why or when a move happened, and no way to answer
-- "what was this person's status in March". A status column with no transition mechanism is a
-- field somebody eventually UPDATEs by hand.
--
-- THE SHAPE, and why it is two tables rather than one:
--
--   `employment`       - effective-dated. WHAT YOUR JOB IS over time: department, designation,
--                        reporting manager, employment type. Already exists (0009). A transfer
--                        or promotion closes the open period and opens a new one (Rule 3).
--
--   `employment_event` - append-only. WHAT HAPPENED: the lifecycle fact stream. A confirmation
--                        is not a new assignment period, and a resignation is not an assignment
--                        at all, so neither belongs in `employment`.
--
-- `employee.status` / `confirmed_on` / `resigned_on` / `exited_on` / `exit_type` /
-- `last_working_day` become a MATERIALISED READ MODEL of that log, maintained by trigger. The
-- log is the source of truth; the columns exist so every query does not need a lateral.
-- Because a trigger owns them, the column and the history cannot diverge.
--
-- THE STATE MACHINE IS DATA, NOT CODE (Must-Know Rule 11). `employment_status_transition`
-- holds the legal moves; `employment_event` carries a composite foreign key into it, so an
-- illegal transition is not rejected by a service method that some later code path forgets to
-- call - it is rejected by the database. `ai/context/architecture-principles.md`: prefer a
-- constraint over a rule, a rule over a review, and a review over a hope.
--
-- The triple (event_type, from_status, to_status) is STORED on the event, not looked up at read
-- time, and the FK targets the triple. `employment_status_transition` is mutable reference data;
-- if the legal moves are ever edited, already-recorded history must not be reinterpreted. Same
-- reasoning as the snapshotted `attendance_policy_id` in 0012.
--
-- BITEMPORALITY. `effective_on` is when the event took effect; `recorded_at` is when we learned
-- of it. HR records a resignation days late as a matter of routine, so back-dating needs no
-- opt-in here (contrast DEC-029, which guards effective-dated tables where a back-dated row
-- REWRITES what an already-resolved date returns). Nothing is overwritten in an append-only
-- log - it only grows - and a late entry stays visibly late. What IS forbidden is inserting an
-- event *before* the previous one, which would make the sequence incoherent.
--
-- MUST-KNOW RULE 5. `effective_on` and `last_working_day` are DATE. A last working day that
-- drifted a timezone would change notice-period arithmetic and final settlement.
--
-- DELIBERATELY NOT ADDED: `marital_status`. `ai/context/security-guidelines.md` classifies it
-- SENSITIVE and it is a normal HR field, but it is also the precise input Employee Handbook
-- §1.3.4.5 would consume, and CLAUDE.md's Forbidden Actions bar implementing that clause "in
-- any form". Module 1 does not need it. See docs/requirements/README.md.
--
-- DELIBERATELY NOT COMPUTED: `probation_end_on` is left NULL rather than derived from
-- `employment_policy.probation_months`, which is NULL by DEC-017 - meaning unknown, not zero.
-- A default of zero would silently confirm probationers on their joining date.
--
-- Class C. Verified by testing/db/0014_employment_lifecycle.verify.sql.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. The state machine, as data
-- -----------------------------------------------------------------------------

CREATE TABLE employment_status_transition (
    event_type   text NOT NULL,
    from_status  text NOT NULL,
    to_status    text NOT NULL,

    PRIMARY KEY (event_type, from_status),

    -- The FK target for employment_event. Redundant with the PK for uniqueness purposes, but a
    -- composite FK needs a unique index covering exactly the referenced columns.
    CONSTRAINT uq_est_triple UNIQUE (event_type, from_status, to_status),

    CONSTRAINT ck_est_from CHECK (from_status IN ('pre_boarding','active','on_notice','exited')),
    CONSTRAINT ck_est_to   CHECK (to_status   IN ('pre_boarding','active','on_notice','exited'))
);

COMMENT ON TABLE employment_status_transition IS
    'Legal employee lifecycle moves, as data (Must-Know Rule 11). PRIMARY KEY (event_type, '
    'from_status) makes the machine deterministic: an event applied to a status has exactly one '
    'outcome. employment_event carries a composite FK here, so an illegal transition cannot be '
    'inserted.';

INSERT INTO employment_status_transition (event_type, from_status, to_status) VALUES
    -- Onboarding
    ('joined',                 'pre_boarding', 'active'),

    -- In-service events that do not change status. They are recorded because the DATE and the
    -- REASON are the point, not the status move.
    ('confirmed',              'active',       'active'),
    ('probation_extended',     'active',       'active'),
    ('transferred',            'active',       'active'),
    ('promoted',               'active',       'active'),

    -- Exit paths. Resignation and employer-initiated termination both serve notice first.
    ('resigned',               'active',       'on_notice'),
    ('termination_initiated',  'active',       'on_notice'),
    ('resignation_withdrawn',  'on_notice',    'active'),

    -- Leaving. Normally from notice; directly from active for summary dismissal or death,
    -- where there is no notice period to serve.
    ('exited',                 'on_notice',    'exited'),
    ('exited',                 'active',       'exited');

-- -----------------------------------------------------------------------------
-- 2. The lifecycle log (append-only)
-- -----------------------------------------------------------------------------

CREATE TABLE employment_event (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id       uuid NOT NULL REFERENCES employee(id),

    event_type        text NOT NULL,
    from_status       text NOT NULL,
    to_status         text NOT NULL,

    -- Rule 5: both are DATE. Notice-period and settlement arithmetic reads them.
    effective_on      date NOT NULL,
    last_working_day  date,

    -- Only meaningful on an exit, and mandatory there.
    exit_type         text,

    -- The assignment period this event opened, for a transfer or promotion. NULL otherwise.
    employment_id     uuid REFERENCES employment(id),

    reason            text,
    recorded_by       uuid REFERENCES employee(id),
    recorded_at       timestamptz NOT NULL DEFAULT now(),

    -- The transition must be one the machine allows, as it stood when recorded.
    CONSTRAINT fk_employment_event_transition
        FOREIGN KEY (event_type, from_status, to_status)
        REFERENCES employment_status_transition (event_type, from_status, to_status),

    CONSTRAINT ck_ee_exit_type CHECK (
        (event_type =  'exited' AND exit_type IS NOT NULL) OR
        (event_type <> 'exited' AND exit_type IS NULL)),

    CONSTRAINT ck_ee_exit_type_value CHECK (
        exit_type IS NULL OR exit_type IN
            ('resignation','termination','end_of_contract','retirement','death')),

    CONSTRAINT ck_ee_lwd_not_before_effective CHECK (
        last_working_day IS NULL OR last_working_day >= effective_on),

    -- A notice date belongs to a notice event; nothing else has a last working day to serve.
    CONSTRAINT ck_ee_lwd_only_on_notice_or_exit CHECK (
        last_working_day IS NULL OR
        event_type IN ('resigned','termination_initiated','exited')),

    CONSTRAINT ck_ee_employment_link CHECK (
        employment_id IS NULL OR event_type IN ('joined','transferred','promoted'))
);

COMMENT ON TABLE employment_event IS
    'Append-only employment lifecycle fact stream. effective_on is when it took effect; '
    'recorded_at is when we learned of it. employee.status and its companion date columns are a '
    'materialised read model of this log, maintained by tg_employment_event_apply.';

COMMENT ON COLUMN employment_event.employment_id IS
    'The effective-dated assignment period this event opened (transfer / promotion / joining). '
    'NULL for events that change no assignment, such as a confirmation.';

CREATE INDEX ix_employment_event_employee
    ON employment_event (employee_id, effective_on DESC, recorded_at DESC);

CREATE INDEX ix_employment_event_type
    ON employment_event (event_type, effective_on);

-- -----------------------------------------------------------------------------
-- 3. Sequencing guard - BEFORE INSERT
-- -----------------------------------------------------------------------------
--
-- The composite FK proves the transition is legal in the abstract. It cannot prove the event
-- starts from the status the employee is actually in, nor that the sequence stays ordered.
--
CREATE OR REPLACE FUNCTION fn_employment_event_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
DECLARE
    v_prev_to        text;
    v_prev_effective date;
    v_joined_on      date;
BEGIN
    SELECT ee.to_status, ee.effective_on
      INTO v_prev_to, v_prev_effective
      FROM public.employment_event ee
     WHERE ee.employee_id = NEW.employee_id
     ORDER BY ee.effective_on DESC, ee.recorded_at DESC
     LIMIT 1;

    IF NOT FOUND THEN
        -- An employee's history has to start at the beginning.
        IF NEW.from_status <> 'pre_boarding' THEN
            RAISE EXCEPTION
                USING MESSAGE = format(
                    'the first lifecycle event for an employee must start from pre_boarding, not %L',
                    NEW.from_status),
                      ERRCODE = 'restrict_violation';
        END IF;
    ELSE
        IF NEW.effective_on < v_prev_effective THEN
            RAISE EXCEPTION
                USING MESSAGE = format(
                    'lifecycle events must be recorded in order: %s precedes the previous event on %s',
                    NEW.effective_on, v_prev_effective),
                      ERRCODE = 'restrict_violation';
        END IF;

        IF NEW.from_status <> v_prev_to THEN
            RAISE EXCEPTION
                USING MESSAGE = format(
                    'lifecycle event starts from %L but the employee is currently %L',
                    NEW.from_status, v_prev_to),
                      ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    -- Nothing can happen to someone before they joined.
    SELECT e.joined_on INTO v_joined_on FROM public.employee e WHERE e.id = NEW.employee_id;
    IF NEW.effective_on < v_joined_on THEN
        RAISE EXCEPTION
            USING MESSAGE = format(
                'lifecycle event effective %s precedes the joining date %s',
                NEW.effective_on, v_joined_on),
                  ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_employment_event_guard
    BEFORE INSERT ON employment_event
    FOR EACH ROW EXECUTE FUNCTION fn_employment_event_guard();

ALTER TABLE employment_event ENABLE ALWAYS TRIGGER tg_employment_event_guard;

-- -----------------------------------------------------------------------------
-- 4. Materialise the read model - AFTER INSERT
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_employment_event_apply()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
BEGIN
    UPDATE public.employee e
       SET status = NEW.to_status,

           confirmed_on = CASE WHEN NEW.event_type = 'confirmed'
                               THEN NEW.effective_on ELSE e.confirmed_on END,

           -- A withdrawn resignation clears the notice, it does not leave a stale date behind.
           resigned_on = CASE
                             WHEN NEW.event_type = 'resignation_withdrawn' THEN NULL
                             WHEN NEW.event_type IN ('resigned','termination_initiated')
                                 THEN NEW.effective_on
                             ELSE e.resigned_on
                         END,

           last_working_day = CASE
                                  WHEN NEW.event_type = 'resignation_withdrawn' THEN NULL
                                  WHEN NEW.last_working_day IS NOT NULL
                                      THEN NEW.last_working_day
                                  ELSE e.last_working_day
                              END,

           exited_on = CASE WHEN NEW.event_type = 'exited'
                            THEN NEW.effective_on ELSE e.exited_on END,

           exit_type = CASE WHEN NEW.event_type = 'exited'
                            THEN NEW.exit_type ELSE e.exit_type END
     WHERE e.id = NEW.employee_id;

    RETURN NULL;
END;
$$;

CREATE TRIGGER tg_employment_event_apply
    AFTER INSERT ON employment_event
    FOR EACH ROW EXECUTE FUNCTION fn_employment_event_apply();

ALTER TABLE employment_event ENABLE ALWAYS TRIGGER tg_employment_event_apply;

-- -----------------------------------------------------------------------------
-- 5. Append-only rails
-- -----------------------------------------------------------------------------
-- ENABLE ALWAYS per DEC-030: a trigger created merely ENABLE is silently switched off by
-- session_replication_role = 'replica', which PGOPTIONS carries into any client.

CREATE TRIGGER tg_employment_event_immutable
    BEFORE UPDATE OR DELETE ON employment_event
    FOR EACH ROW EXECUTE FUNCTION fn_block_mutation();

ALTER TABLE employment_event ENABLE ALWAYS TRIGGER tg_employment_event_immutable;

CREATE TRIGGER tg_employment_event_no_truncate
    BEFORE TRUNCATE ON employment_event
    FOR EACH STATEMENT EXECUTE FUNCTION fn_block_mutation();

ALTER TABLE employment_event ENABLE ALWAYS TRIGGER tg_employment_event_no_truncate;

-- -----------------------------------------------------------------------------
-- 6. Employee columns - lifecycle read model, and the ESS profile fields
-- -----------------------------------------------------------------------------
-- Every column below is classified in docs/privacy/data-inventory.md, which CLAUDE.md's
-- Forbidden Actions require before a personal-data column may be added.

ALTER TABLE employee
    -- Lifecycle read model, maintained by tg_employment_event_apply.
    ADD COLUMN confirmed_on               date,
    ADD COLUMN probation_end_on           date,
    ADD COLUMN resigned_on                date,
    ADD COLUMN notice_days                integer,
    ADD COLUMN last_working_day           date,
    ADD COLUMN exit_type                   text,
    ADD COLUMN exit_reason                 text,

    -- Professional / personal detail. PERSONAL class, self-service editable.
    ADD COLUMN personal_email              text,
    ADD COLUMN address_line1               text,
    ADD COLUMN address_line2               text,
    ADD COLUMN city                        text,
    ADD COLUMN state_region                text,
    ADD COLUMN postal_code                 text,
    ADD COLUMN emergency_contact_name      text,
    ADD COLUMN emergency_contact_phone     text,
    ADD COLUMN emergency_contact_relation  text,
    ADD COLUMN blood_group                 text,
    ADD COLUMN updated_at                  timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN employee.exit_reason IS
    'RESTRICTED (docs/privacy/data-inventory.md). Never in a list endpoint, never logged. '
    'Free text that may describe conduct or health.';

COMMENT ON COLUMN employee.probation_end_on IS
    'NULL means unknown, not "no probation" - employment_policy.probation_months is itself NULL '
    'by DEC-017. Callers must refuse to compute entitlement rather than assume zero.';

ALTER TABLE employee
    ADD CONSTRAINT ck_employee_confirmed_after_join
        CHECK (confirmed_on IS NULL OR confirmed_on >= joined_on),

    ADD CONSTRAINT ck_employee_probation_end_after_join
        CHECK (probation_end_on IS NULL OR probation_end_on >= joined_on),

    ADD CONSTRAINT ck_employee_resigned_after_join
        CHECK (resigned_on IS NULL OR resigned_on >= joined_on),

    ADD CONSTRAINT ck_employee_lwd_after_resigned
        CHECK (last_working_day IS NULL OR resigned_on IS NULL
               OR last_working_day >= resigned_on),

    ADD CONSTRAINT ck_employee_notice_days_sane
        CHECK (notice_days IS NULL OR (notice_days >= 0 AND notice_days <= 365)),

    ADD CONSTRAINT ck_employee_exit_type_value
        CHECK (exit_type IS NULL OR exit_type IN
            ('resignation','termination','end_of_contract','retirement','death')),

    -- An exited employee must record when and why. Without this, `status = 'exited'` with a
    -- NULL exited_on silently breaks service-length and final-settlement arithmetic.
    ADD CONSTRAINT ck_employee_exit_complete
        CHECK (status <> 'exited' OR (exited_on IS NOT NULL AND exit_type IS NOT NULL)),

    -- A reason without a type is unclassifiable.
    ADD CONSTRAINT ck_employee_exit_reason_needs_type
        CHECK (exit_reason IS NULL OR exit_type IS NOT NULL),

    ADD CONSTRAINT ck_employee_blood_group
        CHECK (blood_group IS NULL OR blood_group IN
            ('A+','A-','B+','B-','AB+','AB-','O+','O-'));

CREATE TRIGGER tg_employee_updated_at
    BEFORE UPDATE ON employee
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- -----------------------------------------------------------------------------
-- 7. Status as-of a date - the "employee status/history" requirement
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_employment_status_asof(p_employee uuid, p_on date)
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
    SELECT COALESCE(
        (SELECT ee.to_status
           FROM public.employment_event ee
          WHERE ee.employee_id = p_employee
            AND ee.effective_on <= p_on
          ORDER BY ee.effective_on DESC, ee.recorded_at DESC
          LIMIT 1),
        'pre_boarding');
$$;

COMMENT ON FUNCTION fn_employment_status_asof(uuid, date) IS
    'Employee status AS OF a date, derived from the append-only lifecycle log. Before the first '
    'event an employee is pre_boarding. Never reads employee.status, which is only a cache of '
    'the latest event.';

-- -----------------------------------------------------------------------------
-- 8. Organization hierarchy - the reporting graph, as of a date
-- -----------------------------------------------------------------------------
--
-- ai/context/rbac-rules.md names `reporting_relationship` and `reporting_closure_current` as the
-- source of this graph. NEITHER EXISTS, and neither is created here: `employment.manager_id`
-- already carries the edge, already effective-dated, already under the Rule 3 immutability
-- triggers and an EXCLUDE constraint that forbids overlapping periods. A second table holding
-- the same edge would be a second source of truth for the most security-sensitive relation in
-- the system, and the two would drift.
--
-- WHY A CYCLE GUARD IS NOT PARANOIA. The EXCLUDE constraint means an employee has at most one
-- employment row on any given date, so the graph is a forest per date - UNLESS two people manage
-- each other. `ck_employment_not_self_managed` blocks only self-management, so A -> B -> A is
-- accepted by the schema today. Without the path guard this function would spin until the depth
-- cap on every call that touched such a pair.
--
CREATE OR REPLACE FUNCTION fn_reporting_subtree_asof(p_manager uuid, p_on date)
RETURNS TABLE (employee_id uuid, depth integer)
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
    WITH RECURSIVE walk AS (
        SELECT em.employee_id,
               1 AS depth,
               ARRAY[p_manager, em.employee_id] AS path
          FROM public.employment em
         WHERE em.manager_id = p_manager
           AND em.valid_period @> p_on

        UNION ALL

        SELECT em.employee_id,
               w.depth + 1,
               w.path || em.employee_id
          FROM walk w
          JOIN public.employment em
            ON em.manager_id = w.employee_id
           AND em.valid_period @> p_on
         WHERE w.depth < 10
           AND NOT (em.employee_id = ANY (w.path))
    )
    -- min(depth) collapses diamond paths, which a matrix reporting line can produce.
    SELECT w.employee_id, min(w.depth)::integer
      FROM walk w
     GROUP BY w.employee_id;
$$;

COMMENT ON FUNCTION fn_reporting_subtree_asof(uuid, date) IS
    'The reporting subtree under a manager AS OF a date, resolved recursively over employment. '
    'Depth-capped at 10 and cycle-guarded by path membership. depth 1 = direct reports.';

CREATE OR REPLACE FUNCTION fn_is_direct_report_asof(p_manager uuid, p_employee uuid, p_on date)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.employment em
         WHERE em.employee_id = p_employee
           AND em.manager_id  = p_manager
           AND em.valid_period @> p_on);
$$;

CREATE OR REPLACE FUNCTION fn_is_in_subtree_asof(p_manager uuid, p_employee uuid, p_on date)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.fn_reporting_subtree_asof(p_manager, p_on) s
         WHERE s.employee_id = p_employee);
$$;

COMMENT ON FUNCTION fn_is_direct_report_asof(uuid, uuid, date) IS
    'Depth-1 only. ai/context/rbac-rules.md deliberately distinguishes this from the subtree: a '
    'manager sees attendance for the whole subtree but compensation only for direct reports.';

-- -----------------------------------------------------------------------------
-- 9. Backfill - make the log total
-- -----------------------------------------------------------------------------
--
-- fn_employment_status_asof returns pre_boarding before an employee's first event. Every
-- existing employee is `active` with a known joining date, so without a joining event the
-- resolver would contradict employee.status for every one of them.
--
-- The trigger's own UPDATE writes back status = 'active', which is what they already are.
--
INSERT INTO employment_event
    (employee_id, event_type, from_status, to_status, effective_on, reason, employment_id)
SELECT e.id,
       'joined',
       'pre_boarding',
       'active',
       e.joined_on,
       'backfilled by migration 0014 from employee.joined_on',
       (SELECT em.id FROM employment em
         WHERE em.employee_id = e.id
         ORDER BY em.valid_from ASC
         LIMIT 1)
  FROM employee e
 WHERE NOT EXISTS (SELECT 1 FROM employment_event ee WHERE ee.employee_id = e.id)
 ORDER BY e.joined_on;

-- -----------------------------------------------------------------------------
-- 10. Grants
-- -----------------------------------------------------------------------------
--
-- 0008 grants hrm_app SELECT on everything and INSERT/UPDATE only where named. `employee` and
-- `employment` were never granted write, so as hrm_app the application cannot onboard anyone or
-- record a transfer. The running app still connects as the OWNER (apps/api/src/db.ts, pass-3
-- finding P3-7), so these grants change nothing today - they are what makes Module 1 work when
-- that connection is switched, and they keep 0008's model coherent rather than half-applied.
--
-- No DELETE anywhere: `employment` is effective-dated (Rule 3) and `employment_event` is
-- append-only. UPDATE on `employment` is safe because fn_block_historical_mutation is ENABLE
-- ALWAYS and permits closing an open period but not rewriting a historical one - hrm_app can
-- run into the rail, never remove it.

GRANT INSERT, UPDATE ON employee            TO hrm_app;
GRANT INSERT, UPDATE ON employment          TO hrm_app;
GRANT INSERT         ON employment_event    TO hrm_app;
-- Reference data: read-only for the application. Changing the legal moves is a migration.
GRANT SELECT         ON employment_status_transition TO hrm_app;

COMMIT;
