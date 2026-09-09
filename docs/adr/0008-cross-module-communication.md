# ADR-0008: Cross-Module Communication - Transactional Outbox

## Status

Proposed

> Only a human may set this to Accepted. Once Accepted this file is immutable and
> `.claude/hooks/guard-adr.mjs` will refuse edits - supersede it with a new ADR instead.

## Date

2026-09-08

## Context

Every state change must produce an audit record and may trigger notifications. If the domain write commits and the audit write does not - because the process died in between - the audit trail has a hole, and a hole in an audit trail is indistinguishable from a cover-up.

## Options considered

| Option | Summary | Why not chosen |
|---|---|---|
| Direct cross-module calls | The leave module calls the audit module | Couples modules and still does not guarantee atomicity if the callee fails after the caller commits |
| A message broker | Kafka or RabbitMQ | Another system to operate for a single-VM deployment, and it does not solve dual-write atomicity by itself |
| **Transactional outbox (chosen)** | Event row written in the same transaction, drained by a worker | - |

## Decision

Domain writes insert into `outbox_event` **in the same transaction**. A single-consumer worker drains it and fans out to subscribers (audit, notifications). Delivery is at-least-once; consumers are idempotent, keyed by `outbox_event_id`.

Audit is additionally enforced by **database trigger**, because ADR-0003 explicitly permits raw SQL - a sanctioned escape hatch that would otherwise bypass any application-level audit interceptor. Migrations and DBA sessions bypass the application entirely, and those are exactly the events an auditor cares about most.

The trigger is the floor (what changed); the outbox event is the ceiling (why, by whom, in which request).

### Relationship to Must-Know Rule 2 - what is transactional, and what is not

Must-Know Rule 2 says *every state change emits a domain event via the outbox AND an audit record,
in the same transaction as the write*. Read literally, the second half of that is not what this
design does, and the difference must be stated rather than discovered during an incident.

**The invariant is transactionally committed audit *intent*, not transactionally committed audit
*materialisation*.** Precisely:

| Element | Timing | Guarantee |
|---|---|---|
| The domain write | — | — |
| The `outbox_event` row (the intent: why, by whom, in which request) | **Same transaction** | Atomic with the write. Cannot diverge. |
| The trigger-written `audit_event` row (the floor: what changed) | **Same transaction** | Atomic with the write, once the audit trigger exists. **It does not yet** - `audit_event` and its append-only rails are built, the per-table audit trigger is not. Until then this row is a design commitment. |
| The drain-written `audit_event` row (`source='application'`, carrying actor and correlation) | **Asynchronous** | At-least-once, after commit. Lags by the drain interval. |

So a committed state change **always** leaves two synchronous, durable artefacts - the trigger
audit row and the outbox row - and neither can be lost by a crash after commit. What arrives later
is the *enriched* audit record that joins the change to the actor and the request.

**This is a deliberate narrowing of Rule 2, not a silent one.** The reason the enriched record
cannot be synchronous is the same reason the outbox exists: writing it in the request transaction
would either require the audit module to be called directly by every other module (rejected above,
and a Rule 8 violation) or make the request path depend on downstream availability (Rule 12).

**What is therefore forbidden, and remains forbidden:** a state change that commits with **no**
outbox row and **no** trigger audit row. That is the hole Rule 2 exists to prevent, and this design
closes it. What Rule 2 must not be read to promise is that `audit_event` is fully populated,
actor-attributed, and queryable the instant the transaction commits - it is not, and no design that
keeps modules decoupled can make it so.

**Consequence for anyone reading audit data:** a query over `audit_event` run immediately after a
write may see the trigger row and not yet the enriched one. Reconciliation - "every outbox row has
a corresponding enriched audit row" - is the check that this narrowing holds, and its failure is a
correctness incident, not a lag metric.

### Ordering, poison messages, and the table's real name

**The table is `outbox_event`, singular.** This ADR previously called it `outbox_events` in the
Decision and `outbox_event` in the Consequences; migration 0001 creates `outbox_event`.

**Ordering is per-aggregate, not global.** `id` is `GENERATED ALWAYS AS IDENTITY`, and identity
values are allocated *before* commit - so commit order does not follow id order, and a global read
by `id` can observe `approved` before `submitted`. Consumers must therefore order by
`(aggregate_type, aggregate_id, id)` and treat cross-aggregate ordering as undefined. No event is
lost by this: the drain selects on `processed_at IS NULL`, which is a set, not a high-water mark -
a deliberately correct choice that this ADR should have stated rather than left to be inferred.

**A poison message must have somewhere to go.** `CHECK (attempts <= 100)` means that at attempt 100
the worker's own error-handling `UPDATE` raises `23514`, so a permanently failing event can neither
advance nor be marked done - it sits in the pending index forever, corrupting the drain-lag metric
that is the only alert on this path. The design therefore requires a terminal state:
`dead_lettered_at` plus `last_error`, excluded from the pending partial index, with an alert on any
non-zero count. A dead-lettered event is *not* delivered, so anything downstream of it is missing -
it is an incident, not a cleanup queue.

**Retention.** The append-only trigger blocks `DELETE` and the table is not partitioned, so there is
currently **no way to prune the outbox at all** - it grows without bound with no remediation path.
`audit_event` was partitioned specifically to make this tractable; the outbox got the append-only
trigger without the partitioning. Resolving this needs a migration (monthly partitions with
`DETACH`, or a narrowly-scoped deletion path for rows that are both processed and older than the
retention window). **Not yet done - tracked as OR-11(a).**

## Consequences

### Positive

- "State changed" and "audit recorded" cannot diverge - the single most important property in the system
- No broker to operate
- Trace context propagates through the outbox, so a notification is traceable back to the request that caused it
- Extraction to services later means changing the drain target, not the write path

### Negative / trade-offs

- Eventual consistency for downstream effects - a notification lags the state change by the drain interval
- The outbox table needs a retention sweep or it grows without bound
- **Drain lag is a silent failure mode**: audit and notifications fall behind with no user-visible symptom. It requires its own alert

## Reconsider when

If module extraction happens, swap the drain target for a broker. The write path does not change.
