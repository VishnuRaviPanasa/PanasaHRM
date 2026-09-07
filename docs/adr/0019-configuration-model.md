# ADR-0019: Configuration Model — Effective-Dated Policy vs Mutable Settings

## Status

Proposed

> Only a human may set this to Accepted. Once Accepted this file is immutable and
> `.claude/hooks/guard-adr.mjs` will refuse edits — supersede it with a new ADR instead.

## Date

2026-09-08

## Context

Must-Know Rule 11 says policy is never hardcoded. HR needs a settings screen to maintain values
like the attendance grace period, the half-day threshold and the leave usage cap — the numbers
confirmed on 2026-09-08.

The naive implementation is a mutable key/value settings table that the screen edits in place.
That is wrong here, and the reason is specific rather than theoretical.

Attendance days and leave requests are **derived from policy**. `attendance_day` is recomputed
whenever an input changes (ADR-0011), and a recompute reads the policy. If policy is a single
mutable row, then changing the grace period from 15 to 20 minutes in June and recomputing March
produces **March days classified under June's rules** — history changes silently, and the
recomputed result disagrees with the payroll already paid against it.

The same applies to leave: a request submitted last year should be explicable under the policy
that applied last year, not under whatever the screen says today.

But not every setting has this property. A company logo, an SMTP sender address or a
notification reply-to has no historical computation depending on it. Versioning those adds
ceremony for nothing, and a settings screen that treats "grace period" and "company logo"
identically will get one of them wrong.

## Options considered

| Option | Summary | Why not chosen |
|---|---|---|
| Single mutable settings table | One row per key, edited in place | Silently rewrites history on any recompute. The failure is invisible until someone reconciles a payslip against the system |
| Everything effective-dated | Version every setting including branding | Ceremony with no benefit for values nothing computes from; makes the settings screen tedious and encourages working around it |
| Application config files | Values in env or config, deployed | Removes HR's ability to change policy without a developer — the exact thing Rule 11 exists to prevent |
| **Two classes, split by a single test** | Effective-dated policy vs mutable settings | — |

## Decision

**Two classes of configuration, separated by one question:**

> **Would a historical recomputation give a different answer if this value changed?**
> If yes, it is **policy** and must be effective-dated. If no, it is a **setting** and is mutable.

### Class 1 — Effective-dated policy

Stored in versioned tables with `valid_from` / `valid_to` / `valid_period`, the same
`EXCLUDE` + `NOT isempty` pattern as every other effective-dated table (ADR-0002).

- `attendance_policy` — grace period, half-day and full-day thresholds, OT eligibility
- `leave_policy` — accrual, caps, carry-forward, expiry, the 6-month usage cap
- `employment_policy` — notice period days, probation length
- Later: `payroll_statutory_rule` (ADR-0012)

Every computation **resolves policy as of the date being computed**, never "current". A
recompute of March reads March's policy version.

### Class 2 — Mutable settings

`org_setting`, a typed key/value table with no validity period. Company display name, address,
logo, SMTP sender, notification reply-to, feature flags.

Changes are audited but not versioned, because nothing computes history from them.

### Rules that make this safe

1. **A policy change requires an `effective_from` date.** The settings screen does not offer an
   "update" — it offers "change with effect from". This is the single most important
   consequence, because it makes the temporal question unavoidable in the UI.
2. **Future-dated changes are permitted and are the normal case.** Retroactive changes are
   permitted but require a reason and trigger recompute.
3. **A retroactive change intersecting a locked payroll period is refused.** It emits adjustment
   rows instead (ADR-0011), or it is rejected outright. It never silently mutates a paid period.
4. **The screen shows blast radius before saving** — "this affects 1,247 attendance days across
   340 employees" — because a policy edit is a bulk data operation wearing a form.
5. **Every change is audited** with actor, timestamp, before/after and a mandatory reason.

## Consequences

### Positive

- A recompute of any past period is correct by construction, and stays correct after a policy change
- "Why was I marked half-day in March?" is answerable: the March policy version is still there
- HR changes policy without a developer, which is the whole point of Rule 11
- Payroll stays defensible, because a paid period cannot be silently reinterpreted

### Negative / trade-offs

- Every policy read carries an as-of date. Forgetting one returns the current version and silently
  computes the wrong answer — the same hazard as every effective-dated table, and it is mitigated
  the same way: a resolver function, never a direct table read
- The settings screen is more complex than a form with a Save button. It needs an effective date,
  a history view and an impact preview
- Two classes means someone must decide which class a new setting belongs to. The test above is
  the deciding rule and belongs in the code review checklist

### Neutral

- `org_setting` values are still audited, so "who changed the SMTP sender" remains answerable

## Reconsider when

Never for the split itself. If a setting is discovered to be in the wrong class, move it —
promoting a mutable setting to effective-dated is a migration that backfills one version row
with `valid_from` set to the system epoch.
