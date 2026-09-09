# ADR Verification — Pass 2 (post-amendment adversarial review)

**Date:** 2026-09-08
**Scope reviewed:** the changes made in response to the human decisions of this session — the
immutability gate fix, the `db:verify` safety work, migration `0004_effective_dated_immutability.sql`,
and the §9 amendments across 18 ADRs.
**Method:** five independent specialists in parallel — temporal data, migration/database, ADR
consistency, red team, regression. Findings below marked **[verified]** were reproduced
independently by the synthesizing session against source or the live database.

**No ADR status was changed. All 19 remain `Proposed`** (0012 reads `Proposed - BLOCKED`).

---

## 1. Headline

**The regression baseline is genuinely solid, and the Rule 3 trigger's core logic held up.** The
temporal specialist threw twenty distinct in-place mutation forms at it — `MERGE` (both variants),
`INSERT ... ON CONFLICT DO UPDATE`, `UPDATE ... FROM`, `DELETE ... USING`, data-modifying CTEs,
correlated subqueries, identity-column changes, and every multi-column smuggle through the
`unconfirmed_fields` carve-out — and **every one was refused**. The generated-column exclusion opens
no blind spot. The new hook tests were mutation-tested and genuinely fail against the un-fixed code.

**But the acceptance gate should not open yet.** Three classes of problem were found, and two of
them are in code written *this session*:

1. **Two pre-existing CRITICAL defects in the ADR status parser and commit guard** that make the
   immutability rail fail *open* — one of which triggers on the exact text a human is likely to
   write while accepting an ADR.
2. **Four HIGH holes around the Rule 3 trigger** — not in its logic, but in its perimeter. Three of
   the four are places where the migration's own prose asserts a guarantee the schema does not
   deliver, which is worse than the gap itself.
3. **§9 amendment residue**: several required amendments were only partially delivered, and OR-10
   was closed as complete. It has been reopened.

---

## 2. CRITICAL — the immutability rail fails open

These matter most because they defeat the very mechanism this session set out to fix, and because
one of them activates precisely when ADRs are accepted.

### C-1 — `\Z` is not a JavaScript regex anchor **[verified]**

`guard-adr.mjs` parses the status block with:

```js
/^##\s+Status\s*$([\s\S]*?)(?=^##\s|\Z)/mi
```

In JavaScript `\Z` matches a **literal capital Z**, not end-of-input. The intended "or end of
string" alternative therefore does not exist. Consequences, both reproduced:

- If `## Status` is the **last** section of an ADR, the regex does not match at all →
  `statusBlock` is empty → `isAcceptedAdr()` returns `false` → **an Accepted ADR is freely
  editable**.
- A capital `Z` anywhere in the status block truncates it early.

**`guard-commit.mjs` §3b copied `statusOf()` verbatim**, so the two "independent layers" added this
session share the identical defect — they are one layer implemented twice. The correct anchor is
`$(?![\s\S])` or simply making the lookahead `(?=^##\s|$(?![\s\S]))`.

### C-2 — the status parser misfires on ordinary acceptance wording **[verified]**

`isTemplateLine` treats a status block containing **both** "proposed" and "accepted" as the unfilled
template, and therefore as not-Accepted. A human writing any of these while accepting an ADR
silently disables the rail on that file:

```
Accepted 2026-09-08 (was Proposed 2026-09-01)     -> parsed as: NOT accepted  [verified]
Accepted — supersedes the Proposed draft
```

This is **live and imminent**: 18 ADRs are about to move from Proposed to Accepted, and the natural
way to record that transition is the phrasing that breaks it. It also interacts badly with this
session's own amendments, which deliberately put acceptance prose *inside* the Status block of
ADR-0006 and ADR-0012 (tests T31/T32 cover the safe member of this family, not this one).

### C-3 — `git commit -a` bypasses every commit-guard check **[verified]**

`guard-commit.mjs:101`:

```js
if (staged.length === 0) process.exit(0);
```

`git commit -a` (and `git commit -m x <pathspec>`) stages nothing in the index, so `staged` is
empty and the hook exits before **all four** checks: secrets, forbidden paths, destructive
migrations, the authz matrix, and the new ADR backstop. Demonstrated by the red team: the same ADR
rewrite is DENIED via `git add -A && git commit` and ALLOWED via `git commit -a`.

This is pre-existing and much wider than ADRs — it is the secret-scanning rail too.

### C-4 — the new ADR backstop compares the wrong content **[verified]**

`guard-commit.mjs:176` reads the **working tree** (`readFileSync(p)`) while the file list comes from
`git diff --cached`. Stage a rewrite of an Accepted ADR, restore the worktree copy, and the guard
compares a clean file and allows the commit. It should read the staged blob (`git show :<path>`).

This is a defect in code written this session.

---

## 3. HIGH — the Rule 3 perimeter

The trigger's logic is sound. Its perimeter is not, and the migration header overstates what it
delivers.

### H-1 — the back-dating guard is evaluated in UTC, not business time **[verified]**

`0004_effective_dated_immutability.sql:120` compares against `CURRENT_DATE`. The container runs
`TimeZone=UTC`; the business is in Kochi (UTC+05:30). Measured live during this review:

```
db_tz=UTC  db_current_date=2026-09-07  kochi_date=2026-09-08
```

So for **5h30m of every day** the database's "today" is the previous business day, and
`UPDATE ... SET valid_to = CURRENT_DATE` retroactively closes a period at yesterday-IST — the exact
operation R9 exists to prove impossible. Yesterday's already-derived attendance then silently
re-resolves against different thresholds.

Three reviewers found this independently. It is the same bug class that ADR-0011 opens by rejecting,
reintroduced in the migration meant to enforce temporal correctness. `CURRENT_DATE` appears exactly
once across all four migrations, so the fix is contained — but it needs a decided business-date
function, not a literal replacement.

### H-2 — history is still rewritable, by INSERT **[verified by two reviewers]**

`UPDATE` and `DELETE` are closed; **`INSERT` is not guarded at all**. A back-dated insert changes
what a past date resolves to: demonstrated live, inserting a per-entity row moved 2021-06-15 from
grace 15 / full-day 465 to grace 0 / full-day 480, and CL entitlement from 12 days to 0. The
exclusion constraint does not fire (different scope tuple) and the resolver's `NULLS LAST` ordering
makes the new row win.

**The migration's own KNOWN GAP paragraph (`0004:36-42`) states that retroactive correction "has NO
legal path ... by design". That is factually wrong**, and it is the most consequential error in the
migration — it tells a future reader that a door is locked when it is open.

### H-3 — `TRUNCATE` fires nothing **[verified by two reviewers]**

All triggers are `FOR EACH ROW`; `TRUNCATE` is in no event mask. `TRUNCATE attendance_policy`
succeeded (rolled back), leaving zero rows; likewise `leave_policy`, `employment_policy` and
`audit_event`. This is **not** covered by the header's stated `DISABLE TRIGGER` caveat, because
`TRUNCATE` is separately grantable — the stated mitigation (application role ≠ owner) does not
address it. `fn_block_mutation()` already exists and is exactly the right function for a
`BEFORE TRUNCATE ... FOR EACH STATEMENT` trigger.

### H-4 — `session_replication_role = 'replica'` disables all of it **[verified by three reviewers]**

The triggers are created `tgenabled = 'O'`, not `ENABLE ALWAYS`. Setting the session GUC disables
the Rule 3 trigger *and* the audit/outbox append-only triggers; UPDATE and DELETE then both succeed.
It leaves no catalogue trace and takes no lock. Worse, `PGOPTIONS="-c session_replication_role=replica"`
is inherited by `migrate.mjs`, so `npm run db:migrate` — on the settings allow-list — can apply a
chain with every trigger off. `pg_restore --disable-triggers` does the same thing routinely.

The fix is one word per trigger: `ALTER TABLE ... ENABLE ALWAYS TRIGGER`.

### H-5 — a migration can remove the rail, and the migration guard calls it non-destructive **[verified]**

`DESTRUCTIVE_SQL` covers `DROP TABLE|COLUMN|SCHEMA|TYPE|INDEX|CONSTRAINT`, `TRUNCATE`,
`DELETE FROM` without `WHERE`, and `ALTER TABLE ... DROP`. It does **not** cover `DROP TRIGGER`,
`DROP FUNCTION`, or `ALTER TABLE ... DISABLE TRIGGER`. So the rail protecting Must-Know Rule 3 can
be removed by a migration that passes the guard without an `-- IRREVERSIBLE:` marker.

Related: the `DELETE FROM(?![\s\S]{0,80}WHERE)` lookahead is case-insensitive, so the word "where"
in a nearby comment disarms it.

### H-6 — `valid_to = 'infinity'` is an irreversible brick **[verified]**

There is no upper bound on closure. Closing a period at `infinity` is permitted, after which no
replacement can be inserted (exclusion constraint), the date cannot be moved (closed→closed is
blocked), and it cannot be reopened. A permitted operation reaches an unrecoverable state. It also
splits the two "current row" idioms: `valid_to IS NULL` returns 0 rows while
`valid_period @> CURRENT_DATE` returns 1.

Related (H-7): a mistakenly **future-dated** period cannot be cancelled by any route, so a wrong
policy takes effect for at least one day.

---

## 4. HIGH — §9 amendment residue, and a false claim I introduced

### R-1 — several §9 items were not delivered, and OR-10 was closed as complete

| ADR | §9 required | Delivered |
|---|---|---|
| **0009** | `UNIQUE (tid, oid)`; bind CHECK to the credential not the flag; resolve break-glass contradiction; name the Rule 12 exception | **1 of 4** — only the Rule 12 exception |
| **0008** | partitioning/retention; dead-letter; extend immutability to `actor_user_id`/`correlation_id`; state at-least-once + ordering; name the Rule 2 exception; fix `outbox_events`→`outbox_event` | **2 of 6** |
| **0016** | name the Rule 8 exception; specify the DB role; rate component/divisor/money type; define `comp_viewer` + glossary entry | **2 of 4** |
| **0006** | …plus "require the resolved policy version on the ledger row" | **missed** |

The 0009 and 0008 items are security and data-integrity requirements. **OR-10 has been reopened**
with this detail; closing it had removed the only tracking.

### R-2 — ADR-0013 asserts a mitigation that was not performed **[verified, now fixed]**

The amendment I wrote states the missing-backup risk is "**Now recorded.**" It was not —
`OPEN_RISKS.md` contained no backup, restore or drill entry. **Fixed during this pass: OR-14 added**,
which makes the ADR's statement true. Flagged prominently because a false claim *inside* an ADR is
worse than the gap it describes, and this one was mine.

### R-3 — four ADRs now assert and retract the same claim in one file

Each amendment correctly identifies a false statement and leaves the original standing in the
Decision/Consequences section, which is where an ADR is actually read:

- `0007:75` still says self-approval is blocked by a DB CHECK; `0007:63-68` says it is not
- `0011:88` still calls `pg_partman` "mandatory, not advisory"; `0011:48-52` disclaims it
- `0017:28` still says the purpose "is registered in the processing registry"; the amendment says the registry does not exist
- `0019:131` still says `org_setting` changes are audited; the amendment says no such mechanism exists

These are text deletions, under an hour's work, but they must happen before acceptance freezes both
halves of each contradiction.

### R-4 — ADR-0007's amendment raised a mutable file to immutable authority

The amendment makes `ai/context/workflow-rules.md` "binding at this ADR's level of authority". But
`guard-adr.mjs` protects `docs/adr/*.md` only, and `ai/context/*` sits in the settings `ask` list —
so on acceptance, ADR-authority invariants become editable with one confirmation prompt, or with no
prompt at all via a shell write. §9 asked to *promote into* the ADR; incorporation-by-reference is
not the same act, and the difference is exactly the guard. This is a defect I introduced.

### R-5 — a fifth, unnamed Must-Know Rule narrowing

DEC-025 names four exceptions. There is a fifth: `0004:109` permits an `unconfirmed_fields`-only
UPDATE on **any** row including a closed historical one — verified empirically. The carve-out is
correct on the merits (R10 depends on it), but it is a Rule 3 narrowing that is not recorded.

### R-6 — ADR-0010's amendment contradicts ADR-0010

`0010:28` says session state is "in PostgreSQL cached in Redis"; the amendment's table at `0010:41`
says "Redis, **authoritative**". Opposite statements in one file, and it leaves "where is the token
hash persisted" newly ambiguous. Also mine.

---

## 5. MEDIUM — the tests are weaker than they look

The suite is green, and green is real. But several R-checks pass for the wrong reason:

- **R2 and R7** attempt `grace = 20` and `grace = 99`, both of which independently violate
  `ck_attendance_policy_grace_usable`. They would fail even with no trigger — they never test an
  otherwise-legal edit.
- **R9** targets a row whose period starts `CURRENT_DATE`, so `valid_to = CURRENT_DATE - 30` is an
  inverted range rejected by the empty-range CHECK regardless. The strong form — back-dating the
  pristine 2020 row — is the test that should be there.
- **R3 reports PASS while the trigger is DISABLED** — it checks trigger *existence*, never
  `tgenabled`. It also missed four unprotected effective-dated shapes the temporal specialist
  planted, including a range column named `effective_period` and a partitioned parent. Those were
  named after `employment`, `compensation`, `reporting_relationship` and `work_policy` — the tables
  coming next.

Net: with R2/R7/R9 weakened and R5/R6/R10/R13 being positive tests, roughly five checks carry the
real evidentiary weight. The regression specialist's independent mutation test agrees: dropping the
triggers turns the suite red, but 4 of 13 still pass and 4 more abort for a non-trigger reason.

**Also MEDIUM:**
- `PGHOSTADDR` and `PGSERVICE` (with `hostaddr`) redirect the connection while the `db:verify`
  target guard still reads `127.0.0.1:55432/hrm` — both demonstrated. Guarding on host/port/db name
  is not sufficient; asking the server (`pg_control_system().system_identifier`, or a
  `hrm.environment` GUC set on the database) is. `db:migrate` has **no** target guard at all.
- A `COMMIT;` or `\c` inside a verify script escapes the `-c BEGIN / -c ROLLBACK` wrapper —
  demonstrated. No current script does this, so it is latent.
- `migrate.mjs` records a migration in a **separate psql process** from the one that applies it, and
  `0004` is not re-runnable (`CREATE TRIGGER`, not `CREATE OR REPLACE TRIGGER`). If the bookkeeping
  row is lost, `up` fails permanently with no repair path.
- The `-- NO-TRANSACTION` marker is parsed into a log string and otherwise ignored; per-migration
  atomicity comes only from each file's own `BEGIN/COMMIT`, unchecked.
- `0002 vs 0019`: the amendment claims they are "one rule". They are not — 0002's test is
  **per-table**, 0019's is **per-value**, and `leave_type` already splits them. The OR-11(b) author
  must pick, and neither ADR says which.
- ADR-0002's table list still omits `project_member`, which `temporal-data-rules.md` already
  declares effective-dated and which is ADR-0005's second scope graph.
- ADR-0017's new `24 months` and `k=5` are hardcoded thresholds (Must-Know Rule 11) with no home.

---

## 6. What is genuinely clean

Reported plainly, because an inflated report is a useless one:

- **From-zero migration: PASS.** The chain 0001→0004 applies to an empty database with zero errors,
  and the resulting schema is **byte-identical** to the incrementally-migrated one (`pg_dump`
  diffed). 45 PASS + 1 INFO, exit 0, on both.
- **No residue.** Repeated verify runs leave every table and partition count identical. Only
  sequence values advance (cosmetic).
- **The new hook tests are not vacuous** — mutation-tested: T20/T23/T25/T26 fail without the Bash
  branch, T28 fails without the commit backstop.
- **The 0004 verify suite is not tautological** — the red team could not construct a
  disabled/dropped/neutered-trigger database that it reports green on.
- **The trigger core is genuinely strong.** Twenty in-place mutation forms refused, including
  `MERGE` and upsert, which were tested rather than assumed. `<@` is the correct operator and is not
  smugglable. Closed→closed and closed→NULL both caught. Trigger ordering claim is true.
- Trigger and function inventory reconciles exactly against the catalogue; all 21 constraints
  validated; dynamic partitions inherit the guard; checksums byte-identical across databases.
- `0004` correctly needs no `-- IRREVERSIBLE:` marker. `fn_block_mutation` and
  `fn_block_historical_mutation` neither conflict nor duplicate.
- **Amendment factual accuracy is high** — 11 of 15 sampled claims verified exactly right,
  including every one specifically checked: ESLint absent, no mirror check in `guard-commit`, four
  `gen_random_uuid()` PKs with `uuidv7()` native, `pg_partman` unavailable,
  `fn_ensure_month_partition` with no caller, `Bash(psql *)` allow-listed, no integration markers.
- The four named Rule exceptions (6/0006, 2/0008, 12/0009, 8/0016) are **genuinely narrowly scoped**
  — no reviewer found a way to widen any of them.
- **All 19 ADRs still `Proposed`.** Nothing was accepted. `hrm` verified byte-identical before and
  after the review; all scratch databases dropped.

---

## 7. Recommendation

**Do not open the acceptance gate.** Blockers, in the order I would fix them:

1. **C-1 and C-2** — the status parser. Two small fixes, but until they land, "Accepted" does not
   reliably mean immutable, and C-2 fires on the wording a human would naturally use *while
   accepting*. Fix both, in one place, used by both hooks.
2. **C-3 and C-4** — `git commit -a` and the worktree/staged mismatch. C-3 is wider than this
   exercise: it is the secret-scanning rail.
3. **H-1 through H-5** — the Rule 3 perimeter: business-date function, `ENABLE ALWAYS`,
   `BEFORE TRUNCATE`, an INSERT guard or an honest rewrite of the KNOWN GAP paragraph, and
   `DROP/DISABLE TRIGGER` added to `DESTRUCTIVE_SQL`.
4. **R-1** — finish the undelivered §9 items for 0009, 0008, 0016, 0006.
5. **R-3, R-4, R-6** — remove the retracted claims; resolve the mutable-file authority problem in
   0007; fix the 0010 self-contradiction.
6. **Strengthen R2/R7/R9 and make R3 check `tgenabled`**, so the suite's green means what it appears
   to mean.

Then re-run the suite and a third adversarial pass on the deltas only.

**Confidence:** HIGH on everything marked [verified] and on findings where three reviewers converged
independently (H-1, H-4). MEDIUM on the red team's harness-semantics findings (A-7, A-15), which
depend on how `"if": "Bash(git commit *)"` matches compound commands and could not be executed.

**One structural observation for the human.** Three of the four HIGH perimeter findings are places
where the migration's *prose* claims a guarantee the *schema* does not deliver. That is the same
failure mode the first review found across the ADR corpus — a document asserting a control that does
not exist — reproduced in the artifact written to fix it. It is worth treating as a pattern rather
than as five separate defects.
