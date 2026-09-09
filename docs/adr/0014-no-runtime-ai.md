# ADR-0014: No Runtime AI in v1

## Status

Proposed

> Only a human may set this to Accepted. Once Accepted this file is immutable and
> `.claude/hooks/guard-adr.mjs` will refuse edits - supersede it with a new ADR instead.

## Date

2026-09-08

## Context

AI features over HR data are attractive and genuinely useful, but they introduce prompt injection over personal data, a cross-border transfer question under DPDP, an evaluation burden, and per-request cost. The organization has no LLM API key and does not want one.

## Options considered

| Option | Summary | Why not chosen |
|---|---|---|
| Ship an HR assistant in v1 | Policy Q&A, document extraction, search | Requires an API key, a permission-aware retrieval layer, prompt-injection defences and an eval harness - before the underlying authorization model has been proven in production |
| Ignore AI entirely | No design accommodation | Three seams are nearly free now and expensive to retrofit, and leaving them out would make a later decision unnecessarily costly |
| **No runtime AI, but build the seams (chosen)** | Zero model calls; design so it stays possible | - |

## Decision

**The product makes no model calls.** Claude is a development tool for building this system, not a runtime dependency of it.

Three seams are built anyway because they cost almost nothing now:

1. `documents` stores extracted text alongside binaries, so future retrieval does not require reprocessing every historical file
2. `AuthorizationService.scope()` returns a composable SQL predicate, so any future retrieval filters through **the same** authorization logic rather than a parallel implementation. This is the single control that makes permission-respecting AI possible at all
3. An `ai` module boundary is **reserved for future use** - not created. AI code is never inline in a domain module

> **Amended 2026-09-08 (pre-acceptance) - two wording corrections and one operational bound.**
>
> **Seam 3 was written in the present tense and is not built.** `architecture-principles.md`
> enumerates **ten** bounded contexts with no `ai` among them, and the only feature flag in the
> database is `feature.work_logging_enabled`. Since an Accepted ADR outranks `ai/context/`, the
> original wording would have silently invalidated that ten-module list. Reserving a name costs
> nothing and delivers nothing that would need retrofitting; seams 1 and 2 are the ones that carry
> real value, and seam 2 (`scope()` returning a composable predicate) is already required by
> ADR-0005 for reasons unrelated to AI.
>
> **The development-time / runtime line needs an operational bound, not only a product one.** The
> prohibitions below are written as *product* constraints - what the shipped system may not do.
> They do not, as written, prevent a future operator pointing this development harness at
> production data: `.claude/settings.json` allow-lists `Bash(psql *)` with no prompt and no
> scoping by host, database or role. Harmless today (a local dev container with seeded data), and
> now bounded explicitly:
>
> > **The Claude Code harness is a development tool and must never be connected to a production
> > database, or to any database containing real employee personal data.** That is a constraint on
> > *operating* this repository, not only on what the product ships.
>
> The `db:verify` target guard (DEC-024) is the first mechanical expression of this; it is not
> sufficient on its own.

Forbidden regardless of any later decision: any AI input to hiring, promotion, compensation, performance rating, discipline or termination; attrition prediction on named individuals; productivity or sentiment scoring; and any AI write path to employee records.

## Consequences

### Positive

- No API key, no per-request cost, no prompt-injection surface over HR data
- No DPDP cross-border question from model calls
- The seams keep the option open at trivial cost

### Negative / trade-offs

- Employees do not get assistive features that would genuinely help - policy Q&A in particular
- The seams are unproven until something uses them

## Reconsider when

If the organization decides to fund an API key. The first feature should be **personal work summarisation** (an employee summarising their own logs) rather than policy Q&A - smallest blast radius, clearest authorization scope, and it degrades gracefully. It would require an eval harness with a 100% authorization red-team score as a release gate.
