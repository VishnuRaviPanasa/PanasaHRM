# India Statutory Notes

**Read before anything touching leave, attendance, payroll or retention.**

> **This is not legal advice.** It separates what is **confirmed** from what is **assumed**, so a
> future session does not mistake one for the other. Every item marked ASSUMED must be confirmed
> before it is relied on. **Never infer a legal requirement** - escalate instead.

## Jurisdiction

Panasa Technology Pvt. Ltd., single site: Kakkanad, Kochi, **Kerala**. Applicable state Act is
the **Kerala Shops and Commercial Establishments Act**.

## CONFIRMED - from the Employee Handbook v3 (`PAN/ISMS/HRD/PO/2`, 2 Jan 2025)

| Item | Value |
|---|---|
| Leave year | **Calendar, 1 Jan - 31 Dec** (from "calculated at the end of December") |
| Casual leave | 12/yr confirmed; 6/yr on probation, pro-rated by joining date |
| Sick leave | 12/yr confirmed; 6/yr on probation. Medical certificate if **> 2 consecutive days** |
| CL carry-forward | **Max 6**, only after >= 1 year service. CL only |
| Maternity | 26 weeks (12 if 2+ living children); <= 8 weeks pre-delivery; eligibility 80 days worked in the prior 12 months; full pay |
| Paternity | **None currently.** Section 4.4 anticipates a future government mandate |
| Compensatory off | Earned 1:1 for approved work on a week-off or public holiday. **Expires in 3 months.** Requires prior approval **and** a timesheet proving 8 hours effective |
| Public holiday work | **Double pay AND a comp-off** |
| Leave without pay | After CL+SL exhausted, and for any leave taken without prior approval |
| WFH | 12/yr but **max 1 per month, no carry-over.** Needs reporting manager **and** IT manager, 48h notice. Not permitted from outside India |
| Working hours | 09:00-18:00 Mon-Fri, 1h break => **8h effective** |
| Week off | Saturday, Sunday |
| Notice period | **90 days.** No CL during notice; SL taken during notice **extends** it. Buyout = 3 months salary |
| **Leave usage cap** | **Maximum 6 CL and 6 SL per 6 months**, enforced as a **warning, not a block** (HR, 2026-09-08). Not a balance constraint |
| **Grace period** | **15 minutes** - late if the first punch is after 09:15 (HR, 2026-09-08) |
| **Half-day threshold** | **4 hours** worked (HR, 2026-09-08) |
| **Full day** | **8 hours** nominal. Configured threshold is **465 min (7h45)** so the grace period remains usable - pending confirmation |
| Salary | Monthly, on the **10th**. No advance salary |
| Appraisal | **Annually on each employee's joining anniversary** - rolling per-employee cycles, not one org-wide window |
| Gratuity | After **5 years continuous service**, per the Payment of Gratuity Act |
| Benefits | PF, ESI, family health + accidental insurance, Labour Welfare Fund |

## CONFIRMED - from the live 2026 holiday calendar (GreytHR, observed 2026-09-08)

11 fixed + 6 optional holidays. Full list in `docs/requirements/holiday-calendar-2026.md`.

Three facts that shape the model:

1. **The optional-holiday allowance is not a constant** - 2 of 5 in 2025, at least 3 of 6 in
   2026. It must be per-calendar-year configuration
2. **Holidays are added mid-year by government order** ("Election - Kerala", 9 Apr 2026). The
   calendar is editable in-year and a retroactive addition triggers attendance recompute
3. **Two festivals can share one date** (First Onam / Milad-i-Sherif, 25 Aug 2026)

## ASSUMED - must be confirmed before it is relied on

These are engineering defaults chosen so work can proceed, **not** established facts.

| Ref | Assumption | Why it is uncertain |
|---|---|---|

| **C1** | Sandwich leave is **OFF** | Section 4.5 states the rule and cancels it in consecutive sentences |
| **C2** | Advance notice is **2 working days** | Section 2.4 says one week; section 4.9 says two working days |
| **C4** | Probation length, and whether the 6->12 uplift pro-rates from joining or confirmation | Probation length is never stated anywhere in the handbook |
| **C5** | Carried CL is additive to the fresh 12 (max 18) and expires after 12 months | Expiry is unstated |
| **C6** | Comp-off validity runs from the **worked date** | Could be earned, approved or worked date |
| **C7** | Overtime is captured but **unpaid** | The handbook defers to "the overtime policy", which does not exist |

| **C12** | Leave accrues during maternity leave | Unstated |
| **H-01** | Optional-holiday election cap for 2026 | Screenshot shows 3 applied of 6; handbook said 2 of 5 for 2025 |
| **H-03** | Leave already approved on a date that later becomes a holiday | Refund or not - unstated, and it is a real ledger reversal path |
| **H-04** | A holiday falling on a Saturday/Sunday | No 2026 holiday does, so the rule is untested and undefined |

~~C3 and C8~~ **both RESOLVED by HR on 2026-09-08** - see the CONFIRMED table above.
The remaining ASSUMED items are real but none of them blocks starting the leave or attendance
engines; they block *finishing* them.

## Payroll (Phase 10) - statutory areas, not encoded rules

EPF/EPS · ESI · Professional Tax (Kerala slabs) · TDS under the Income Tax Act · Gratuity ·
Labour Welfare Fund. **All are effective-dated data in the rules engine (ADR-0012), never
constants in code.**

**Regulatory timing risk:** India's four Labour Codes were enacted 21 Nov 2025 with central rules
notified 8 May 2026, but **state rules and commencement dates remain incomplete**. Wage
definitions, register formats and overtime rules **will** change during this build. That is the
whole reason ADR-0012 exists.

## Privacy

DPDP Act 2023 + DPDP Rules 2025 (notified 13 Nov 2025; hard enforcement widely expected around
May 2027). See `docs/privacy/`. **No named legal contact exists yet** (OR-03) - until there is
one, DPDP compliance is an accepted risk with no owner.

## Not to be implemented

Handbook **1.3.4.5** requires that if two employees in a relationship marry, one must seek
employment outside the company. Potential marital-status discrimination exposure.

**PanasaHRM will not encode, automate, flag or enforce this in any form.** Recorded so a future
session reading the handbook as a specification does not implement it silently.
