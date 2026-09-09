# ADR-0016: Effort in Integer Minutes; Cost Never Stored on the Entry

## Status

Proposed

> Only a human may set this to Accepted. Once Accepted this file is immutable and
> `.claude/hooks/guard-adr.mjs` will refuse edits - supersede it with a new ADR instead.

## Date

2026-09-08

## Context

Logged effort may eventually feed project costing or client billing. Two decisions made now determine whether that is safe: how effort is stored, and whether monetary value lives on the effort row.

## Options considered

| Option | Summary | Why not chosen |
|---|---|---|
| Decimal hours | NUMERIC hours, e.g. 7.5 | Reintroduces rounding into something that may feed billing, and invites float arithmetic downstream |
| Store computed cost on the entry | Denormalise rate x minutes | **Leaks compensation into a project-scoped table.** A project manager legitimately reads effort; storing cost means they read salary by arithmetic |
| **Integer minutes, cost resolved at report time (chosen)** | No money on the effort row | - |

## Decision

Effort is **`minutes INTEGER`**. Never decimal hours, never float. Display converts; storage does not.

**No rate or cost column exists on `work_log_entry`.** Project cost is computed at report time by resolving effort against effective-dated compensation, behind the `work.effort_cost:read` action (see below - this was written as a `comp_viewer` entitlement, which is not how ADR-0005 models authorization).

If external billing ever requires a frozen cost snapshot, it goes in a **separate, access-restricted table** - not on the effort row.

### Scoped exception to Must-Know Rule 8

Must-Know Rule 8 forbids breaking module boundaries: modules own their tables and never import
each other's internals, communicating through a public module interface or a domain event. The
report-time cost computation above reads compensation, which the `work` module does not own. That
is a boundary crossing and is named here rather than left to be improvised by whoever builds the
first cost report:

> **Permitted exception to Must-Know Rule 8.** The `work` module may obtain effective-dated
> compensation for the purpose of computing project cost at report time, subject to all of:
>
> 1. **Read-only, and one direction only.** `work` never writes compensation, and `people` never
>    reads work logs as a consequence of this exception.
> 2. **Through the `people` module's public interface**, not by a direct `JOIN` from `work` code
>    onto `people`-owned tables. The interface takes an employee and an as-of date and returns the
>    resolved rate; the join, if any, happens inside `people`, which owns both the table and the
>    temporal semantics of reading it.
> 3. **Behind the `work.effort_cost:read` action**, enforced by `AuthorizationService` (ADR-0005)
>    before the interface is called - never by the reporting code deciding for itself.
> 4. **Resolved as of the work date**, not as of today, so a backdated increment does not silently
>    rewrite historical cost.
> 5. **Never persisted into a `work`-owned table.** The result is a report value with a lifetime
>    of one response.
>
> **This does not create a general cross-module read permission.** It authorises exactly one
> caller, for exactly one purpose, in one direction, behind one entitlement. No other `work` →
> `people` read is sanctioned by this ADR, and no other module may cite this exception as
> precedent. A second such crossing needs its own decision, not an appeal to this one.

**Note on the database grant.** `rbac-rules.md` states that `hrm_app` holds no grant at all on
compensation, precisely so that an injection flaw elsewhere cannot reach salary. This exception
does not widen that grant. Satisfying it therefore requires a distinct, narrowly-granted database
role used only by the cost-report path - and if that role is not created, the correct outcome is
that cost reporting does not ship, **not** that `hrm_app` is given the grant.

### The money type, the divisor, and `comp_viewer`

The ADR was meticulous about the *time* type and silent about the *money* type, which is the half
Must-Know Rule 4 actually governs.

**Money is integer minor units plus an explicit currency** - `bigint` paise and an ISO-4217 code,
never a float and never a bare `numeric` without a stated scale. Cost is computed as
`minutes * rate_minor_per_minute` in integer arithmetic, with rounding applied once at presentation
and the rounding mode stated on the report rather than left to the client.

**The divisor is policy, not a constant.** Converting monthly compensation to a per-minute rate
requires a standard-minutes-per-month figure, and that number is a policy decision (Must-Know Rule
11) which changes over time and must therefore be effective-dated like every other policy value. It
belongs on `work_policy` - the table ADR-0015 also needs and which does not yet exist (see the
amendment to ADR-0002). Until it exists, cost reporting cannot be built: **a hardcoded divisor would
silently produce a different answer for every historical period.**

**`comp_viewer` is an action, not an entitlement flag.** The term appeared only in this ADR, with no
definition and no glossary entry, while `ai/context/rbac-rules.md` uses an action/resource/policy
model rather than boolean entitlements. Restated in that model: reading computed effort cost is the
action **`work.effort_cost:read`**, resolved through `AuthorizationService` like every other
decision, and granted to a small set of roles rather than carried as a flag on a user row. The name
`comp_viewer` should not survive into code.

## Consequences

### Positive

- Exact arithmetic; no rounding drift across a month of entries
- The compensation boundary is structural: the table a project manager can read simply does not contain money
- Rate changes recompute historical cost correctly, because compensation is effective-dated

### Negative / trade-offs

- Cost reports require a join to compensation and an entitlement check, so they are more expensive than reading a column
- Minutes are less human-readable in raw data than hours

## Reconsider when

If external invoicing requires an immutable cost snapshot at invoice time - which is a new restricted table, not a new column here.
