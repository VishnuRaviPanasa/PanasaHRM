# Architecture Principles

**Authority:** implements ADR-0001, ADR-0003, ADR-0008. Read before any backend code or any
cross-module change. Editing requires architecture review.

## The governing principle

> **Prefer a constraint over a rule, a rule over a review, and a review over a hope.**

Anything a database constraint, a type, or a lint rule can enforce **must not** be delegated to
an agent's judgement or a reviewer's attention. Judgement is the least reliable and most
expensive layer, and the only one that can be wrong while sounding right.

## Modules

Eleven bounded contexts, each owning its own tables:

```
identity      auth, sessions, users, roles, permissions
organization  legal entities, org units, locations, grades, designations
people        person, employee, employment, reporting, lifecycle
documents     employee documents, versions, expiry, storage port
workflow      generic FSM engine, approval chains, delegation, escalation
leave         types, policies, entitlements, ledger, accrual, holidays
work          projects, tasks, work logs, timesheets, summaries
attendance    punches, shifts, rosters, daily derivation, regularization
notifications templates, dispatch, in-app inbox, preferences
audit         append-only trail, retention, query surface
assistant     the in-product AI assistant: tool catalogue, transcripts (ADR-0020)
```

**Dependency rule:** `identity` and `audit` are depended on by all. `organization` <- `people` <-
{`leave`, `work`, `attendance`, `documents`}. `workflow` is depended on by `leave`, `work` and
`attendance` but **knows nothing about them**. No cycles.

`assistant` is a **leaf**: it reads from the others and **nothing depends on it**, so deleting it
would break no module. That is deliberate and is what keeps it removable. It reads under the
named exception in ADR-0020 §5 - read-only, one direction, through the same authz action and the
same `scope()` predicate the owning module uses, never persisted. It is the eleventh context
because ADR-0014 required that "AI code is never inline in a domain module"; ADR-0014 reserved
the name `ai`, and ADR-0020 records why it is `assistant` instead.

`work` and `attendance` are **siblings, not parent and child** (ADR-0015).

## Layering inside a module

```
interfaces/      HTTP controllers, job handlers, event subscribers
application/     use cases - orchestration, transaction boundaries
domain/          entities, value objects, invariants. NO framework imports
infrastructure/  repositories, adapters. The ONLY place Drizzle is imported
```

Dependencies point **inward**. `domain/` imports nothing from the other three.

## Crossing a boundary

- **Write time:** publish a domain event through the transactional outbox
- **Read time:** call the other module's public interface, or use a read model

Never import another module's `service.ts`, `repository.ts` or entity types.

## The outbox is not optional

Every state change writes its event row **in the same transaction as the domain write**. This is
what guarantees "state changed => audit recorded" cannot diverge, and it is the single most
important property in the system.

Audit is *additionally* enforced by database trigger, because ADR-0003 permits raw SQL as a
sanctioned escape hatch — and an audit mechanism that a sanctioned code path can bypass is a
convention, not a control. Migrations and DBA sessions bypass the application entirely, and those
are exactly the events an auditor cares about most.

## Transaction boundaries

**One transaction:** the aggregate root, its children, its ledger entries, its projection update,
its workflow instance, and its outbox event.

**Never in a transaction:** an HTTP call, an email send, an object-store write, a full-org
recompute, or a user's think-time.

Object storage writes happen **before** the transaction; on failure the orphan is reaped later.
Never hold a transaction open across an S3 call.

## Error model

A typed hierarchy caught by one global filter: `ValidationError` -> 422, `AuthorizationError` ->
403 (or 404 when existence itself is a disclosure), `NotFoundError` -> 404, `ConflictError` ->
409, `DomainError` -> 4xx. Responses are RFC 9457 problem details.

**Fail closed.** If the authorization service, a scope resolver or the field registry throws, the
request is **denied** — never defaulted to allow. Postgres driver detail (`detail`, `hint`,
`constraint`, `where`) is stripped from both the response **and** the log line, or a unique
violation on a blind index prints the conflicting value.

## Configuration

Validated by a Zod schema **at boot**. The app refuses to start on missing or malformed config
rather than failing mysteriously at 2am. Secrets are file-backed, never plain environment
variables — a startup assertion refuses to boot in production if a known secret name appears as
one.

## What lives in configuration, not code

Rates, thresholds, approval chains, statuses, leave rules, shift definitions, statutory values,
retention periods, holiday calendars. Must-Know Rule 11.

The test: **if HR could reasonably change it without a developer, it is data.**

## Naming

`snake_case` in SQL, `camelCase` in TypeScript, `PascalCase` for types. Tables singular
(`employee`, not `employees`). Booleans read as assertions (`is_primary`, `has_expired`).
Dates ending `_on` are `DATE`; timestamps ending `_at` are `timestamptz`. That suffix convention
is load-bearing — it makes Must-Know Rule 5 violations visible at a glance.
