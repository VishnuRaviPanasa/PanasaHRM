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

### Amended 2026-09-08 (pre-acceptance)

**`X-Request-Id` is untrusted input, and this is a security boundary, not a formatting rule.** The
header is propagated into logs, jobs and `audit_event.correlation_id` - an append-only table with a
decade-long retention. A client-supplied value reaching it unchecked is audit-trail poisoning into
storage that by design cannot be corrected. Therefore:

> The server **generates** the request id. An inbound `X-Request-Id` is accepted only from a
> trusted proxy hop, and only if it matches a strict format (UUID); otherwise it is discarded and
> a fresh id is generated. An inbound value is never written to `audit_event` without having
> passed that validation, and the correlation id recorded in audit is always the server's own.

**UUIDv7 versus what shipped.** This ADR mandates UUIDv7, but migrations 0002 and 0003 use
`gen_random_uuid()` (v4) for every primary key. That is a real divergence and not a platform
limitation - `uuidv7()` exists natively on the PostgreSQL 18.6 this project runs. Resolution:
**UUIDv7 is the standard for new identifier columns from this point**; the four v4 columns already
shipped are not worth a migration, because they carry no ordering assumption and no data depends on
their generation scheme. A future migration may align them, and need not.

**`docs/standards/api-conventions.md` does not exist yet** and this ADR is not sufficient on its
own to finish task T9. What can be scaffolded from `ai/context/engineering-guidelines.md` and
`architecture-principles.md` is the error model, RFC 9457 shape and cursor pagination; what remains
genuinely undecided is idempotency-key replay semantics (window, storage, and what a repeated key
with a *different* body must do) and ETag derivation. Those must be written before, not after, the
endpoints that implement them.

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
