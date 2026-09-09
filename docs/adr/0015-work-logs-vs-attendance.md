# ADR-0015: Work Logs and Attendance Are Siblings That Reconcile, Never Derive

## Status

Proposed

> Only a human may set this to Accepted. Once Accepted this file is immutable and
> `.claude/hooks/guard-adr.mjs` will refuse edits - supersede it with a new ADR instead.

## Date

2026-09-08

## Context

Both record time. The tempting simplification is to derive one from the other - compute attendance from timesheets, or pre-fill timesheets from punches. Every HRM that does this ends up with an indefensible payroll.

## Options considered

| Option | Summary | Why not chosen |
|---|---|---|
| Derive attendance from work logs | Logged hours imply presence | A timesheet is self-reported. Once paid days derive from it, every payroll dispute becomes a timesheet dispute, and the statutory register rests on an employee assertion |
| Derive work logs from attendance | Presence implies work | Presence says nothing about which project was worked on, which is the entire purpose of the work log |
| One unified time table | A single model for both | Their rules, approvers, retention periods and legal bases all differ. One table would need every field to be conditional |
| **Two domains that reconcile (chosen)** | Separate modules; variance is reported, never computed | - |

## Decision

`work` and `attendance` are **sibling modules**. Neither derives from the other.

They answer different questions: attendance answers *"was this person present?"* (statutory, payroll days); the work log answers *"what did they do?"* (project effort, accomplishment evidence).

A scheduled job produces a **variance report** flagging four cases - present but nothing logged, logged but absent, logged on approved leave, and variance beyond a threshold. It **flags; it never corrects.**

**Payroll consumes `attendance_day.payable_day_fraction` and never work-log minutes.** Project costing consumes work-log minutes and never attendance.

### Amended 2026-09-08 (pre-acceptance)

**(a) Comp-off is gated by attendance, not by the work log.** `docs/requirements/leave-policy.md`
states that comp-off requires *"a timesheet proving 8 hours effective work"*, and
`ai/context/domain-glossary.md` maps "timesheet" to **work log**. Read literally, a self-reported
work log would gate a paid, encashable leave credit - which is the boundary this ADR exists to
defend, breached in the one place nobody looked. The binding reading:

> Comp-off eligibility is determined by **`attendance_day.worked_minutes`** on the qualifying date.
> A work log may *accompany* the request as evidence of what was done; it is never the *quantity*
> that establishes the entitlement.

**(b) The variance report is read-only, org-scoped, and never a per-person metric.** It is the one
artifact that must join both authorization graphs, and it is functionally an under-reporting flag,
which collides with ADR-0017's "no ranking, no score, no league table". Therefore: it is generated
under an explicit administrative permission, never exposed on an employee or manager dashboard as a
per-person score, retained only as long as needed to resolve the discrepancy, and it **writes to
neither domain** - consistent with "it flags; it never corrects". An employee can see variance
flags raised against their own records (ADR-0017's visibility principle extends to data *about*
them, not merely data authored *by* them).

**(c) The variance threshold is policy and needs a home.** Must-Know Rule 11 forbids hardcoding it.
`work_policy` is referenced only in `ai/context/temporal-data-rules.md` and exists in no ADR and no
migration - see the amendment to ADR-0002.

**(d) ADR-0012 does not acknowledge this boundary.** The payroll ADR never mentions
`attendance_day`, `payable_day_fraction`, effort or timesheets, so the most important invariant
here is asserted only from this side. It must be stated in ADR-0012 as a condition of that ADR's
acceptance - which is separately blocked (OR-09).

## Consequences

### Positive

- Payroll rests on attendance evidence, not on self-reported effort
- Each module has rules appropriate to its purpose
- The variance report surfaces genuine data-quality problems that a derived model would have silently hidden

### Negative / trade-offs

- Employees record time twice in a sense - once by being present, once by logging what they did. Mitigated by making the daily log entry fast, and by never requiring it to reconcile exactly
- Two sources of time data invites future pressure to "simplify" by merging them

## Reconsider when

Never. This is the boundary that keeps payroll defensible.
