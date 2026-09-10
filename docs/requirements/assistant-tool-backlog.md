# Assistant tool backlog — 89 candidate tools, and what each one costs

**Status:** Backlog. **Nothing here is approved**, and nothing here is a business rule.
**Date:** 2026-09-09
**Class if built:** **C** for anything marked **R** or **D** below (field registry, authorization,
migration). **B** for an **A**-marked tool inside an existing domain.

## What this document is, and what it is not

The rest of `docs/requirements/` holds **business rules traceable to the Employee Handbook**, and
its README is explicit that "a rule with no source is an assumption". This file is a different
kind of document and must not be read as the first kind.

It is a **derived engineering backlog**: a systematic sweep of the shipped product for questions a
user of each role would ask an assistant, and what it would take to answer each one. Its sources
are all in this repository:

| Claim | Source |
|---|---|
| What a tool may be at all | `docs/adr/0020-runtime-ai-assistant.md` (**Proposed**, not Accepted) |
| Which actions exist | `packages/authz/authz-matrix.yaml` — 50 actions |
| Which fields a tool may return | `packages/authz/src/field-registry.ts` |
| Which domains route | `infrastructure/db/migrations/0035_assistant_transcripts.sql` line 130 |
| What the screens already do | `apps/api/src/*.ts`, `apps/web/app/(app)/*/page.tsx` |
| Existing tools | `apps/api/src/assistant/tools-{me,leave,attendance}.ts` |

**No entry here cites the Handbook, and no entry here creates a requirement.** Where a candidate
tool would need a policy or statutory answer, it is marked **D** and the question is named rather
than answered — `ai/context/india-statutory-notes.md` and CLAUDE.md's "never infer legal
requirements" both apply unchanged.

## The four constraints that decide whether a tool is buildable

1. **ADR-0020 §1 — a tool reuses an action that already exists.** Every tool declares the action
   its equivalent *screen* uses. The catalogue can therefore never be wider than the 50 actions in
   `authz-matrix.yaml`, and **a tool that needs a new action is not a tool** — it is a feature with
   its own decision. This is also why the assistant cannot out-reach the screen beside it.
2. **The field registry is default-deny.** `fieldMask` returns an **empty set** for an unregistered
   resource type and `applyMask` drops what it does not know, so a tool over an unregistered type
   returns `{}`. Eleven types are registered today. **Eight are not:** `work_log`, `timesheet`,
   `task`, `project`, `project_effort`, `designation`, `audit_event`, `identity`.
3. **The routing domain is a CHECK constraint.** `ck_assistant_message_domain` pins it to
   `me, leave, attendance, work, people, documents, cross, meta`. A `config` or `audit` domain
   needs migration 0030 — or those tools file under an existing domain, which is what
   `attendance_policy` already does.
4. **ADR-0020 §6 is not amendable by a feature ticket.** No compensation amounts; no tool that
   ranks, scores or orders people; no narrative work-log text to anyone but its author; k = 5 on
   any aggregate crossing an individual boundary; no write path.

### Status markers used throughout

| | Meaning | Count |
|---|---|---|
| **A** | Buildable now — the action, the registry entry and the domain all exist | **51** (50 marked **A**, plus `payslip_schedule`, marked **Recommended**) |
| **R** | Needs a field-registry entry first (constraint 2) | **28** |
| **D** | Needs a human decision — an ADR amendment, a new action, a migration, or a gate change | **10** |

## Where the catalogue stands

**35 tools, across 5 of the 7 domains:** `me` 6, `leave` 11, `attendance` 9, `people` 4, `work` 5.

`documents` (beyond `me_documents`) and `cross` have **zero**. `documents` is now the cheapest
gap to close: `employee_document` is already registered, so 5 of its 6 tools are marked **A**.

**Built 2026-09-10 (DEC-147):** the work registry pass (`work_log`, `project_effort`, `timesheet`)
plus `work_my_log`, `work_effort_summary`, `work_team_effort`, `timesheet_status` and
`timesheet_team_status`. `work_log.description` landed as **SELF_ONLY**, which is what prerequisite
#1 said it had to be.

**Built 2026-09-10 (DEC-145):** `people_directory_lookup`, `people_department_roster`,
`org_department_tree`, `org_teams` — marked **BUILT** in the tables below.

**Built 2026-09-10 (DEC-146), not from this backlog:** `attendance_team_summary` and
`leave_taken_by_person` — the team-scoped counterparts DEC-144 made necessary. `leave_taken_by_person`
reads the LEDGER rather than `leave_request`, which has zero rows in the seed.

~~**Two of six roles get an empty catalogue.**~~ **Corrected 2026-09-10 (DEC-145) — measured, not
inferred.** `permittedTools` filters on the action, and the matrix cells for `finance` and
`auditor` do read `deny` on most of them. But **roles are additive and the seeded users also hold
`employee`** (`employee + finance`, `auditor + employee`), so `assertCan` passes on the employee
branch: they were already offered **21 and 23 tools** respectively, scoped by `scope()` to their
own rows. The original claim holds only for a hypothetical pure-role account, which is what a
matrix cell describes. This is DEC-062's rule seen from the other side — a privileged role does
not remove ordinary rights — and it is why per-role tool COUNTS must be measured against
`/assistant/capabilities` rather than read off the matrix.

---

## 1. `work` — 18 tools

Every action already exists. Every tool needs registry entries first (constraint 2), which is why
the whole domain is **R** rather than **A**.

| Tool | Action reused | Answers | |
|---|---|---|---|
| `work_log_today` | `work.log.read` | "what have I logged today?" | R |
| `work_log_entries` | `work.log.read` | "show my log for last Tuesday". Register `description` as `SELF_ONLY` — that is what makes ADR-0020 §6's narrative rule structural instead of a promise, exactly as `leave_request.reason` did | R |
| `work_effort_summary` | `work.log.read` | "how many hours did I put on ATLAS this month?" | R |
| `work_effort_by_day` | `work.log.read` | "how much did I log each day last week?" | R |
| `work_missing_logs` | `work.log.read` | "which working days have no log?" — mirrors `attendance_missing_days` | R |
| `work_hr_entered_logs` | `work.log.read` | "did HR enter effort for me?" — reads `entry_source` / `entered_by_employee_id` from migration 0028 | R |
| `work_my_projects` | `work.project.read` | "which projects am I on, and as what?" | R |
| `work_project_directory` | `work.project.read` | "which projects are active?" — project graph, so HR sees all and a non-member sees none | R |
| `work_project_members` | `work.project.read` | "who is on ATLAS?" — lead / project_manager only | R |
| `work_project_hierarchy` | `work.project.read` | "what can I log effort against?" — the four-level tree from migration 0027 | R |
| `work_my_tasks` | `work.task.read` | "what is assigned to me, and what state is it in?" | R |
| `work_task_status_summary` | `work.task.read` | "how many tasks are open on ATLAS?" — aggregated by project, never by person | R |
| `work_project_effort` | `work.project_effort.read` | "where did ATLAS's effort go this month?" — k = 5, alphabetical only, never ordered by minutes | R |
| `work_team_effort` | `work.team_effort.read` | manager: "how did my team's effort split across projects?" — k = 5, no ordering. `employee` is deny on this action | R |
| `timesheet_status_mine` | `work.timesheet.read` | "is last week's timesheet submitted? was it returned, and why?" | R |
| `timesheet_pending_approvals` | `work.timesheet.read` | manager / HR: "whose timesheets are waiting on me?" | R |
| `timesheet_history` | `work.timesheet.read` | "when did I submit it, and who approved it?" | R |
| `timesheet_compliance` | `work.timesheet.read` | HR / manager: "who has not submitted for last week?" | R |

---

## 2. `people` — 14 tools

| Tool | Action reused | Answers | |
|---|---|---|---|
| `people_directory_lookup` | `people.employee.list` | "what is Priya's work email / department / location?" The most-asked question with no tool behind it. Row scope is open and the **field mask** is what keeps personal data out — two separate concerns | **BUILT** |
| `people_manager_of` | `people.employee.list` | "who does Vishnu report to?" | A |
| `people_who_reports_to` | `people.employee.list` | "who are my reports?" / "who reports to Priya?" | A |
| `people_reporting_chain_of` | `people.employee.list` | the chain for a named person. `me_reporting_chain` covers the asker; the ancestor deny-override still governs personal detail | A |
| `people_department_roster` | `people.employee.list` | "who is in Engineering?" | **BUILT** |
| `people_headcount` | `people.employee.list` | "headcount by department as of 1 April?" — mirrors `/reports/headcount`, k = 5 | A |
| `people_new_joiners` | `people.employee.list` | "who joined this quarter?" | A |
| `people_work_anniversaries` | `people.employee.list` | derived from `joined_on`, which is PUBLIC. **Birthdays are deliberately excluded**: `date_of_birth` is SENSITIVE and `neverInList` | A |
| `people_probation_status` | `people.employee.personal.read` | "when does my probation end?" — `probation_end_on` is HR_AND_SELF | A |
| `people_confirmations_due` | `people.employee.personal.read` | HR / manager: "whose probation ends in the next 60 days?" Manager reach here is **direct reports only**, never the subtree | A |
| `people_leavers` | `people.employee.personal.read` | HR: exits in a period and last working day. `exit_reason` is RESTRICTED and stays out | A |
| `people_lifecycle_history` | `people.lifecycle.read` | "when was Vishnu confirmed / promoted / transferred?" | A |
| `people_employment_history_of` | `people.lifecycle.read` | the effective-dated assignment periods for a named person | A |
| `people_org_chart_as_of` | `people.employee.list` | "who reported to whom in March?" — via `fn_reporting_subtree_asof`. The temporal question no screen asks | A |

### Organisation structure — 5 tools, and the only ones `finance` and `auditor` can use

`org.unit.read` and `org.team.read` are **`allow` for all six roles**, with `scope: () => ALLOW_ALL`
— verified in `policies.ts` and the matrix, not assumed. They were described here as the cheapest
fix for "the two empty catalogues"; those catalogues were never empty (see above), so the actual
argument for them is that they are the only tools a **pure-role** finance or auditor account could
ever use, and the first tools in the catalogue that read organisation structure at all.

> **These tools are the FIRST consumer of `org.unit.read` and `org.team.read`.** Nothing in
> `apps/api/src` uses either action — there is no org-chart screen. ADR-0020 §1's usual guarantee,
> that a tool cannot reveal more than the equivalent detail screen, therefore has nothing to
> compare against here. The action, its policy and its matrix cells exist and are tested; the
> compensating control for the columns is the field registry, which is why every column returned
> appears in it.

| Tool | Action reused | | |
|---|---|---|---|
| `org_department_tree` | `org.unit.read` | the hierarchy as of a date, from `department_period` | **BUILT** |
| `org_department_detail` | `org.unit.read` | head, parent, headcount, description | A |
| `org_teams` | `org.team.read` | teams, lead, department, member count. **Returns `department_code`, not the name** — only the code is registered on `team`, and an unregistered column is dropped silently | **BUILT** |
| `org_team_members` | `org.team.read` | membership as of a date. **Re-marked R on 2026-09-10 (DEC-145): it is NOT buildable as an A.** Its rows are employees under resource `team`, where `employee_number` and `full_name` are unregistered, so every row masks to `{}`. It needs a registry decision first, not a SELECT list | R |
| `org_masters` (designations, work locations) | — | **No read action exists.** `leave_holidays` set the precedent of reusing a nearby action (`leave.balance.read`), and doing the same here is a DEC, not a developer's call | D |

---

## 3. `documents` — 6 tools, and one deliberate exclusion

`me_documents` is the only document tool today. Note the asymmetry this domain carries: **a line
manager gets nothing over their reports here**, unlike every other reporting-graph resource.

| Tool | Action reused | Answers | |
|---|---|---|---|
| `documents_expiring` | `documents.document.list` | "which of my documents expire soon?" — and org-wide for HR | A |
| `documents_for_employee` | `documents.document.list` | HR: metadata for a named person | A |
| `documents_versions` | `documents.document.read` | "how many versions of my Aadhaar are on file?" | A |
| `documents_pending_scan` | `documents.document.list` | HR: uploads still in quarantine | A |
| `documents_counts_by_type` | `documents.document.list` | counts only — naming the types would reveal who holds a medical certificate, which is why `/reports/documents` is counts-only too | A |
| `documents_missing_required` | `documents.document.list` | "what do I still need to upload?" Needs a `required` flag on `document_type`, which does not exist | D |

> **Deliberately excluded: a download tool.** A document read **is** the disclosure and carries an
> `audit_read` obligation, and a presigned URL is not a `SELECT`. The assistant should name the
> screen instead. Reconsidering this is an ADR-0020 change, not a tool.

---

## 4. `leave` — 9 additions to the existing 10

| Tool | Action reused | Answers | |
|---|---|---|---|
| `leave_preview_days` | `leave.balance.read` | "if I take 12–16 Oct, how many days does that cost?" — mirrors `/leave/preview`: working days, holidays, and optional holidays listed separately | A |
| `leave_pending_approvals` | `leave.request.read` | the manager / HR queue. `leave_requests` defaults to the asker (DEC-144), so the queue is a genuinely different tool | A |
| `leave_calendar_month` | `leave.request.read` | "who is off in October?" — a month grid, against `leave_who_is_off`'s window | A |
| `leave_carry_forward` | `leave.balance.read` | "how much carried into this year, and what is the cap?" | A |
| `leave_accrual_projection` | `leave.balance.read` | "how much CL will I have by December?" | A |
| `leave_encashment_and_lapse` | `leave.balance.read` | ledger entries of kind `encashed` / `lapsed`. **Days, never money** | A |
| `leave_optional_holiday_usage` | `leave.balance.read` | "how many optional holidays have I elected?" The election cap is **OR-06, still open** — the tool must say so rather than imply a number | A |
| `leave_negative_balances` | `leave.balance.read` | HR: accounts at or below zero | A |
| `leave_type_eligibility` | `leave.balance.read` | "am I eligible for maternity / paternity leave?" **Statutory**, and Handbook §1.3.4.5 is forbidden to implement in any form. Answer only from configured effective-dated data, or refuse. Never infer the law | D |

---

## 5. `attendance` — 6 additions to the existing 8

| Tool | Action reused | Answers | |
|---|---|---|---|
| `attendance_today_me` | `attendance.day.read` | "am I clocked in? how long have I worked?" — the punch card's own question | A |
| `attendance_my_policy` | `attendance.day.read` | "what is my grace period / expected hours?" The employee-facing half of `attendance_policy`, which is `config.policy.read` and therefore HR-only. **C8 is unresolved** — grace period and half-day threshold have no Handbook source, so the tool reports the configured number and badges it as a default | A |
| `attendance_reconciliation` | `attendance.day.read` | the ADR-0015 variance: attendance against approved leave. Reports it; offers nothing that would change either side | A |
| `attendance_week_off_pattern` | `attendance.day.read` | "which days are my week-offs?" | A |
| `attendance_worked_minutes_trend` | `attendance.day.read` | minutes per week over a period, self or in scope | A |
| `attendance_punch_locations` | `attendance.punch.read` | punches with geo from migration 0012. `attendance_punch` is registered, but the **geo columns carry SENSITIVE location data** and need a deliberate classification call before a tool returns them | D |

> **Not proposed: an overtime-entitlement tool.** No overtime policy exists. A tool that turned
> `worked_minutes` above expected into an entitlement would be inferring a statutory rule.
> `attendance_worked_minutes_trend` reports minutes and stops there.

---

## 6. `me` — 3 additions

| Tool | Action reused | Answers | |
|---|---|---|---|
| `me_emergency_contact` | `people.employee.read` | third-party contact data, `SELF_ONLY` in the registry — so it needs DEC-143's `selfOnly: true` class and its `inList: false` masking | A |
| `me_sessions` | `identity.session.read` | "where am I signed in? when did I last sign in?" — `identity` is unregistered | R |
| `me_access_log` | — | "who has looked at my record?" Genuinely valuable and DPDP-adjacent, but `audit.event.read` is hr_admin / auditor only. A self-scoped variant is a **new action**, which §1 puts outside the catalogue | D |

---

## 7. Payroll — the question left open on 2026-09-09

Context that must travel with this section: **OR-29.** `hrm_app` holds no grant on the payslip
tables, but the API still connects as the owner — so **the absence of the tool is currently the
only effective control.** Adding one does not add a feature, it removes a control.

| Tool | Action reused | | |
|---|---|---|---|
| `payslip_schedule` | `payroll.payslip.read` | period, `pay_date`, status, currency. **No amounts.** Answers "when is my salary credited?", which DEC-142 stopped refusing and nothing can yet answer. Touches no column on the red team's BANNED list. `selfOnly` | **Recommended** |
| `payslip_list_mine` | `payroll.payslip.read` | "is my September payslip issued? is the PDF available?" — amount-free, `selfOnly` | A |
| `payslip_net_mine` | `payroll.payslip.read` | **Blocked on two human decisions**: ADR-0020 §6 says "no tool reads compensation", and `net_minor` / `declared_net_minor` are on the `assistant:redteam` BANNED list — a CRITICAL, no-waiver gate. Aliasing the column to slip past the check would be gaming the gate, which CLAUDE.md forbids outright | D |
| `payslip_components_mine` | `payroll.payslip.read` | Blocked, and more strongly: a breakdown is compensation *structure*, not just a figure | D |
| `payroll_period_totals` | `payroll.payslip.read` | Not recommended. Amounts **and** an aggregate across people | D |

What already exists and would not need building for any of these: the `payroll.payslip.read`
action and its policies, the `payslip` field-registry entry, and the `/payslips` screen.

---

## 8. `config` and `audit` — 11 tools, and the only content `auditor` can reach

Both groups need a domain value added to `ck_assistant_message_domain` (constraint 3), **or** to be
filed under an existing domain the way `attendance_policy` sits in `attendance` and
`leave_types_and_rules` sits in `leave`. Filing them is the cheaper option and needs no migration.

| Tool | Action reused | Answers | |
|---|---|---|---|
| `config_settings_list` | `config.setting.read` | the current `org_setting` values | A |
| `config_policy_current` | `config.policy.read` | attendance / employment policy in force on a date | A |
| `config_policy_history` | `config.policy.read` | the effective-dated periods — "what was the grace period in March?" | A |
| `config_policy_impact` | `config.policy.read` | the impact preview from `/settings/policy/:kind/impact` | A |
| `config_leave_policy_by_type` | `config.policy.read` | accrual, cap and carry-forward per type as of a date | A |
| `config_document_types` | — | the type master and its data classes. No read action exists | D |
| `audit_events_for_employee` | `audit.event.read` | "what changed on this record, and who changed it?" | R |
| `audit_document_downloads` | `audit.event.read` | the `audit_read` obligation made answerable — "who downloaded this?" | R |
| `audit_break_glass_use` | `audit.event.read` | "was break-glass used, when, and by whom?" High value, and no screen shows it | R |
| `audit_assistant_turns` | `audit.event.read` | what the assistant was asked and refused — the `no_tool` backlog as a tool | R |
| `audit_actor_activity` | `audit.event.read` | an auditor's legitimate use, but it **must not order by volume**. Ordering people by activity is scoring with a different label, and §6 forbids it | D |

---

## 9. `cross` — 8 composite tools

ADR-0020 §5 authorises a composite **per section**: the actor must pass `assertCan` for each
component, and a component they fail is **omitted from the answer**, not cause to refuse all of it.

| Tool | Composes | Answers | |
|---|---|---|---|
| `cross_my_day` | attendance + punches + leave + effort + timesheet | "what does today look like for me?" | R |
| `cross_my_month` | attendance summary + leave taken + effort + timesheet status | the question that currently needs four separate tools | R |
| `cross_person_snapshot` | the same, for a named person in scope | manager / HR: "give me the picture on Vishnu for September" | R |
| `cross_team_today` | `attendance_team_today` + `leave_who_is_off` + timesheet lateness | the manager's morning question, in one answer | R |
| `cross_effort_vs_attendance` | attendance days against logged minutes | present with nothing logged; effort logged on an absent day. **No ranking** | R |
| `cross_leave_attendance_conflicts` | approved leave on days marked present | the ADR-0015 variance, per person | A |
| `cross_onboarding_readiness` | documents on file + probation date + assignment + first punch | HR: "is EMP014 fully set up?" | A |
| `cross_exit_readiness` | last working day + leave balance in **days** + open timesheets + documents | HR. The encashment *value* is money and stays out | A |

---

## 10. `meta` — 4 tools, no employee data, high value

| Tool | Answers | |
|---|---|---|
| `meta_capabilities` | "what can I ask you?" `/assistant/capabilities` exists as an endpoint but no question reaches it | A |
| `meta_where_do_i` | "where do I apply for leave / submit my timesheet?" A deterministic route map. No database read at all | A |
| `meta_glossary` | CL, SL, LOP, business date, week-off, effective-dated. Sourced from `ai/context/domain-glossary.md`. **Not** retrieval over the Handbook — RAG is the option ADR-0020 rejected, and this must not become it by accident | A |
| `meta_explain_refusal` | "why can't you tell me that?" Turns a dead end into an explanation | A |

---

## What each role gains

| Role | Today | With the **A**-marked tools |
|---|---|---|
| `employee` | own profile, leave, attendance | + own effort and timesheet, colleague lookup, org chart, probation date, document expiry, leave preview, pay date, "where do I…" |
| `manager` | team leave and attendance | + approval queues for leave **and** timesheets, team effort, timesheet compliance, confirmations due, one-shot team-today |
| `hr_admin` | leave and attendance, org-wide | + headcount, joiners and leavers, lifecycle, documents, policy history and impact, audit trail, reconciliation, onboarding and exit readiness |
| `hr_ops` | as hr_admin, minus audit | + the same, minus audit and payslips |
| `finance` | **nothing** | org chart, teams, amount-free payslip status |
| `auditor` | **nothing** | config current and history, audit events, break-glass, org chart |

---

## Prerequisites, in dependency order

1. ~~**Field-registry entries** for `work_log`, `timesheet`, `project_effort`~~ — **done 2026-09-10
   (DEC-147)**, with `description` as `SELF_ONLY`. Still unregistered: `task`, `project`,
   `audit_event`, `identity`, `designation`, which is what still blocks the project-graph and
   audit tools.
   `work_log_entry.description` must land as `SELF_ONLY`, which is what makes §6's narrative rule
   structural. The leave and attendance types went through exactly this in ADR-0020's own registry
   pass, and the comment there records why: the endpoints build column lists by hand, so the
   registry was not protecting those tables — it was simply absent.
2. **Decide the salary question.** `payslip_schedule` needs no gate change and answers the real
   question; `payslip_net_mine` needs an ADR amendment **and** a red-team gate change, and both are
   human decisions. Record the outcome as a DEC either way.
3. **Migration 0030** if `config` and `audit` become routing domains. Filing those tools under
   existing domains avoids it.
4. **A DEC per missing read action** — designation master, work location master, document type
   master, and an employee's own access log. Four separate calls. `leave_holidays` reusing
   `leave.balance.read` is the precedent to argue from; §1 is the constraint to argue against.
5. **Per tool, two test obligations.** A red-team cell asserting the tool's rows **equal** the rows
   the equivalent endpoint returns for that role, and paraphrase coverage in `assistant:accuracy`.
   `testing/assistant/accuracy.test.mjs` is wired in `package.json` but **does not exist yet**, so
   the first tool added also builds that harness.

## Suggested first slice

`people_directory_lookup`, `meta_where_do_i`, `org_department_tree`.

Three **A** tools: no registry work, no migration, no decision. The third gives `finance` and
`auditor` an assistant for the first time, and the first answers the most common question the
catalogue currently refuses.

## The trade this backlog is an instrument for

ADR-0020 accepted that "coverage is bounded by anticipation" and named the `no_tool` log as the
correction mechanism. **This document is anticipation, not evidence.** Where the log disagrees with
it, the log wins — and a sustained volume of questions that no tool here could serve is the
signal ADR-0020's *Reconsider when* section is waiting for.
