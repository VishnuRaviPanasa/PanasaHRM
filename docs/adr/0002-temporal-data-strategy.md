# ADR-0002: Temporal Data Strategy - Effective-Dated Records

## Status

Proposed

> Only a human may set this to Accepted. Once Accepted this file is immutable and
> `.claude/hooks/guard-adr.mjs` will refuse edits - supersede it with a new ADR instead.

## Date

2026-09-08

## Context

HR questions are inherently historical: which department was this person in on 31 March, who approved that request, what was the policy when this leave was taken. Payroll, statutory registers and audit all depend on reconstructing past state. Getting this wrong is not a bug that can be patched - it is data that was never recorded.

## Options considered

| Option | Summary | Why not chosen |
|---|---|---|
| Overwrite with an audit log | Current row only; history reconstructed from audit entries | The audit log records that a change happened, not a queryable prior state. "Show the org chart as of 1 April" becomes a replay exercise, and reports become unwritable |
| Current table + history table | A shadow table per entity | Every as-of query must union two shapes, and the two drift. Doubles the surface for the same information |
| Full event sourcing | Events as the only truth, state as a projection | Real cost in complexity and query difficulty, to buy replay semantics the requirement does not ask for |
| **Effective-dated row versioning (chosen)** | daterange validity per row, enforced by EXCLUDE constraints | - |

## Decision

**Effective-dated row versioning**, governed by a rule rather than a fixed list:

> **A table is effective-dated if a historical recomputation would give a different answer when
> one of its values changes.** If yes, it carries the period columns and constraints below. If no,
> it is mutable. (This is the same dividing test ADR-0019 applies to configuration; the two are
> deliberately one rule, not two.)

Known to satisfy the rule at the time of writing: `employment`, `reporting_relationship`,
`compensation`, `leave_policy`, `attendance_policy`, `employment_policy`,
`employee_holiday_calendar`, `wf_delegation` and `user_role`.

> **Amended 2026-09-08 (pre-acceptance):** this was a closed enumeration, and it was already
> incomplete on the day it was written - `attendance_policy` and `employment_policy` had shipped
> in migration 0002 without appearing in it. Acceptance would have frozen a wrong list. It is now
> a rule with a non-exhaustive list of instances.
>
> **Identified as satisfying the rule but not yet modelled:** `shift_roster` (ADR-0011 requires it
> as a snapshotted input for attendance recompute) and `work_policy` (ADR-0015's variance
> threshold). **Identified as being in the wrong class today:** `leave_type.reduces_attendance` /
> `is_paid` and `org_setting['company.timezone']`, all of which are historical derivation inputs
> sitting in mutable storage. Migrating them is tracked as **OR-11** and is not yet done.

Every such table carries:

```sql
valid_from   DATE NOT NULL,
valid_to     DATE,                        -- NULL = open-ended
valid_period daterange GENERATED ALWAYS AS (daterange(valid_from, valid_to, '[)')) STORED,

CONSTRAINT ex_<table>_no_overlap EXCLUDE USING gist (
    <entity_id> WITH =, valid_period WITH &&
),
CONSTRAINT ck_<table>_not_empty CHECK (NOT isempty(daterange(valid_from, valid_to, '[)')))
```

Requires the `btree_gist` extension. **The `NOT isempty` CHECK is mandatory**, not optional - see the negative consequences.

Changes create a **new period**; a historical period is never updated in place.

### How that is enforced (added 2026-09-08, pre-acceptance)

The sentence above was, until migration `0004_effective_dated_immutability.sql`, enforced by
**nothing**. `fn_block_mutation()` existed and was applied to `outbox_event` and `audit_event`,
but never to the effective-dated tables, so an in-place `UPDATE` of a historical policy period was
accepted by the database - the exact outcome ADR-0019 exists to prevent.

Every effective-dated table therefore carries `fn_block_historical_mutation()` as a
`BEFORE UPDATE OR DELETE` trigger, which:

- **forbids** `DELETE`, in-place value changes on current *or* historical rows, re-opening a closed
  period (`valid_to` → `NULL`), and back-dating `valid_to` before today;
- **permits** `INSERT` of a new period, forward-dated closure of the currently-open period
  (optionally with a `reason`), and changes to badge metadata that cannot affect resolution.

`testing/db/0004_effective_dated_immutability.verify.sql` proves each of those, including a
catalogue check that **no table carrying a `valid_period` column is left without the trigger** - so
a future effective-dated table added without protection fails verification rather than shipping
silently.

**Two limits, stated rather than implied.** The trigger cannot stop the table *owner* running
`ALTER TABLE ... DISABLE TRIGGER`; the mitigation is grant separation, and the application role
does not exist yet. And a genuine *retroactive correction* - a value that was recorded wrongly -
has no sanctioned path at all, by design. That needs its own decision (a correction table, or
supersede-with-annotation); until it exists such a change requires a reviewable migration.

## Consequences

### Positive

- As-of queries are a single predicate: `WHERE valid_period @> $date`
- The exclusion constraint makes overlapping periods impossible at the database level, so no application bug can produce contradictory history
- The constraint index also serves the as-of query, so correctness and performance come from the same object

### Negative / trade-offs

- Every read on these tables must carry a temporal predicate. Forgetting one silently returns the wrong row, and the mistake is invisible until someone checks a historical report
- **Empty ranges defeat the exclusion constraint.** `daterange(x, x)` is empty, and `empty && anything` is false - so a zero-length row slips past, then matches no as-of query and the record silently vanishes. This is why the `NOT isempty` CHECK is mandatory
- `valid_to IS NULL` does NOT mean "current" - a future-dated transfer also has a NULL end. Application code must query as-of a date, never test for NULL

## Reconsider when

**Never for these entities.** This is foundational; retrofitting it after leave and attendance depend on it would mean rebuilding both.
