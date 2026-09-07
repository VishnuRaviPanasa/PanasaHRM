# GreytHR - current-state observation

**Source:** GreytHR ESS navigation, `panasa.greythr.com`, observed 2026-09-08.
**Purpose:** scope intelligence only. **PanasaHRM has no dependency on GreytHR** (D5) - no
integration, no data pull, no shared schema. This file records what employees use today so the
retire-or-coexist decision (O12) is made on facts.

## Modules live in GreytHR today

| Nav item | Sub-items observed |
|---|---|
| Home | - |
| Engage | - |
| My Worklife | - |
| To do | - |
| **Salary** | - |
| **Leave** | Leave Apply · Leave Balances · Leave Calendar · Holiday Calendar |
| **Attendance** | - |
| **Document Center** | - |
| **People** | - |
| Helpdesk | - |
| Request Hub | - |
| Workflow Delegates | - |

## What this tells us

1. **GreytHR already covers most of the PanasaHRM MVP** - leave, attendance, documents, people,
   plus salary and a request/helpdesk surface that the MVP does not attempt. Employees have a
   working self-service tool today.

2. **"Workflow Delegates" exists**, which means delegated approvals are already an expectation,
   not a nice-to-have. The plan models delegation as a first-class bounded object; that is
   validated rather than speculative.

3. **The bar for replacement is higher than the plan assumed.** OR-07. Two honest readings:
   - *Complement:* PanasaHRM owns what GreytHR does badly or not at all - effective-dated
     history, project-based daily work logging, org-as-of-date reporting, auditability. GreytHR
     keeps payroll and statutory filing.
   - *Replace:* PanasaHRM must reach parity across leave, attendance, documents **and** salary
     before anyone can switch off GreytHR. That is a materially larger programme than the
     current Phase 0-9 plan.

   **This is a business decision (O12), not an engineering one.** It does not block Phase 1-5,
   because identity, org, employee core, documents and the workflow engine are needed under
   either reading. It must be answered before Phase 7.

4. **Do not treat GreytHR as a requirements source.** It shows what is *currently done*, which is
   not the same as what is *policy*. The Employee Handbook and HR remain authoritative; where the
   two disagree, that disagreement is itself a finding worth raising.

## Not to be done

Per D5 and the Forbidden Actions in `/CLAUDE.md`: no API call to GreytHR, no database read, no
scraping, no scheduled sync. If historical data is ever wanted, it arrives as a **one-time CSV
export handed over by HR** - a migration input, never a live interface.
