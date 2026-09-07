# Project Context

Scale, constraints and non-goals. Read when a decision depends on "how big is this".

## Scale assumptions

| Dimension | Design point |
|---|---|
| Legal entities | 1 now (Panasa Technology Pvt. Ltd.); model supports several |
| Employees | <= 5,000 |
| Concurrent users | <= 1,500 at peak (month-end, appraisal season) |
| History retained online | ~10 years |
| Attendance punches | ~5M/yr at design point; **partitioned monthly from creation** |
| Audit events | 10-20M/yr; **partitioned monthly from creation** |
| Work log entries | ~3.75M/yr; partition at ~25M rows |

**Design for this, not for infinite scale.** Over-designing trades real simplicity for imaginary
growth. Architectural thresholds that would invalidate ADR-0001 are in the plan; none is
anticipated.

## Constraints that shape everything

1. **One developer.** Automated gates substitute for peer review. Process that is not sustainable
   will be abandoned, and an abandoned gate is worse than none because it is still believed in.
2. **Single VM, Docker Compose** (ADR-0013). No HA. Backups and patching are our responsibility.
3. **No dependency on any other system** (ADR-0018). Employee records originate here.
4. **No runtime AI** (ADR-0014). No API key exists and none is wanted.
5. **India / Kerala jurisdiction**, with statutory rules mid-transition (ADR-0012).

## Performance targets

p95 under expected peak: simple read < 150ms · filtered list < 400ms · search < 300ms · write
< 500ms · team attendance month < 1.2s · page LCP < 2.0s. Nightly attendance derivation for
5,000 employees < 15 min. Reports > 1s are asynchronous and delivered as a file.

**Query plans are asserted in CI**: a regression from Index Scan to Seq Scan on a large table
fails the build. That catches the classic "worked in dev with 50 rows".

## Non-goals for v1

Multi-tenancy · mobile native apps · applicant tracking · payroll (Phase 10) · performance
(Phase 11) · client billing · AI features · integration with any existing application.

## Where the reasoning lives

`docs/adr/` for architectural decisions, `docs/governance/decisions.md` for the rest, and the
full blueprint at `C:\Users\panasa137user\.claude\plans\you-are-acting-as-lazy-moon.md` for the
long-form analysis behind both.
