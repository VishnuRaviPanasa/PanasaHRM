# ADR-0005: Authorization - Central Service, Two Scope Graphs, Tested Matrix

## Status

Proposed

> Only a human may set this to Accepted. Once Accepted this file is immutable and
> `.claude/hooks/guard-adr.mjs` will refuse edits - supersede it with a new ADR instead.

## Date

2026-09-08

## Context

Broken Access Control is A01 in OWASP Top 10:2025 and the highest-impact failure mode for HR software. This system additionally has two independent notions of "who may see this": line management, and project membership. In an IT services organization these are routinely different people.

## Options considered

| Option | Summary | Why not chosen |
|---|---|---|
| Inline role checks | if (user.role === ...) at each call site | Unauditable and untestable. Cannot answer "who can do X" without reading every file, and a missed check is invisible |
| Route guards only | Coarse role gate per endpoint | Answers "may they call this" but not "about whom" or "which fields" - which is where HR leaks actually happen |
| External policy engine (OPA / Cedar) | Policies in a dedicated language | A second policy language on a solo project guarantees drift between it and the TypeScript, and drift in authorization is invisible until it is a breach |
| **Central service + declarative policy + generated matrix tests (chosen)** | One service, three concerns, machine-checked coverage | - |

## Decision

All authorization goes through a single `AuthorizationService` in `packages/authz`. **No inline role checks anywhere else** (Must-Know Rule 1, lint-enforced).

Three separate concerns, deliberately not conflated:

| Concern | Method | Prevents |
|---|---|---|
| May they act at all? | `can` / `assertCan` | Privilege escalation |
| Which rows? | `scope` returns a SQL predicate composed into the query | IDOR and over-broad lists |
| Which fields? | `fieldMask` applied centrally at serialization | Salary leaking through a legitimate list response |

Two orthogonal scope graphs: the **reporting hierarchy** governs HR resources; **project membership** governs work resources. Neither widens into the other.

Coverage is mechanical: a global guard denies any route without `@Authorize` metadata, a boot assertion refuses to start if any route lacks it, and `authz-matrix.yaml` generates a test per (role x action x resource) cell asserting **both** allow and deny.

## Consequences

### Positive

- One place to audit, one place to change, one place to test
- `scope` returning a predicate means a list query is physically incapable of returning out-of-scope rows - as opposed to filtering in JavaScript, which still leaks via counts, pagination totals and timing
- The field registry is default-deny: a new column is invisible until consciously classified, which is the safe failure direction

### Negative / trade-offs

- Every resource type needs a scope resolver; adding one is real work
- Two graphs means roughly double the matrix cells and negative fixtures
- A central mask means one bug is a broad bug - offset by it being one heavily-tested place rather than dozens of DTOs

## Reconsider when

Never for the central-service decision. The policy-definition mechanism could be revisited if the rules outgrow declarative TypeScript.
