# ADR-0011: Attendance - Immutable Punches, Derived Days, Partitioned

## Status

Proposed

> Only a human may set this to Accepted. Once Accepted this file is immutable and
> `.claude/hooks/guard-adr.mjs` will refuse edits - supersede it with a new ADR instead.

## Date

2026-09-08

## Context

Attendance feeds payroll, so it must be defensible. It is also the highest-volume data in the system, and its rules change retroactively - a shift correction, a late-arriving punch, or a holiday added by government order all require recomputing days that were already calculated.

## Options considered

| Option | Summary | Why not chosen |
|---|---|---|
| A single mutable attendance table | One row per employee-day, edited in place | A corrected row loses the evidence it was derived from, so "why was I marked absent" becomes unanswerable, and a later policy change cannot be recomputed |
| Punches only, derive on read | No stored daily result | Every report recomputes months of data, and the answer can silently change after a policy edit - including for periods already paid |
| **Immutable punches plus a derived daily table (chosen)** | Raw facts preserved, verdict materialised and explainable | - |

## Decision

**`attendance_punch`** holds immutable facts. `business_date` is computed at ingest and **stored**, never derived at query time - because `date_trunc` evaluated in UTC misattributes every punch before 05:30 IST, which for an early shift is the first punch of every day.

**`attendance_day`** holds the derived verdict with its **inputs snapshotted** (shift, day type, holiday, policy version) so the result is explainable, plus `payable_day_fraction` as the only value payroll consumes.

Three properties make retroactive recompute safe:

1. **`input_fingerprint`** - the upsert writes only when inputs actually changed, so a recompute storm is free and produces no audit noise
2. **`is_locked`** - once payroll finalises a period, recompute cannot mutate it; it emits adjustment rows the next cycle consumes as arrears
3. **Derived purity enforced by grants** - `REVOKE UPDATE ON attendance_day` from the application role. All human input enters as an approved correction, never a direct edit

`attendance_punch` is partitioned monthly from creation - not primarily for size, but because 99% of queries carry a date filter and because retention needs `DETACH` rather than `DELETE`.

### Amended 2026-09-08 (pre-acceptance)

**(a) The partition key is `business_date` (DATE).** This was never stated, and getting it wrong
would reintroduce at the partition boundary the exact bug this ADR opens by rejecting. Queries
filter `business_date`, but the punch *instant* is a different value; the dev stack runs
`TimeZone=UTC`, so a `timestamptz`-keyed table would place 1 Sep 00:00-05:29 IST punches in the
**August** partition - and would prune nothing, since the filter column would not be the key.

**(b) `pg_partman` is not available and is not used.** This ADR previously called it "mandatory,
not advisory". It is not installed, is not bundled with the `postgres:18-alpine` image the project
runs, and is not in ADR-0013's service list. The baseline instead ships `fn_ensure_month_partition`
(migration 0001), which is what `audit_event` actually uses. That function is the mechanism;
`pg_partman` may be adopted later, and this ADR no longer depends on it.

**(c) Partition exhaustion needs a degradation strategy, which does not exist yet.** Verify case T5
proves that inserting past the last partition is a **hard error**. For audit rows that is
acceptable. For punches it means *nobody can badge in*, and unlike an audit row the evidence is
unrecoverable - under ADR-0013 (single VM, no HA, solo operator) preventive alerting alone is not
sufficient. Compounding it: **nothing currently schedules `fn_ensure_month_partition`** - it is
invoked once inside migration 0001 - and `audit_event`'s newest bound is **2027-01-01**. Before
`attendance_punch` is built this ADR requires one of: a `DEFAULT` partition that quarantines
mis-routed rows, or create-on-demand retry in the ingest path. **Not yet decided - tracked as
OR-11.**

**(d) `payable_day_fraction` is `NUMERIC`, never a float.** It is the sole multiplicand payroll
consumes (ADR-0015), so a binary floating-point column would violate Must-Know Rule 4 by proxy -
the rule is about money, and this value is a direct factor of it.

**(e) `shift_roster` is effective-dated.** Recompute depends on resolving the roster *as of the
date being recomputed*, so an in-place edit would breach Must-Know Rule 3 and silently change past
verdicts. It is not modelled anywhere yet - see the amendment to ADR-0002.

**(f) Retention is stated as `DETACH`, but the period has no citation.** The "3-year" figure that
previously appeared here is not traced to any statute, and CLAUDE.md forbids inferring legal
requirements. The number must come from the retention schedule with a named source before it is
implemented; the mechanism (`DETACH`, not `DELETE`) is unaffected.

## Consequences

### Positive

- A retroactive policy change recomputes correctly and provably, without touching paid periods
- Every attendance verdict can be explained from stored inputs
- Partition pruning turns a 50M-row scan into a single month

### Negative / trade-offs

- Two tables and a derivation job rather than one table
- **Partitions must be created ahead of time.** A missing future partition means every punch INSERT fails at 00:00 IST on the 1st - which is why ahead-of-time provisioning plus a bound-check alert is mandatory, not advisory. **The mechanism is `fn_ensure_month_partition` (migration 0001), not pg_partman** - see amendment (b); pg_partman is not installed and is not available in the shipped image. Nothing currently schedules the provisioner (OR-11)
- `attendance_day` is deliberately NOT partitioned initially; converting a large hot table later needs a maintenance window. Mitigated by putting `business_date` first in the primary key now, at zero cost

## Reconsider when

Partition the attendance_day table at ~50M rows (about 13,500 employees, or immediately if sub-daily granularity is added).
