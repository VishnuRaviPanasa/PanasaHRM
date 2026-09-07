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

**No rate or cost column exists on `work_log_entry`.** Project cost is computed at report time by joining effort to effective-dated compensation, behind the `comp_viewer` entitlement.

If external billing ever requires a frozen cost snapshot, it goes in a **separate, access-restricted table** - not on the effort row.

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
