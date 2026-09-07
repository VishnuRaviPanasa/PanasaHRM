# Engineering Guidelines

**Read before any code generation or review.**

## The feature workflow - ten steps, in this order

The order is not stylistic. Database before API means constraints catch what code forgets;
contract before implementation means the type checker propagates a change to both apps;
**authorization before UI** means a screen is never built against an endpoint that has not yet
decided who may call it - the single most common way permission holes are introduced.

```
 1 REQUIREMENT   Read docs/requirements/. Ambiguous -> STOP and ask.
                 Write acceptance criteria as testable statements BEFORE any code.
 2 DOMAIN MODEL  Identify the aggregate, its invariants, the transaction boundary.
                 New concept -> glossary entry.
 3 DATABASE      Write the .sql migration. Constraints express the invariants: a rule
                 enforceable in the DB is NOT left to application code.
                 Mirror in Drizzle. Integration test FIRST.
 4 CONTRACT      Zod schemas in packages/contracts. Request, response, error types.
 5 API           interfaces -> application -> domain -> infrastructure.
                 Drizzle only in infrastructure/repositories.
                 Every state change emits an outbox event.
 6 AUTHORIZATION Matrix rows first. assertCan / scope / fieldMask.
                 NEVER an inline role check. Generated tests must pass allow AND deny.
 7 UI            RSC for reads, client components for interaction.
                 Loading / empty / error / denied. Keyboard path. axe clean.
 8 TESTS         Unit, integration, contract, component, E2E for the primary journey.
                 Concurrency test if it touches a balance, counter or workflow.
 9 OBSERVABILITY Structured business events. Spans on the use case. Alert only if
                 action is required.
10 DOCS + REVIEW Update glossary, module README, progress. Run /review.
                 Fix every CRITICAL and HIGH before push.
```

## TypeScript

Strict, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`.

- **`any` is forbidden.** Use `unknown` and narrow
- **No non-null assertion (`!`)** except immediately after an explicit check the compiler cannot see
- Parse external input with Zod at the boundary; inside the boundary, trust the types
- Prefer discriminated unions over optional-field soup
- `readonly` on anything not intentionally mutable

## Errors

Typed hierarchy, one global filter, RFC 9457 responses.

- **No empty catch blocks.** Handle, convert, or re-throw
- **Fail closed**: if authorization, a scope resolver or the field registry throws, **deny**
- Never leak driver detail, stack traces or internal identifiers to a client
- Every outbound call has a timeout - an SMTP hang must not exhaust the request pool

## Money, dates and numbers

| Kind | Type | Never |
|---|---|---|
| Money | Integer minor units + explicit currency | Float |
| Leave balance | `NUMERIC(8,2)` | Float |
| Effort | `INTEGER` minutes | Decimal hours |
| Date-only | `DATE`, suffix `_on` | Timestamp |
| Instant | `timestamptz`, suffix `_at` | Naive local time |

The `_on` / `_at` suffix convention is load-bearing: it makes a Must-Know Rule 5 violation
visible at a glance in a diff.

Business timezone is `Asia/Kolkata`, applied explicitly at every boundary. **Never rely on a
session default.**

## Queries

- No query inside a loop. Batch, or join
- Every list endpoint paginates. Cursor by default; offset only on admin screens with a hard cap
- Every list query composes the `scope()` predicate **into the SQL**
- Prefer a partial index over a filtered scan
- `EXPLAIN` the ten hottest paths; CI asserts the plan shape

## Comments

Explain **why**, never what. The code says what.

Worth a comment: a non-obvious constraint interaction, a deliberate deviation, a workaround with
its reason, and any invariant a reader could accidentally break.

Not worth a comment: restating the line above it.

Every hook script and every migration carries a header stating **what it prevents and how to
remove it safely** - that is the institutional memory which stops a future tired developer
deleting it.

## Definition of done

A feature is done when: acceptance criteria met · matrix rows added with allow **and** deny
tests · field masking correct including list, export and search · input validated · errors typed
· invariants in **database constraints** where expressible · concurrency considered · tests at
every relevant layer · migration reversible or explicitly marked · **every state change emits an
event and an audit record** · a11y clean · all four UI states · within performance targets ·
structured logs with redaction · docs updated · `/review` passed with zero CRITICAL and no
unwaived HIGH · no new TODO without a tracked issue · personal-data columns classified.

**"The UI works" is roughly a third of this list.**
