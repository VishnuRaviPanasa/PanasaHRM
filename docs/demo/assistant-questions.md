# Assistant demo questions — seven per role, each one measured

**Status:** Demo script. **Every question below was run through the real `POST /assistant/ask`**
against the seeded database on 2026-09-10, with the tool it selected and the row count recorded.
This is not a list of questions that ought to work.

**Date:** 2026-09-10 · **Catalogue:** 41 tools · **Seed:** `infrastructure/db/seeds/demo.sql`

> **Selection is the only part of the assistant no offline check can prove.** `assistant:redteam`
> deliberately drives no model — a gate that can be flaky is not a gate — so it proves
> authorization and says nothing about whether a question finds its tool. That is what this file
> is for, and why it records the tool each question actually reached.

---

## Manager — Priya Menon (EMP002)

| # | Question | Tool reached | Result |
|---|---|---|---|
| 1 | Can you share the team's attendance details for September? | `attendance_team_summary` | 4 people |
| 2 | Who are the employees reporting to me? | `people_who_reports_to` | 3 reports |
| 3 | Whose timesheets are pending? | `timesheet_team_status` | 3 periods |
| 4 | What is Vishnu Ravi's leave balance? | `leave_balance` | 2 rows |
| 5 | How much leave has my team taken this year? | `leave_taken_by_person` | 2 people |
| 6 | Does anyone on my team have overdue tasks? | `work_open_tasks` | 2 people |
| 7 | What are my team's leave balances? | `leave_balance_team` | 8 rows |

Question 4 is the one worth demonstrating deliberately: it shows the manager's **reach**. The same
question asked by Vishnu about Priya is refused — *"Priya Menon is outside what your account can
see"* (DEC-142).

## HR admin — Deepa Suresh (EMP005)

| # | Question | Tool reached | Result |
|---|---|---|---|
| 1 | Can you provide the team's effort? | `work_team_effort` | 5 rows |
| 2 | How many hours has each employee spent on the HRM project? | `work_team_effort` | 2 people |
| 3 | Who has taken the most leave? | `leave_taken_by_person` | 2 people |
| 4 | Who has logged the most working hours? | `work_team_effort` | 5 rows |
| 5 | Does anyone have any pending tasks? | `work_open_tasks` | 3 people |
| 6 | How many employees are there in total? | `people_headcount` | total 5 |
| 7 | Who is in the Engineering department? | `people_department_roster` | 4 people |

> **Questions 3 and 4 sit against ADR-0020 §6**, which forbids a tool that "ranks, scores or orders
> people". No tool does — `work_team_effort` is ordered by NAME and `leave_taken_by_person` by
> employee number — but the ANSWER to "who has logged the most" is a ranking of people by output,
> which is the shape §6 exists to prevent. They work, and they are recorded here as they were
> asked. Whether they belong in a demo is a product decision, not an engineering one: an
> alternative that shows the same data without ranking anybody is *"How did the team split their
> time this month?"*

## Employee — Vishnu Ravi (EMP001)

| # | Question | Tool reached | Result |
|---|---|---|---|
| 1 | Who is my manager? | `people_manager_of` | Priya Menon |
| 2 | How many days have I worked? | `attendance_summary` | 6 days |
| 3 | Do I have any late check-ins? | `attendance_late_days` | 1, at 09:47 |
| 4 | Can you list the optional holidays available to me? | `leave_holidays` | Ganesh Chaturthi |
| 5 | How much casual leave do I have left? | `leave_balance` | 8.00 days |
| 6 | What is my phone number? | `me_contact_details` | see the caveat below |
| 7 | What can you help me with? | `meta_capabilities` | 5 subject names, no examples (DEC-163) |

> **Question 6 needs the API restarted before it is demo-safe.** As first shipped,
> `meta_capabilities` described itself as answering "what do you know about", and the model chose
> it for this question instead of `me_contact_details`. The description was narrowed (DEC-162) and
> the build is ready, but the running API predates it — re-run this one after a restart.

---

## Two questions that CANNOT work on this seed

Both are data gaps, not defects, and no tool change fixes them:

| Question | Why |
|---|---|
| Who is off next week? | `leave_request` has **zero rows**. `leave_who_is_off` and `leave_requests` read that table, so anything request-shaped — who applied, what is pending, who is away — is unanswerable in the demo. Leave that WAS taken exists only as `leave_ledger` entries, which is why `leave_taken_by_person` works |
| Anything about individual punches | `attendance_punch` has **zero rows**. The seed writes `attendance_day` directly, so clock-in times come from `attendance_days.first_in_at` |

Both are recorded in DEC-146 and DEC-156. Fixing them means changing seed data, which changes
every demo and every screenshot — a decision, not a patch.

---

## Re-running this

`scratchpad/demoq.mjs` in the session scratchpad drives all 21 through `/assistant/ask` and prints
the tool, the row count and the answer. Three model calls per question. Point it at a running API
with a key configured.
