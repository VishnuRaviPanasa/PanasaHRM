# ADR-0001: Application Architecture - Modular Monolith

## Status

Proposed

> Only a human may set this to Accepted. Once Accepted this file is immutable and
> `.claude/hooks/guard-adr.mjs` will refuse edits - supersede it with a new ADR instead.

## Date

2026-09-08

## Context

PanasaHRM serves one organization of at most a few thousand employees, built and operated by a single developer. The architecture must keep module boundaries clean enough that a module could later be extracted, without paying distributed-systems costs now.

## Options considered

| Option | Summary | Why not chosen |
|---|---|---|
| Microservices | A service per bounded context | Introduces distributed transactions across leave-balance and audit writes, network failure modes in the approval path, and N deployment pipelines - to solve scaling problems this system does not have |
| Service-oriented (a few coarse services) | API, worker and web as separate deployables | Still splits the transaction boundary between domain write and audit write, for marginal benefit at this scale |
| **Modular monolith (chosen)** | One deployable, hard internal boundaries, one database | - |

## Decision

A **modular monolith**. One NestJS API, one PostgreSQL database, one Next.js frontend. Modules (`identity`, `organization`, `people`, `documents`, `workflow`, `leave`, `work`, `attendance`, `notifications`, `audit`) own their own tables and expose a public interface. Cross-module communication is via domain events through a transactional outbox (ADR-0008). Workers run in the same image, toggled by an environment flag.

The genuine risk of a monolith is **boundary erosion**, so boundaries are enforced mechanically by `eslint-plugin-boundaries` and reviewed by the `authz-auditor` and `reviewer` agents - not by good intentions.

## Consequences

### Positive

- A state change and its audit record commit in one transaction. This is the property that makes the audit trail trustworthy, and it is the first thing microservices would take away
- One deployment, one log stream, one place to debug - decisive for a solo operator
- Refactoring across a boundary is a compile-time error, not a runtime 500

### Negative / trade-offs

- Boundaries erode unless actively enforced; the lint rule is load-bearing, not decorative
- The whole application scales as one unit - one hot module cannot be scaled independently
- A bad deploy takes everything down together

## Reconsider when

Past roughly 20,000 employees; if the organization becomes a multi-tenant product; or if one module needs an independent deploy cadence. **None of these is anticipated.** If none occurs, the monolith is the permanent answer, not a stepping stone.
