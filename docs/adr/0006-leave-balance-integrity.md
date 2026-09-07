# ADR-0006: Leave Balance Integrity - Ledger Plus a Constrained Account Row

## Status

Proposed

> Only a human may set this to Accepted. Once Accepted this file is immutable and
> `.claude/hooks/guard-adr.mjs` will refuse edits - supersede it with a new ADR instead.

## Date

2026-09-08

## Context

An employee with 2 days of leave opens two browser tabs and submits two 2-day requests. Both transactions read the balance, both pass the check, both write. Four days are consumed from a two-day balance, with no error raised anywhere.

## Options considered

| Option | Summary | Why not chosen |
|---|---|---|
| Mutable counter with SELECT FOR UPDATE | Lock the balance row before spending | Correct only where the lock is actually taken. Any new code path that sums without locking sees a stale value and the guarantee evaporates silently - discovered at year-end, not at write time |
| Append-only ledger alone, balance as SUM | Balance derived, no counter | **Does not prevent double-spend.** Classic write skew: both transactions sum, both see 2, both insert -2. The inserts do not conflict, and neither READ COMMITTED nor REPEATABLE READ sees the other. A CHECK cannot save it, because CHECK is per-row and cannot reference an aggregate |
| Advisory locks | pg_advisory_xact_lock on a hashed key | The lock space is shared across all subsystems, and the lock is invisible in the schema - undiscoverable by anyone reading the DDL, and bypassed by any new code path with the same silent-failure signature |
| SERIALIZABLE isolation | Let SSI detect the conflict | Every caller needs retry handling; predicate locks escalate under pressure producing false aborts that worsen as the table grows; and it taxes the 95% of traffic that is reads |
| **Ledger + lockable account row carrying the constraint (chosen)** | Each piece does what the other cannot | - |

## Decision

Both, at READ COMMITTED. Each exists for exactly one reason the other cannot serve.

**`leave_ledger`** is append-only and authoritative - it gives natural reversal, provenance and reconstruction, and append-only is enforceable by trigger and grant.

**`leave_account`** exists specifically to host a constraint an aggregate cannot host:

```sql
available NUMERIC(8,2) GENERATED ALWAYS AS
    (accrued + carried_in + adjusted - taken - pending - encashed - lapsed) STORED,
CONSTRAINT ck_leave_account_no_overdraw CHECK (available >= -allowed_negative)
```

**And the lock cannot be forgotten, because the database takes it:** a `BEFORE INSERT` trigger on `leave_ledger` performs `SELECT ... FOR UPDATE` on the account row regardless of what the caller did.

Overdrawing is therefore a `23514` constraint violation - loud, in the database, on every code path, forever.

## Consequences

### Positive

- The invariant survives contact with future code, including code written by an agent or by a tired developer at midnight
- Reversal is a compensating entry preserving both valid time and transaction time, so a retroactive cancellation is auditable rather than destructive
- FIFO lot tracking via `consumes_ledger_id` makes carry-forward expiry correct - expiring lots are consumed before fresh accrual, which is what prevents the classic "my leave lapsed even though I took it" complaint

### Negative / trade-offs

- A cached projection that can drift from the ledger. Mitigated by revoking direct UPDATE, routing changes through a function that writes the ledger first, and a nightly reconciliation that pages on any mismatch. **This projection is the part of the design most likely to rot** - the reconciliation job is not optional infrastructure
- Every balance mutation serialises on one row per employee per leave type per year. Contention is negligible at this scale

## Reconsider when

Never. Note explicitly: **if the leave_account row is ever removed in favour of a pure ledger fold, SERIALIZABLE becomes mandatory**, because write skew is then the only remaining exposure and only SSI catches it.
