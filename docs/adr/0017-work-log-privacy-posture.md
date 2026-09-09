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

Work logs exist for **two declared purposes**: effort accounting, and self-reported accomplishment. That purpose is **to be** registered in a processing registry with its own notice and retention period. **The registry does not exist** - see amendment (c). Until it does, this is a design commitment, not a control.

Concretely:

- Employees can always read and export their own logs
- Logs carry their own retention period, shorter than employment records
- **No productivity-scoring surface exists in the product** - not a ranking, not a score, not a league table
- In performance reviews, **the employee chooses what to cite**. The system never auto-scores from log content
- Aggregate, de-identified team-level analysis is permitted; the same analysis attributed to named individuals is not. **The dividing line is attribution, enforced in the query**

### Amended 2026-09-08 (pre-acceptance)

**(a) The legal claim is softened to a design posture.** This ADR previously asserted a DPDP
requirement as settled fact and claimed a "defensible DPDP position". **No one is authorised to
assert that**: OR-03 records that DPDP compliance has no named legal owner, and CLAUDE.md forbids
inferring legal requirements. The design choices below stand on their own merits - each is *more*
restrictive than the law is likely to demand, so the cost of being wrong is a foreclosed feature,
not exposure. They are **not** a compliance opinion and must not be cited as one. A named legal
contact must review this before go-live (Phase 9).

**(b) Retention gets a number, or it is not a control.** "Shorter than employment records" is a
comparative with no value on either side, no mechanism and no owner. **Proposed: 24 months from the
work date**, long enough for two annual review cycles and any project-costing reconciliation, after
which narrative content is deleted and only aggregate effort totals survive. This number is an
engineering default and is **badged unconfirmed** in the DEC-020 sense - it needs HR and legal
confirmation, but an unconfirmed number is reviewable in a way that a comparative is not.

**(c) The processing registry does not exist.** It appears exactly once in this repository - in
this ADR. `docs/privacy/` contains only a README, `docs/privacy/data-inventory.md` does not exist,
and there is no CI pipeline for the check that README promises. Until the registry exists, "the
purpose is registered" is an intention. **Additionally: CLAUDE.md's Forbidden Actions bar adding a
personal-data column without a `data-inventory.md` classification - so the work module cannot
currently be built without violating that rule.** That is a live blocker on Phase 7, not a
paperwork gap (OR-12).

**(d) Aggregation needs a k-threshold.** "Aggregate, de-identified team-level analysis" is not
de-identified on a two-person project, and is not an aggregate on a one-person project. With ≤5,000
employees and small delivery teams this is the normal case, not the edge. **Minimum group size k=5**
for any aggregate that crosses an individual boundary; below that the query returns suppressed
rather than a number. Without a threshold, "de-identified" is a label rather than a property.

**(e) Erasure is unaddressed, and work logs are exactly where it bites.** `docs/privacy/README.md`
makes erasure selective with statutory retention overriding - but this ADR's whole thesis is that
work logs are **not** statutory records. They are therefore the one data class with no override,
and the first place a deletion request lands. The interaction with project-costing history (effort
totals that outlive the narrative) must be decided before the module ships.

**(f) "No productivity-scoring surface exists" is a promise, not a design.** You cannot constrain
the absence of a feature, and this ADR's own governance clause correctly predicts the failure mode.
Two structural backstops are worth claiming because they already exist: ADR-0014 removes the
easiest scoring path by forbidding runtime AI, and ADR-0005's default-deny field masking means a
scoring column would have to be deliberately exposed rather than accidentally leaked.

## Consequences

### Positive

- The data stays honest, which is what makes it useful for costing
- A narrower posture than open-ended monitoring, which should be easier to defend - **not a compliance opinion**; no one on this project is authorised to give one (OR-03)
- Employees can see everything held about them, which is both a right and a trust mechanism

### Negative / trade-offs

- Managers who want a productivity dashboard will not get one, and will ask
- Some genuinely useful analysis is foreclosed by the attribution rule

## Reconsider when

Only by explicit governance decision with legal review, recorded as a superseding ADR - **never as a feature ticket.** The pressure to cross this line will arrive as a reasonable-sounding request.
