# Leave Policy — Requirements

**Source:** Employee Handbook, HR Policy Ver. 3 (`PAN/ISMS/HRD/PO/2`, issued 2 Jan 2025, author
Tresa Ann, approved Rajesh Thaikoottathil), sections 4.1–4.9 and 8.1.1.
**Status:** baseline established; **six ambiguities unresolved (C1–C6)** — see the bottom.

> **Nothing here may be resolved by assumption.** Where the handbook is silent or contradicts
> itself, that is recorded as an open question, not filled in with a sensible-looking default.

## Leave year

**Calendar year, 1 January – 31 December.** Established by §4.8: *"unavailed leaves is calculated
at the end of December every year."*

A single leave year applies to **all** types — not the split Jan–Dec / Apr–Mar pattern common
elsewhere in India. This must remain configurable per `leave_type` even though only one value is
used today, because the split pattern is what a future acquisition or entity would bring.

## Leave types

| Type | Confirmed employee | On probation | Accrual | Carry forward | Expiry |
|---|---|---|---|---|---|
| **Casual (CL)** | 12/yr | 6/yr, pro-rated by joining date | Front-loaded annually | **Max 6**, only after ≥1 year service | C5 |
| **Sick (SL)** | 12/yr | 6/yr, pro-rated by joining date | Front-loaded annually | None | — |
| **Maternity (ML)** | 26 weeks; **12 weeks if 2+ living children** | Statutory | On event | — | — |
| **Paternity** | **None** | — | — | — | — |
| **Compensatory off (CO)** | Earned 1:1 | Same | On approved work on a week-off or public holiday | No | **3 months** (C6) |
| **Leave without pay (LWP)** | Unbounded | Same | — | — | — |
| **Work from home (WFH)** | 12/yr, **max 1 per month** | Same | Monthly grant | **No — lapses monthly** | End of month |

### Rules per type

**Casual leave.** Not permitted during the notice period (§8.1.1). Carry-forward is conditional
on ≥1 year of service, computed against **`service_start_on`**, not `hired_on` — the two differ
after a contract-to-permanent conversion, and using the wrong one silently changes entitlement.

**Sick leave.** Medical certificate required for **more than 2 consecutive days** (§4.2). Sick
leave taken during the notice period **extends the notice period** by the same number of days
(§8.1.1) — a policy predicate on employment status, not on the leave type alone.

**Maternity leave.** Per the Maternity Benefit Act 1961 as amended 2017. Up to 8 weeks may be
taken pre-delivery. Eligibility: **80 days worked in the 12 months prior** to the expected
delivery date. Paid at full salary computed on average daily wage. No strenuous work for 10 weeks
before delivery; no work at all for 6 weeks after. WFH is possible after the 26 weeks by mutual
agreement.

**Paternity leave.** Explicitly absent. §4.4 anticipates a future government mandate — the rules
engine (ADR-0012) must be able to add it as effective-dated data, not a code change.

**Compensatory off.** Requires **prior manager approval** *and* a timesheet proving **8 hours
effective work**. Working a **public holiday** additionally earns **double pay** — a payroll
consequence originating in leave/attendance, which must travel as a flagged fact on
`attendance_day` and never be computed inside either module (ADR-0015).

**Leave without pay.** Applies once CL and SL are exhausted, **and to any leave taken without
prior approval** (§4.7).

**Work from home.** Not strictly leave — it is a non-deducting, monthly-resetting entitlement.
Requires approval from the **reporting manager *and* the IT manager**, 48 hours in advance.
Requires primary and backup internet plus power backup. **Not permitted from outside India.**

## Requesting leave

- Advance notice: **C2** — §2.4 says one week, §4.9 says two working days
- Approval is required before the leave is taken; unapproved leave becomes LWP
- Half-day granularity is supported

## Engine implications

These follow from the policy and are design constraints, not restatements:

1. **WFH models as a leave type** with `accrual_method = monthly`, `max_balance = 1`,
   `carry_forward_enabled = false`, `is_paid = true`, and a second approver role. It is **not
   absence** — `payable_day_fraction` stays 1.0 and it must not reduce attendance.
2. **Comp-off is the only earned-lot type.** Its 3-month expiry makes FIFO lot tracking
   (`consumes_ledger_id` ordered by `expires_on`) load-bearing: expiring lots must be consumed
   before fresh accrual, or the lapse job debits balance the employee already used.
3. **`leave_policy` needs two columns the generic model does not have**:
   `blocked_during_status TEXT[]` (CL during notice) and `extends_notice BOOLEAN` (SL during
   notice).
4. **Probation entitlement is a policy predicate on employment status**, not a separate leave type.

## Open questions — blocking

| Ref | Question | Why it blocks |
|---|---|---|
| **C3** | §4.9: *"a **minimum** of 6 sick leaves and 6 casual leaves will only be allowed for an employee every 6 months."* Read literally this is incoherent. It almost certainly means a **maximum** of 6+6 per half-year | **Changes the available balance for every employee.** The highest-impact ambiguity in the handbook |
| **C1** | §4.5 states the sandwich rule *and cancels it* in consecutive sentences | Changes how many days a request consumes |
| **C2** | Advance notice: 1 week (§2.4) or 2 working days (§4.9)? | Request validation |
| **C4** | **Probation length is never stated.** At confirmation, does entitlement jump 6→12, and is the uplift pro-rated from joining or from confirmation? | Affects every new joiner's balance |
| **C5** | Does carried CL expire? Is the 6-day cap **additive** to the fresh 12 (max 18)? | Year-close correctness |
| **C6** | Comp-off "valid three months" — from the **worked**, **approved**, or **earned** date? | Lot expiry |
| **C12** | Does leave accrue during the 26-week maternity period? | Accrual engine |

### Worked examples still needed from HR

Abstract answers produce abstract bugs. These three make the answer unambiguous:

1. Someone joins **15 March**. What is their CL and SL balance on 1 April, and again on 1 January
   after confirmation?
2. An employee ends December with **9 unused CL**. What is their opening CL balance on 1 January,
   and when does any carried portion expire?
3. Someone works a public holiday on **2 October** and earns a comp-off. What is the last date
   they can use it, and what happens to it if unused?

Concrete dates get concrete answers.
