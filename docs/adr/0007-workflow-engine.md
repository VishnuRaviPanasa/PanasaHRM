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

### Amended 2026-09-08 (pre-acceptance)

**(a) The invariants in `ai/context/workflow-rules.md` are part of this decision, not commentary
on it.** That file declares itself as implementing this ADR, yet carries six database-enforced
invariants, the mandatory `fallback_rule_id` chain semantics, the "delegation chains at most once"
cap and the `auto_approve` governance gate - none of which appear here. Because an Accepted ADR
**outranks** `ai/context/`, accepting this ADR as written would install the *thinner* document as
the higher authority, permanently, while the richer one stays editable. Those invariants are
therefore incorporated by reference and are binding at this ADR's level of authority; where the
two documents differ in detail, the stricter reading governs until a superseding ADR says
otherwise.

**(b) "Configuration, not a deployment" is bounded.** The claim is that a new approval flow needs
no code change - and it is true only inside an envelope, which this ADR previously left undrawn
while conceding elsewhere that a new workflow-able entity needs a migration. The envelope:

| No deploy | Needs a deploy |
|---|---|
| New states, transitions, actor rules, guard *expressions* over existing snapshot fields, reminder and escalation timings, a new definition version | A new **resolver**, a new **effect handler**, a new **guard operator**, a new workflow-able **entity** (migration on that entity's table), any new snapshot field a guard needs |

**(c) Firing a transition requires BOTH gates, and `AuthorizationService` is first.** `wf_actor_rule`
and ADR-0005 overlap, and unstated precedence is how one silently becomes decorative. The order is:
`AuthorizationService.can()` decides whether this actor may perform this action on this resource at
all; **only then** does `wf_actor_rule` decide whether they are the assigned actor for *this task*.
A `wf_actor_rule` match is **never** sufficient on its own - workflow data cannot grant a permission
the authorization model withholds, or Must-Know Rule 1 would be bypassable by inserting a row.

**(d) Self-approval is not yet structurally impossible, and this ADR should not claim it is.**
Design points 1 and 2 deliberately keep the engine ignorant of the subject, so any
`approver <> subject` check can only run against caller-supplied snapshot data - which makes it a
service-layer check relocated into the database, not a structural guarantee. Closing this properly
requires the subject identity to reach `wf_task` through a path the caller does not control. Until
then it is enforced, but by convention plus a test, and it is recorded here as a known weakness.

## Consequences

### Positive

- A new approval flow is configuration, not a deployment
- Chain integrity is structural: the chain is frozen at submission so a reorg cannot retarget an in-flight approval; step ordering is enforced by a unique index plus a trigger; and self-approval is blocked by a CHECK on a denormalised subject id. **That CHECK is not a structural guarantee** - see amendment (d): the subject id can only reach the engine as caller-supplied snapshot data, so it is a service-layer check relocated, and it is backed by a test rather than by the schema
- A transition-validity trigger means a developer cannot set `status = approved` with a hand-written UPDATE

### Negative / trade-offs

- Indirection: reading a leave request status means understanding the engine. Mitigated by projecting status onto the domain table
- Configuration errors become runtime errors rather than compile errors
- The FSM shape does not express parallel gateways or timer events beyond simple escalation

## Reconsider when

If flows need genuine parallel gateways, sub-processes or complex timers - at which point revisit BPMN. Linear chains with escalation do not justify it.
