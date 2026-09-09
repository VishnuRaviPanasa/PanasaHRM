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

**Hand-written SQL migrations in `infrastructure/db/migrations/*.sql` are the source of truth.** The Drizzle TypeScript schema is a *mirror* used for typed queries, verified against the database by **schema-mirror drift detection** in the gate and in CI.

### "Drift detection" names two different mechanisms - amended 2026-09-08

The term was used for two unrelated checks, only one of which exists. They are now named
separately, because `docs/backlog.md` marked the wrong one done:

| Name | What it compares | Status |
|---|---|---|
| **Migration-file drift** | The checksum of a migration file against the checksum recorded when it was applied | **Implemented** in `scripts/migrate.mjs` (DEC-012/014). Verified: editing an applied migration causes `status` to report `DRIFT` and `up` to refuse |
| **Schema-mirror drift** | The live database schema against the Drizzle TypeScript mirror | **Not implemented.** The Drizzle mirror itself does not exist yet (task T7b) |

**Schema-mirror drift detection is not yet specified precisely enough to build**, and this ADR does
not pretend otherwise. `scripts/README.md` refers to "drift checks D1-D9"; **D1-D9 are enumerated
nowhere in the repository**. Before the mirror is built, the check must state how it treats the
constructs Drizzle cannot express - and which are most of this schema: `EXCLUDE USING gist`
constraints, `GENERATED ALWAYS AS ... STORED` columns, range types, partitioned tables and their
routing function, and every trigger in migrations 0001 and 0004. A mirror check that silently
ignores those would report green on a schema it cannot actually represent, which is worse than no
check.

Drizzle imports are permitted **only** inside `**/infrastructure/repositories/**`. Application code sees repositories, never Drizzle types. Raw SQL via `db.execute(sql\`...\`)` is permitted for recursive CTEs and JSONB paths, and is reviewed as a cross-module concern.

## Consequences

### Positive

- Full access to the Postgres features the model actually requires
- Migrations are plain, greppable, diffable SQL - readable by a human and by an agent without an ORM abstraction in the way
- Typed queries still catch a renamed column at compile time

### Negative / trade-offs

- **Two representations of the schema that can drift.** To be mitigated by schema-mirror drift detection and by a commit guard requiring the mirror to be staged alongside a migration. **Neither exists yet** (amended 2026-09-08): `guard-commit.mjs` has no such check, and `ai/agents/migration-author.md` repeated the claim to the agent as though it did. Until both are built the risk is unmitigated, and it is load-bearing
- A contributor expecting `drizzle-kit generate` to author migrations from TypeScript will be confused. Documented in the migrations README
- The escape hatch to raw SQL is also a bypass of the audit interceptor, which is part of why audit is enforced by trigger as well (ADR-0008)

## Reconsider when

If the team grows and the ergonomic cost of hand-written SQL outweighs the control. The SQL-as-truth decision means migrations survive any such swap.
