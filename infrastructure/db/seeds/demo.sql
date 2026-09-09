-- =============================================================================
-- Demo seed data for the manager demo (Track A)
--
-- Run with: npm run db:seed        (scripts/seed.mjs computes the password hashes)
-- NOT a migration. Demo data must never be part of the production chain.
--
-- Idempotent: deletes and reinserts the demo cast, so it can be re-run between rehearsals.
-- leave_ledger is append-only, so it is cleared with the trigger session-disabled - acceptable
-- for a seed script against a disposable demo database, and it refuses to run anywhere else.
--
-- The cast, and the story they tell:
--   Vishnu Ravi   EMP001  Senior Engineer   <- the employee the demo follows
--   Priya Menon   EMP002  Engineering Manager  <- approves Vishnu's leave and timesheet
--   Anu Krishnan  EMP003  Engineer          <- gives the manager dashboard a second row
--   Rahul Nair    EMP004  Engineer          <- and a third
--   Deepa Suresh  EMP005  HR Manager        <- the HR dashboard view
--
-- Vishnu's CL: accrual 12, then hold 4 + take 4 already consumed => available 8.
-- The demo then holds 3 more (Sep 14-16) => available 5. That is the 8 -> 5 the story needs,
-- and it is arithmetic the ledger actually performs, not a hardcoded number.
-- =============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- Effective-dated inserts are back-dated to real joining dates, which the Rule 3 perimeter
-- (migration 0005) refuses unless a caller opts in deliberately. This is that opt-in (DEC-029).
SET LOCAL hrm.allow_backdated_period = 'on';

-- ---------------------------------------------------------------------------
-- Clear previous demo data, children first
-- ---------------------------------------------------------------------------
-- Unlock first: the period-lock trigger (migration 0010) refuses writes to a submitted or
-- approved period, and it is ENABLE ALWAYS so session_replication_role cannot switch it off.
-- That is the rail working as designed - a re-seed has to ask, not sneak.
UPDATE timesheet_period
   SET status = 'draft', submitted_at = NULL, decided_at = NULL, decided_by = NULL
 WHERE status <> 'draft';

DELETE FROM work_log_entry WHERE work_log_id IN (SELECT id FROM work_log);
DELETE FROM work_log;
-- timesheet_transition references timesheet_period (0019) and is append-only, so the owner
-- disables the rail explicitly - same pattern as the ledger and the lifecycle log.
ALTER TABLE timesheet_transition DISABLE TRIGGER tg_timesheet_transition_immutable;
DELETE FROM timesheet_transition;
ALTER TABLE timesheet_transition ENABLE ALWAYS TRIGGER tg_timesheet_transition_immutable;

DELETE FROM timesheet_period;
-- Punches are append-only facts (migration 0012), so clearing them needs the owner to disable
-- the rail - same reasoning as the ledger below.
ALTER TABLE attendance_punch DISABLE TRIGGER tg_punch_append_only;
DELETE FROM attendance_punch;
ALTER TABLE attendance_punch ENABLE ALWAYS TRIGGER tg_punch_append_only;

DELETE FROM attendance_day;
-- project_member became effective-dated in 0019, so Rule 3 refuses DELETE. Same
-- "the owner disables it explicitly for a destructive re-seed" reasoning as everywhere else.
ALTER TABLE project_member DISABLE TRIGGER tg_project_member_immutable_history;
DELETE FROM project_member;
ALTER TABLE project_member ENABLE ALWAYS TRIGGER tg_project_member_immutable_history;
DELETE FROM task;
DELETE FROM project;
-- user_identity and user_role reference app_user (migration 0016), so they go first.
-- user_role is effective-dated, so Rule 3 refuses DELETE - same "the owner disables it
-- explicitly" reasoning as the ledger below.
DELETE FROM user_identity;
ALTER TABLE user_role DISABLE TRIGGER tg_user_role_immutable_history;
DELETE FROM user_role;
ALTER TABLE user_role ENABLE ALWAYS TRIGGER tg_user_role_immutable_history;

DELETE FROM session;
DELETE FROM app_user;

-- leave_ledger and leave_account are append-only, and their rails are ENABLE ALWAYS, so
-- session_replication_role cannot switch them off (migration 0007 / DEC-030). Clearing them
-- requires the OWNER to disable the triggers explicitly - which is exactly the residual power
-- the migration headers concede an owner has, and exactly why the application role must never
-- be the owner. Doing it loudly here is better than pretending the seed is non-destructive.
DELETE FROM leave_request;   -- references leave_ledger (migration 0011); children first

ALTER TABLE leave_ledger  DISABLE TRIGGER tg_leave_ledger_no_update;
ALTER TABLE leave_account DISABLE TRIGGER tg_leave_account_no_delete;
DELETE FROM leave_ledger;
DELETE FROM leave_account;
ALTER TABLE leave_ledger  ENABLE ALWAYS TRIGGER tg_leave_ledger_no_update;
ALTER TABLE leave_account ENABLE ALWAYS TRIGGER tg_leave_account_no_delete;

-- employment_event is the append-only lifecycle log (migration 0014). It references BOTH
-- employee and employment, so it has to be cleared before either of them, and its rails are
-- ENABLE ALWAYS - same "the owner disables it explicitly" reasoning as the ledger above.
ALTER TABLE employment_event DISABLE TRIGGER tg_employment_event_immutable;
DELETE FROM employment_event;
ALTER TABLE employment_event ENABLE ALWAYS TRIGGER tg_employment_event_immutable;

-- Payslips (migration 0024) reference employee_document, so they clear BEFORE it - the sixth
-- table in this seed to need a place in this ordering, and the sixth time the FK graph found the
-- omission before a human did.
--
-- Three rails to disable, all ENABLE ALWAYS: payslip_event is append-only, a payslip is never
-- deleted, and an issued payslip's lines are frozen. Same "the owner disables it explicitly"
-- reasoning as the ledger above - and worth restating here, because payslips are the one thing in
-- this schema `hrm_app` cannot touch at all (rbac-rules item 5). Only the OWNER can clear them,
-- which is precisely why the application must never connect as the owner.
ALTER TABLE payslip_event DISABLE TRIGGER tg_payslip_event_append_only;
ALTER TABLE payslip       DISABLE TRIGGER tg_payslip_no_delete;
ALTER TABLE payslip_line  DISABLE TRIGGER tg_payslip_line_frozen;
DELETE FROM payslip_event;
DELETE FROM payslip_line;
DELETE FROM payslip;
ALTER TABLE payslip_event ENABLE ALWAYS TRIGGER tg_payslip_event_append_only;
ALTER TABLE payslip       ENABLE ALWAYS TRIGGER tg_payslip_no_delete;
ALTER TABLE payslip_line  ENABLE ALWAYS TRIGGER tg_payslip_line_frozen;

-- Employee documents (migration 0018) reference employee. The FK between document and version
-- is CIRCULAR - the document points at its current version and the version points back at the
-- document - so current_version_id is nulled first, then versions, then documents.
-- employee_document_version is append-only, so the owner disables the rail explicitly.
UPDATE employee_document SET current_version_id = NULL WHERE current_version_id IS NOT NULL;
ALTER TABLE employee_document_version DISABLE TRIGGER tg_dv_immutable;
DELETE FROM employee_document_version;
ALTER TABLE employee_document_version ENABLE ALWAYS TRIGGER tg_dv_immutable;
DELETE FROM employee_document;

-- Organization structure (migration 0017) references department AND employee, so it clears
-- before either. department_period, team_period and team_membership are all effective-dated,
-- so Rule 3 refuses DELETE - the owner disables the rail explicitly, as everywhere else here.
ALTER TABLE team_membership   DISABLE TRIGGER tg_team_membership_immutable_history;
ALTER TABLE team_period       DISABLE TRIGGER tg_team_period_immutable_history;
ALTER TABLE department_period DISABLE TRIGGER tg_department_period_immutable_history;
DELETE FROM team_membership;
DELETE FROM team_period;
DELETE FROM department_period;
ALTER TABLE team_membership   ENABLE ALWAYS TRIGGER tg_team_membership_immutable_history;
ALTER TABLE team_period       ENABLE ALWAYS TRIGGER tg_team_period_immutable_history;
ALTER TABLE department_period ENABLE ALWAYS TRIGGER tg_department_period_immutable_history;
DELETE FROM team;

-- employment is effective-dated, so Rule 3 refuses DELETE (migration 0009). Same reasoning as
-- the ledger above: the owner disables it explicitly for a destructive re-seed.
ALTER TABLE employment DISABLE TRIGGER tg_employment_immutable_history;
DELETE FROM employment;
ALTER TABLE employment ENABLE ALWAYS TRIGGER tg_employment_immutable_history;

DELETE FROM employee;
DELETE FROM designation;
DELETE FROM department;
DELETE FROM holiday;

-- ---------------------------------------------------------------------------
-- Reset the POLICY baseline, so a rehearsal that changes a threshold on the settings screen
-- can be undone and db:verify stays deterministic.
--
-- Only the successor periods are removed and the original re-opened. The original's VALUES need
-- no restoring - Rule 3 made them unmodifiable, so they are pristine by construction. That is
-- the immutability guarantee paying for itself: the only thing a policy change can do to
-- history is end it, so undoing one is a two-line operation rather than a data-repair exercise.
--
-- Disabling these triggers requires ownership, which is exactly why the application role must
-- never be the owner (migration 0008).
-- ---------------------------------------------------------------------------
ALTER TABLE attendance_policy DISABLE TRIGGER tg_attendance_policy_immutable_history;
ALTER TABLE employment_policy DISABLE TRIGGER tg_employment_policy_immutable_history;
ALTER TABLE leave_policy      DISABLE TRIGGER tg_leave_policy_immutable_history;

DELETE FROM attendance_policy WHERE valid_from > DATE '2020-01-01';
DELETE FROM employment_policy WHERE valid_from > DATE '2020-01-01';
DELETE FROM leave_policy      WHERE valid_from > DATE '2020-01-01';

UPDATE attendance_policy SET valid_to = NULL, reason = NULL WHERE valid_to IS NOT NULL;
UPDATE employment_policy SET valid_to = NULL, reason = NULL WHERE valid_to IS NOT NULL;
UPDATE leave_policy      SET valid_to = NULL, reason = NULL WHERE valid_to IS NOT NULL;

ALTER TABLE attendance_policy ENABLE ALWAYS TRIGGER tg_attendance_policy_immutable_history;
ALTER TABLE employment_policy ENABLE ALWAYS TRIGGER tg_employment_policy_immutable_history;
ALTER TABLE leave_policy      ENABLE ALWAYS TRIGGER tg_leave_policy_immutable_history;

-- ---------------------------------------------------------------------------
-- The real 2026 holiday calendar (docs/requirements/holiday-calendar-2026.md)
-- 11 fixed + 6 optional. Optional holidays are NOT auto-excluded from working days: an
-- employee elects them, and the election cap is still an open question (OR-06).
-- ---------------------------------------------------------------------------
INSERT INTO holiday (holiday_on, name, is_optional) VALUES
  ('2026-01-01', 'New Year''s Day',          false),
  ('2026-01-15', 'Pongal',                   true),
  ('2026-01-26', 'Republic Day',             false),
  ('2026-03-20', 'Id-ul-Fitr (Ramzan)',      false),
  ('2026-04-02', 'Maundy Thursday',          true),
  ('2026-04-03', 'Good Friday',              false),
  ('2026-04-09', 'Election - Kerala',        true),
  ('2026-04-15', 'Vishu',                    false),
  ('2026-05-01', 'May Day',                  false),
  ('2026-05-27', 'Id-ul-Ad''ha (Bakrid)',    true),
  ('2026-08-25', 'First Onam / Milad-i-Sherif', true),
  ('2026-08-26', 'Thiruvonam',               false),
  ('2026-09-14', 'Ganesh Chaturthi',         true),
  ('2026-10-02', 'Gandhi Jayanti',           false),
  ('2026-10-20', 'Mahanavami',               false),
  ('2026-12-25', 'Christmas',                false),
  ('2026-12-31', 'New Year''s Eve',          false);

-- ---------------------------------------------------------------------------
-- Organization
-- ---------------------------------------------------------------------------
INSERT INTO department (code, name) VALUES
  ('ENG', 'Engineering'), ('HR', 'Human Resources'), ('DEL', 'Delivery');

INSERT INTO designation (code, name, grade) VALUES
  ('SE',  'Senior Engineer',     3),
  ('ENGR','Engineer',            2),
  ('EM',  'Engineering Manager', 4),
  ('HRM', 'HR Manager',          4);

-- ---------------------------------------------------------------------------
-- The cast
-- ---------------------------------------------------------------------------
INSERT INTO employee (employee_number, full_name, work_email, personal_phone, gender,
                      date_of_birth, joined_on, status) VALUES
  ('EMP001','Vishnu Ravi',  'vishnu.ravi@panasatech.com',  '+91 98470 11001','male',  '1994-03-12','2021-06-14','active'),
  ('EMP002','Priya Menon',  'priya.menon@panasatech.com',  '+91 98470 11002','female','1988-11-02','2019-02-04','active'),
  ('EMP003','Anu Krishnan', 'anu.krishnan@panasatech.com', '+91 98470 11003','female','1996-07-21','2022-09-05','active'),
  ('EMP004','Rahul Nair',   'rahul.nair@panasatech.com',   '+91 98470 11004','male',  '1993-01-30','2020-11-16','active'),
  ('EMP005','Deepa Suresh', 'deepa.suresh@panasatech.com', '+91 98470 11005','female','1985-05-09','2018-07-02','active');

-- Effective-dated assignments. Priya has TWO periods, so the demo can show real history:
-- she was an Engineer until 2023-04-01 and an Engineering Manager since.
INSERT INTO employment (employee_id, department_id, designation_id, manager_id, valid_from, valid_to, reason)
SELECT e.id, d.id, g.id, m.id, '2019-02-04', '2023-04-01', 'joined as Engineer'
  FROM employee e, department d, designation g, employee m
 WHERE e.employee_number='EMP002' AND d.code='ENG' AND g.code='ENGR' AND m.employee_number='EMP005';

INSERT INTO employment (employee_id, department_id, designation_id, manager_id, valid_from, reason)
SELECT e.id, d.id, g.id, NULL, '2023-04-01', 'promoted to Engineering Manager'
  FROM employee e, department d, designation g
 WHERE e.employee_number='EMP002' AND d.code='ENG' AND g.code='EM';

INSERT INTO employment (employee_id, department_id, designation_id, manager_id, valid_from, reason)
SELECT e.id, d.id, g.id, m.id, e.joined_on, 'initial assignment'
  FROM employee e, department d, designation g, employee m
 WHERE e.employee_number='EMP001' AND d.code='ENG' AND g.code='SE' AND m.employee_number='EMP002';

INSERT INTO employment (employee_id, department_id, designation_id, manager_id, valid_from, reason)
SELECT e.id, d.id, g.id, m.id, e.joined_on, 'initial assignment'
  FROM employee e, department d, designation g, employee m
 WHERE e.employee_number='EMP003' AND d.code='ENG' AND g.code='ENGR' AND m.employee_number='EMP002';

INSERT INTO employment (employee_id, department_id, designation_id, manager_id, valid_from, reason)
SELECT e.id, d.id, g.id, m.id, e.joined_on, 'initial assignment'
  FROM employee e, department d, designation g, employee m
 WHERE e.employee_number='EMP004' AND d.code='ENG' AND g.code='ENGR' AND m.employee_number='EMP002';

INSERT INTO employment (employee_id, department_id, designation_id, manager_id, valid_from, reason)
SELECT e.id, d.id, g.id, NULL, e.joined_on, 'initial assignment'
  FROM employee e, department d, designation g
 WHERE e.employee_number='EMP005' AND d.code='HR' AND g.code='HRM';

-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- Lifecycle history (migration 0014)
--
-- Without this the log is empty, so fn_employment_status_asof reports every seeded employee as
-- pre_boarding while employee.status says active - the exact divergence the log exists to
-- prevent, and the reason 0014's verify suite asserts the log is total.
--
-- Events are inserted in ascending effective_on order per employee, because the sequencing
-- guard refuses an event dated before the one preceding it.
-- ---------------------------------------------------------------------------

-- 1. Everyone joined, linked to the assignment period that opened on their joining date.
INSERT INTO employment_event
    (employee_id, event_type, from_status, to_status, effective_on, reason, employment_id)
SELECT e.id, 'joined', 'pre_boarding', 'active', e.joined_on, 'joined ART',
       (SELECT em.id FROM employment em
         WHERE em.employee_id = e.id ORDER BY em.valid_from ASC LIMIT 1)
  FROM employee e
 ORDER BY e.joined_on;

-- 2. Everyone cleared probation. The trigger materialises employee.confirmed_on from this;
--    probation_end_on stays NULL because employment_policy.probation_months is itself NULL by
--    DEC-017 - unknown, not zero - and a seeded guess would look like settled policy.
INSERT INTO employment_event
    (employee_id, event_type, from_status, to_status, effective_on, reason)
SELECT e.id, 'confirmed', 'active', 'active', e.joined_on + 180, 'probation cleared'
  FROM employee e
 ORDER BY e.joined_on;

-- 3. Priya's promotion, linked to the assignment period it opened, so the append-only log and
--    the effective-dated assignment tell the same story from two angles.
INSERT INTO employment_event
    (employee_id, event_type, from_status, to_status, effective_on, reason, employment_id)
SELECT e.id, 'promoted', 'active', 'active', DATE '2023-04-01',
       'promoted to Engineering Manager',
       (SELECT em.id FROM employment em
         WHERE em.employee_id = e.id AND em.valid_from = DATE '2023-04-01' LIMIT 1)
  FROM employee e
 WHERE e.employee_number = 'EMP002';

-- Logins. :pw_* are scrypt hashes computed by scripts/seed.mjs.
-- TRACK B: ADR-0009 specifies argon2id.
-- ---------------------------------------------------------------------------
INSERT INTO app_user (employee_id, email, password_hash, password_algo, role)
SELECT id, work_email, :'pw_hash', 'scrypt', 'employee'  FROM employee WHERE employee_number='EMP001';
INSERT INTO app_user (employee_id, email, password_hash, password_algo, role)
SELECT id, work_email, :'pw_hash', 'scrypt', 'manager'   FROM employee WHERE employee_number='EMP002';
INSERT INTO app_user (employee_id, email, password_hash, password_algo, role)
SELECT id, work_email, :'pw_hash', 'scrypt', 'employee'  FROM employee WHERE employee_number='EMP003';
INSERT INTO app_user (employee_id, email, password_hash, password_algo, role)
SELECT id, work_email, :'pw_hash', 'scrypt', 'employee'  FROM employee WHERE employee_number='EMP004';
INSERT INTO app_user (employee_id, email, password_hash, password_algo, role)
SELECT id, work_email, :'pw_hash', 'scrypt', 'hr_admin'  FROM employee WHERE employee_number='EMP005';

-- Effective-dated role grants (migration 0016). `app_user.role` is superseded by this table, so
-- without these rows fn_user_roles() returns {} and the AuthorizationService correctly denies
-- everything - a demo where nobody can do anything.
--
-- Roles are ADDITIVE: a manager is also an employee. That is the whole reason user_role is
-- multi-valued, and the reason the backfill in 0016 grants 'employee' alongside the other role.
SET hrm.allow_backdated_period = 'on';

INSERT INTO user_role (user_id, role, valid_from, reason)
SELECT u.id, u.role, e.joined_on, 'seeded from app_user.role'
  FROM app_user u JOIN employee e ON e.id = u.employee_id;

INSERT INTO user_role (user_id, role, valid_from, reason)
SELECT u.id, 'employee', e.joined_on, 'seeded: every account is also an employee'
  FROM app_user u JOIN employee e ON e.id = u.employee_id
 WHERE u.role <> 'employee';

RESET hrm.allow_backdated_period;

-- ---------------------------------------------------------------------------
-- Organization structure (migration 0017)
--
-- The department hierarchy and the teams. Placed AFTER the employees, because a department has
-- a head and a team has a lead, and both are employees.
--
-- History is built by inserting CLOSED periods directly rather than inserting an open one and
-- closing it: back-dating a period's `valid_to` is refused by Rule 3 in every case, while a
-- back-dated INSERT is permitted behind the DEC-029 opt-in. Getting that backwards is the first
-- thing that fails when writing effective-dated seed data.
-- ---------------------------------------------------------------------------
-- Company identity. `org_setting` is MUTABLE (ADR-0019): nothing computes history from it, so a
-- rename is a plain UPDATE and needs no migration and no deployment. HR can change these again
-- from the settings screen at any time - which is why they were built as configuration rather
-- than as constants in the code.
UPDATE org_setting SET value = '"Art Technology and Software"'
 WHERE key = 'company.legal_name';
UPDATE org_setting SET value = '"ART"'
 WHERE key = 'company.display_name';

SET hrm.allow_backdated_period = 'on';

-- A root unit, so the tree has a top rather than three disconnected departments.
INSERT INTO department (code, name, description) VALUES
  ('ART', 'Art Technology and Software', 'The company as an organizational unit');

INSERT INTO department_period (department_id, parent_department_id, head_employee_id, valid_from, reason)
SELECT d.id, NULL, (SELECT id FROM employee WHERE employee_number = 'EMP005'),
       DATE '2018-07-02', 'company root'
  FROM department d WHERE d.code = 'ART';

-- ENG, HR and DEL sit under the root. Engineering is headed by Priya, HR by Deepa.
INSERT INTO department_period (department_id, parent_department_id, head_employee_id, valid_from, reason)
SELECT d.id,
       (SELECT id FROM department WHERE code = 'ART'),
       CASE d.code WHEN 'ENG' THEN (SELECT id FROM employee WHERE employee_number = 'EMP002')
                   WHEN 'HR'  THEN (SELECT id FROM employee WHERE employee_number = 'EMP005')
       END,
       DATE '2018-07-02', 'placed under the company root'
  FROM department d WHERE d.code IN ('ENG', 'HR', 'DEL');

-- Two teams inside Engineering, so the team model is exercised rather than merely present.
INSERT INTO team (code, name, description) VALUES
  ('PLATFORM', 'Platform', 'Internal HRM and shared services'),
  ('CLIENT',   'Client Delivery', 'Client-facing project work');

INSERT INTO team_period (team_id, department_id, lead_employee_id, valid_from, reason)
SELECT t.id, (SELECT id FROM department WHERE code = 'ENG'),
       (SELECT id FROM employee WHERE employee_number = 'EMP002'),
       DATE '2022-09-05', 'formed inside Engineering'
  FROM team t WHERE t.code IN ('PLATFORM', 'CLIENT');

-- Membership. Vishnu is on both, which is the normal case in an IT services organisation and
-- the reason the exclusion constraint is keyed per (team, employee) rather than per employee.
INSERT INTO team_membership (team_id, employee_id, role, valid_from, reason)
SELECT (SELECT id FROM team WHERE code = 'PLATFORM'), e.id,
       CASE WHEN e.employee_number = 'EMP002' THEN 'lead' ELSE 'member' END,
       DATE '2022-09-05', 'seeded'
  FROM employee e WHERE e.employee_number IN ('EMP001', 'EMP002', 'EMP003');

INSERT INTO team_membership (team_id, employee_id, role, valid_from, reason)
SELECT (SELECT id FROM team WHERE code = 'CLIENT'), e.id, 'member', DATE '2022-09-05', 'seeded'
  FROM employee e WHERE e.employee_number IN ('EMP001', 'EMP004');

RESET hrm.allow_backdated_period;

-- ---------------------------------------------------------------------------
-- Leave balances, built by the ledger rather than asserted
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_cl UUID; v_sl UUID; v_pol UUID;
    r RECORD;
BEGIN
    SELECT id INTO v_cl FROM leave_type WHERE code = 'CL';
    SELECT id INTO v_sl FROM leave_type WHERE code = 'SL';
    SELECT id INTO v_pol FROM leave_policy WHERE leave_type_id = v_cl AND valid_to IS NULL LIMIT 1;

    FOR r IN SELECT id, employee_number FROM employee LOOP
        -- CL: 12 accrued for everyone
        INSERT INTO leave_ledger (employee_id, leave_type_id, leave_year, entry_type, days,
                                  leave_policy_id, reason)
        VALUES (r.id, v_cl, 2026, 'accrual', 12, v_pol, 'annual entitlement 2026');
        -- SL: 12 accrued
        INSERT INTO leave_ledger (employee_id, leave_type_id, leave_year, entry_type, days, reason)
        VALUES (r.id, v_sl, 2026, 'accrual', 12, 'annual entitlement 2026');
    END LOOP;

    -- Vishnu has already used 4 CL this year: hold then take, which is the real consumption path.
    SELECT id INTO r FROM employee WHERE employee_number = 'EMP001';
    INSERT INTO leave_ledger (employee_id, leave_type_id, leave_year, entry_type, days, reason)
    VALUES (r.id, v_cl, 2026, 'hold', 4, 'CL taken 2026-04-20 to 2026-04-23');
    INSERT INTO leave_ledger (employee_id, leave_type_id, leave_year, entry_type, days, reason)
    VALUES (r.id, v_cl, 2026, 'take', 4, 'CL taken 2026-04-20 to 2026-04-23');

    -- Anu has used 2
    SELECT id INTO r FROM employee WHERE employee_number = 'EMP003';
    INSERT INTO leave_ledger (employee_id, leave_type_id, leave_year, entry_type, days, reason)
    VALUES (r.id, v_cl, 2026, 'hold', 2, 'CL taken 2026-07-02 to 2026-07-03');
    INSERT INTO leave_ledger (employee_id, leave_type_id, leave_year, entry_type, days, reason)
    VALUES (r.id, v_cl, 2026, 'take', 2, 'CL taken 2026-07-02 to 2026-07-03');
END $$;

-- ---------------------------------------------------------------------------
-- Attendance for the two weeks around the demo. Deliberately varied so the monthly
-- summary has something to show, and so ONE day disagrees with the work log on purpose.
-- ---------------------------------------------------------------------------
INSERT INTO attendance_day (employee_id, business_date, status, worked_minutes,
                            payable_day_fraction, first_in_at, last_out_at, note)
SELECT e.id, d::date,
       CASE
         WHEN EXTRACT(ISODOW FROM d) >= 6 THEN 'week_off'
         WHEN d::date = '2026-09-03' AND e.employee_number = 'EMP001' THEN 'late'
         WHEN d::date = '2026-09-04' AND e.employee_number = 'EMP001' THEN 'wfh'
         WHEN d::date = '2026-09-02' AND e.employee_number = 'EMP004' THEN 'absent'
         WHEN d::date = '2026-09-09' AND e.employee_number = 'EMP003' THEN 'wfh'
         ELSE 'present'
       END,
       CASE WHEN EXTRACT(ISODOW FROM d) >= 6 THEN 0
            WHEN d::date = '2026-09-02' AND e.employee_number = 'EMP004' THEN 0
            WHEN d::date = '2026-09-03' AND e.employee_number = 'EMP001' THEN 455
            ELSE 495 END,
       CASE WHEN EXTRACT(ISODOW FROM d) >= 6 THEN 0
            WHEN d::date = '2026-09-02' AND e.employee_number = 'EMP004' THEN 0
            ELSE 1 END,
       CASE WHEN EXTRACT(ISODOW FROM d) >= 6 THEN NULL
            WHEN d::date = '2026-09-03' AND e.employee_number = 'EMP001'
              THEN (d::date + TIME '09:47') AT TIME ZONE 'Asia/Kolkata'
            ELSE (d::date + TIME '09:12') AT TIME ZONE 'Asia/Kolkata' END,
       CASE WHEN EXTRACT(ISODOW FROM d) >= 6 THEN NULL
            ELSE (d::date + TIME '18:30') AT TIME ZONE 'Asia/Kolkata' END,
       CASE WHEN d::date = '2026-09-03' AND e.employee_number = 'EMP001'
              THEN 'arrived 09:47 - beyond the 15 minute grace'
            WHEN d::date = '2026-09-02' AND e.employee_number = 'EMP004'
              THEN 'no punch recorded'
            ELSE NULL END
  FROM employee e
  -- STOPS THE DAY BEFORE TODAY, and that is the point rather than an off-by-one.
  --
  -- `attendance_day` is a DERIVED verdict - `fn_derive_attendance_day` computes it from punches.
  -- Seeding a row for the CURRENT business date fabricated a derivation whose inputs do not
  -- exist, and the dashboard then told three contradictory stories at once: "8h 15m, in 09:12,
  -- out 18:30" beside "No punches yet" beside a "Check in" button. Every one of those was a
  -- truthful rendering of the data; the data was the lie.
  --
  -- Ending at yesterday keeps the month's history (so the summary has something to show) and
  -- leaves TODAY genuinely open, which is also the more useful demo: the first thing a visitor
  -- can do is punch in and watch the verdict derive itself.
  CROSS JOIN generate_series(DATE '2026-08-31', fn_business_date() - 1, INTERVAL '1 day') d
 WHERE e.employee_number IN ('EMP001','EMP002','EMP003','EMP004');

-- ---------------------------------------------------------------------------
-- Projects, tasks, membership
-- ---------------------------------------------------------------------------
INSERT INTO project (code, name, client_name, manager_id, started_on)
SELECT 'HRM', 'Internal HRM', 'Art Technology and Software', m.id, '2026-06-01'
  FROM employee m WHERE m.employee_number = 'EMP002';
INSERT INTO project (code, name, client_name, manager_id, started_on)
SELECT 'CPRT', 'Client Portal', 'Meridian Retail', m.id, '2026-03-15'
  FROM employee m WHERE m.employee_number = 'EMP002';
INSERT INTO project (code, name, client_name, manager_id, started_on)
SELECT 'MOBL', 'Mobile App', 'Meridian Retail', m.id, '2026-07-20'
  FROM employee m WHERE m.employee_number = 'EMP002';
SET hrm.allow_backdated_period = 'on';

-- Membership is effective-dated (0019). It begins when the project began, so the effort
-- already seeded against these projects falls inside a period the member actually held.
INSERT INTO project_member (project_id, employee_id, role, valid_from, reason)
SELECT p.id, e.id, m.role, p.started_on, 'seeded at project start'
  FROM project p
  JOIN (VALUES
    ('HRM','EMP001','lead'), ('HRM','EMP003','contributor'), ('HRM','EMP002','project_manager'),
    ('CPRT','EMP001','contributor'), ('CPRT','EMP004','lead'), ('CPRT','EMP002','project_manager'),
    ('MOBL','EMP003','lead'), ('MOBL','EMP004','contributor'), ('MOBL','EMP002','project_manager')
  ) AS m(pcode, emp, role) ON m.pcode = p.code
  JOIN employee e ON e.employee_number = m.emp;

-- `closed_at` is derived from the status, because 0019 requires a terminal task to carry a
-- closure time - a task marked done with no closure date cannot appear in any "when did this
-- finish" report.
--
-- ASSIGNEES AND DUE DATES EXERCISE EVERY COUNTER IN fn_task_status, INCLUDING THE ONES THAT MUST
-- STAY AT ZERO.
--
-- Originally every task here was unassigned and undated, which made the task report return
-- nothing to anybody - and a test over an empty report asserts nothing, the trap that has bitten
-- this repo three times (0014 L13, 0017 G5, 0012 N8). So:
--
--   * HRM-11 / CP-41 are OVERDUE (due before the business date, still open);
--   * HRM-12 / CP-42 are DUE SOON (inside the seven-day window);
--   * HRM-13 / MB-07 are open with NO due date - not late, but not plannable either;
--   * HRM-14 is DONE with a due date already past, and must NOT count as overdue: a closed task
--     has stopped consuming time whatever its date said. A seed where nothing was both closed and
--     past its date could not have caught that.
--   * CP-43 and MB-08 are left DELIBERATELY UNASSIGNED. They are the reason
--     fn_project_task_status exists: an unassigned task has no subject, so the reporting graph
--     cannot report it, and "two open tasks belong to nobody" is exactly the finding a manager
--     needs. Assigning everything here would have made that cut untestable.
--
-- Dates are relative to fn_business_date(), never literals, so the fixture stays meaningful as
-- the calendar moves - a hardcoded 2026-09-01 would silently stop being overdue.
--
-- EVERY ASSIGNEE MUST BE A MEMBER OF THE TASK'S PROJECT, and that is a trigger, not a
-- convention: `fn_task_assignee_is_member` refused this insert outright the first time, because
-- the block used to sit ABOVE the project_member insert and no membership existed yet. Hence its
-- position here, after the memberships it depends on. The database was right and the fixture was
-- wrong, which is the correct direction for that argument to be settled in.
INSERT INTO task (project_id, code, title, status, closed_at, assignee_employee_id, due_on)
SELECT p.id, t.code, t.title, t.status,
       CASE WHEN t.status IN ('done', 'cancelled') THEN now() END,
       a.id,
       CASE WHEN t.due_offset IS NULL THEN NULL
            ELSE fn_business_date() + t.due_offset END
  FROM project p
  JOIN (VALUES
    ('HRM','HRM-11','Leave module',              'in_progress', 'EMP001',  -6),
    ('HRM','HRM-12','Attendance module',         'in_progress', 'EMP003',   3),
    ('HRM','HRM-13','Work log and timesheets',   'in_progress', 'EMP001', NULL),
    ('HRM','HRM-14','Authentication',            'done',        'EMP001', -20),
    ('CPRT','CP-41','API integration',           'in_progress', 'EMP004',  -2),
    ('CPRT','CP-42','Dashboard UI',              'in_progress', 'EMP001',   5),
    ('CPRT','CP-43','Payment reconciliation',    'open',         NULL,     NULL),
    ('MOBL','MB-07','Offline sync',              'in_progress', 'EMP003', NULL),
    ('MOBL','MB-08','Push notifications',        'open',         NULL,      12)
  ) AS t(pcode, code, title, status, assignee, due_offset) ON t.pcode = p.code
  LEFT JOIN employee a ON a.employee_number = t.assignee;

-- ---------------------------------------------------------------------------
-- Timesheets
--   Last week (Aug 31 - Sep 6) is APPROVED for everyone, so there is history.
--   This week (Sep 7 - 13) is a DRAFT: Vishnu has two days logged and the demo adds today's,
--   then submits. Anu and Rahul are fully logged so the manager dashboard has real numbers.
-- ---------------------------------------------------------------------------
INSERT INTO timesheet_period (employee_id, period_start, period_end, status, submitted_at,
                              decided_at, decided_by)
SELECT e.id, '2026-08-31', '2026-09-06', 'approved',
       TIMESTAMPTZ '2026-09-06 18:00+05:30', TIMESTAMPTZ '2026-09-07 10:15+05:30', m.id
  FROM employee e, employee m
 WHERE e.employee_number IN ('EMP001','EMP003','EMP004') AND m.employee_number = 'EMP002';

INSERT INTO timesheet_period (employee_id, period_start, period_end, status)
SELECT e.id, '2026-09-07', '2026-09-13', 'draft'
  FROM employee e WHERE e.employee_number IN ('EMP001','EMP003','EMP004');

-- Work logs. Entries are inserted BEFORE the period is linked where the period is approved,
-- because the period lock refuses writes to a submitted or approved period - which is the
-- behaviour the demo wants to be able to show.
DO $$
DECLARE
    v_emp UUID; v_log UUID; v_period UUID;
    r RECORD; d DATE;
BEGIN
    -- last week, approved: 5 days x ~7h across two projects, for the three contributors
    FOR r IN SELECT id, employee_number FROM employee
              WHERE employee_number IN ('EMP001','EMP003','EMP004') LOOP
        FOR d IN SELECT g::date FROM generate_series(DATE '2026-08-31', DATE '2026-09-04', INTERVAL '1 day') g LOOP
            INSERT INTO work_log (employee_id, work_date) VALUES (r.id, d) RETURNING id INTO v_log;
            INSERT INTO work_log_entry (work_log_id, project_id, task_id, minutes, description)
            SELECT v_log, p.id, t.id, 270, 'Feature work'
              FROM project p JOIN task t ON t.project_id = p.id
             WHERE p.code = CASE WHEN r.employee_number='EMP004' THEN 'CPRT' ELSE 'HRM' END
             LIMIT 1;
            INSERT INTO work_log_entry (work_log_id, project_id, task_id, minutes, description)
            SELECT v_log, p.id, t.id, 150, 'Review, standup and fixes'
              FROM project p JOIN task t ON t.project_id = p.id
             WHERE p.code = CASE WHEN r.employee_number='EMP003' THEN 'MOBL' ELSE 'CPRT' END
             LIMIT 1;
            -- link it to the approved period only after the entries exist
            SELECT id INTO v_period FROM timesheet_period
             WHERE employee_id = r.id AND period_start = '2026-08-31';
            UPDATE work_log SET timesheet_period_id = v_period WHERE id = v_log;
        END LOOP;
    END LOOP;

    -- this week, draft. Vishnu: Mon and Tue partially logged; the demo adds more and submits.
    SELECT id INTO v_emp FROM employee WHERE employee_number = 'EMP001';
    SELECT id INTO v_period FROM timesheet_period
     WHERE employee_id = v_emp AND period_start = '2026-09-07';

    INSERT INTO work_log (employee_id, work_date, timesheet_period_id)
    VALUES (v_emp, '2026-09-07', v_period) RETURNING id INTO v_log;
    INSERT INTO work_log_entry (work_log_id, project_id, task_id, minutes, description)
    SELECT v_log, p.id, t.id, 390, 'Leave ledger and balance projection'
      FROM project p JOIN task t ON t.project_id=p.id AND t.code='HRM-11' WHERE p.code='HRM';
    INSERT INTO work_log_entry (work_log_id, project_id, task_id, minutes, description)
    SELECT v_log, p.id, t.id, 120, 'API integration review'
      FROM project p JOIN task t ON t.project_id=p.id AND t.code='CP-41' WHERE p.code='CPRT';

    -- Anu and Rahul: fully logged Mon-Thu so the team overview has real totals
    FOR r IN SELECT id, employee_number FROM employee
              WHERE employee_number IN ('EMP003','EMP004') LOOP
        SELECT id INTO v_period FROM timesheet_period
         WHERE employee_id = r.id AND period_start = '2026-09-07';
        -- Rahul is deliberately PRESENT on Monday with nothing logged: a client workshop day.
        -- The variance report must flag it, and must not "correct" either side (ADR-0015). This
        -- is the demo's evidence that attendance and work effort are separate domains.
        FOR d IN SELECT g::date FROM generate_series(DATE '2026-09-07', fn_business_date(), INTERVAL '1 day') g
                  WHERE public.fn_is_working_day(g::date)
                    AND NOT (r.employee_number = 'EMP004' AND g::date = DATE '2026-09-07') LOOP
            INSERT INTO work_log (employee_id, work_date, timesheet_period_id)
            VALUES (r.id, d, v_period) RETURNING id INTO v_log;
            INSERT INTO work_log_entry (work_log_id, project_id, task_id, minutes, description)
            SELECT v_log, p.id, t.id,
                   CASE WHEN r.employee_number='EMP004' THEN 480 ELSE 420 END, 'Feature work'
              FROM project p JOIN task t ON t.project_id = p.id
             WHERE p.code = CASE WHEN r.employee_number='EMP004' THEN 'CPRT' ELSE 'MOBL' END
             LIMIT 1;
        END LOOP;
    END LOOP;
END $$;

COMMIT;

SELECT 'DEMO SEED COMPLETE' AS result;

-- ---------------------------------------------------------------------------
-- Payslips (migration 0024)
--
-- DETERMINISTIC, and issued rather than draft, so the feature is demonstrable the moment the
-- stack comes up rather than only after somebody clicks through the HR form.
--
-- THE OBJECT KEYS ARE FIXED, and that is what makes this work. A seeded payslip needs its PDF to
-- actually exist in MinIO, or opening one 500s on a document the UI insists is there. So the keys
-- are written here and `scripts/seed.mjs` uploads a generated PDF to each of them straight after
-- this file runs. The two must agree; if they ever drift, the payslip flow test's byte-comparison
-- is what catches it.
--
-- Real object keys carry two surrogate UUIDs and nothing else (0018 check D15: no employee number,
-- name or email in a key, because a bucket listing is readable by anybody who reaches the storage
-- layer). These say `seed/` instead - deliberately, so a seeded object is obvious in a listing and
-- nobody mistakes demo data for a real wage record.
--
-- NO PAYROLL WAS CALCULATED HERE. The figures are typed-in constants that happen to add up, which
-- is exactly what the product does: HR enters a finalised result. ADR-0012 is BLOCKED on
-- build-versus-buy and owns the engine.
--
-- The amounts are integer PAISE (Rule 4). 5000000 is fifty thousand rupees.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_hr UUID;
    v_emp UUID;
    v_doc UUID; v_ver UUID; v_ps UUID;
    m RECORD;
    e RECORD;
    v_gross BIGINT; v_ded BIGINT;
BEGIN
    SELECT id INTO v_hr FROM employee WHERE employee_number = 'EMP005';

    -- Two employees, three months each. EMP005 (HR) is deliberately EXCLUDED: nobody issues their
    -- own payslip (ck_payslip_no_self_issue), and Deepa is the only seeded hr_admin.
    FOR e IN
        SELECT id, employee_number,
               CASE employee_number
                    WHEN 'EMP001' THEN 5000000    -- basic 50,000.00
                    WHEN 'EMP003' THEN 4200000    -- basic 42,000.00
               END AS basic
          FROM employee
         WHERE employee_number IN ('EMP001', 'EMP003')
    LOOP
        FOR m IN
            SELECT * FROM (VALUES
                (DATE '2026-06-01', DATE '2026-06-30', DATE '2026-07-01', 6),
                (DATE '2026-07-01', DATE '2026-07-31', DATE '2026-08-01', 7),
                (DATE '2026-08-01', DATE '2026-08-31', DATE '2026-09-01', 8)
            ) AS t(ps, pe, pd, mn)
        LOOP
            -- Earnings and deductions, all constants. HRA is 40% of basic and PF is 12%, which is
            -- how these numbers were CHOSEN - but nothing computes them at runtime, and no rate
            -- lives in the database. Change the seed and the payslip changes; change a statutory
            -- rate and nothing here moves, because that is ADR-0012's job and it does not exist.
            v_gross := e.basic + (e.basic * 4 / 10) + 250000;          -- basic + HRA + special
            v_ded   := (e.basic * 12 / 100) + 20000;                   -- PF + professional tax

            -- Both ids are generated FIRST, because the object key is built from them and from
            -- nothing else. The first version of this seed used
            -- 'seed/payslip-emp001-2026-06.pdf' and 0018's check D15 refused the whole run:
            -- "no object key contains an employee number, name or email - bucket listings,
            -- backups and access logs all travel differently from the database". The check was
            -- right and this seed was wrong, which is the correct direction for that argument.
            -- The `seed/` prefix stays so a demo object is obvious in a listing; everything after
            -- it is a surrogate, exactly as `objectKeyFor(documentId, versionId)` does in the
            -- request path.
            v_doc := gen_random_uuid();
            v_ver := gen_random_uuid();

            INSERT INTO employee_document (id, employee_id, document_type_code, title, uploaded_by)
            VALUES (v_doc, e.id, 'payslip',
                    'Payslip ' || to_char(m.ps, 'YYYY-MM'), v_hr);

            INSERT INTO employee_document_version
                (id, document_id, version_no, bucket, object_key, content_type, size_bytes,
                 sha256_hex, original_name, scan_status, scanned_at, scan_detail, uploaded_by)
            VALUES (v_ver, v_doc, 1, 'hrm-documents',
                    'seed/' || v_doc::text || '/' || v_ver::text || '.pdf',
                    'application/pdf', 512,
                    -- A placeholder digest; seed.mjs rewrites it to the real one after upload,
                    -- because the download path re-checks the hash and would refuse to serve a
                    -- file whose digest does not match what was recorded.
                    repeat('0', 64),
                    'payslip-' || to_char(m.ps, 'YYYY-MM') || '.pdf',
                    'clean', now(),
                    'seeded demo data; no scanner is configured (OR-23)', v_hr);

            UPDATE employee_document SET current_version_id = v_ver WHERE id = v_doc;

            INSERT INTO payslip (employee_id, period_start, period_end, pay_date,
                                 declared_net_minor, document_id, created_by, note)
            VALUES (e.id, m.ps, m.pe, m.pd, v_gross - v_ded, v_doc, v_hr,
                    'Seeded demo payslip')
            RETURNING id INTO v_ps;

            INSERT INTO payslip_line (payslip_id, component_code, amount_minor) VALUES
                (v_ps, 'basic',             e.basic),
                (v_ps, 'hra',               e.basic * 4 / 10),
                (v_ps, 'special_allowance', 250000),
                (v_ps, 'pf_employee',       e.basic * 12 / 100),
                (v_ps, 'professional_tax',  20000);

            -- Issued through the event log, like every other status move. The issue guard checks
            -- the declared net against the lines, so if the constants above ever stop adding up
            -- the SEED fails loudly instead of producing a payslip that lies.
            INSERT INTO payslip_event (payslip_id, subject_employee_id, event_type,
                                       from_status, to_status, actor_employee_id)
            VALUES (v_ps, e.id, 'issue', 'draft', 'issued', v_hr);
        END LOOP;
    END LOOP;
END $$;

