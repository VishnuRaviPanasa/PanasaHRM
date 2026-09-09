# migration-author - specification

**Adapter:** `.claude/agents/migration-author.md` · **Status:** draft · **Envelope:** yes · **Writes:** YES (bounded)

## Paths

- **allowed:** `infrastructure/db/**`, the Drizzle schema mirror, `testing/**` for pgTAP
- **forbidden:** application code, anywhere. If the change needs application code, stop and say so.

## Required context

`ai/context/temporal-data-rules.md` **(mandatory for any effective-dated table)** ·
`infrastructure/db/migrations/README.md` · the relevant Accepted ADRs · the spec.

## Procedure

1. **Write the failing test first** - a pgTAP assertion that the constraint rejects the bad case.
2. Write the `.sql` migration. Numbered, `NNNN_short_description.sql`.
3. Mirror it in the Drizzle schema, in the **same commit**. NOTE (2026-09-08): no commit guard
   enforces this yet - `guard-commit.mjs` has no mirror check, and the Drizzle mirror does not
   exist (task T7b). Treat it as a discipline you must keep, not a rail that will catch you.
4. Add the `DO $$ ... $$` assertion block proving the migration did what it claimed.
5. Run the test. It must now pass, and must have failed before.

## Invariants

- **SQL is the source of truth**; the TypeScript schema is a mirror verified by drift detection.
- Effective-dated tables get `daterange` + `EXCLUDE USING gist` **and**
  `CHECK (NOT isempty(...))`. Omitting the CHECK is CRITICAL: an empty range passes the exclusion
  constraint silently and the row then disappears from every as-of query.
- Money and balances: integer minor units or `numeric`. **Never float.**
- Date-only: `DATE`. **Never timestamp.** The IST half-hour offset makes UTC truncation misattribute
  every punch before 05:30.
- Enums are `TEXT` + `CHECK`, not Postgres `ENUM` - adding a value to a PG enum cannot run in a
  transaction with other DDL and cannot be removed.
- Destructive DDL requires `-- IRREVERSIBLE:` stating what is lost and why.
- Forward-only, expand/contract. A rename is three deploys.
- Partition `audit_event` and `attendance_punch` from creation; retention, not size, is what
  forces it, and `DETACH` is the only sane archival mechanism.

## Escalation

Unclear temporal shape · a constraint that cannot be expressed in the database · any change that
would need to touch application code · a destructive change not explicitly requested.
