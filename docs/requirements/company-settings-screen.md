# Company Settings Screen - Requirements

**Source:** requested 2026-09-08. **Implements:** ADR-0019, Must-Know Rule 11.
**Phase:** admin screens (Phase 5+). The data model exists now (migration 0002).

## Purpose

HR maintains policy values without a developer. That is the whole point of Rule 11 - a threshold
that needs a deployment to change is a threshold that stays wrong.

## The one thing that makes this screen different from a normal form

**A policy change is a bulk data operation wearing a form.**

Changing the grace period from 15 to 20 minutes does not just update a row. It changes how every
future attendance day is classified, and - if backdated - changes days that have already been
computed, reported on, and possibly paid.

So the screen does not offer **Save**. It offers **Change with effect from**.

## Configurable vs answerable - the distinction that decides scope

Not everything that *could* be a setting *should* be. Two kinds of thing get confused:

- **A value** - a number, a flag, a choice between well-defined options. Making it configurable
  is nearly free, and it should be.
- **A behaviour** - a different computation shape. Making it configurable means building and
  testing every branch, when HR will only ever use one.

Almost every open handbook question turned out to be a value, which is why they are now settings
rather than blockers. The exception is **C4**: `probation_accrual_method` is three genuinely
different accrual algorithms, and each is real work.

It is still configurable, for a reason that matters more than the cost: **HR cannot choose
between these in the abstract.** "Segmented vs annual-capped" is jargon. So the screen must show
the arithmetic (see below).

## The safeguard: unconfirmed fields

Making a value configurable does not make it correct. It moves the risk from *"the developer
guessed"* to *"HR never opened the screen, and the engineering default silently became policy"* -
which is worse, because it looks settled.

Every policy row therefore carries `unconfirmed_fields`: the columns whose value is an
engineering default rather than a human decision. The screen **badges them**, and any report
built on them must say so rather than presenting the number as authoritative. A database trigger
rejects a field name that does not exist, so a typo cannot silently remove a badge.

Currently badged (16 fields): attendance full-day threshold and both overtime fields; all three
probation fields; CL and SL sandwich rule, notice days and cap window; CL carry-forward expiry
and additivity; CO lot expiry basis; ML accrual during leave.

## Two tabs, because there are two classes of setting (ADR-0019)

### Tab 1: Policy - effective-dated

| Group | Field | Current | Notes |
|---|---|---|---|
| Attendance | Grace period | 15 min | Late if the first punch is after start + grace |
| Attendance | Half-day threshold | 4 h (240 min) | Below this and above zero = half day |
| Attendance | Full-day threshold | **7h45 (465 min)** | See the warning below |
| Attendance | Standard day | 8 h (480 min) | Nominal. Also the comp-off proof requirement |
| Attendance | Overtime enabled | No | Captured but unpaid until a policy exists (C7) |
| Employment | Notice period | 90 days | |
| Employment | Probation length | **Not set** | C4 unanswered. NULL means unknown, not zero |
| Employment | CL blocked during notice | Yes | |
| Employment | SL extends notice | Yes | |
| Employment | Salary disbursement day | 10th | Capped at 28 so the date exists in February |
| Leave | CL / SL per year | 12 / 12 | 6 / 6 on probation, pro-rated |
| Leave | Usage cap | 6 CL + 6 SL per 6 months, **warn** | Warns, never blocks. Not a balance constraint |
| Leave | CL carry-forward cap | 6, after 1 year service | |
| Leave | Comp-off validity | 3 months | Basis (worked / approved / earned date) is **C6, badged** |
| Leave | Sandwich rule | None | **C1, badged.** none / holidays / week-offs / both |
| Leave | Advance notice | 2 days | **C2, badged.** Handbook says both 1 week and 2 days |
| Leave | Carry-forward expiry | 12 months | **C5, badged** |
| Leave | Accrual during maternity | Yes | **C12, badged** |
| Employment | Probation accrual method | Segmented | **C4, badged.** See below |
| Employment | Confirmation top-up | Immediate | **C4, badged** |

Each row shows **current value**, **effective from**, and a **history** link.

### Tab 2: Settings - mutable

Company legal and display name, business timezone, notification from/reply-to addresses,
feature flags. Plain edit, audited, no version history.

## Required behaviours

1. **Effective date is mandatory on a policy change.** Default to today. Future dates are the
   normal case and must be first-class - HR usually knows a policy change is coming.

2. **Show the blast radius before saving.** A backdated change must state what it affects:

   > *Effective 1 April 2026. This will recompute **1,247 attendance days** across **340
   > employees**. **86 of those days fall in a locked payroll period** and will produce
   > adjustment entries rather than being changed.*

   Without this, HR cannot tell a harmless change from a payroll incident.

3. **A reason is mandatory on any backdated change.** Optional for a future-dated one.

4. **Never silently mutate a locked payroll period.** Either refuse, or emit adjustments
   (ADR-0011). The screen must say which will happen before the user commits.

5. **Show version history per field** - value, effective range, who changed it, why. This is what
   answers "why was I marked half-day in March", which is the question this whole design exists
   to make answerable.

6. **Validation happens in the database, not only the form.** The constraints in migration 0002
   already reject inverted thresholds, absurd grace periods, overlapping versions, zero-length
   periods, and the grace-defeating combination below. The form should give a friendly message
   first, but the database is what makes a bad configuration impossible.

7. **Unknown is not zero.** `probation_months` is NULL. The screen shows "Not set - see C4", and
   any calculation depending on it refuses rather than assuming.

## The probation field needs live arithmetic, not a dropdown

`probation_accrual_method` has three options, and their names are meaningless to HR. The screen
must compute a worked example as the option changes:

> **For an employee joining 15 March with a 6-month probation, 2026 casual leave entitlement:**
> - **Segmented** - probation rate over the probation period, confirmed rate after: **6.5 days**
> - **Annual, capped** - confirmed rate across the year, usage capped while on probation: **9.6 days**
> - **Annual at probation rate** - uplift only next leave year: **4.8 days**

Nearly double between the extremes, for the same person. Presented this way it is a question HR
can answer in seconds; presented as three enum names it is a question nobody can answer at all.

The same applies, less dramatically, to the cap window: show *"an employee who used 6 CL in June
is warned again from 1 July (calendar) or from 1 December (rolling)"*.

## The warning HR needs to see on the full-day field

The standard day is 09:00-18:00 minus a 1-hour break = **exactly 8 hours**. If the full-day
threshold is also 8 hours, then anyone who uses any part of the 15-minute grace works 7h50m and
is classified a **half day** - making the grace period cost half a day's pay.

The full-day threshold is therefore set to **465 minutes (7h45)**, and the database enforces
`full_day_min_minutes <= standard_day_minutes - grace_period_minutes`. Raising the grace to 20
minutes will require lowering the full-day threshold to 460 or below, and **the screen must
explain that rather than just rejecting it.**

Verified: `testing/db/0002_configuration.verify.sql` case C5 proves the bad combination cannot
be saved.

## Authorization

| Action | Role |
|---|---|
| View settings | `hr_ops`, `hr_admin`, `finance`, `super_admin` |
| Edit **mutable settings** | `hr_admin` |
| Edit **policy** | `hr_admin`, with step-up re-auth |
| Backdated policy change | `hr_admin` + reason + step-up. Alerted |
| View version history | Anyone who can view settings |

Every change writes an audit record with actor, timestamp, before/after and reason. Policy
changes additionally emit a domain event so a recompute can be scheduled.

## Out of scope for this screen

Leave **types** and holiday calendars get their own admin screens - they are collections, not
scalar settings. Statutory payroll rates (EPF, ESI, PT, TDS) are a separate rules-engine surface
(ADR-0012) with its own audit and approval requirements.
