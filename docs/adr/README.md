# Architecture Decision Records

21 ADRs. **20 are `Proposed`; ADR-0014 is `Superseded by ADR-0020`.** None has been Accepted.
Only a human may set one to Accepted; no agent may.
Once Accepted a file is immutable and `.claude/hooks/guard-adr.mjs` refuses edits - supersede it
with a new ADR instead.

Three ADRs carry a condition a reader must not miss:

- **ADR-0012 (payroll) is BLOCKED** pending plan question Q10, build-vs-buy. If payroll is bought,
  it should be retired rather than amended (DEC-026, OR-09).
- **ADR-0006 (leave balance) carries an acceptance precondition**: the anti-overdraw mechanism must
  be implemented and concurrency-tested first.
- **ADR-0014 is superseded but NOT void.** Two clauses outlive it and bind ADR-0020: the list of
  uses forbidden "regardless of any later decision", and the rule that this development harness is
  never pointed at a production database. Read its status blockquote before assuming it is spent.

Every ADR was amended on 2026-09-08 following two adversarial verification passes. The findings and
what remains open are in `adr-review-report.md` and `adr-review-report-pass2.md`.

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
| ~~[0014](0014-no-runtime-ai.md)~~ | ~~No runtime AI in v1~~ **Superseded by 0020** | Its forbidden-uses list and its harness/production bound both SURVIVE the supersession |
| [0015](0015-work-logs-vs-attendance.md) | Siblings that reconcile, never derive | Deriving paid days from a timesheet makes payroll indefensible |
| [0016](0016-effort-granularity-and-cost.md) | Integer minutes; no cost on the effort row | Storing cost leaks salary to project managers by arithmetic |
| [0017](0017-work-log-privacy-posture.md) | Purpose-bound, not a productivity signal | An honest log is only possible when it is not graded |
| [0018](0018-standalone-application.md) | No dependency on any existing system | Zero coupling, at the price of some duplicate data entry |
| [0019](0019-configuration-model.md) | Effective-dated policy vs mutable settings | A mutable settings row would silently rewrite history on every recompute |
| [0020](0020-runtime-ai-assistant.md) | Runtime AI as tool calling, not text-to-SQL | The assistant defines no new authz action, so it cannot out-reach the screens beside it |
| [0021](0021-onboarding-boundary.md) | The onboarding boundary is `offer_accepted` | Hiremate owns the candidate; this system owns the employee. Drafted as 0020, renumbered when the chatbot branch merged claiming the same number |

## Accepting an ADR

Change `## Status` so that its **first non-blockquote line** is exactly `Accepted`. The parser
reads only that line, so explanatory prose belongs on a `> ` blockquote beneath it - but do NOT
write something like `Accepted 2026-09-08 (was Proposed)` on the status line itself unless you
mean it: the parser accepts it now, though an earlier version silently read it as *not* Accepted
and disabled the rail.

From that moment the file is immutable. The guard covers Edit/Write **and** shell commands, with an
independent commit-time check against the staged content; the one permitted change is
`Superseded by ADR-NNNN`. `node testing/hooks/guards.test.mjs` (56 cases) proves it, and each case
has been mutation-tested against the un-fixed hooks. Cases T14-T19 alone are NOT sufficient
evidence - they passed while a total bypass existed, which is what the 2026-09-08 review found.

**Accept deliberately, one at a time.** These are the decisions everything downstream inherits;
0002, 0005, 0006 and 0015 are the ones whose reversal would be most expensive later.
