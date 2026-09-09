# Session Handoff

**Last session:** 2026-09-09
**Slice worked:** MST-01 — HR masters (after PAY-01 payslips, RPT-01 reporting)
**Branch:** `main`, **nothing committed** (CLAUDE.md Rule 14 — no commit without an explicit request)

---

## Completed this session

| Area | What landed |
|---|---|
| Migration **0020** | Seven per-employee reporting functions: headcount movement, leave liability, attendance summary, WFH usage, attendance-vs-effort, timesheet compliance, document compliance |
| Migration **0021** | Fix: `fn_document_compliance` counted the ROW not the KEY over its LEFT JOIN, reporting a phantom pending scan for every employee with no documents |
| Migration **0022** | Task reporting: `fn_task_status` (per assignee) and `fn_project_task_status` (per project, and the only cut that can see unassigned work) |
| Migration **0023** | Fix: `fn_task_status` published its subject as `employee_id`; authz renders `assignee_employee_id`, so every SCOPED caller got a 500 while HR worked |
| `packages/authz` | New `task` resource type, `work.task.read` action, policy identical to `work.log.read`, matrix entry, subject column declared in `EMPLOYEE_COLUMN` |
| `apps/api/src/reports.ts` | Nine endpoints — index, headcount, leave, attendance, wfh, reconciliation, timesheets, documents, tasks, effort — every one composing `scope()` into the SQL |
| `apps/web/.../reports/page.tsx` | Nine-tab reports UI, tab strip driven by `GET /reports` rather than by a role check |
| Seed | Task assignees and relative due dates, chosen so every counter has a reason to be wrong; two tasks left deliberately unassigned |
| Tests | `testing/db/0020_reporting.verify.sql` (15), `testing/db/0022_task_reporting.verify.sql` (10), `testing/demo/reports-scope.test.mjs` (63) |
| `apps/web/.../layout.tsx` | Shell rebuilt: grouped **sidebar** (My records · My team · Organisation · Administration) replacing a 12-item top bar whose labels wrapped; self-sizing flex column, no hand-measured header height |
| `testing/demo/nav-shell.test.mjs` | New `nav:test` (19) - every nav href resolves, and the two glossary naming rules are enforced mechanically |
| Migration **0024** | Payslip records: component catalogue (configuration), `payslip` with a generated half-open period + one-live-per-period EXCLUDE, `payslip_line` (signed integer paise), FSM-as-data + append-only `payslip_event` with no self-issue, `fn_payslip_totals`, the issue guard, `fn_audit_payslip`, and the Tier 1 REVOKEs + `hrm_payroll` role |
| Migration **0025** | Fix: the writer flag leaked, making `payslip.status` directly writable for the rest of the transaction — and through that re-opening an ISSUED payslip's lines and document link |
| `packages/authz` | `payslip` resource type, `payroll.payslip.read` / `.manage`, the **compensation deny-override** DEC-041 deferred, 7 named threat cases, field registry entries (hr_admin + finance + self only) |
| `apps/api/src/payroll.ts` | 10 endpoints: components, list, detail, create, patch, attach PDF, issue, void, history, document stream |
| `apps/web` | `/payslips` (My payslips), `components/payslips.tsx` (detail + list + HR's add form), Payslips card on the employee profile, nav entry |
| Seed | 6 issued payslips across 2 employees × 3 months, with real PDFs uploaded to MinIO and their true digests recorded |
| Docs | `docs/privacy/data-inventory.md` — pay data classified (the Forbidden-Actions gate) |
| Tests | `testing/db/0024_payslip_records.verify.sql` (26), `testing/demo/payslip-flow.test.mjs` (79) |
| Also fixed | 0019 **W14/W15 were silently skipping** (DEC-079); the seed's teardown order and object keys (DEC-078) |
| `apps/web/components/punch-card.tsx` | Rebuilt around three states — the action is the hero when there is nothing to report; retention detail behind a disclosure, consent line kept beside the button |
| Also fixed | The seed fabricated today's DERIVED attendance verdict (DEC-083); my own state discriminator repeated it (DEC-084); **0012 N9 and 0016 I11 were order-dependent** (DEC-085); `payslip:test` was eroding the seeded payslips (DEC-086) |
| Migration **0026** | A department cannot be placed inside its own subtree — the cycle was creatable, and its cost was a silently understated headcount, not an error |
| `apps/api/src/org.ts` | Department + designation masters: as-of list with headcount rollup, create, rename, re-parent, retire/reinstate |
| `apps/api/src/people.ts` | Employee master: create (employee + employment + joined event in one transaction), edit, change assignment |
| `apps/web/.../organisation` | The masters UI, plus Add employee on the directory and Change assignment on the profile |
| **OR-18 closed** | Personal data through the policy + field registry; HR gets what it needs, `emergency_contact_*` and `blood_group` stay SELF_ONLY, and the WRITE list is derived from the READ mask |
| Tests | `testing/demo/masters-flow.test.mjs` (49), 0017 checks G19–G21, `privacy:test` re-pinned 18 → 20 |
| Decisions | **DEC-060 … DEC-093** |
| Risks | **OR-26** (tasks read-only), **OR-27** (no export/pagination), **OR-28** (nobody can pay the payroll admin's manager), **OR-29** (Tier 1 not yet effective — API runs as owner), **OR-30** (payslip PDFs cleared without a scanner), **OR-31** (8-year retention not derived from statute) |

**1,109 automated checks, 0 failures.** See `CURRENT_SLICE.md` for the per-suite bar.

---

## The defects worth remembering from PAY-01, all found by RUNNING code

1. **The writer flag leaked, and one leaked GUC undid four controls** (DEC-075). `SET LOCAL` is
   scoped to the TRANSACTION, not the function — a function's own `SET` clause restores only the
   parameter it names. So after one legitimate transition `payslip.status` was directly writable,
   and with the status forged back to `draft` both freeze triggers correctly concluded the payslip
   was still a draft: an ISSUED payslip's amounts became editable and its `document_id`
   re-pointable at another employee's PDF. Neither trigger was at fault. **0007 already had this
   trap and its check V6 exists for it** — the shape just wasn't reused.
2. **Three smoke checks passed for the wrong reason.** Self-issue, an invented transition and the
   flag-leak test were all refused by an *earlier* guard (no document attached) or by a different
   CHECK, so none exercised what it claimed. The leak was invisible until each check was rebuilt
   to be the only thing that could fail.
3. **My negative test accepted a 500** (DEC-080). `check('a duplicate is refused', !dup.ok)` is
   true of any non-2xx, which is how a bare "Internal server error" survived where HR needed an
   actionable message. Assert the status.
4. **0019 W14/W15 were silently SKIPPING** (DEC-079). Not failing — skipping, because they
   borrowed a seeded draft timesheet that `demo:test` submits. `db:verify` reported 230 where 232
   was expected and nothing else complained. **Check the count, not just the absence of failures.**
5. **Two of my own fixtures were wrong and a check caught each** (DEC-078). D15 refused the seed
   for putting an employee number in an object key — while my comment claimed the keys carried no
   personal data. D9 refused the seed's digest rewrite, because a version's hash is immutable.

## The four defects worth remembering from RPT-01, all found by RUNNING code

1. **An employee's own attendance report returned 404.** A report is a collection request with no
   subject, and the self-scoped policies are written around `isSelf`, which an empty ref cannot
   satisfy — so `assertCan` denied before `scope` was ever computed. Fixed by having the ref carry
   the caller as its own subject (DEC-061): `assertCan` answers *may you read this type at all*,
   `scope` answers *whose rows*.
2. **`/reports/tasks` was 200 for HR and 500 for everybody else** (DEC-064). HR's predicate is
   `ALLOW_ALL`, which renders as literal `true` and names no column, so it never touched the
   mis-named subject column that broke every scoped caller. **A smoke test against HR alone would
   have passed.** Check the roles whose predicates actually reference columns.
3. **A phantom `pending_scan = 1`** for four employees who had uploaded nothing (0021):
   `COUNT(*)` over a LEFT JOIN counts the all-NULL row, and `d.withdrawn_at IS NULL AND
   d.current_version_id IS NULL` is true of it, twice. Count the KEY. 0022 was written with this
   in mind and its verify check TK5 pins it.
4. **My own test expectation was wrong, not the code** (DEC-062). I had asserted the documents
   report was HR-only; the policy has always admitted an employee to their own documents, and
   refusing the report would have made it stricter than the `/documents` screen it summarises.
   Verified what the employee actually receives *before* relaxing the assertion.

---

## Exact next action

**Finish OR-19 — the authorization retrofit — starting with `apps/api/src/hr.ts`.**

Unchanged by PAY-01, and now the largest standing violation by some distance: `payroll.ts`,
`reports.ts`, `documents.ts` and `settings.ts` all resolve every decision through
`AuthorizationService`, while `hr.ts`, `leave.ts` and most of `work.ts` still decide in the
controller and in raw SQL.

This is now the largest standing violation of Must-Know Rule 1, and reporting made it more
visible rather than less: `/reports` resolves every decision through `AuthorizationService`, while
the screens those reports summarise still decide in the controller and in SQL. Concretely:

Line numbers below were re-verified at the end of this session with
`grep -nE "hr_admin' OR|= 'hr_admin'"` — check them again before editing, they move.

1. `hr.ts` — dashboard and employees. Three separate checks: the inline SQL predicate
   `($2 = 'hr_admin' OR em.manager_id = $1)` at **`hr.ts:44`** and **`hr.ts:52`**, and a
   TypeScript role comparison at **`hr.ts:19`** (`me.role === 'manager' || me.role ===
   'hr_admin'`). Compose `scope()` instead. The pattern to copy is `reports.ts` `gate()`, which
   returns a rendered predicate rather than rows precisely so the caller cannot fetch-then-filter.
2. `leave.ts` — the SQL predicate at **`leave.ts:175`**, and a different form at
   **`leave.ts:201`** (`me.role !== 'hr_admin' && r.manager_id !== me.employeeId`), which is a
   role check and a graph traversal fused into one condition.
3. `work.ts` — the SQL predicate at **`work.ts:406`**, **`work.ts:527`** and **`work.ts:539`**.
   The timesheet *decide* route is already retrofitted (DEC-058); these are the remaining three.
4. Then the **fail-closed global guard** plus the `assertPolicyCoverage` boot assertion, so a
   route with no policy refuses to start rather than silently allowing.

Do it with the matrix as the oracle, not as documentation: `settings` (DEC-053) proved the matrix
was right and the route was wrong for as long as nothing compared them.

### After that, in order

- **AUDIT-01** — Must-Know Rule 2 is still unsatisfied on every write path: domain events and
  outbox rows in the same transaction as the write. `audit_column_policy` still holds 0 rows.
  Identity is the exception (DEC-042) and is the pattern to follow.
- **Module 1 write endpoints** — create/edit employee, lifecycle transitions, MSS, org chart.
  Blocked-adjacent: **OR-15**, nothing calls `fn_refresh_due_employment_status()`, so a
  future-dated joining or exit never materialises. Read through
  `fn_employment_status_asof(employee, fn_business_date())` rather than the cache until a
  scheduler exists.
- **Module 3 endpoints and UI** (OR-22) — schema and resolvers are done and verified; this is
  presentation work.
- **Task write endpoints** (OR-26) — the task report surfaces unassigned work and nothing in the
  product can assign it.

### Needs a human, not a developer

**OR-16** (`blood_group` purpose, emergency-contact third-party data) · **OR-18** (`hr_admin`
cannot see personal data — a deliberate default-deny that is also a functional regression) ·
**OR-23** (no virus scanner behind the quarantine gate) · **OR-24** (no two-bucket split, MinIO
posture, no EXIF stripping) · **OR-25** (an employee cannot see their own RESTRICTED documents) ·
**OR-20** (Entra is unbuildable and unverifiable from this environment).

---

## Traps this repo keeps re-learning

1. **A check must create its own fixture.** Four occurrences now — 0014 L13, 0017 G5, 0012 N8,
   and the task report, whose seeded tasks were all unassigned so the report was empty and any
   test over it asserted nothing.
2. **Exercise the roles whose predicates name columns.** `ALLOW_ALL` renders as `true` and hides
   every column-level mistake, so HR passing proves the least.
3. **`COUNT(*)` over a LEFT JOIN counts the phantom row.** Count the key.
4. **Add the column, backfill, *then* add the constraint.** 0016 (`password_algo`) and 0019
   (`ck_task_closed_coherent`) both failed this way.
5. **The database is usually right.** `fn_task_assignee_is_member` refused a seed I had just
   commented as unenforced.
6. **Verify counts on stderr.** `db:verify` emits `NOTICE:  PASS`; redirect with `> log 2>&1`.
7. **A check must fail for its OWN reason.** Three payslip smoke checks were refused by an
   earlier guard and proved nothing. Build the fixture so the thing under test is the only thing
   that can refuse.
8. **Check the check COUNT.** A skipped check is silent; a failed one is loud. 0019 lost two for a
   while and only the total showed it.
9. **`!res.ok` is not an assertion.** It accepts a 500. Name the status.
10. **`SET LOCAL` lasts the transaction, not the function.** Clear a writer flag immediately after
   the statement it exists for.
11. **`LIMIT 1` with no `ORDER BY` is not a fixture.** Three occurrences (0017 G14, 0016 I11).
   Whichever row the planner reaches first is not a stable choice.
12. **Fix the PATTERN, not the instance.** DEC-059 recorded the append-only-punch trap for N8;
   N9 sat beside it with the same weakness for a whole session. Grep the file.
13. **A derived TOTAL cannot tell you whether something happened.** It is allowed to be zero.
   Ask the log.
14. **A test must not degrade the fixture it runs against.** Idempotent about its own leftovers is
   not the same as harmless.
15. **A client must never compute the business date.** `new Date().toISOString()` is the previous
   day for 5.5 hours out of every 24 in IST. Ask the server (DEC-091).
16. **"The traversal is safe" is not "the data is valid".** 0017 proved a cycle terminated the
   walk and left the cycle creatable; the walk then returned a WRONG answer silently (DEC-088).
