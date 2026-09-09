# ADR-0012: Payroll Statutory Logic - A Versioned Rules Engine

## Status

Proposed - **BLOCKED, do not accept**

> Only a human may set this to Accepted. Once Accepted this file is immutable and
> `.claude/hooks/guard-adr.mjs` will refuse edits - supersede it with a new ADR instead.

> **BLOCKED by an unresolved product decision (human decision, 2026-09-08).**
>
> This ADR must not be accepted or finalised until **plan question Q10** is resolved: *is payroll
> built here, or bought/integrated from an existing provider?*
>
> The blocker is live rather than hypothetical. **OR-07** records that GreytHR's ESS already
> includes Salary, and `docs/requirements/organization-and-lifecycle.md` already assumes a payroll
> hand-off. This ADR is not merely *early* - its premise may turn out to be false.
>
> **If Q10 resolves to "buy/integrate", the correct outcome is to retire or void this ADR, not to
> amend it.** A rules engine that is never built should not sit Accepted at the top of the
> authority order describing a module that does not exist. In that case the replacement decision
> is an integration boundary (and, under ADR-0018, one that must not become a coupling without
> its own ADR).
>
> **If Q10 resolves to "build"**, this ADR still requires the substantive amendments identified in
> `docs/adr/adr-review-report.md` §9 before acceptance - principally: a precise definition of
> "as of" for rule resolution, a money type and a rounding policy that is *part of the versioned
> rule*, a statement of engine expressiveness sufficient to express formula changes rather than
> only rate changes, and an explicit path for retrospectively-notified rates and arrears.

## Date

2026-09-08

## Context

India's four Labour Codes were enacted 21 Nov 2025 with central rules notified 8 May 2026, but state rules and commencement dates remain incomplete. Meanwhile EPF, ESI, Professional Tax and TDS rates and thresholds change on their own schedules. Statutory logic written today will be wrong within a year.

## Options considered

| Option | Summary | Why not chosen |
|---|---|---|
| Hardcoded India rules | Rates and formulas in TypeScript | Guarantees obsolescence, and every change becomes a deployment. Worse, historical recalculation becomes impossible once the constant changes |
| Configuration file per rate | Rates externalised, formulas in code | Handles rate changes but not structural ones - a changed wage definition or a new contribution ceiling is a formula change, not a number change |
| **Effective-dated versioned rules engine (chosen)** | Rules as data with validity periods | - |

## Decision

Statutory rules are **effective-dated data**, not code. A payroll run resolves the rule version in force **as of the pay period**, and stores the resolved version identifier on every computed line.

This means recalculating March after a June rate change produces March's answer, not June's - which is the difference between a defensible payroll and an indefensible one.

No country-specific logic sits in the payroll core. India is the first implementation, not the only possible one.

## Consequences

### Positive

- A rate change is a data change with an effective date, not a deployment
- Historical recalculation is correct by construction
- Every payslip figure traces to an input and a rule version - the audit property payroll actually needs

### Negative / trade-offs

- A rules engine is more complex than an if-statement, and harder to read for a simple case
- Rules-as-data can encode a wrong rule just as easily as code can; it changes how fast you can fix it, not whether you can get it wrong
- Requires someone to own keeping the rules current - a real operational duty, not a one-off

## Reconsider when

**Immediately, on the resolution of Q10** (build payroll versus buy/integrate). Until that question
is answered this decision has an unresolved premise, and `Never` cannot honestly be recorded as the
reconsideration trigger - which is why it no longer is.

- **Q10 → buy/integrate:** retire or void this ADR. Do not amend it into an integration decision;
  the decision recorded here would not be the decision taken.
- **Q10 → build:** the trigger below becomes the operative one, and this clause is superseded by
  the accepted version of this ADR.

*Original text, retained so the intent is not lost:* "Never. The regulatory environment is the
reason this exists, and it is not stabilising." That reasoning holds **conditionally on payroll
being built here**, and only then.
