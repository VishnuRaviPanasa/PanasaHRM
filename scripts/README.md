# scripts/

Developer and verification utilities. Node (`.mjs`) or Python 3.13 - both are installed.

Planned:

| Script | Purpose |
|---|---|
| `status.mjs` | **Generates** `implementation-status.md` from git, migrations, routes and test results. Status is derived, never written by hand |
| `check-drift.mjs` | Schema-mirror drift checks, run in the gate and in CI. **Not written.** The "D1-D9" enumeration this table used to cite exists nowhere in the repo; ADR-0003 now records what such a check must cover before it can be built |
| `session-brief.mjs` | Live state for the session-start skill |
| `migration-status.mjs` | Applied vs pending migrations |
| `check-schema-drift.ts` | Applies migrations to a scratch DB, dumps the schema, diffs it against the committed snapshot and the Drizzle mirror |
| `verify-findings.mjs` | Asserts every agent finding cites a real `file:line` in the diff and a real rule anchor. **A fabricated finding fails mechanically** |

**Principle:** prefer a constraint over a rule, a rule over a review, and a review over a hope.
Anything a script can check deterministically must not be delegated to an agent's judgement.
