# Attendance and Working Time - Requirements

**Source:** Employee Handbook v3, sections 1.1.3 and 2. **Status:** baseline established;
**C7 and C8 unresolved and blocking.**

## Working time

| Item | Value |
|---|---|
| Standard hours | **09:00-18:00, Monday-Friday** |
| Breaks | **1 hour total** (lunch + tea) => **8 hours effective** |
| Week off | **Saturday, Sunday** - fixed, not rotating |
| Flexibility | Per-department flexible arrangements, subject to managerial approval |
| Timezone | `Asia/Kolkata` |

The 8-hour effective figure is consistent with the comp-off rule, which requires a timesheet
proving 8 hours worked - so the two definitions agree, which is worth noting because they often
do not in HR policy.

## Recording

Handbook §1.1.3.2.2 names **GreytHR, biometrics, muster roll and timesheet trackers**.

**PanasaHRM integrates with none of them** (ADR-0018). Attendance enters as CSV import first,
with a device adapter behind a port later. Any historical data from GreytHR would arrive as a
**one-time CSV handed over by HR**, never as a live interface.

## Late arrival and absence

- §1.1.3.2.2: **any** arrival after the scheduled start is considered late
- Absence must be notified to the supervisor, preferably before the workday starts
- Planned leave needs advance approval (see `leave-policy.md`, C2)
- Prolonged illness - more than 2 consecutive sick days - requires a medical certificate
- Repeated lateness escalates: verbal warning -> written warning -> PIP -> suspension or
  termination. Punctuality also feeds the performance review

## Extra hours and overtime

- Employees may be required to work extra hours to meet deadlines
- Extra hours require **advance approval** from the supervisor
- Compensation is "as per the overtime policy, if it aligns with legal requirements and is
  subject to management decision"

**C7: that overtime policy does not exist in the handbook.** Until it does, overtime is
**captured but unpaid** - recorded on `attendance_day` as `overtime_minutes` and
`approved_ot_minutes`, so no data is lost when a policy arrives.

## Work from home

12 days per year, **maximum 1 per month, no carry-over**. Requires approval from the **reporting
manager and the IT manager**, 48 hours in advance except in emergencies. Requires primary and
backup internet plus power backup. **Not permitted from outside India.** Feasibility varies by
project; some projects require physical presence for confidentiality or client reasons.

Modelled as a non-deducting leave type - see `leave-policy.md`.

## Holidays

See `holiday-calendar-2026.md`. 11 fixed + 6 optional in 2026, with the employee electing from
the optional pool. **The optional allowance is per-calendar-year configuration** - it was 2 of 5
in 2025 and at least 3 of 6 in 2026.

## Engine implications

1. **`business_date` is computed at ingest and stored**, never derived at query time. The IST
   half-hour offset means `date_trunc('day', punched_at)` evaluated in UTC misattributes every
   punch before 05:30 - which, for an early shift, is the first punch of every day.
2. **Punches are immutable; the daily verdict is derived** with its inputs snapshotted, so the
   result is explainable (ADR-0011).
3. **A retroactive change recomputes, guarded by `input_fingerprint` and `is_locked`** - a locked
   payroll period emits adjustment rows rather than mutating.
4. **A holiday added mid-year triggers recompute** for the affected dates. This is not
   theoretical: "Election - Kerala" was added to the 2026 calendar by government order.
5. **Attendance and work logs reconcile but never derive from each other** (ADR-0015).

## Open questions - blocking

| Ref | Question | Why it blocks |
|---|---|---|
| **C8** | **No grace period and no half-day threshold exist anywhere in the handbook.** §1.1.3.2.2 says *any* arrival after 09:00 is late - enforced literally, that flags most of the company most days | **Attendance derivation cannot run.** It needs both numbers to classify a day |
| **C7** | The overtime policy is referenced but absent | Overtime cannot be paid |
| **H-04** | A holiday falling on a Saturday or Sunday - observed on the next working day, lost, or converted to comp-off? | No 2026 holiday does, so the rule is untested and undefined |
| Q8 | Biometric device vendor and export interface | Ingestion adapter. CSV import is built first regardless |

### The specific numbers needed from HR

1. **Grace period**: how many minutes after 09:00 before an arrival is recorded as late?
2. **Half-day threshold**: how many hours worked constitute a half day rather than a full day or
   an absence?
3. **Minimum full day**: how many hours for a full day?

Three numbers. Without them the derivation job cannot assign a status to a single day.
