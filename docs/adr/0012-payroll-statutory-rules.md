# ADR-0012: Payroll Statutory Logic - A Versioned Rules Engine

## Status

Proposed

> Only a human may set this to Accepted. Once Accepted this file is immutable and
> `.claude/hooks/guard-adr.mjs` will refuse edits - supersede it with a new ADR instead.

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

Never. The regulatory environment is the reason this exists, and it is not stabilising.
