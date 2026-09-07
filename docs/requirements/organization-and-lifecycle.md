# Organization, Employment Lifecycle and Other Workflows

**Source:** Employee Handbook v3, sections 3, 5, 6, 8, 9, 12. **Status:** baseline.

## Organization

| Fact | Value |
|---|---|
| Legal entity | Panasa Technology Pvt. Ltd. |
| Site | 13th Floor, Transasia Cyber Park, Infopark Phase II, Kakkanad, Kochi, **Kerala** 682030 |
| State Act | **Kerala** Shops and Commercial Establishments Act |
| HR Manager | Tresa Ann |
| Governance | Document ID carries `ISMS` - an Information Security Management System exists, with separate Information Security, IT, Email and WFH policies (§8.2.3) |

One entity today; the model supports several, because the group is known to have more.

## Compensation and appraisal

| Item | Value | Design consequence |
|---|---|---|
| Salary | Monthly, on the **10th** | Payroll cycle anchor |
| Advance salary | **None** - explicitly refused | No advance/loan module |
| **Appraisal** | **Annually, in the month of each employee's joining anniversary** | **Per-employee rolling cycles**, not one org-wide window. Phase 11 must model ~12 overlapping cohorts running continuously. Most performance modules assume the opposite and would need rebuilding |

## Resignation and exit

- **90-day notice period.** Buyout = 3 months' salary
- **No casual leave during notice**; sick leave taken during notice **extends** it
- Written resignation to the supervisor, cc HR; HR confirms the last working day
- Handover, then a **non-dues certificate from all departments**
- Exit interview (optional)
- Final settlement **on the next payroll date after the last working day**
- Employment certificate on request

## Termination

Grounds: performance (after a PIP), conduct, or operational (redundancy, closure). **Immediate
termination without notice** for gross misconduct, serious policy breach - explicitly including
the Information Security, IT, Email and WFH policies - or legal/regulatory violation. Written
termination letter; appeal in writing.

## Disciplinary ladder

Three tiers, applied to attendance, leave and conduct alike:

| Tier | Examples | Steps |
|---|---|---|
| Minor | Occasional tardiness, dress code, cleanliness | Verbal warning -> written warning |
| Moderate | Repeated minor violations, missed deadlines, resource misuse, disrespect | Written warning with improvement plan -> PIP |
| Major | Confidentiality breach, harassment, discrimination, safety violation | Immediate suspension pending investigation -> possible termination |

All actions documented in the personnel record. Appeals in writing to HR.

**Records are `RESTRICTED`** (see `ai/context/security-guidelines.md`). Documented here, not
automated in the MVP.

## Other approval workflows

Each is an additional consumer of the generic workflow engine (ADR-0007).

### Reimbursement (§12) - in Phase 7

Form from HR -> **prior approval required** -> submit with receipts by **the last working day of
the month in which the expense was incurred, else forfeited** -> HR processes -> **paid via the
next month's salary, or as arrears** if it misses the cycle. **Fuel is excluded.**

Money is involved, so: integer minor units, and a payroll hand-off rather than a direct payment.
The forfeiture deadline is a scheduled job, not a manual check.

### Grievance (§5)

Informal resolution first -> written complaint to HR -> **acknowledged within 2-3 business days**
-> neutral investigator (internal or external) -> evidence gathering -> findings report ->
resolution -> appeal to a senior manager or external arbitrator. Records are `RESTRICTED`.

### POSH (§6) - deliberately out of scope

Complaint to the Internal Committee **within 3 months** of the incident -> IC investigation ->
report within **90 days** -> action -> appeal. The IC has six named members reachable at a shared
address.

> **Recommendation: do not build POSH case management in PanasaHRM.** The confidentiality bar is
> materially higher than anything else in this system, the IC operates independently of HR, and a
> general-purpose HRM is the wrong container for it. Confirm with counsel before revisiting.

## Benefits (Phase 10 payroll inputs)

Provident Fund - employee and employer, percentage of basic · ESI below the salary threshold ·
**family** health insurance (employee, spouse, children) plus accidental insurance (employee
only) · Labour Welfare Fund · **Gratuity after 5 years continuous service** · retirement plan.

> Gratuity's continuous-service test is why `employee.service_start_on` must be a **separate
> column from `hired_on`**. A contract-to-permanent conversion that resets the clock underpays
> gratuity by years, and it is discovered at exit - the most expensive time to find it.

## For legal review

1. **§1.3.4.5 - the marriage clause.** Requires that if two employees in a relationship marry,
   one must seek employment outside the company. Potential marital-status discrimination
   exposure. **PanasaHRM will not encode, automate, flag or enforce this in any form.** Recorded
   so a future session reading the handbook as a specification does not implement it silently.
2. Kerala Shops & Commercial Establishments Act minimums versus 12 CL + 12 SL, and 6 + 6 on
   probation.
3. Whether POSH records may reside in a general HRM at all.
4. 90-day notice with a 3-month buyout, and "sick leave extends notice" - enforceability.
5. Republic Day was absent from the 2025 handbook calendar but present in 2026 (C11).
