# ADR-0017: Work Logs Are Purpose-Bound, Not a Productivity Signal

## Status

Proposed

> Only a human may set this to Accepted. Once Accepted this file is immutable and
> `.claude/hooks/guard-adr.mjs` will refuse edits - supersede it with a new ADR instead.

## Date

2026-09-08

## Context

Daily work logging is surveillance-adjacent. It captures narrative content - achievements, challenges, next-day plans - alongside structured effort. Under DPDP, employee monitoring is a distinct processing purpose requiring its own basis and notice.

## Options considered

| Option | Summary | Why not chosen |
|---|---|---|
| Open-ended monitoring use | Logs available for any management purpose | Changes the processing purpose without notice, and creates discrimination and dignity exposure |
| Use logs as a performance input | Feed log content into ratings | Changes what people write. **An honest log is only possible when it is not being graded** - and then the effort data is worthless for the costing it exists for |
| **Purpose-bound, employee-visible, retention-limited (chosen)** | Effort accounting and self-reported accomplishment only | - |

## Decision

Work logs exist for **two declared purposes**: effort accounting, and self-reported accomplishment. That purpose is registered in the processing registry with its own notice and retention period.

Concretely:

- Employees can always read and export their own logs
- Logs carry their own retention period, shorter than employment records
- **No productivity-scoring surface exists in the product** - not a ranking, not a score, not a league table
- In performance reviews, **the employee chooses what to cite**. The system never auto-scores from log content
- Aggregate, de-identified team-level analysis is permitted; the same analysis attributed to named individuals is not. **The dividing line is attribution, enforced in the query**

## Consequences

### Positive

- The data stays honest, which is what makes it useful for costing
- A narrower, defensible DPDP position than open-ended monitoring
- Employees can see everything held about them, which is both a right and a trust mechanism

### Negative / trade-offs

- Managers who want a productivity dashboard will not get one, and will ask
- Some genuinely useful analysis is foreclosed by the attribution rule

## Reconsider when

Only by explicit governance decision with legal review, recorded as a superseding ADR - **never as a feature ticket.** The pressure to cross this line will arrive as a reasonable-sounding request.
