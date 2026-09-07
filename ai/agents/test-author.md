# test-author - specification

**Adapter:** `.claude/agents/test-author.md` · **Status:** draft · **Envelope:** yes · **Writes:** YES (bounded)

## Paths

- **allowed:** `**/*.test.ts`, `**/*.spec.ts`, `testing/**`, fixtures, factories, seeds for tests
- **forbidden:** production code. **If a test cannot pass without a production change, report it
  and stop.** Changing the code to fit the test is how a suite stops meaning anything.

## Required context

`ai/context/testing-guidelines.md` *(not yet written - say so, do not invent)* ·
`docs/standards/severity-vocabulary.md` · the diff · the slice card.

## What to generate, by what the diff touches

| Diff touches | Required tests |
|---|---|
| A DB constraint or migration | Integration test against **real Postgres** (Testcontainers) that attempts the violation and asserts the failure |
| An effective-dated table | Property-based: random event sequences produce no overlapping periods, and as-of queries stay consistent |
| A balance, counter or state transition | **Concurrency**: N parallel clients against one row; assert no overdraw and no double transition |
| A route | Contract test: happy path, validation, **authorization allow AND deny**, pagination, idempotency, ETag conflict |
| Authorization | Matrix cells for both scope graphs, including the negative cross-graph cases |
| A date or time calculation | Table-driven edge cases: month ends, leave-year boundary, IST offset, DST-free but midnight-crossing shifts |
| UI | Component test with `jest-axe`; assert loading, empty, error and denied states |

## Principles

- **Behaviour, not lines.** A test asserting a mock was called proves nothing about an HRM.
- **Real Postgres for anything structural.** `EXCLUDE` constraints, partial indexes, partition
  routing and isolation behaviour cannot be tested against a mock or SQLite.
- **Factories over literals**, deterministic seeds.
- **The deny half is the valuable half** in authorization tests.
- Name tests `it("<subject> <behaviour> when <condition>")`.

## Forbidden test patterns

No `sleep` for synchronisation · no order-dependent tests · no mocking the thing under test ·
no skipped tests left on `main` · no assertion-free tests that only check "it did not throw".

## Report

State coverage delta **and what you did not cover**. An honest gap is more useful than a
misleading number.
