# ADR-0003: Data Access - Drizzle as a Mirror, SQL as the Source of Truth

## Status

Proposed

> Only a human may set this to Accepted. Once Accepted this file is immutable and
> `.claude/hooks/guard-adr.mjs` will refuse edits - supersede it with a new ADR instead.

## Date

2026-09-08

## Context

The data model depends on PostgreSQL features an ORM-owned schema handles poorly: EXCLUDE constraints with btree_gist, generated daterange columns, partial unique indexes, declarative partitioning and triggers. The org has two precedents - Prisma (Hiremate) and Drizzle (Thredd portal).

## Options considered

| Option | Summary | Why not chosen |
|---|---|---|
| Prisma owning the schema | Schema-first, generated migrations | Its schema language cannot express EXCLUDE constraints, partial indexes or partitioning. Fighting the ORM on the foundational model is worse than learning a second one |
| TypeORM | Entity decorators own the schema | Same expressiveness problem, plus weaker typing |
| Raw pg with no query layer | Hand-written SQL everywhere | Loses compile-time checking of column names and result shapes, which is the fastest feedback loop available to an agentic workflow |
| **Drizzle as a typed mirror over hand-written SQL (chosen)** | SQL DDL is authoritative; TypeScript mirrors it; drift detection keeps them honest | - |

## Decision

**Hand-written SQL migrations in `infrastructure/db/migrations/*.sql` are the source of truth.** The Drizzle TypeScript schema is a *mirror* used for typed queries, verified against the database by drift detection in the gate and in CI.

Drizzle imports are permitted **only** inside `**/infrastructure/repositories/**`. Application code sees repositories, never Drizzle types. Raw SQL via `db.execute(sql\`...\`)` is permitted for recursive CTEs and JSONB paths, and is reviewed as a cross-module concern.

## Consequences

### Positive

- Full access to the Postgres features the model actually requires
- Migrations are plain, greppable, diffable SQL - readable by a human and by an agent without an ORM abstraction in the way
- Typed queries still catch a renamed column at compile time

### Negative / trade-offs

- **Two representations of the schema that can drift.** Mitigated by drift detection, and by the commit guard requiring the mirror to be staged alongside a migration - but the risk is real and the detection is load-bearing
- A contributor expecting `drizzle-kit generate` to author migrations from TypeScript will be confused. Documented in the migrations README
- The escape hatch to raw SQL is also a bypass of the audit interceptor, which is part of why audit is enforced by trigger as well (ADR-0008)

## Reconsider when

If the team grows and the ergonomic cost of hand-written SQL outweighs the control. The SQL-as-truth decision means migrations survive any such swap.
