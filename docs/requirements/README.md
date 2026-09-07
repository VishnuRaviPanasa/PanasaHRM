# docs/requirements/

Business rules, traceable to a source. **Every rule here cites the artefact or the person it
came from.** A rule with no source is an assumption, and assumptions get flagged, not shipped.

## Primary source

**Employee Handbook, HR Policy Ver. 3** - document `PAN/ISMS/HRD/PO/2`, issued 2 Jan 2025,
authored by Tresa Ann, approved by Rajesh Thaikoottathil.

Already extracted into **Appendix A of the architecture plan**
(`C:\Users\panasa137user\.claude\plans\you-are-acting-as-lazy-moon.md`): organization facts, the
leave policy table, attendance and working time, the holiday calendar, the other workflows
discovered (reimbursement, grievance, POSH, resignation, disciplinary), compensation and
appraisal, benefits, and the contradictions register. Task 5 moves it here as versioned docs.

## Open contradictions - resolve before building

Twelve are logged as C1-C12 in the plan appendix. **None may be resolved by assumption.**
The two that block work:

- **C3** - "a **minimum** of 6 sick leaves and 6 casual leaves will only be allowed... every 6
  months" (handbook 4.9). Read literally this is incoherent; it almost certainly means a
  **maximum**. The two readings give different balances for every employee.
- **C8** - **no grace period and no half-day threshold** exist anywhere. Section 1.1.3.2.2 says
  *any* arrival after 09:00 is late; enforced literally that flags most of the company most days.
  Attendance derivation cannot run without these two numbers.

## Not to be implemented

Handbook **1.3.4.5** requires that if two employees in a relationship marry, one must seek
employment outside the company. This carries potential marital-status discrimination exposure.

> **Engineering position: PanasaHRM will not encode, automate, flag or enforce this rule in any
> form.** It is recorded here solely so a future session reading the handbook as a specification
> does not implement it silently. Referred to counsel.
