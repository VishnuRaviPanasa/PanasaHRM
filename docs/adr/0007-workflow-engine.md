# ADR-0007: Approval Workflow - A Generic FSM Defined as Data

## Status

Proposed

> Only a human may set this to Accepted. Once Accepted this file is immutable and
> `.claude/hooks/guard-adr.mjs` will refuse edits - supersede it with a new ADR instead.

## Date

2026-09-08

## Context

Leave, timesheets, attendance corrections and reimbursement all need approval chains, and payroll and performance will later. Each has different states, approvers and rules. Building the same machinery four times is how HRM codebases rot into unmaintainable switch statements.

## Options considered

| Option | Summary | Why not chosen |
|---|---|---|
| Hardcoded per module | Each module owns its own status field and transitions | Four implementations that drift; a new flow means a deployment; and approval-chain integrity has to be re-proven in each |
| A BPMN engine | Camunda or similar | An entire platform to operate and learn, for flows that are linear chains with escalation. Disproportionate |
| **FSM defined as data, interpreted generically (chosen)** | States and transitions in tables, one engine | - |

## Decision

A generic engine over `wf_definition`, `wf_definition_version` (immutable once published), `wf_state`, `wf_transition`, `wf_actor_rule`, `wf_instance`, `wf_task` and an append-only `wf_transition_log`.

Three design points carry most of the value:

1. **The polymorphic subject problem is solved by reversing the FK.** Each subject table carries `workflow_instance_id UUID UNIQUE REFERENCES wf_instance(id)`. Real referential integrity, and adding a workflow-able entity is a migration on *that* entity's table - not on a central one.
2. **Guards evaluate against `wf_instance.subject_snapshot` (JSONB)**, captured at submission. The engine never reads the subject table, so it has zero knowledge of leave's schema, and guard evaluation stays reproducible after the fact.
3. **Actor resolution is dynamic but snapshotted.** Resolvers (`reporting_manager`, `org_unit_head`, `role`, ...) evaluate against the reporting graph as of submission, then freeze into `wf_task`. A mandatory `fallback_rule_id` chain makes resolution total.

## Consequences

### Positive

- A new approval flow is configuration, not a deployment
- Chain integrity is structural: the chain is frozen at submission so a reorg cannot retarget an in-flight approval; step ordering is enforced by a unique index plus a trigger; and self-approval is blocked by a DB CHECK on a denormalised subject id, not by a service-layer `if`
- A transition-validity trigger means a developer cannot set `status = approved` with a hand-written UPDATE

### Negative / trade-offs

- Indirection: reading a leave request status means understanding the engine. Mitigated by projecting status onto the domain table
- Configuration errors become runtime errors rather than compile errors
- The FSM shape does not express parallel gateways or timer events beyond simple escalation

## Reconsider when

If flows need genuine parallel gateways, sub-processes or complex timers - at which point revisit BPMN. Linear chains with escalation do not justify it.
