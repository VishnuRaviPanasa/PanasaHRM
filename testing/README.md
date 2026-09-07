# testing/

Cross-cutting fixtures, factories, contract tests and load profiles. Per-module unit tests live
beside their code; what is shared lives here.

**Principle: test behaviour and invariants, not lines.** Coverage is a diagnostic, never a goal.
A test asserting that a mock was called proves nothing about an HRM.

The suites that earn their keep:

| Suite | Why |
|---|---|
| **Integration against real Postgres 18** (Testcontainers) | `EXCLUDE` constraints, partial indexes, partition routing and isolation behaviour **cannot** be tested against a mock or SQLite |
| **Concurrency** | The leave-spend path under parallel requests. The bug class that costs most and is found latest |
| **Authorization matrix** (generated) | Every `(role x action x resource)` cell, allow **and deny**, across **both** scope graphs. The single highest-value suite in the repo |
| **Property-based temporal** | For random event sequences: no overlapping periods, and as-of queries stay consistent |
| **Migration** | Every migration applies to a *populated* DB and preserves data |

One fixture exists from day one and is the canary for the whole temporal design:
**"show the org chart as of a past date, including people who have since left, with their
then-current manager and department."** If a global `WHERE status = 'active'` ever creeps into a
shared repository method, this test fails - and that is the single most natural piece of wrong
code to write in this system.
