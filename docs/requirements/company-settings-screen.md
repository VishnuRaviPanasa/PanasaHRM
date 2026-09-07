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
| Leave | Comp-off validity | 3 months | |

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
