# PanasaHRM — Project Briefing

> **Read this before every task.** It is the operating contract for all work in this repo.
> It contains **no mutable state** — for where the project actually is, read
> `.claude/state/CURRENT_SLICE.md` and `.claude/state/SESSION_HANDOFF.md`.

## Mission

A production HRM for **Panasa Technology Pvt. Ltd.** (single site, Kochi, Kerala; India
jurisdiction). Covers post-hire HR: employee master data with history, org structure, leave,
daily work management, attendance, documents, approvals and audit. Payroll, performance and
analytics come later.

**This is a standalone application.** It has **no dependency on any other system** — no
integration endpoints, no service tokens, no webhooks, no reading another system's database.
Hiremate, GreytHR, the Thredd portal and attendance-symphony are **reference material only**.
Copying a *pattern* is encouraged; creating a *coupling* requires an ADR.

## Architecture in one paragraph

Domain-driven **modular monolith**: one NestJS API, one PostgreSQL database, one Next.js
frontend, deployed by Docker Compose on a single VM. Modules (`identity`, `organization`,
`people`, `documents`, `workflow`, `leave`, `work`, `attendance`, `notifications`, `audit`) own
their tables and never import each other's internals — cross-module communication is via
**domain events through a transactional outbox**. Core HR data is **effective-dated**
(`daterange` + `EXCLUDE` constraints), so any record can be reconstructed as-of any past date.
Leave balances are an **append-only ledger** with a lockable account row carrying the
anti-overdraw constraint. Approval flows are a **generic FSM defined as data**, reused by leave,
timesheets, attendance corrections and reimbursement. Authorization is **centralised** and
resolves **two orthogonal scope graphs**: the reporting hierarchy for HR resources, and project
membership for work resources.

## Stack

TypeScript strict everywhere · Next.js 16 (App Router) + Tailwind + Radix + TanStack Query +
react-hook-form/Zod · NestJS 11 on Node 24 · PostgreSQL 18 with **hand-written SQL migrations as
the source of truth** and Drizzle as a typed mirror · Redis + BullMQ · MinIO · OpenTelemetry ·
Vitest + Testcontainers + Playwright · npm workspaces (**not** pnpm/bun — not installed here).

## Must-Know Rules (NEVER violate)

1. **Never bypass authorization.** Every decision goes through `AuthorizationService`. No inline
   `if (user.role === ...)` outside `packages/authz`.
2. **Never skip audit emission.** Every state change emits a domain event via the outbox AND an
   audit record, in the same transaction as the write.
3. **Never overwrite effective-dated data.** Changes create a **new period**. Closing a period is
   allowed; mutating a historical one is not.
4. **Never use floating point for money or leave balances.** Integer minor units, or `numeric`.
5. **Never store a date-only value as a timestamp.** `joined_on`, `work_date`, `leave_date`,
   `business_date` are `DATE`. Timezone drift on these silently corrupts payroll and attendance.
6. **Never mutate a leave balance directly.** Append a ledger entry; balance is derived.
7. **Never edit an Accepted ADR.** Supersede with a new one.
8. **Never break module boundaries.** Use the public module interface or a domain event.
9. **Never import Drizzle outside `infrastructure/repositories/`.**
10. **Never log PII or secrets.** Never log a raw entity. Use the redaction layer.
11. **Never hardcode policy** — rates, thresholds, approval chains, statuses, leave rules,
    statutory values. All are configuration or effective-dated data.
12. **Never call an external service from the request path.** Publish an event; a worker handles it.
13. **Never write a destructive migration** without an explicit `-- IRREVERSIBLE:` marker and a
    fresh verified backup.
14. **Never commit without an explicit user request.** Never `push --force`, `reset --hard`, or
    `--no-verify`.
15. **Never mark an agent finding resolved without fixing it.** Waivers go in
    `docs/governance/decisions.md` with a reason and a review date.

## Forbidden Actions

- **Adding a dependency on another application** — no integration endpoint, service token,
  webhook subscriber, cross-system DB read, or imported schema. Patterns yes; couplings need an ADR.
- Writing to `.env*`, `secrets/**`, `*.pem`, `*.key`
- Editing `docs/adr/*.md` with status Accepted, or `ai/context/*.md` without architecture review
- Adding a route without a corresponding `authz-matrix.yaml` entry
- Adding a personal-data column without a `docs/privacy/data-inventory.md` classification
- Disabling a lint rule, test, or hook to make a build pass
- Adding a dependency without recording why (supply chain is OWASP A03:2025)
- Creating a new top-level workflow state without an ADR
- Implementing Employee Handbook §1.3.4.5 (the "one partner must leave on marriage" clause) in
  any form — flagged for legal review, see `docs/requirements/README.md`

## Change classes — match ceremony to risk

The gate derives the class from **changed file paths**, not from your assertion.

| Class | Scope | Ceremony |
|---|---|---|
| **A** | Copy, styling, non-authz UI, docs, tests-only, dependency patches | Commit hooks + fast gate (~90s) |
| **B** | A feature slice inside an existing module, no schema change | Slice card + review + verify (~5 min) |
| **C** | Schema, authorization, effective-dating, workflow engine, audit, leave/attendance/work arithmetic — **anything touching money or time** | Full gate (~10–12 min) |

## Context files — read before…

| File | Read before… |
|---|---|
| `ai/context/architecture-principles.md` | Any backend code; any cross-module change |
| `ai/context/temporal-data-rules.md` | **Any effective-dated table or as-of query** |
| `ai/context/rbac-rules.md` | Any endpoint or UI gate touching permissions |
| `ai/context/security-guidelines.md` | Auth, uploads, state changes, PII |
| `ai/context/testing-guidelines.md` | Generating or reviewing tests |
| `ai/context/workflow-rules.md` | Any approval-flow or FSM change |
| `ai/context/domain-glossary.md` | Any naming task or user-facing text |
| `ai/context/engineering-guidelines.md` | Any code generation or review |
| `ai/context/india-statutory-notes.md` | Anything touching leave, attendance or payroll rules |
| `docs/standards/agent-output-contract.md` | Any agent producing structured output |
| `docs/standards/severity-vocabulary.md` | Emitting findings of any kind |
| `docs/requirements/` | **Any leave, attendance or work-logging behaviour** |
| `ai/REGISTRY.md` | Adding, removing or revalidating an agent or skill |
| `docs/governance/decisions.md` | Recording a non-architectural decision (DEC-NNN) |

> **Several files in this table do not exist yet** — Phase 1 is unfinished.
> `.claude/state/SESSION_HANDOFF.md` lists exactly which. **If a file listed here is missing,
> say so and stop. Never invent its contents.** A fabricated standard is worse than a missing
> one, because the next session will treat it as authoritative.

## Session protocol

**Start:** read this file, then `.claude/state/CURRENT_SLICE.md` and
`.claude/state/SESSION_HANDOFF.md`. Work **one slice** to completion.

**End:** update `SESSION_HANDOFF.md` with what was completed, what is in flight, and the
**exact next action**. Record any decision as an ADR or a DEC entry.

## When to STOP and ask

- The requirement is ambiguous and different readings give different data models
- A change would contradict an Accepted ADR
- A statutory or compliance question arises (**never infer legal requirements**)
- A migration would be destructive or irreversible
- A finding is CRITICAL and the fix is not obvious
- The temporal model or the authorization model would need to change
- Work would exceed the current slice's scope

## Authority order

Accepted ADRs → this file → `ai/context/` → `docs/standards/` → SQL migrations →
`packages/contracts` → `docs/governance/decisions.md` → generated docs → guides/runbooks.
**When documents disagree, higher wins.**

## The plan

The full architecture blueprint (51 sections, every decision and its reasoning) lives at
`C:\Users\panasa137user\.claude\plans\you-are-acting-as-lazy-moon.md`, with the Panasa HR policy
baseline in its Appendix A. Read it when you need the *why* behind a rule.
