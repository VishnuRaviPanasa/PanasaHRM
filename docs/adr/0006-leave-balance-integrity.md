# ADR-0006: Leave Balance Integrity - Ledger Plus a Constrained Account Row

## Status

Proposed

> Only a human may set this to Accepted. Once Accepted this file is immutable and
> `.claude/hooks/guard-adr.mjs` will refuse edits - supersede it with a new ADR instead.

> **Acceptance precondition (human decision, 2026-09-08).** This ADR must NOT be accepted until
> the database anti-overdraw mechanism described below is **implemented and concurrency-tested**.
> The mechanism is the entire content of this decision; accepting it while it exists only on
> paper would ratify a guarantee nothing provides. The required evidence is a test that runs N
> concurrent spend transactions against a single account and proves no interleaving overdraws -
> including the two cases identified in review as the ones the original text did not cover: a
> first-ever request (no account row yet) and the first request of a new leave year.

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

### What the trigger does, precisely

Stating this exactly matters, because a lock alone does not raise `23514`. A CHECK on
`leave_account` is evaluated only when `leave_account` is written; an INSERT into `leave_ledger`
on its own evaluates nothing. The trigger therefore performs **three** steps in one transaction:

1. **Materialise then lock.** `INSERT ... ON CONFLICT DO NOTHING` the account row for
   `(employee, leave_type, leave_year)`, then `SELECT ... FOR UPDATE` it. The insert comes first
   because `SELECT ... FOR UPDATE` on a row that does not exist locks nothing - which would leave
   the serialisation point absent exactly at a first-ever request and at every new leave year.
2. **Update the projection from the ledger**, in the same statement path as the ledger insert.
   This write is what causes the CHECK to be evaluated.
3. **Let the constraint decide.** If the resulting `available` falls below `-allowed_negative`,
   the CHECK raises and the whole transaction - ledger row included - rolls back.

Overdrawing is therefore a `23514` constraint violation - loud, in the database, on every code
path, forever. No caller can opt out, because no caller performs step 2.

### Authoritative vs derived - and the permitted exception to Must-Know Rule 6

**`leave_ledger` is authoritative. `leave_account` is derived.** The account row is a constrained
projection of the ledger and never an independent source of truth: if the two disagree, the ledger
is right by definition and the account row is repaired from it. Nothing may read the account row
as an answer without that being reconcilable to a ledger fold.

Must-Know Rule 6 says *never mutate a leave balance directly; append a ledger entry; the balance
is derived*. This ADR's mechanism performs an `UPDATE` on `leave_account`, so the relationship
must be stated rather than left implicit:

> **Permitted exception to Must-Know Rule 6.** The `leave_account` projection is written **only**
> by the `leave_ledger` trigger described above, inside the same transaction as the ledger row
> that caused it, and only ever to the value derived from that ledger. Direct `UPDATE` on
> `leave_account` by application code, by a repository, or by any other trigger is forbidden, and
> `hrm_app` is to hold no UPDATE grant on the table. **That role does not exist yet** - no
> application role has been created, so today this half of the exception is a design commitment
> rather than a control, and the trigger is the only thing enforcing it.
>
> **This is not a relaxation of Rule 6 - it is the mechanism by which Rule 6 is enforced.** The
> rule prohibits a balance that can be set independently of the ledger. The exception permits
> exactly one writer, whose only possible input is the ledger. A change that lets anything else
> write `leave_account` is not covered by this exception and contradicts this ADR.

The nightly reconciliation job named under *Negative / trade-offs* exists to detect violation of
this exception, not merely to detect drift.

### The resolved policy version is recorded on the ledger row

`leave_policy` is effective-dated (ADR-0002/0019) and `leave_ledger` is append-only, so a ledger
entry written today under today's policy must remain re-derivable after that policy is superseded.
Every ledger row therefore carries **`leave_policy_id`** - the specific policy *version* that was
resolved when the entry was written, not the leave type and not a lookup performed at read time.

This closes the one seam that separated this ADR from the other arithmetic decisions: ADR-0011
snapshots its derivation inputs on `attendance_day`, and ADR-0012 records the rule version on every
payroll line. Without it, "why is my balance 12 and not 15" becomes unanswerable the moment policy
changes, and the accrual engine cannot distinguish a genuine correction from a policy shift.

The same applies to the accrual and carry-forward jobs: each writes the policy version it acted
under, so a re-run under a newer policy produces a *new compensating entry* rather than silently
re-deciding history.

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
