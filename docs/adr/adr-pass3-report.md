# Pass 3 — ADR-0008 completion, ADR-0006 concurrency evidence, privilege separation, delta review

**Date:** 2026-09-08
**No ADR status was changed. All 19 remain `Proposed`** (0012 reads `Proposed - BLOCKED`).

## Verdict: NOT clean. Do not start the acceptance ceremony.

Three areas were to be closed. All three produced their deliverable, and all three produced new
HIGH findings — several in code written this session, and one that corrects a claim in my own
pass-2 report.

---

## 1. ADR-0008 — finished

`0006_outbox_retention.sql` builds the three items the ADR specified and the schema lacked:
dead-letter state (`dead_lettered_at`, `dead_letter_reason`, coherence CHECK), a pending index
that excludes dead-lettered rows, immutability extended to `aggregate_type`, `actor_user_id`,
`correlation_id`, `causation_id`, and a retention-aware delete guard replacing the blanket
no-DELETE trigger. 8 checks (O1–O8). **OR-11(a) is delivered.**

### But two findings against it

**P3-1 (HIGH, verified by me).** **Back-dating defeats retention.** The guard authorises a DELETE
on `processed_at` / `dead_lettered_at` — columns the immutability trigger deliberately leaves
writable as drain bookkeeping. So:

```sql
INSERT INTO outbox_event (...);                        -- pending, undelivered
UPDATE outbox_event SET processed_at = '1970-01-01';   -- permitted: bookkeeping
DELETE FROM outbox_event WHERE ...;                    -- succeeds
```

Confirmed: *"undelivered event deleted: true"*, with the default 90-day window and no GUC touched.
The guard's authorisation key is writable by the principal it guards against. The repo already
holds the fix pattern — 0005's `tg_*_no_backdate`.

**P3-2 (MEDIUM).** Migration 0006's own comment claims *"a sweep must not be able to widen"* the
retention window. `SET LOCAL hrm.outbox_retention='-1 year'` does exactly that (session-scoped;
persisting it needs superuser). The comment is misstated.

Also: the retention sweep's own query has **no supporting index**, on the table whose unbounded
growth motivated the migration.

---

## 2. ADR-0006 — concurrency evidence produced, and the concurrency claim holds

`testing/db/concurrency/leave-overdraw.test.mjs`: 20 real connections, a wall-clock starting gun,
16 checks. Instrumented by the reviewer: **peak 21 in-transaction sessions, 15 simultaneously
blocked on a lock** — genuine contention, not an artefact.

| Scenario | Result |
|---|---|
| 2 days available, 20 × 2-day holds | exactly **1** succeeded; balance 0.00; 19 refusals all `23514` |
| First-ever request, no account row | **0** succeeded; no phantom account left behind |
| First request of a new leave year | **0** succeeded; the 2026 balance untouched |
| Control: 40 days, 20 × 2-day holds | all **20** succeeded; balance exactly 0.00 |

**Mutation proof.** Replacing the trigger with ADR-0006's mechanism *exactly as originally
written* — `SELECT ... FOR UPDATE` and nothing else — let **all 20 workers succeed, consuming 40
days from a 2-day balance, with the account still reading `available = 2.00`.** The ADR as drafted
would have shipped a leave system with unlimited silent overdraw. The acceptance precondition was
worth insisting on.

The reviewer could not overdraw by racing at any isolation level, with any entry-type mix.

### But four non-concurrent holes, two verified by me

**P3-3 (HIGH, verified).** **The Rule 6 "mechanical enforcement" claim is false.**
`fn_leave_account_writer_guard()` trusts a GUC any session can set:

```sql
SELECT set_config('hrm.leave_account_writer','on',true);
UPDATE leave_account SET accrued = accrued + 1000;   -- succeeds; available = 1001.00
```

Migration 0007 says this makes one-writer *"a property of the schema rather than a convention"*.
It does not. Tests V5, V6 and E1 all pass because none of them ever raises the flag.

**P3-4 (HIGH, verified).** **`ON CONFLICT DO NOTHING` keeps the side effect and discards the
ledger row.** The projection is a `BEFORE INSERT` trigger, and BEFORE triggers fire before conflict
resolution:

```
before: accrued=1.00  rows=1
after : accrued=501.00 rows=1     <-- 500 days created, no ledger row
```

This breaks ADR-0006's central sentence — *"No caller can opt out, because no caller performs step
2"* — through the **sanctioned surface**, an INSERT on `leave_ledger`. The fix is an `AFTER INSERT`
trigger, which contradicts the ADR's explicit "BEFORE INSERT" and therefore needs an ADR change,
not just a migration.

**P3-5 (HIGH, reviewer-demonstrated).** `leave_account` accepts a **direct INSERT** — the writer
guard is `BEFORE UPDATE` only. A fabricated account with an inflated `allowed_negative` persists.

**P3-6 (HIGH, reviewer-demonstrated).** `allowed_negative` **escalates across leave types**:
nothing checks that the cited `leave_policy_id` belongs to the entry's `leave_type`. A CL account
was driven to −30.00 while CL policy says `allow_negative_balance = false`.

**Also:** negative `days` reverses consumed components (`encash -10` credits 10); the drift query
is an INNER JOIN and is blind to accounts with no ledger rows — precisely what P3-3/4/5 create;
`leave_year` is unconstrained (accepts 0, −32768); REPEATABLE READ collapses to one writer per
round with `40001` unmentioned anywhere.

---

## 3. Privilege separation — the claim holds, the grant set is wrong in both directions

`0008_app_role_privilege_separation.sql` creates `hrm_app` (NOLOGIN, owns nothing). Verified under
`SET ROLE hrm_app`: `DISABLE`/`DROP TRIGGER`, `DROP CONSTRAINT`, `ALTER ... OWNER` refused by
**ownership**; `TRUNCATE`/`DELETE` on policy, `UPDATE leave_account`, `DELETE audit_event` refused
by **grant**; `session_replication_role` refused by GUC context; `setval` correctly withheld. Zero
`SECURITY DEFINER` functions. 7 checks (G1–G7).

**The modest claim is true and survived attack.** But:

**P3-7 (HIGH).** **`hrm_app` cannot write a leave ledger entry at all.** The trigger is not
`SECURITY DEFINER`, so its write to `leave_account` runs as the invoker, which holds only SELECT.
Every `INSERT INTO leave_ledger` fails with *permission denied for table leave_account*. Migration
0008 justifies withholding that grant with a factual error — *"the writer-guard flag is what
authorises it, not a grant to the caller"* — which is not how PostgreSQL privilege checks work.
**Check G6, whose own comment says "or the separation is useless theatre", passes because it calls
`has_table_privilege()` and never executes the INSERT.** G5 and a working leave flow are currently
mutually exclusive.

**P3-8 (HIGH).** **`pg_temp` search-path poisoning of the policy resolvers.** Six functions do not
pin `search_path` — the three `fn_*_asof` resolvers, `fn_ensure_month_partition`,
`fn_set_updated_at`, `fn_validate_unconfirmed_fields`. A temp table named `attendance_policy` makes
`fn_attendance_policy_asof()` return grace 999 / full-day 1, real table untouched, nothing audited.
This is the exact attack migration 0005 documents and pins its own functions against; 0008 made the
older ones reachable by `hrm_app`.

**P3-9 (MEDIUM).** `ALTER DEFAULT PRIVILEGES ... GRANT SELECT ON TABLES` means a future
`compensation` table **auto-grants SELECT to `hrm_app`** — a standing violation of
`rbac-rules.md`'s "no grant at all on compensation", and it makes ADR-0016's "this exception does
not widen that grant" false on acceptance.

**P3-10 (MEDIUM).** `GRANT CONNECT ON DATABASE hrm` is a hardcoded literal: migration 0008 fails
outright on any database not named `hrm`.

**P3-11 (MEDIUM).** Audit partitions end 2026-12-31 and `hrm_app` cannot extend them — under
Must-Know Rule 2 that is a total write outage on a known date.

---

## 4. Diff audit — three real issues, all fixed

- **The commit guard blocked committing its own test suite.** The secret fixtures were verbatim
  matching strings, so the scanner fired on the test file — verified DENIED. Fixed by assembling
  the fixtures at runtime; the scanner was not weakened and no path was allow-listed.
- **`TRUNCATE` in `DESTRUCTIVE_SQL` matched `BEFORE TRUNCATE ON ...`** — so *creating a truncate
  guard* was classified as destructive DDL, training authors to add meaningless markers. Now
  matched only as a command.
- **Prose explaining the `-- IRREVERSIBLE:` convention satisfied the marker check.** Migration 0005
  did exactly that. The marker is now anchored to the start of a line; only 0006 has a real one.

Sweeps otherwise clean: one status line changed (0012's BLOCKED banner), no files outside expected
trees, no real secrets, no TODOs. The whole change set now passes the commit gate.

---

## 5. Delta review — and a correction to my own pass-2 report

**P3-12 (CRITICAL, verified).** **`CREATE OR REPLACE FUNCTION` neuters any rail and is not
flagged.** Every enforcement mechanism here is a function body. `DROP FUNCTION` is flagged;
`CREATE OR REPLACE` is not — and it is *strictly easier*, because a DROP fails while triggers
depend on the function while a REPLACE swaps the body with every trigger in place. It is also the
house idiom (0005, 0006 both use it). Pass 2's H-5 fix closed the weaker route and left the
stronger one open.

**P3-13 (HIGH, verified).** **`git commit -a` still bypasses the secret *content* scan, and my
pass-2 report was wrong to call C-3 closed.** The C-3 fix unioned the worktree into the *file
lists* but the content scan still reads `git diff --cached` only. Reproduced standalone: a tracked
file modified with an `sk-ant-…` key, nothing staged, `git commit -am` → **ALLOW**. Worse, **T49
passes for the wrong reason** — instrumented, its deny comes from leftover ADR test state hitting
the backstop, not from the secret rail. `adr-repair-verification.md` cites T49 as proof of exactly
the thing it does not prove.

**P3-14 (HIGH, verified).** `TRUNCATE` inside `DO $$ ... $$` or `EXECUTE` is invisible to the new
anchor — and `DO $$` is this repo's own idiom. `UPDATE` with no `WHERE` is not flagged at all, and
the 80-character `DELETE FROM` lookahead crosses statement boundaries.

**P3-15 (MEDIUM).** **T58 and T60 flip under neither mutation** — they pass against un-fixed code.
Two of the five tests added this round are not discriminating.

**P3-16 (MEDIUM).** **The ADR-0008 text now contradicts the schema.** Its amendment still says
there is *"no way to prune the outbox at all"* and *"Not yet done — OR-11(a)"* while migration 0006
implements exactly the deletion path that paragraph proposes. ADRs outrank migrations, so accepting
that text ratifies the opposite of what was built. **OR-10 and OR-11(a) should now be closed, and
are not.** An eighth assert-and-retract also survives inside ADR-0008 ("cannot diverge" vs "the
audit trigger does not yet exist"), plus three uncorrected present-tense control claims in
ADR-0005, ADR-0007 and ADR-0011.

**P3-17 (MEDIUM).** A **sixth unnamed Rule narrowing**: ADR-0007's amendment substitutes "the
stricter reading governs" for CLAUDE.md's "higher wins", rewriting the authority order itself, with
no DEC entry. Introduced by my pass-1 amendment.

**P3-18 (MEDIUM).** ADR-0009 names one column three ways (`oid`/`tid`, `entra_object_id`,
`subject`/`tenant_id`), so the new `UNIQUE (tenant_id, subject)` is not implementable as written —
on the account-linking decision. And `work.effort_cost:read` uses a colon where `rbac-rules.md`
uses dots everywhere else.

**P3-19 (MEDIUM).** DEC-030 claims protective triggers *are* ENABLE ALWAYS. 24 of 28 are; the three
`tg_*_unconfirmed` triggers are not, and the ENABLE-ALWAYS check is a hard-coded list of three
function names, so every new rail must be added by hand.

---

## Test results (clean database, rebuilt from zero)

```
node testing/hooks/guards.test.mjs                     61 passed, 0 failed
node scripts/migrate.mjs verify                        81 PASS, exit 0
node testing/db/concurrency/leave-overdraw.test.mjs    16 passed, 20 workers
node scripts/migrate.mjs status                        0001..0008 applied, no DRIFT
from-zero: 8 migrations apply to an empty DB; 81/81; pg_dump schema byte-identical
3 consecutive verify runs: every row and partition count unchanged
```

**The suites being green is not evidence of correctness here.** Every finding above sits outside
what they cover — that is the point of the adversarial pass, and it is the third round running in
which green suites coexisted with real holes.

---

## Housekeeping

A reviewer accidentally committed one row to `hrm.leave_ledger`. Append-only, so it could not be
deleted; the dev database was **rebuilt from zero** and is now clean (ledger=0, accounts=0,
audit=0, outbox=0). A stale `hrm_verify` scratch database was dropped. All reviewer scratch
databases dropped. No repository file was modified by any reviewer.

---

## Recommendation

**Do not begin the acceptance ceremony.** Not because the architecture is wrong — the concurrency
proof, the privilege-separation result and the outbox completion are all genuine — but because
three findings would make an *Accepted, immutable* ADR state something false:

- ADR-0006 claims a mechanical Rule 6 guarantee that a one-line `set_config` defeats (P3-3), and a
  "no caller can opt out" guarantee that `ON CONFLICT` defeats (P3-4).
- ADR-0008's text asserts its own migration was never built (P3-16).
- ADR-0016 asserts a compensation grant boundary that migration 0008 already widened (P3-9).

Suggested order if you want these closed: P3-12 and P3-13 first (they are the commit gate and one
of them corrects my own report), then P3-4 and P3-3 (they need an ADR-0006 text change, not only a
migration), then P3-7 (the leave flow does not work under privilege separation), then the text and
governance items.

**Wave 1 of your ceremony — 0018 → 0001 → 0013 → 0014 — is the least affected.** None of the
findings above touches those four. If you want to start narrow while the rest is repaired, that
wave is defensible today; **0002 + 0019 should wait**, because P3-8 (`pg_temp` poisoning of the
resolvers) lands squarely on ADR-0019's "the resolver is the mitigation" claim.
