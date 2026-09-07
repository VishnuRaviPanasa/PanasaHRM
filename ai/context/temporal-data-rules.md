# Temporal Data Rules

**Authority:** implements ADR-0002. **Read before touching any effective-dated table or writing
any as-of query.** Editing this file requires architecture review.

> This is the highest-value file in `ai/context/`. The temporal model is the one thing in this
> system that cannot be retrofitted: leave, attendance, work logs, payroll and every historical
> report read through it. Getting it wrong is not a bug you patch — it is data you never recorded.

## Which tables are effective-dated

`employment` · `reporting_relationship` · `compensation` · `leave_policy` ·
`employee_holiday_calendar` · `wf_delegation` · `user_role` · `project_member` · `work_policy`

Everything else is either **append-only** (ledgers, audit, punches, transition logs) or
**mutable reference data** (a designation's display name).

## The pattern — copy it exactly

```sql
valid_from   DATE NOT NULL,
valid_to     DATE,                         -- NULL = open-ended
valid_period daterange GENERATED ALWAYS AS (daterange(valid_from, valid_to, '[)')) STORED,

CONSTRAINT ex_employment_no_overlap EXCLUDE USING gist (
    employee_id     WITH =,
    assignment_slot WITH =,
    valid_period    WITH &&
),
CONSTRAINT ck_employment_not_empty
    CHECK (NOT isempty(daterange(valid_from, valid_to, '[)')))
```

Requires `CREATE EXTENSION btree_gist;` for the `uuid WITH =` operator class.

Note `'[)'` — **half-open**. A period ending 31 March and one starting 1 April do not overlap.
Closed ranges `'[]'` would make consecutive periods collide, and every transfer would fail.

## The five rules

### 1. `CHECK (NOT isempty(...))` is mandatory, never optional

`daterange('2026-04-01','2026-04-01','[)')` is **empty**, and `empty && anything` is **false**.
A zero-length row therefore slips straight past the exclusion constraint, then matches no as-of
query — so the employee silently vanishes from every report, for reasons nobody can reproduce.

A badly-implemented period split produces exactly this. Omitting the CHECK is **CRITICAL**.

### 2. `valid_to IS NULL` does NOT mean "current"

HR enters transfers weeks ahead. A future-dated row has `valid_to IS NULL` **and**
`valid_from > CURRENT_DATE`. Any query testing for NULL therefore reports the *future* as the
present: an employee appears in their new department before the transfer takes effect, and cost
allocation lands on the wrong cost centre.

```sql
-- WRONG. Silently returns future-dated rows.
SELECT * FROM employment WHERE employee_id = $1 AND valid_to IS NULL;

-- RIGHT.
SELECT * FROM employment WHERE employee_id = $1 AND valid_period @> CURRENT_DATE;
```

Use the view `v_employment_current`, which bakes this in. **A lint rule bans `valid_to IS NULL`
in application queries.** There is a regression test that inserts a future-dated row and asserts
the current view excludes it.

### 3. Changes create a new period; never UPDATE a historical one

A promotion, transfer or manager change is: close the open period, insert a new one, in **one
transaction**.

```sql
-- close
UPDATE employment SET valid_to = $effective_date
 WHERE employee_id = $1 AND assignment_slot = 1 AND valid_period @> $effective_date;
-- open
INSERT INTO employment (employee_id, assignment_slot, ..., valid_from, valid_to)
VALUES ($1, 1, ..., $effective_date, NULL);
```

Because ranges are half-open, the closing `valid_to` and the opening `valid_from` are the **same
date**. This is correct, not an off-by-one.

### 4. Read as-of the right date — and there are three different ones

| Date | Use it for |
|---|---|
| `CURRENT_DATE` | "Who reports to me *now*" — actions and permission checks on live operations |
| The **record's** effective date | Reading history: who approved this, which department was this attributed to. A manager's authority over a record resolves as of **the record's** date, not today — this is what makes a former manager lose access automatically |
| A **user-supplied** as-of date | Reports and the "as of" control in the UI |

Never default to `CURRENT_DATE` in a report. Pass the date explicitly.

### 5. Bitemporality lives in exactly one place

Full bitemporal modelling — valid time × transaction time on every row — doubles the complexity
of every query, for a need that arises in one place: a **reversal** must record when the thing
was true separately from when we recorded it.

That is handled by `leave_ledger` carrying both `effective_on` (valid time) and `created_at`
(transaction time), plus the immutable audit log. **Do not add a second range to other tables.**

**Accepted limit, stated so nobody is surprised:** the operational tables cannot answer *"what
did the June report say, in June?"* Only the frozen payroll snapshot and the audit log can.

## The reporting hierarchy

Adjacency list, effective-dated, plus a trigger-maintained closure table for the current state.

- `reporting_relationship (employee_id, manager_employee_id, relationship_type, valid_*)` with
  `relationship_type ∈ solid | dotted | functional`
- `reporting_closure_current (manager_employee_id, employee_id, depth)` — **current state only**,
  the RBAC hot path: `isDirectReport` is `depth = 1`, `isInSubtree` is `depth >= 1`
- Historical "all reports of X as of D" uses a recursive CTE over `reporting_relationship`
  filtered by `valid_period @> D`. Slower, but it runs on report screens, not every request

A **cycle-rejection trigger** is mandatory. A cycle makes everyone transitively everyone's
manager, which is a privilege-escalation bug, not a data bug.

## Canonical queries — use these, do not reinvent them

Two functions exist because ad-hoc org attribution produces three different answers to the same
question, and all three will appear in the codebase within a year:

- `fn_headcount_asof(date)` — point-in-time, `valid_period @> $date`
- `fn_cost_allocation(month)` — period-weighted, `days_in_period / days_in_month`

A period-weighted report must sum **FTE-days**, not employees, or its total will not reconcile
to headcount — and someone will spend a week discovering that.

## Concurrent assignments

`assignment_slot` makes dual employment representable. The hard part is that most joins get
written as `JOIN employment ON employee_id` **without** a slot filter, which silently doubles
headcount, attendance and accrual.

**Never expose `employment` to the repository layer.** Expose `v_employment_primary`, with
`assignment_slot = 1` baked in.

If dual employment is not needed at launch, keep the column and add `CHECK (assignment_slot = 1)`,
dropped when the feature ships. That keeps the constraint shape right at zero cost.

## Testing — non-negotiable

1. **Property-based**: for random sequences of hire/transfer/promote/exit events, assert no
   overlapping periods and that as-of queries stay internally consistent.
2. **Empty-range test**: attempt to insert a zero-length period; assert `23514`.
3. **Future-dated test**: insert a future transfer; assert the current view excludes it.
4. **The canary** — this exact query is a fixture from day one:

   > *"Show the org chart as of 1 April 2024, including people who have since left, with their
   > then-current manager, department and legal entity."*

   It fails the moment anyone adds a global `WHERE employee.status = 'active'` to a shared
   repository method — **the single most natural piece of wrong code to write in this system.**
   If this test passes, the temporal design is working.

## Review checklist

- [ ] Every effective-dated table has both the `EXCLUDE` **and** the `NOT isempty` CHECK
- [ ] No application query tests `valid_to IS NULL`
- [ ] Writes close-and-open; no UPDATE of a historical period
- [ ] Reads pass an explicit as-of date, and it is the *right one* of the three
- [ ] Joins to `employment` go through a slot-filtered view
- [ ] Reports use the canonical functions, not ad-hoc attribution
