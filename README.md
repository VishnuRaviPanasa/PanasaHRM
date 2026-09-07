# PanasaHRM

HR management platform for **Panasa Technology Pvt. Ltd.** — employee records with full history,
org structure, leave, daily work management, attendance, documents, approvals and audit.

> **Status: scaffolding.** The repository skeleton and Claude Code harness exist. There is no
> application code yet. See `.claude/state/SESSION_HANDOFF.md` for exactly where things stand.

## What this is

A standalone, production-intended HRM — not a prototype. It is deliberately **independent of
every other system**: no integration endpoints, no shared databases, no webhooks. Employee
records originate here.

The design priorities, in the order they resolve conflicts:

1. **Correctness of history.** Employment, org assignment and policy are effective-dated, so any
   record can be reconstructed as of any past date. This is the one thing that cannot be
   retrofitted.
2. **Correctness of balances.** Leave is an append-only ledger with a database constraint that
   makes overdrawing a `23514` error rather than a logic bug.
3. **Authorization that can be proven.** One central service, a machine-checkable
   `(role × action × resource)` matrix, and CI that fails when a route has no matrix entry.

## Stack

| Layer | Choice |
|---|---|
| Frontend | Next.js 16 (App Router), Tailwind, Radix, TanStack Query, react-hook-form + Zod |
| Backend | NestJS 11 on Node 24, TypeScript strict |
| Database | PostgreSQL 18 — **hand-written SQL migrations are the source of truth**, Drizzle is a typed mirror |
| Jobs | BullMQ on Redis 7 |
| Storage | MinIO (S3-compatible) |
| Deploy | Docker Compose on a single VM, nginx in front |
| Observability | OpenTelemetry → Prometheus / Loki / Tempo / Grafana |
| Testing | Vitest + Testcontainers (real Postgres), Playwright, axe |

Package manager is **npm** (workspaces). `pnpm` and `bun` are not installed on the target machine.

## Prerequisites

- Node **24+** (`.nvmrc` pins the major)
- npm **11+**
- Docker **28+** with Compose
- Git

## Getting started

```bash
git clone https://github.com/VishnuRaviPanasa/PanasaHRM.git
cd PanasaHRM
npm install          # only prettier today
```

There is nothing to run yet. The dev stack (Postgres 18, Redis, MinIO) arrives in Phase 2 —
after which `docker compose -f infrastructure/compose/docker-compose.dev.yml up` is the entry
point, and `docs/guides/development.md` becomes authoritative.

That guide has one hard acceptance test: **a fresh clone reaches a running app by following it
alone.**

## Repository layout

```
CLAUDE.md            Operating contract — read this first
.claude/             Claude Code harness: permissions, state
  state/             Where the project actually is (CURRENT_SLICE, SESSION_HANDOFF, OPEN_RISKS)
ai/                  Agent specs, context standards, eval fixtures
  REGISTRY.md        Source of truth for every agent and skill
docs/
  adr/               Architecture Decision Records — immutable once Accepted
  requirements/      Business rules, each traceable to a source
  governance/        DEC log — waivers, deferrals, accepted risks
  standards/         Machine-consumable contracts for agents and CI
apps/                api (NestJS), web (Next.js)          [Phase 2]
packages/            contracts, authz, ui, design-tokens  [Phase 2]
infrastructure/      migrations (schema source of truth), compose, docker, nginx
observability/       Dashboards, alerts, SLOs
scripts/             Generation and verification utilities
testing/             Shared fixtures, factories, contract and load tests
```

## Working on this project

The architecture blueprint — every decision and its reasoning, 51 sections plus the Panasa HR
policy baseline — lives outside the repo at
`C:\Users\panasa137user\.claude\plans\you-are-acting-as-lazy-moon.md`.

`CLAUDE.md` is the condensed operating contract: 15 Must-Know Rules, Forbidden Actions, the
change-class model, and a routing table saying which context file to read before which kind of
work. Read it before starting anything.

**Two conventions worth knowing up front:**

- **Ceremony scales with risk.** Class A (copy, styling, docs) gets a 90-second gate. Class C
  (schema, authorization, effective-dating, anything touching money or time) gets the full one.
  The gate derives the class from changed paths, not from your assertion.
- **Documentation that can be generated is generated.** Hand-written docs cover decisions and
  intent only.

## Known open items

Tracked in `.claude/state/OPEN_RISKS.md`. The ones that block real work:

- **Handbook contradictions** — the leave policy says *"a **minimum** of 6 sick leaves and 6
  casual leaves will only be allowed... every 6 months"*, which read literally is incoherent and
  almost certainly means a maximum. And no grace period or half-day threshold is defined
  anywhere, so attendance cannot be derived. Both are one-line answers from HR.
- **Holiday calendar** is 2025; 2026 and 2027 are needed.
- **No named legal contact** for DPDP sign-off.

## Licence

UNLICENSED — proprietary to Panasa Technology Pvt. Ltd.
