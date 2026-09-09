# ADR-0018: Standalone Application - No Dependency on Any Existing System

## Status

Proposed

> Only a human may set this to Accepted. Once Accepted this file is immutable and
> `.claude/hooks/guard-adr.mjs` will refuse edits - supersede it with a new ADR instead.

## Date

2026-09-08

## Context

Panasa runs other systems: Hiremate for recruitment and onboarding, GreytHR for leave, attendance, salary and documents. The obvious move is to integrate - pull hired candidates from Hiremate, sync attendance from GreytHR. The human decision was explicitly the opposite.

## Options considered

| Option | Summary | Why not chosen |
|---|---|---|
| Integrate with Hiremate and GreytHR | API contracts, scheduled sync | Every integration is a permanent maintenance liability, a versioned API surface and a shared failure mode - to avoid data entry that happens a few times a month |
| Read their databases directly | Shared database access | Couples to another system internal schema, which breaks silently on their deploys and makes both systems unchangeable |
| **Fully standalone (chosen)** | No integration of any kind | - |

## Decision

**No dependency on any other application.** No integration endpoint, no service token, no webhook subscriber, no cross-system database read, no imported schema, no scheduled sync.

The only external interfaces are **infrastructure, not applications**: Entra ID as an identity provider, an SMTP relay, and biometric or CSV attendance ingest - which starts as CSV, so even that has no vendor on the critical path.

**Employee records originate here.** New hires are created by HR directly, or seeded through the bulk importer with dry-run validation.

Other systems on this machine - Hiremate, the Thredd portal, attendance-symphony - are **reference material only**. Copying a *pattern* is encouraged; creating a *coupling* requires a superseding ADR.

> **Context refresh, 2026-09-08 (pre-acceptance).** The Context above describes GreytHR as covering
> "leave, attendance, salary and documents". `docs/requirements/greythr-current-state.md` records a
> wider footprint than that: its ESS today also includes **People, Helpdesk, Request Hub and
> Workflow Delegates**. Replacing it is therefore a materially larger scope than this ADR's
> framing - "data entry that happens a few times a month" understates the trade for the modules
> GreytHR already serves daily.
>
> **This does not change the decision, and OR-07 does not block it.** Standalone-versus-integrated
> is an architectural question, already settled by the human (D5); retire-versus-coexist is an
> operations question about *when* Panasa stops dual-entering, and this ADR already anticipates
> parallel running. The two can both hold: running alongside GreytHR indefinitely is fully
> consistent with taking no dependency on it. What the wider footprint changes is the *cost*
> estimate and the MVP cut line, which belong to OR-07, not here.
>
> Verified at review: no integration marker exists anywhere in the repository - no endpoint, no
> service token, no webhook, no external identifier column in any migration, and the GreytHR
> reference document carries no credentials. One ambiguity worth noting: `org_setting.category`
> permits the value `'integration'`. It is unused, and it is ambiguous precisely where this ADR is
> most sensitive.

## Consequences

### Positive

- No versioned contract to maintain, no shared failure mode, no coupling to another system release cycle
- The architecture is simple enough to hold in one head - materially valuable for a solo developer
- Removes an entire class of integration bugs and an entire authentication path

### Negative / trade-offs

- **Duplicate data entry** where a hire already exists elsewhere. This is a real recurring operational cost and the honest price of zero coupling
- The two systems can drift, and HRM is only trusted as the record if it is declared the system of record and kept current
- No automatic reconciliation against another source - discrepancies surface as human observations

## Reconsider when

If hiring volume makes re-keying genuinely painful. Revisit as an explicit superseding ADR - **not as an ad-hoc endpoint added under deadline pressure**, which is how coupling actually enters a system.
