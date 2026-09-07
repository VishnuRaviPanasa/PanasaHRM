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

`attendance_punch` is partitioned monthly from creation - not primarily for size, but because 99% of queries carry a date filter and because 3-year retention needs `DETACH` rather than `DELETE`.

## Consequences

### Positive

- A retroactive policy change recomputes correctly and provably, without touching paid periods
- Every attendance verdict can be explained from stored inputs
- Partition pruning turns a 50M-row scan into a single month

### Negative / trade-offs

- Two tables and a derivation job rather than one table
- **Partitions must be created ahead of time.** A missing future partition means every punch INSERT fails at 00:00 IST on the 1st - which is why pg_partman with premake=3 plus a bound-check alert is mandatory, not advisory
- `attendance_day` is deliberately NOT partitioned initially; converting a large hot table later needs a maintenance window. Mitigated by putting `business_date` first in the primary key now, at zero cost

## Reconsider when

Partition the attendance_day table at ~50M rows (about 13,500 employees, or immediately if sub-daily granularity is added).
