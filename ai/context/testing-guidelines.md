# Testing Guidelines

**Read before generating or reviewing tests.**

## The principle

> **Test behaviour and invariants, not lines.** Coverage is a diagnostic, never a goal.

A test asserting that a mock was called proves nothing about an HRM. A test asserting that the
database rejected an overlapping employment period proves something that matters.

## The layers, and what each is actually for

| Layer | Tool | Earns its keep on |
|---|---|---|
| Unit | Vitest | Pure domain logic with many edge cases: accrual arithmetic, pro-rating, overtime, FSM legality, date-range overlap |
| **Integration (real Postgres)** | Vitest + Testcontainers | **Non-negotiable.** `EXCLUDE` constraints, partial indexes, partition routing, triggers and isolation behaviour **cannot** be tested against a mock or SQLite |
| **Concurrency** | Vitest + N parallel clients | The bug class that costs the most and is found the latest |
| Contract / API | supertest + OpenAPI assertions | Happy path, validation, **authorization allow AND deny**, pagination, idempotency, ETag conflict |
| **Authorization matrix** | Generated from `authz-matrix.yaml` | The highest-value suite in the repo. CI fails if any route has no entry |
| Property-based | `fast-check` | Temporal invariants over random event sequences |
| Component | Testing Library + `jest-axe` | Interactive UI, including a11y |
| E2E | Playwright + `@axe-core/playwright` | ~15-25 journeys per persona, not hundreds |
| Migration | Vitest + Testcontainers | Applies to a **populated** database and preserves data |

## Mandatory tests by what you touched

| If the change touches | You must add |
|---|---|
| A DB constraint | An integration test that **attempts the violation** and asserts the specific SQLSTATE |
| An effective-dated table | Property test: no overlapping periods; as-of consistency; plus the empty-range and future-dated cases |
| A balance, counter or state transition | **Concurrency test** — N parallel clients against one row |
| A route | Contract test including **deny** cases |
| Authorization | Matrix cells across **both** scope graphs, including the cross-graph negatives |
| A date/time calculation | Table-driven: month ends, leave-year boundary, the IST offset, midnight-crossing shifts |

## Naming

`it("<subject> <behaviour> when <condition>")`

```ts
it("rejects a second primary employment period when the ranges overlap")
it("returns 404 when an unrelated employee requests a profile")
it("does not overdraw the balance when two requests are submitted concurrently")
```

Acceptance criteria on a slice card **are** test names. `/close-slice` runs exactly those names
and refuses to close if any is missing or failing — which is what stops written state drifting
from reality.

## Forbidden patterns

- **No `sleep` for synchronisation.** Poll a condition or await the real signal
- **No order-dependent tests.** Each sets up and tears down its own state
- **No mocking the thing under test**
- **No skipped or `.only` tests on `main`**
- **No assertion-free tests** that merely check "it did not throw"
- **No SQLite standing in for Postgres.** It does not have `EXCLUDE`, `daterange` or partitioning,
  so a green suite would prove nothing about the constraints that carry the model

## Coverage floors — by risk, not globally

| Area | Statements / branches |
|---|---|
| `packages/authz` | 95 / 90 |
| `leave` (ledger, accrual, carry-forward) | 95 / 90 |
| `work`, `attendance` derivation | 90 / 85 |
| `workflow` engine | 90 / 85 |
| Domain services generally | 85 / 80 |
| Presentational UI components | 50 / 40 |

A single global number encourages meaningless tests in low-risk code while leaving the dangerous
paths under-tested.

## Test data

Factories, never literals. Deterministic seeds. A shared realistic dataset (~500 employees, two
years of leave and attendance) exercises performance and reporting paths that a three-row fixture
never will.

Seed the **real 2026 holiday calendar** from `docs/requirements/holiday-calendar-2026.md` — it
contains consecutive holidays, an ad-hoc mid-year addition, co-dated festivals, months with zero
holidays and a per-employee election mechanism. A synthetic calendar would omit exactly the edge
cases that break things.

## What NOT to test

Framework behaviour · third-party libraries · getters and setters · generated code · that a mock
was called.
