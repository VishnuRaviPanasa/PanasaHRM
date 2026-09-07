# ai/evaluations/ - agent eval fixtures

## Why this exists

`confidence_score` is **not** a gate input. A model that misreads a diff will misreport its
certainty about the misreading with equal serenity. The only empirical evidence that the review
gate still works is a seeded-bug eval.

## The seeded-bug set (Task 2)

Ten known defects, one injected into a scratch branch per run:

1. A missing authorization guard on a new endpoint
2. Audit emission outside the transaction
3. An off-by-one in leave-day counting
4. A `daterange` overlap hole (missing `CHECK (NOT isempty(...))`)
5. A PII field leaked into a list-response DTO
6. A float used for a leave balance
7. A date-only value stored as a timestamp
8. A cross-graph authz leak (project manager reaching an HR record)
9. A migration that drops a column with no `-- IRREVERSIBLE:` marker
10. An N+1 query inside a repository loop

Record catch/miss in `results.jsonl`.

> **Stated honestly:** with no API key there is no automated eval harness. This is a manual
> ~20-minute exercise, once a month. It is also the only real measurement of whether the
> reviewer still says no. **Put it on the calendar or it will not happen.**
