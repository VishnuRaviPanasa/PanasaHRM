# Architecture Decision Records

18 ADRs, **all currently `Proposed`**. Only a human may set one to Accepted; no agent may.
Once Accepted a file is immutable and `.claude/hooks/guard-adr.mjs` refuses edits - supersede it
with a new ADR instead.

| ADR | Decision | Load-bearing because |
|---|---|---|
| [0001](0001-application-architecture.md) | Modular monolith | Keeps the domain write and its audit record in one transaction |
| [0002](0002-temporal-data-strategy.md) | Effective-dated records | **The one thing that cannot be retrofitted** |
| [0003](0003-data-access-and-migrations.md) | Drizzle mirrors hand-written SQL | The model needs EXCLUDE, partitioning, partial indexes and triggers |
| [0004](0004-api-style.md) | REST + OpenAPI | Field-level authorization is far harder under a client-composed query language |
| [0005](0005-authorization-model.md) | Central service, two scope graphs, tested matrix | OWASP A01 is the top risk for HR software |
| [0006](0006-leave-balance-integrity.md) | Ledger **plus** a constrained account row | A ledger alone does **not** prevent double-spend - write skew |
| [0007](0007-workflow-engine.md) | FSM defined as data | Four consumers; building it four times is how HRM code rots |
| [0008](0008-cross-module-communication.md) | Transactional outbox | "State changed" and "audit recorded" cannot diverge |
| [0009](0009-authentication.md) | Entra OIDC + constrained local fallback | A DB CHECK kills the MFA-downgrade path |
| [0010](0010-session-strategy.md) | Opaque server-side sessions | Immediate revocation on offboarding; JWTs cannot |
| [0011](0011-attendance-storage.md) | Immutable punches, derived days, partitioned | Retroactive recompute must never touch paid periods |
| [0012](0012-payroll-statutory-rules.md) | Versioned statutory rules engine | India's Labour Codes are mid-transition |
| [0013](0013-deployment.md) | Docker Compose on one VM | Sustainable beats sophisticated for a solo operator |
| [0014](0014-no-runtime-ai.md) | No runtime AI in v1 | No API key; seams built anyway at near-zero cost |
| [0015](0015-work-logs-vs-attendance.md) | Siblings that reconcile, never derive | Deriving paid days from a timesheet makes payroll indefensible |
| [0016](0016-effort-granularity-and-cost.md) | Integer minutes; no cost on the effort row | Storing cost leaks salary to project managers by arithmetic |
| [0017](0017-work-log-privacy-posture.md) | Purpose-bound, not a productivity signal | An honest log is only possible when it is not graded |
| [0018](0018-standalone-application.md) | No dependency on any existing system | Zero coupling, at the price of some duplicate data entry |

## Accepting an ADR

Read it, then change `## Status` from `Proposed` to `Accepted`. From that moment the file is
immutable - the guard enforces it, and a regression test proves the guard works
(`node testing/hooks/guards.test.mjs`, cases T14-T19).

**Accept deliberately, one at a time.** These are the decisions everything downstream inherits;
0002, 0005, 0006 and 0015 are the ones whose reversal would be most expensive later.
