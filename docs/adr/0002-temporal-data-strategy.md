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

**Effective-dated row versioning** on `employment`, `reporting_relationship`, `compensation`, `leave_policy`, `employee_holiday_calendar`, `wf_delegation` and `user_role`.

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
