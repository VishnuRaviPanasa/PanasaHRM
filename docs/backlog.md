# Backlog

Single prioritised list. Phase tags follow the roadmap in the plan (section 38).

## Now - Phase 1 (Architecture and ADRs)

| # | Task | Notes |
|---|---|---|
| ~~T2~~ | ~~Author the review gate~~ **DONE** | 7 subagents, slash commands, skills, hooks, `agent-output-contract.md` (envelope v2), `severity-vocabulary.md`, populate `ai/REGISTRY.md`. **Then try to break each rail and confirm it holds.** |
| ~~T3~~ | ~~Write ADRs~~ **DONE - 18 written, all Proposed. Human must Accept** | Drafted in plan section 13. Human accepts; no agent may mark one Accepted |
| ~~T4~~ | ~~Write ai/context~~ **DONE - all 10 files** | Especially `temporal-data-rules.md` and `rbac-rules.md` - precise enough to implement from |
| T5 | **Write `docs/requirements/` from the Employee Handbook** | Plan Appendix A is the source. Carry C1-C12 through as explicit open questions |

## Now - human action required

| # | Task | Who |
|---|---|---|
| T3a | **Accept the ADRs** - read and set Status to Accepted, one at a time. 0002, 0005, 0006 and 0015 are the expensive ones to reverse | Human |
| T5 | Move plan Appendix A into `docs/requirements/` as versioned docs | Claude |

## Next - Phase 2 (Foundation)

| # | Task |
|---|---|
| T6 | Docker Compose dev stack (postgres 18, redis 7, minio, adminer) |
| T7 | Migration runner, baseline migration, Drizzle mirror, drift detection |
| T8 | `audit_log` (monthly partitions) + `outbox_events` + drain worker |
| T9 | NestJS bootstrap: Zod-validated config, typed errors, RFC 9457, request IDs, OpenAPI, health endpoints |
| T10 | Observability: OpenTelemetry, pino with redaction, Prometheus, Grafana/Loki/Tempo |
| T11 | Test harness: Vitest + Testcontainers against real Postgres 18 |
| T12 | CI gates 1 and 2, branch protection |
| T13 | ESLint + `eslint-plugin-boundaries` (DEC-002) |

## Blocked - needs a human

| # | Item | Blocked on |
|---|---|---|
| B1 | Leave engine specification | Handbook contradictions C1-C6 (OR-01) |
| B2 | Attendance derivation | C7, C8 - no grace period or half-day threshold defined (OR-01) |
| ~~B3~~ | ~~Realistic leave/attendance test data~~ | **UNBLOCKED** - 2026 calendar recorded in `docs/requirements/holiday-calendar-2026.md`; seed it in Phase 2 |
| B4 | DPDP compliance sign-off | No named legal contact (OR-03) |
| B5 | Push to remote | Sandbox has no network (OR-04) |
| B6 | Holiday election cap and retroactive-holiday handling | H-01..H-06 (OR-06) |
| B7 | Retire-or-coexist decision for GreytHR | O12 / OR-07 - needed before Phase 7, not before Phase 1-5 |
