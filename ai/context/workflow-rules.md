# Workflow Engine Rules

**Authority:** implements ADR-0007. Read before any approval-flow or FSM change.

## FSM as data, never as code

States and transitions live in tables and are interpreted by one generic engine. **A new approval
flow is configuration, not a deployment.**

Forbidden: a `switch` on status, a hardcoded approver, a status field mutated by a direct UPDATE.

## The engine knows nothing about its subjects

Three design points carry this, and all three are load-bearing:

1. **Reversed foreign key.** Each subject table carries
   `workflow_instance_id UUID UNIQUE REFERENCES wf_instance(id)`. `wf_instance` has **no**
   `subject_id`. Real referential integrity, and adding a workflow-able entity is a migration on
   *that entity's* table - which respects module boundaries.
2. **Guards evaluate `subject_snapshot` (JSONB)**, captured at submission. The engine never reads
   the subject table, so guard evaluation is reproducible after the fact and the approvals module
   has zero knowledge of leave's schema.
3. **Actor resolution is dynamic but snapshotted.** Resolvers evaluate against the reporting graph
   **as of submission**, then freeze into `wf_task`. Not re-resolved on render, or the approver
   changes under the user mid-decision.

## Invariants enforced by the database

| Invariant | Mechanism |
|---|---|
| Only legal transitions | Trigger on `wf_instance` UPDATE checks `(from_state, event, to_state)` exists for the **pinned** definition version. A developer **cannot** set `status = approved` by hand |
| No self-approval | `CHECK (decided_by_employee_id <> subject_employee_id)` on a denormalised subject id, plus a trigger asserting it still matches its parent |
| Step ordering | `UNIQUE (request_id, step_no)` + BEFORE INSERT trigger asserting all lower steps are terminal |
| Immutable history | `wf_transition_log` is append-only. A reversal is a new compensating row |
| Published versions immutable | Trigger blocks mutation of a published `wf_definition_version` and its children |
| No hung instances | Deferred constraint: a non-terminal instance must have >= 1 pending task at commit |

## Actor resolution must be total

`wf_actor_rule.fallback_rule_id` is **mandatory**, forming a chain that always terminates:

```
reporting_manager -> org_unit_head -> hr_business_partner -> role:hr_admin
```

Without it, an instance is created with zero tasks and hangs **invisibly** - nothing is in
anyone's inbox to complain about. The manager left, or the employee *is* the manager (the CEO
applying for leave), or a reorg left no reporting row for that date.

**Monitoring query whose correct value is always exactly zero:** non-terminal instances with no
pending task.

## Delegation

`wf_delegation` is effective-dated with `CHECK (delegator <> delegate)` and an exclusion
constraint preventing overlapping delegations for the same workflow.

**Resolution happens at task-creation time only, and chains at most once.** A delegates to B, B
delegates to C: a task for A goes to B, not C. Without the cap, a company holiday where everyone
delegates produces either an infinite loop or a task routed to someone with no context. The
delegate is re-checked against the subject at decision time, which blocks "I delegate to my
report, who approves my leave".

## Escalation

One scheduled job scans due tasks and fires transitions **through the same engine**
(`is_automatic = true`) - never through a parallel code path.

Two details most engines get wrong:

- **`hours_basis = 'business'` must consult the holiday calendar and work schedule.** A 24-hour
  SLA starting Friday 18:00 must not breach on Saturday.
- **`auto_approve` as an escalation action is dangerous.** Gate it behind an explicit
  `allow_auto_approve` flag on the definition version and require a governance decision. An SLA
  breach silently approving a 30-day leave request is a control failure, not a feature.

## Status projection

`leave_request.status` and equivalents are **projections** maintained by the engine's effect
handler. The redundancy is deliberate: "approvals pending for me" needs `wf_task`, while "my
approved leave this year" needs the domain table, and forcing every list through a three-table
join into the engine is the wrong trade.

Projections are guarded by the same drift discipline as the leave balance.

## Current consumers

`leave` · `work` (timesheet periods) · `attendance` (corrections) · `reimbursement`.
Later: payroll, performance.

**Three independent consumers inside the MVP is what proves the engine generic** rather than
merely intended to be.
