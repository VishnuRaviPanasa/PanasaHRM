# ADR Repair — Verification Report

**Date:** 2026-09-08
**Scope:** the reviewer-approved fixes for C-1/C-2, C-3/C-4, H-1..H-5, the §9 residue, and the
assert-and-retract text pattern.
**No ADR status was changed. All 19 remain `Proposed`** (0012 reads `Proposed - BLOCKED`).

---

## 1. Changed files

**New (8):**

| File | Purpose |
|---|---|
| `.claude/hooks/lib/adr-status.mjs` | The single ADR status parser, shared by both guards |
| `infrastructure/db/migrations/0005_rule3_perimeter.sql` | H-1..H-4 |
| `testing/db/0005_rule3_perimeter.verify.sql` | 11 checks, P1–P11 |
| `infrastructure/db/migrations/0004_effective_dated_immutability.sql` | (from the previous round, still untracked) |
| `testing/db/0004_effective_dated_immutability.verify.sql` | 13 checks, R1–R13 |
| `docs/adr/adr-review-report.md`, `adr-review-report-pass2.md`, `adr-repair-verification.md` | Reports |

**Modified (34):** both hook scripts, `settings.json`, `scripts/migrate.mjs`,
`testing/hooks/guards.test.mjs`, three verify scripts, all 19 ADRs, `docs/adr/README.md`,
`docs/governance/decisions.md`, `ai/context/domain-glossary.md`, `.claude/state/OPEN_RISKS.md`,
`.claude/state/SESSION_HANDOFF.md`, `scripts/README.md`, and both `migration-author` agent specs.

Nothing was committed.

---

## 2. Completed findings, with the evidence item 9 requires

For each: the claimed invariant, the mechanism, the negative test, and proof that removing the
mechanism makes that test fail. Every mutation below was executed, not reasoned.

### C-1 — the status parser had no end-of-input anchor

- **Invariant:** an Accepted ADR is immutable regardless of where `## Status` sits in the file.
- **Mechanism:** `lib/adr-status.mjs` uses `$(?![\s\S])`. `\Z` matches a *literal Z* in JavaScript,
  so the old regex failed to match when `## Status` was last, returned an empty block, and read
  Accepted as not-Accepted.
- **Negative tests:** T33 (Status is the last section), T35 (a capital Z earlier in the block).
- **Mutation proof:** reverting the anchor and the blockquote skip → **T33, T34, T35, T36 fail**
  (52/56).

### C-2 — the template heuristic misread acceptance prose

- **Invariant:** `Accepted 2026-09-08 (was Proposed 2026-09-01)` is Accepted.
- **Mechanism:** the status value is now the **first non-blockquote, non-comment line**; prose and
  acceptance preconditions live on `> ` lines and are ignored. An unparseable status returns
  `UNKNOWN` and **fails closed**.
- **Negative tests:** T34 (the prose form), T36 (garbage status must deny), T37/T38 (Proposed with a
  blockquote precondition, and BLOCKED, both stay editable).
- **Mutation proof:** as above.

### C-3 — `git commit -a` bypassed every commit check

- **Invariant:** a commit is scanned whether its content comes from the index or the working tree.
- **Mechanism:** `guard-commit.mjs` detects `-a`/`--all`/an empty index and unions the worktree
  change set. Deletions are collected separately (`--diff-filter=D`).
- **Negative tests:** T48 (`commit -am` rewriting an Accepted ADR), T49 (`commit -am` carrying a
  secret — this was the secret-scanning rail too).
- **Mutation proof:** restoring the `staged.length === 0` early exit → **T48, T49 fail**.

### C-4 — the backstop compared the working tree, not the staged content

- **Invariant:** the guard inspects the bytes that will actually be committed.
- **Mechanism:** `contentToCommit()` reads the staged blob via `git show :<path>`, falling back to
  the worktree only for a `-a` commit.
- **Negative test:** T50 — stage a rewrite, restore the worktree, commit.
- **Mutation proof:** restoring `readFileSync` → **T50 fails**.

### H-1 — the back-dating guard was evaluated in UTC

- **Invariant:** a period may be closed only on or after **today in the company's timezone**.
- **Mechanism:** `fn_business_date()` resolves `org_setting['company.timezone']` (default
  `Asia/Kolkata`), so the timezone stays configuration rather than a literal (Rule 11). It replaces
  the single `CURRENT_DATE` in the trigger.
- **Negative test:** P3 — closing at `fn_business_date() - 1` must be refused. Positive control P2 —
  closing *at* the business date must be accepted. P3 runs first, deliberately: P2 closes the only
  open period, so P3 would otherwise update zero rows and pass vacuously.
- **Mutation proof:** dropping the Rule 3 triggers → **P3 fails** (34/56).
- **Measured gap when found:** db `CURRENT_DATE` = 2026-09-07 while Kochi was 2026-09-08.

### H-2 — history was still rewritable by INSERT

- **Invariant:** inserting a period that starts in the past is refused unless explicitly opted into.
- **Mechanism:** `fn_block_backdated_period()` on all three tables; the escape hatch is
  `SET LOCAL hrm.allow_backdated_period = 'on'` (DEC-029), which keeps seeding and genuine backfill
  possible while making them deliberate and greppable.
- **Negative test:** P4 — a back-dated insert is refused **and** 2021 still resolves grace=15.
  Positive controls: P5 (opted-in backfill succeeds), P6 (future-dated changes unimpeded — the
  normal case under ADR-0019).
- **Mutation proof:** dropping `tg_attendance_policy_no_backdate` → **P4 fails** (49/56).
- **Correction of record:** migration 0004's header claimed retroactive correction "has NO legal
  path … by design". That was false. 0005's header says so explicitly; 0004 is not edited, because
  migrations are forward-only (DEC-011).

### H-3 — `TRUNCATE` fired nothing

- **Invariant:** an effective-dated or append-only table cannot be emptied.
- **Mechanism:** `BEFORE TRUNCATE … FOR EACH STATEMENT` triggers on the three policy tables **and**
  on `audit_event` and `outbox_event`, which had the same hole.
- **Negative tests:** P7 (three policy tables), P8 (audit and outbox).
- **Mutation proof:** dropping the TRUNCATE triggers → **P7 fails** (52/56).

### H-4 — `session_replication_role='replica'` disabled every rail

- **Invariant:** no session GUC can switch off Rule 3 or the append-only rails.
- **Mechanism:** `ENABLE ALWAYS TRIGGER` on all eleven protective triggers, including the three
  from migration 0001.
- **Negative tests:** P9 (the trigger still fires under `replica`), P10 (catalogue assertion on the
  audit/outbox rails), and R3 now asserts `tgenabled = 'A'`.
- **Mutation proof:** downgrading one trigger from ALWAYS to ENABLE → **R3 and P9 fail** (45/56).
  This is the sharpest evidence in the report: the *old* R3 passed against a fully **disabled**
  trigger.

### H-5 — a migration could remove the rail and pass the migration guard

- **Invariant:** removing an enforcement rail is destructive DDL and needs an `-- IRREVERSIBLE:`
  marker.
- **Mechanism:** `DESTRUCTIVE_SQL` extended with `DROP TRIGGER|FUNCTION|PROCEDURE|DATABASE|VIEW`,
  `ALTER TABLE … DISABLE TRIGGER`, and `DETACH PARTITION`. SQL comments are stripped before the
  patterns are tested, so a trailing `-- … where …` can no longer disarm the `DELETE FROM` check;
  the marker is still looked for in the **raw** text, because the marker *is* a comment.
- **Negative tests:** T53 (drop trigger), T54 (disable trigger), T56 (comment disarm). Positive
  control T55 — the same drop **with** a marker is allowed.
- **Mutation proof:** narrowing the pattern and removing comment-stripping → **T53, T54, T56 fail**.

### Also completed

- **The supersede transition now works.** The guard previously denied the Accepted → `Superseded by
  ADR-NNNN` change its own error message instructed you to make. T39/T40 cover it via Edit and
  Write; T41 confirms a non-supersede edit is still refused; T52 covers the commit path.
- **Deleting an Accepted ADR is blocked** (T51) — it destroys the record as surely as a rewrite.
- **Shell paths the first fix missed:** T42 (`cd docs/adr && sed -i`), T43 (`1>`), T44 (`>|`),
  T45 (variable-indirected path), T46 (`rm -rf docs/adr`). T47 confirms reads are still allowed.
- **`search_path` pinned** on all four Rule 3 functions, closing the operator-shadowing route a
  reviewer demonstrated. Asserted by P11.
- **§9 residue closed** — ADR-0006 (policy version on the ledger row), ADR-0009 (`UNIQUE
  (tenant_id, subject)`, CHECK bound to `password_hash` rather than a flag, break-glass exception
  named), ADR-0016 (integer minor units, the divisor as effective-dated policy, `comp_viewer`
  restated as the action `work.effort_cost:read` with a glossary entry), ADR-0008 (per-aggregate
  ordering, dead-letter design, `outbox_events` → `outbox_event`).
- **Assert-and-retract removed** at source in ADR-0007, 0008, 0010, 0011, 0016, 0017, 0019 —
  including three instances my own pass-1 amendments introduced.
- **A fifth Rule narrowing recorded** (DEC-027): `unconfirmed_fields` may be updated on any row,
  including a closed one. Correct on the merits, but it was missing from DEC-025.

---

## 3. Remaining findings — deliberately not closed

Per the instruction not to close a risk until the amendment is actually present and verified:

| Ref | What remains | Why it is still open |
|---|---|---|
| **OR-10** | ADR-0008's retention / dead-letter **migration** | The ADR now specifies it; the schema does not implement it. `DELETE` is blocked and `outbox_event` is unpartitioned, so the outbox still cannot be pruned at all |
| **OR-11(a)** | Same item, from the migration side | — |
| **OR-11(b)** | `company.timezone` and `leave_type` derivation flags still mutable; resolvers still return NULL outside the policy epoch instead of raising | Not attempted this round |
| **OR-12** | `docs/privacy/data-inventory.md` absent; `audit_column_policy` holds 0 rows | Blocks Phase 7; needs a human |
| **OR-13** | `docs/standards/api-conventions.md` absent | Needed before T9 |
| **OR-14** | No backup script, restore runbook or drill | ADR-0013's principal accepted risk |
| **OR-09** | ADR-0012 BLOCKED on Q10 | Human decision |
| **ADR-0006** | Acceptance precondition unmet — the anti-overdraw mechanism is specified but not built or concurrency-tested | The ADR itself says do not accept until it is |
| — | The table **owner** can still `DROP`/`DISABLE TRIGGER` | No trigger can prevent this. `ENABLE ALWAYS` removes the session-GUC route and the commit guard now flags the DDL, but real mitigation is grant separation and the application role does not exist |

---

## 4. Tests added / changed

| Suite | Before | After | New cases |
|---|---|---|---|
| `testing/hooks/guards.test.mjs` | 32 | **56** | T33–T56 |
| `testing/db/*.verify.sql` | 45 | **56** | P1–P11; R2/R3/R7/R9 rewritten |

**Rewritten because they passed for the wrong reason:**

- **R2/R7** changed `grace_period_minutes`, which independently violates
  `ck_attendance_policy_grace_usable` — so they would have failed with no trigger at all and never
  tested an otherwise-legal edit. They now change `ot_min_minutes`, and R2 carries a positive
  control proving that value is schema-legal first.
- **R9** ran after R5, so its target row started today and `valid_to = today − 30` was an inverted
  range rejected by the empty-range CHECK. It now runs while the 2020 period is open, where only
  the trigger can reject it.
- **R3** checked trigger *existence* and passed against a disabled trigger. It now keys on
  `valid_from` + `valid_to` (so a differently-named range column cannot hide) and asserts
  `tgenabled = 'A'`.

Two fixtures in the pre-existing suites were also corrected: C3 and L7 tested overlap using
back-dated ranges, which the new H-2 guard refuses; they now use future ranges that still overlap
the open-ended seeded period, testing the same constraint without needing the opt-in.

---

## 5. Complete test results

```
node testing/hooks/guards.test.mjs        56 passed, 0 failed
node scripts/migrate.mjs verify           56 PASS + 1 INFO, exit 0
node scripts/migrate.mjs status           0001..0005 applied, no DRIFT
```

**Mutation matrix — each mutation applied in isolation to a scratch database or hooks copy:**

| Mutation | Result |
|---|---|
| Revert status parser (C-1 + C-2 + fail-open) | 52/56 — T33, T34, T35, T36 fail |
| Restore `git commit -a` early exit (C-3) | T48, T49 fail |
| Restore worktree read in backstop (C-4) | T50 fails |
| Narrow `DESTRUCTIVE_SQL`, drop comment-strip (H-5) | T53, T54, T56 fail |
| `DROP` the three Rule 3 triggers | 34/56 — R1, P3 fail first |
| `DISABLE` one Rule 3 trigger | 34/56 — R1, P3 fail |
| Downgrade `ALWAYS` → `ENABLE` | 45/56 — **R3, P9 fail** |
| `DROP` the TRUNCATE guards | 52/56 — P7 fails |
| `DROP` the back-date guard | 49/56 — P4 fails |

No mutation left the suite green.

---

## 6. Migration-from-zero

```
DROP DATABASE hrm_final; CREATE DATABASE hrm_final;
PGDATABASE=hrm_final node scripts/migrate.mjs up
  applying 0001_baseline.sql ... ok (209ms)
  applying 0002_configuration.sql ... ok (117ms)
  applying 0003_leave_policy_configuration.sql ... ok (150ms)
  applying 0004_effective_dated_immutability.sql ... ok (59ms)
  applying 0005_rule3_perimeter.sql ... ok (78ms)

PGDATABASE=hrm_final HRM_VERIFY_ALLOW_NONDEV=i-understand ... verify
  56 PASS, exit 0
```

**Schema equivalence:** `pg_dump --schema-only --no-owner --no-privileges` of the from-zero database
versus the working database → **IDENTICAL**, byte for byte.

The `hrm` database was itself dropped and rebuilt from zero during this work, so the whole chain is
proven against an empty database rather than an incrementally-patched one. All scratch databases
(`hrm_mut`, `hrm_final`) were dropped.

---

## 7. `db:verify` before / after — still non-destructive

```
BEFORE 3 verify runs: audit=0 outbox=0 att=1 emp=1 lv_policy=6 lv_type=6 org_set=6 parts=25 open_periods=1
AFTER  3 verify runs: audit=0 outbox=0 att=1 emp=1 lv_policy=6 lv_type=6 org_set=6 parts=25 open_periods=1
```

Identical across every table, the partition count, and the count of open policy periods — which is
the value the old restore blocks used to corrupt. The target guard still refuses a non-dev
database: `PGDATABASE=hrm_final node scripts/migrate.mjs verify` → **exit 2**.

---

## 8. Newly discovered issues

Found while doing this work, not previously reported:

1. **The `-- IRREVERSIBLE:` marker check was broken by my own first fix.** Stripping SQL comments
   before testing the patterns also stripped the marker, so every destructive migration would have
   been denied even with a valid marker. Caught by T6 within a minute. Patterns now test stripped
   SQL; the marker is looked for in the raw text.
2. **`fn_block_historical_mutation` blocked every legitimate update in its first version.**
   PostgreSQL computes `GENERATED` columns *after* before-row triggers, so `NEW.valid_period` is
   always NULL inside the trigger and every update looked changed. Only caught because a badge-only
   update was tested; the close-a-period path masked it by allow-listing `valid_period`.
3. **The back-date guard broke two pre-existing overlap tests** (C3, L7), which used back-dated
   ranges to test the `EXCLUDE` constraint. A real consequence worth noting: any future test or
   fixture that seeds history now needs the DEC-029 opt-in.
4. **P3 initially passed vacuously.** It ran after P2 had closed the only open period, so its
   UPDATE matched zero rows, fired no trigger, and reported success. Reordered. **This is the same
   class of defect as the R2/R7/R9 weaknesses being repaired** — a negative test that never reaches
   the mechanism it claims to test. Worth watching for in every future suite.
5. **The verify suites are order-dependent within a file and coupled to the runner.** Run bare with
   `psql -f`, they mutate the real database; the rollback lives in `migrate.mjs`, not in the SQL.
   Not fixed here — noted as a hazard.

---

## 9. Status

**No ADR was accepted, superseded, or otherwise changed in status.** All 19 read `Proposed`;
ADR-0012 reads `Proposed - **BLOCKED, do not accept**`. Nothing was committed. The acceptance gate
remains closed pending independent review of this report.
