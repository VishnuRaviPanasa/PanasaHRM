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

Domain writes insert into `outbox_events` **in the same transaction**. A single-consumer worker drains it and fans out to subscribers (audit, notifications). Delivery is at-least-once; consumers are idempotent, keyed by `outbox_event_id`.

Audit is additionally enforced by **database trigger**, because ADR-0003 explicitly permits raw SQL - a sanctioned escape hatch that would otherwise bypass any application-level audit interceptor. Migrations and DBA sessions bypass the application entirely, and those are exactly the events an auditor cares about most.

The trigger is the floor (what changed); the outbox event is the ceiling (why, by whom, in which request).

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
