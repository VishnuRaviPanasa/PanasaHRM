# ADR-0004: API Style - REST with OpenAPI

## Status

Proposed

> Only a human may set this to Accepted. Once Accepted this file is immutable and
> `.claude/hooks/guard-adr.mjs` will refuse edits - supersede it with a new ADR instead.

## Date

2026-09-08

## Context

The API serves one first-party frontend. There are no external consumers (ADR-0018). The dominant constraint is that HR responses carry fields at four sensitivity classifications, and the wrong field reaching the wrong caller is the top risk in the system.

## Options considered

| Option | Summary | Why not chosen |
|---|---|---|
| GraphQL | Single endpoint, client-specified selection | Field-level authorization and query-cost control are dramatically harder when the client composes the selection set. With RESTRICTED fields as the crown jewels, that is the wrong risk to take |
| tRPC | End-to-end typed RPC | Excellent DX, but produces no language-neutral contract artifact, and the procedure surface is harder to enumerate for authorization-coverage checking |
| **REST + OpenAPI (chosen)** | Resource-oriented HTTP, generated spec | - |

## Decision

**REST with an OpenAPI document generated from code and committed.** Committing it makes the contract diffable, so a breaking change appears in review rather than in production.

Conventions are binding and live in `docs/standards/api-conventions.md`: UUIDv7 identifiers, cursor pagination, RFC 9457 problem details, `Idempotency-Key` required on balance-affecting writes, `ETag`/`If-Match` on mutable entities, and `X-Request-Id` propagated into logs, jobs and audit rows.

## Consequences

### Positive

- Every route is enumerable, which is what makes the boot-time authorization-coverage assertion possible
- The committed spec is machine-readable context for agents - the true API surface without re-reading controllers
- Field-level masking applies centrally at serialization, because the server decides the shape

### Negative / trade-offs

- More endpoints to write and document than a single GraphQL schema
- Clients may over-fetch relative to a query language; acceptable for a first-party UI

## Reconsider when

If a third-party consumer ever needs flexible querying - at which point a read-only GraphQL layer over the same authorization primitives is preferable to replacing REST.
