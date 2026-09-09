# ADR Formal Verification Report

**Date:** 2026-09-08
**Repository state:** branch `main`, clean tree at `582b355`
**Scope:** all 19 ADRs, `docs/adr/0001` – `docs/adr/0019`, all currently `Status: Proposed`
**Purpose:** determine whether each ADR is safe to accept. **No ADR status was changed by this review.**

**Method.** Six independent reviewers ran in parallel — five domain specialists and one adversarial
red team covering all 19. Each was required to read the complete ADR, the operating contract, the
actual implementation, the SQL migrations, the tests, the configuration and the git history, and to
verify ADR claims against the DDL rather than accepting the ADR's own account of itself. Reviewers
were explicitly calibrated that **absence of implementation is not a defect** — the project is early
Phase 2 of 13 and most ADRs are unimplemented by design.

A subset of the highest-severity findings was then re-verified independently against source by the
synthesizing session; those are marked **[verified]** throughout. Findings marked
**[reviewer-reported]** are single-source and their line numbers have not been independently
confirmed.

---

## 1. Executive summary

**No ADR was rejected. No architectural decision in this corpus is wrong.** All 19 decisions are
defensible on their merits, internally coherent, and appropriate to the project's constraints. The
temporal model, the append-only ledger, the FSM-as-data engine, the outbox, the two-graph
authorization model and the standalone constraint are all sound choices, and several are notably
well-reasoned.

**The corpus is nevertheless not yet safe to accept**, for reasons that are almost entirely
procedural and textual rather than architectural:

**1 — The immutability rail has an untested bypass, and it must be fixed first.** Accepting an ADR
is supposed to make it immutable (Must-Know Rule 7), enforced by `guard-adr.mjs`. That hook is
registered on `"matcher": "Edit|Write"` only. Any Bash path — `sed -i`, a heredoc, a script under
`scripts/` — rewrites an Accepted ADR with no prompt and no commit-time detection, and
`guard-commit.mjs` has no ADR check at all. The 19 passing hook tests probe the guard's *parsing*,
never its *reach*. **This changes the price of the entire exercise**: the protection that makes
acceptance meaningful does not currently hold. It is a small fix, and it should land before any ADR
is accepted. **[verified]**

**2 — Four authority-order traps.** `CLAUDE.md` places Accepted ADRs *above* itself in the authority
order. Four ADRs contradict a Must-Know Rule without acknowledging it, so acceptance would silently
repeal that rule rather than surface the conflict. These are the findings most worth a human's
attention, because acceptance is the mechanism by which they take effect.

**3 — Must-Know Rule 3 ("never overwrite effective-dated data") is enforced by nothing.**
`fn_block_mutation()` exists and is applied to `outbox_event` and `audit_event`, but was never
applied to the three effective-dated policy tables. An in-place `UPDATE` of a historical policy
period is accepted by the database today. **[verified]**

**4 — A recurring pattern: ADRs state controls in the present tense that do not exist.** ESLint
boundaries, Drizzle drift detection, a commit guard requiring the mirror, image digests, `pg_partman`,
a processing registry, `org_setting` auditing. Each is one line of text, but an Accepted ADR is
immutable and outranks everything below it, so an aspirational present tense becomes a permanent
false statement of fact.

**5 — One genuine business blocker.** ADR-0012 (payroll) rests on an unanswered build-versus-buy
question (plan Q10), sharpened by OR-07 recording that GreytHR's ESS already includes Salary. If that
resolves to "buy", ADR-0012 is void rather than deferred — and its `Reconsider when: Never` would
then be a permanently wrong statement in an immutable file.

**Bottom line:** this is a healthy corpus that needs a text pass, not a redesign. The recommended
path is to fix the guard, make a batch of small text amendments, and then accept in dependency order
— with ADR-0012 held back pending a business decision.

### Verdict distribution

| Verdict | Count | ADRs |
|---|---|---|
| **ACCEPT** as-is | 0 unanimous | (0013, 0014, 0018 each have one ACCEPT and one AMEND — see §2) |
| **AMEND** before accepting | 18 | all except 0012 |
| **REJECT** | 0 | — |
| **BLOCKED** | 1 | 0012 (split: specialist BLOCKED, red team AMEND) |

---

## 2. ADR-by-ADR verdict table

Where the specialist and the red team disagreed, the **consolidated** column takes the more
conservative verdict and the disagreement is noted. The human decision-maker should treat a split as
a signal to read that ADR personally.

| ADR | Title | Specialist | Red team | **Consolidated** | Conf. |
|---|---|---|---|---|---|
| 0001 | Application architecture | AMEND | AMEND | **AMEND** | HIGH |
| 0002 | Temporal data strategy | AMEND | AMEND | **AMEND** | HIGH |
| 0003 | Data access and migrations | AMEND | AMEND | **AMEND** | HIGH |
| 0004 | API style | AMEND | AMEND | **AMEND** | HIGH |
| 0005 | Authorization model | AMEND | AMEND | **AMEND** | HIGH |
| 0006 | Leave balance integrity | AMEND | AMEND | **AMEND** | HIGH |
| 0007 | Workflow engine | AMEND | AMEND | **AMEND** | HIGH |
| 0008 | Cross-module communication | AMEND | AMEND | **AMEND** | HIGH |
| 0009 | Authentication | AMEND | AMEND | **AMEND** | HIGH |
| 0010 | Session strategy | AMEND | AMEND | **AMEND** | HIGH |
| 0011 | Attendance storage | AMEND | AMEND | **AMEND** | HIGH |
| 0012 | Payroll statutory rules | **BLOCKED** | AMEND | **BLOCKED** ⚠ split | MED |
| 0013 | Deployment | AMEND | **ACCEPT** | **AMEND** ⚠ split | MED |
| 0014 | No runtime AI | AMEND | **ACCEPT** | **AMEND** ⚠ split | HIGH |
| 0015 | Work logs vs attendance | AMEND | AMEND | **AMEND** | HIGH |
| 0016 | Effort granularity and cost | AMEND | AMEND | **AMEND** | HIGH |
| 0017 | Work-log privacy posture | AMEND | AMEND | **AMEND** | HIGH |
| 0018 | Standalone application | **ACCEPT** | AMEND | **AMEND** ⚠ split | HIGH |
| 0019 | Configuration model | AMEND | AMEND | **AMEND** | HIGH |

### The four disagreements, and how to read them

- **0012 — BLOCKED vs AMEND.** The specialist blocks on plan Q10 (build payroll or buy it), noting
  OR-07 records GreytHR already provides Salary, and `organization-and-lifecycle.md` already assumes
  "a payroll hand-off". The red team treats the ADR as implicitly conditional and therefore cheap to
  accept. **The specialist's argument is stronger**: the cost of being wrong is an immutable ADR
  containing `Reconsider when: Never` for a module that will never be built.
- **0013 — ACCEPT vs AMEND.** The specialist's objection is that ADR-0013's principal accepted risk
  (off-host encrypted backups) has no backup script, no restore runbook, and — unlike ESLint (OR-05)
  or the remote (OR-04) — **no OPEN_RISKS entry at all**. That is a real gap, but it is an operational
  debt rather than a defect in the decision. Reasonable either way.
- **0014 — ACCEPT vs AMEND.** Both agree the decision is correct and the "Reconsider when" clause is
  unusually good. The AMEND is for present-tense wording that would, on acceptance, outrank
  `architecture-principles.md`'s ten-module list. A one-sentence fix.
- **0018 — ACCEPT vs AMEND.** The specialist verified the constraint holds — zero integration markers
  repo-wide, no external identifier columns, no endpoints or credentials. The red team's AMEND is that
  the ADR's *Context* is stale relative to OR-07 and under-prices the trade. Both agree OR-07 does not
  make it BLOCKED.

---

## 3. Evidence for every verdict

### ADR-0001 — Application architecture (modular monolith) — AMEND
- **Implementation:** module boundaries exist only as documentation. `packages/` and `apps/` contain
  only READMEs. **[verified]**
- **Problem:** the ADR states `eslint-plugin-boundaries` enforcement in the present tense; no ESLint
  config exists (OR-05 records this). Rule 8 is documentation, not mechanism.
- **Fix:** change tense, or cite OR-05/T13 as the pending enforcement.

### ADR-0002 — Temporal data strategy — AMEND
- **Implementation:** the pattern is applied **consistently and completely**. Exactly three tables
  carry `valid_from`/`valid_to`/`valid_period`, and all three have both `EXCLUDE USING gist` and the
  `NOT isempty` CHECK. **[reviewer-reported, queried against `pg_constraint`]**
- **Test:** `0001_baseline.verify.sql` T11–T13 do not merely assert this — they construct a table
  *without* the CHECK, demonstrate empty ranges bypass `EXCLUDE`, then show the CHECK catches them.
  This is genuinely adversarial testing. **[verified via test output]**
- **Problem (HIGH):** ADR-0002 promises "a historical period is never updated in place". Nothing
  enforces it. The only triggers on the three policy tables are `unconfirmed_fields` validators;
  `fn_block_mutation()` is applied only to `outbox_event` and `audit_event`. **[verified]**
- **Problem:** the ADR enumerates a *closed list* of effective-dated tables. That list is already
  incomplete on the day of acceptance, and acceptance freezes it.

### ADR-0003 — Data access and migrations — AMEND
- **Implementation:** `scripts/migrate.mjs` works and is verified. The Drizzle mirror does not exist.
- **Problem (HIGH):** "drift detection" names **two unrelated mechanisms**. `migrate.mjs` uses it for
  *migration file edited after apply*; ADR-0003 uses it for *Drizzle mirror vs database*. `backlog.md`
  marks the wrong one DONE.
- **Problem:** `scripts/README.md` cites "drift checks D1–D9"; **D1–D9 are enumerated nowhere in the
  repo**. Nothing states how `EXCLUDE` constraints, generated columns, partitions and triggers — which
  Drizzle cannot express and which are most of this schema — are to be compared.
- **Problem:** ADR-0003 claims a commit guard requiring the mirror to be staged. `guard-commit.mjs` has
  no such check, and `ai/agents/migration-author.md` repeats the false claim to the agent.

### ADR-0004 — API style — AMEND
- **Problem:** the ADR mandates UUIDv7; migrations 0002 and 0003 use `gen_random_uuid()` for all four
  PKs. Not a platform limit — `uuidv7()` exists natively on the running PostgreSQL 18.6.
  **[reviewer-reported, confirmed against `pg_proc`]**
- **Problem (security):** the `X-Request-Id` trust boundary is undecided. A client-supplied header
  reaching `audit_event.correlation_id` is audit-trail poisoning into an append-only, decade-retained
  table.
- **Problem:** `docs/standards/api-conventions.md` is missing and is *not* among the two absences
  CLAUDE.md excuses. T9 can be scaffolded without it but not finished — idempotency replay and ETag
  derivation are undecided.

### ADR-0005 — Authorization model — AMEND
- **Implementation:** none. `packages/authz/authz-matrix.yaml` does not exist. **[verified]**
- **Problem (HIGH):** the two-graph model is stated as exhaustive and is not. `org_setting`,
  `attendance_policy`, `employment_policy`, the leave-policy tables and `audit_event` already exist in
  committed schema and belong to **neither** graph; `scope()` for them has no defined answer.
- **Problem:** ADR-0002 makes `user_role` effective-dated, but nothing states whether the actor's role
  grant resolves as-of *today* or as-of the *record date*. Two readings, two data models — CLAUDE.md's
  own STOP-and-ask trigger.
- **Problem:** two competing column registries — ADR-0005's default-deny field registry and
  `audit_column_policy` — with no stated relationship and no default for an unlisted column.

### ADR-0006 — Leave balance integrity — AMEND
- **Positive:** Rule 4 satisfied — `NUMERIC` throughout, no float anywhere. FIFO lots and bitemporal
  ledger columns agree with the requirements docs.
- **Problem (HIGH):** **the specified mechanism never fires the CHECK.** The ADR specifies a
  `BEFORE INSERT` trigger doing `SELECT ... FOR UPDATE`, then concludes overdraw raises `23514`. That
  does not follow: a CHECK on `leave_account` is evaluated only when `leave_account` is written; an
  INSERT into `leave_ledger` evaluates nothing. The load-bearing account UPDATE is never stated.
- **Problem (HIGH):** `SELECT ... FOR UPDATE` on a **non-existent row locks nothing** — a new joiner's
  first request, or the first request of a new leave year. The serialisation point is absent precisely
  on 1 January and at every new hire.
- **Problem:** `allowed_negative` denormalises effective-dated policy with no refresh rule.
- **Problem:** the `pending` term is an unowned cross-ADR invariant — hold/release belongs to ADR-0007,
  which never mentions leave balances.
- **Note:** plan §13 chose `SERIALIZABLE`; ADR-0006 rejects it **without saying so**.

### ADR-0007 — Workflow engine — AMEND
- **Problem (HIGH):** the ADR is **materially thinner than `ai/context/workflow-rules.md`, which
  declares itself as implementing it** — and the ADR outranks it. Six DB-enforced invariants, the
  mandatory `fallback_rule_id` chain, the delegation cap and the `auto_approve` governance gate exist
  only in the companion. Accepting as-is installs the weaker document as the higher authority,
  immutably, while the richer one stays editable.
- **Problem:** "configuration, not a deployment" is unbounded and self-contradicted — the ADR concedes
  a new workflow-able entity needs a migration; resolvers, guard evaluator and effect handlers are all
  code.
- **Problem:** the governance boundary is structurally unenforceable. CLAUDE.md bans "a new top-level
  workflow state without an ADR", but the change-class gate derives class from **changed file paths**,
  and a new state is an INSERT touching no file.
- **Problem:** self-approval is **not** shown to be structurally impossible — the check reduces to a
  service-layer check relocated into a CHECK over caller-supplied snapshot data.

### ADR-0008 — Cross-module communication (outbox) — AMEND
- **Implementation:** `outbox_event` exists with `available_at`, `attempts`, `last_error` and a partial
  pending index matching the drain query. **Schema is sufficient for the missing drain worker**, with
  the two additions below.
- **Problem (HIGH):** **retention is structurally impossible.** The ADR says the outbox "needs a
  retention sweep or it grows without bound", but `tg_outbox_no_delete` blocks every DELETE and the
  table is **not partitioned** — only one `PARTITION BY` exists in all migrations, at line 206, for
  `audit_event`. No DELETE path, no DETACH path. **[verified]**
- **Problem (HIGH):** no dead-letter path, and `CHECK (attempts <= 100)` makes a poison message
  unresolvable — at attempt 100 the worker's own error-handling UPDATE raises `23514`. The row stays in
  the pending index forever, corrupting the drain-lag metric. **[verified]**
- **Problem (HIGH):** **immutability omits the accountability columns.** The trigger guards
  `event_type`, `aggregate_id`, `payload`, `occurred_at` only. `actor_user_id` and `correlation_id` —
  the ADR's own "by whom, in which request" — are freely rewritable. T9 passes because it tests only
  `payload`. **[verified]**
- **Problem:** conflicts with Must-Know Rule 2 (audit record "in the same transaction as the write").
  The audit row is written asynchronously by the drain, so it can lag or never land.
- **Note:** the migration comment states at-least-once delivery and requires an idempotent subscriber,
  but `uq_audit_event_outbox` is `(occurred_at, outbox_event_id)` — dedupe holds only if the subscriber
  derives `occurred_at` deterministically. Unrecorded assumption. **[verified]**

### ADR-0009 — Authentication — AMEND
- **Problem (HIGH):** account linking is undecided. The ADR says how an `oid` must *not* arrive but
  never how it does. **No `UNIQUE (tid, oid)` is specified** — two rows with the same `oid` is a
  takeover primitive.
- **Problem:** the CHECK binds a boolean flag, not the credential; a row with `local_auth_enabled=false`
  may still hold a live `password_hash`.
- **Problem:** the ADR's Decision says local auth "exists only for employees", but its own Consequences
  require privileged local break-glass accounts. Self-contradiction.
- **Problem (authority trap):** the OIDC token/JWKS exchange is an external call on the request path;
  Rule 12 says never, and the ADR never names the exception.

### ADR-0010 — Session strategy — AMEND
- **Problem (HIGH):** "in PostgreSQL cached in Redis" vs "read fresh" is undefined. If the cache holds
  role/scope/employment status with a TTL, revocation is delayed by that TTL and "immediate" is false —
  reintroducing exactly the window for which JWTs were rejected.
- **Problem (HIGH):** **the ADR never says the session token is stored hashed.**
- **Problem:** `audit_event.session_id` is `UUID` (128 bits) but the ADR specifies a 256-bit
  identifier. The dangerous reading has an implementer writing the bearer token into an append-only,
  decade-retained table.

### ADR-0011 — Attendance storage — AMEND
- **Problem (HIGH):** **the partition key is never stated.** The ADR justifies partitioning by "99% of
  queries carry a date filter", but queries filter `business_date` while the punch instant is a
  different value. With `TimeZone=UTC` in the Compose stack, a timestamptz-keyed punch table would put
  1 Sep 00:00–05:29 IST punches in the **August** partition — reintroducing at the boundary the exact
  skew the ADR exists to eliminate, and giving zero pruning.
- **Problem (HIGH):** `pg_partman` is declared "mandatory, not advisory" and **is not installed**, is
  not in the shipped image, and is not in ADR-0013's service list. The baseline instead ships a
  hand-rolled `fn_ensure_month_partition` — implementation diverged from the ADR before acceptance.
- **Problem (HIGH, operational):** no degradation strategy. T5 proves partition exhaustion is a **hard
  error**; for punches that means nobody can badge in, and the evidence is unrecoverable. Nothing
  currently calls `fn_ensure_month_partition` at all — it is invoked once inside the migration itself
  — and `audit_event`'s newest bound is **2027-01-01**. **[verified]**
- **Problem:** `payable_day_fraction` has no specified type. It is the sole payroll multiplicand, so a
  float column violates Rule 4 by proxy.
- **Problem:** `shift_roster` is a required snapshotted input with **no model anywhere** — zero hits
  repo-wide, absent from ADR-0002's effective-dated list, yet committed to by
  `architecture-principles.md`. In-place edits would breach Rule 3.

### ADR-0012 — Payroll statutory rules — BLOCKED (split)
- **Positive:** the principle — statutory rules as effective-dated data — is sound and satisfies
  Rule 11.
- **Blocker:** plan **Q10** (build payroll or integrate a provider) is unanswered and the plan gates
  the payroll phase on it. OR-07 records GreytHR's ESS **already includes Salary**. If Q10 resolves to
  "buy", ADR-0012 is **void, not deferred** — and its `Reconsider when: Never` would be permanently
  wrong in an immutable file.
- **Problem (HIGH):** **"as of the pay period" is not a date.** Period start, period end and
  disbursement day can resolve to three different rule versions. The one ADR governing money is the
  vague one.
- **Problem (HIGH):** no money type and no rounding policy. Rounding is where Indian payroll actually
  breaks; unless rounding is *part of the versioned rule*, a rounding change silently alters historical
  recomputation — defeating the ADR's entire purpose.
- **Problem (HIGH):** engine expressiveness unspecified. The rejected option was rejected because wage
  definition changes are *formula* changes. If the engine expresses only rates, the decision **silently
  collapses into the rejected option**.
- **Problem:** retrospectively-notified rates are normal in India and must change past answers plus
  generate arrears; the ADR states only determinism, so as written it forbids the correct behaviour.

### ADR-0013 — Deployment — AMEND (split; red team said ACCEPT)
- **Problem:** the ADR's principal accepted risk — off-host encrypted backups — has **no backup script,
  no restore runbook, and no OPEN_RISKS entry at all**, unlike every other tracked gap.
- **Problem:** DEC-010's mount layout puts PGDATA at a non-obvious path that a naive restore will not
  handle, and that is written down nowhere.
- **Problem:** the ADR states image digests in the present tense; no CI exists.

### ADR-0014 — No runtime AI in v1 — AMEND (split; red team said ACCEPT)
- **Positive:** the decision **is still appropriate as of 2026-09-08**, and better supported than the
  text claims — the authorization model it requires to be "proven in production" is not merely unproven
  but unbuilt. The "Reconsider when" clause is concrete and well-drafted.
- **Positive:** the ADR **does** draw the development-time / runtime line explicitly, so the concern
  that this repo is built by AI while shipping without it is addressed.
- **Problem:** it draws that line once and never binds it. `.claude/settings.json` allow-lists
  `Bash(psql *)` with no prompt, unscoped by host, database or role. Harmless today; the ADR's
  prohibitions read as *product* constraints and would not obviously stop a future operator pointing
  the harness at production.
- **Problem:** "seams only" is partly aspirational — reserving a module name delivers nothing that
  needs retrofitting, and the present-tense wording would, on acceptance, outrank
  `architecture-principles.md`'s explicit ten-module list.

### ADR-0015 — Work logs vs attendance — AMEND
- **Positive:** the boundary is right and the reconciliation direction is unambiguous — "It flags; it
  never corrects."
- **Problem (HIGH):** **comp-off is an unaddressed breach of the boundary.** The requirements state
  comp-off requires "a timesheet proving 8 hours effective work", and the glossary maps "timesheet" →
  **work log**, not attendance. Read literally, a work log gates a paid, encashable entitlement. The
  intended reading is almost certainly `attendance_day.worked_minutes`, but ADR-0015 never says so.
  Two readings, two data models.
- **Problem (HIGH):** **ADR-0012 is silent, not agreeing.** It never mentions `attendance_day`,
  `payable_day_fraction`, effort or timesheets. The invariant is asserted by 0011, 0015 and the
  glossary and acknowledged nowhere by the payroll ADR itself.
- **Problem:** the variance report is unspecified on authorization and privacy. It is the one artifact
  that must join **both** scope graphs, and it is functionally a per-employee under-reporting flag —
  colliding with ADR-0017's "no ranking, no score, no league table". Neither ADR references the other.

### ADR-0016 — Effort granularity and cost — AMEND
- **Positive:** integer minutes **verifies clean** — `minutes INTEGER`, matching the engineering
  guidelines and glossary exactly. Every duration column in shipped migrations agrees. Since payroll
  consumes only `payable_day_fraction`, payroll reconciliation can never need work-log cost, so
  0015/0016/0012 are genuinely reinforcing here.
- **Problem (HIGH, authority trap):** the ADR mandates a JOIN from `work` to `people.compensation` at
  report time; **Rule 8 forbids cross-module internals access** and no exception is named anywhere.
- **Problem (HIGH):** `rbac-rules.md` states `hrm_app` has *no grant at all* on compensation, so "a SQL
  injection in the leave module physically cannot read salary". The mandated join may therefore be
  impossible for the app role — either a separate DB role runs it (right answer, unwritten) or the
  Tier-1 control gets quietly widened.
- **Problem:** rate derivation entirely unspecified — which component, and what divisor converts
  monthly to per-minute. That divisor is policy (Rule 11) with no home.
- **Problem:** money type unstated (Rule 4). Meticulous about the time type, silent about the money.
- **Problem:** `comp_viewer` is undefined anywhere — grep returns only this ADR and an example in
  another standard. `rbac-rules.md` uses an action/policy model, not entitlement flags.

### ADR-0017 — Work-log privacy posture — AMEND (closest to BLOCKED)
- **Assessment:** "purpose-bound, employee-visible, retention-limited" is **two-thirds intent,
  one-third specification**. *Purpose-bound* — the "processing registry" appears exactly once in the
  entire repo, in this ADR. *Retention-limited* — "shorter than employment records" is a comparative
  with no number on either side, no mechanism, no owner. *Employee-visible* — real and testable, but
  scoped to "their own logs", so ADR-0015's variance flags fall outside it.
- **Problem (HIGH):** claims a compliance posture nobody is authorised to assert — it states a legal
  requirement as fact and claims a "defensible DPDP position", while OR-03 records in four places that
  DPDP compliance has no owner. CLAUDE.md: never infer legal requirements. *Why AMEND not BLOCKED:*
  every concrete choice is more restrictive than the law likely demands, so being wrong costs
  foreclosed features, not exposure.
- **Problem:** "no productivity-scoring surface exists" is a promise, not a design — you cannot
  constrain the absence of a feature.
- **Problem:** the attribution rule has **no k-threshold**. On a 2-person project the aggregate is
  trivially re-identifiable; on a 1-person project it is not an aggregate.
- **Problem:** erasure is unaddressed, and work logs are the one class with no statutory-retention
  override — exactly where erasure bites.

### ADR-0018 — Standalone application — AMEND (split; specialist said ACCEPT)
- **Positive:** the constraint **holds**. Grep across all code and config types for integration markers
  returns zero hits; no external identifier columns in any migration; the GreytHR document explicitly
  disclaims dependency and carries no endpoint or credential.
- **Assessment:** OR-07 (retire-or-coexist) is a scope question the ADR already anticipates and
  accepts. It does **not** make this BLOCKED — both reviewers agree.
- **Problem (red team):** the ADR's Context is stale relative to OR-07 and under-prices the trade.
- **Problem (LOW):** `org_setting.category` permits `'integration'`, unused, ambiguous exactly where
  this ADR is most sensitive.

### ADR-0019 — Configuration model — AMEND
- **Positive:** the effective-dated/mutable split is a good decision, well tested — 11 checks including
  proof that changing policy today does not change what a 2021 date resolves to.
- **Problem (HIGH):** **the dividing test was not applied exhaustively, and two tables fail it.**
  `leave_type` is mutable but carries `reduces_attendance`, `is_paid`,
  `requires_document_after_days` — verify case L2 is literally "WFH does not reduce attendance", i.e. a
  historical derivation input. And `company.timezone` sits in mutable `org_setting` with the seed
  description *"Changing it re-attributes punches"* — a direct "yes" to the ADR's own dividing test.
  Both cost one migration now and a data-archaeology exercise after Phase 6.
- **Problem (HIGH):** **the policy resolvers fail soft.** `fn_attendance_policy_asof('2019-06-15')`
  returns one row with every threshold NULL rather than raising. ADR-0019 names the resolver as *the*
  mitigation for the silent-wrong-answer hazard, and it has that exact failure mode. Policy epoch is
  2020-01-01, so any tenure longer than ~6.7 years is exposed. Untested.
- **Problem:** the ADR states `org_setting` auditing in the present tense; only an `updated_at` trigger
  exists.

---

## 4. Cross-ADR contradictions

### 4.1 Authority-order traps — the highest-value class

`CLAUDE.md`'s authority order is **Accepted ADRs → CLAUDE.md → ai/context → …**. An Accepted ADR that
contradicts a Must-Know Rule therefore *repeals that rule silently*. Four cases:

| # | ADR | Contradicts | Nature |
|---|---|---|---|
| C-2 | 0016 | **Rule 8** (module boundaries) | Mandates a `work` → `people.compensation` JOIN. No exception named. |
| C-3 | 0009 | **Rule 12** (no external call on request path) | OIDC token/JWKS exchange is exactly that. Never acknowledged. |
| C-4 | 0006 | **Rule 6** (never mutate a leave balance directly) | The design requires UPDATEing `leave_account` counter columns; the ADR never says what writes them. |
| C-5 | 0008 | **Rule 2** (audit record in the same transaction) | The audit row is written asynchronously by the drain. |

Each is fixable with one sentence — either the ADR names the exception explicitly, or CLAUDE.md's rule
is reworded. What must not happen is acceptance without the conflict being recorded.

### 4.2 Seams between ADRs

- **0006 × 0002** — ADR-0006 is the **only arithmetic ADR that does not require the resolved policy
  version on the row**; 0011 and 0012 both do. `leave_policy` is now effective-dated and the ledger is
  append-only, so a ledger entry written under a superseded policy cannot be re-derived.
- **0008 × 0002** — outbox events carry **transaction time only**. There is no as-of context, so a
  retroactive change cannot tell consumers which dates to recompute — and the table is append-only, so
  it can never be backfilled.
- **0005 × 0007** — **two independent authorization gates with no stated precedence**, in either ADR or
  in `rbac-rules.md`/`workflow-rules.md`. Who decides who may fire a transition: `AuthorizationService`
  or `wf_actor_rule`?
- **0007 × 0019** — `leave_policy.requires_second_approver_role` is **already shipped and seeded**, and
  competes with `wf_actor_rule` for chain composition.
- **0011 × 0012** — arrears have no stated rule version, and it is a statutory question the corpus is
  required to stop on. ADR-0012 never mentions arrears at all.
- **0015 × 0012** — the payroll boundary is asserted by 0011, 0015 and the glossary, and acknowledged
  **nowhere by ADR-0012 itself**. A one-sided invariant is a latent contradiction.
- **0015 × 0017** — ADR-0015 creates a variance report that is functionally a per-employee
  under-reporting flag; ADR-0017 forbids ranking and scoring. Neither references the other.
- **0002's closed list** — enumerates effective-dated tables and is already incomplete
  (`shift_roster`, `work_policy`, `user_role` handling). Acceptance freezes a wrong list.

### 4.3 Scope and numbering integrity

Plan §13's 17 rows all map cleanly onto ADRs; 0018 and 0019 are justified additions. But:
- §13 chose `SERIALIZABLE` for leave; **ADR-0006 rejects it without saying so.**
- **DEC-011** (forward-only migrations) is architectural, yet sits below SQL migrations in the
  authority order — it should probably be an ADR.
- Three shipped decisions sit below ADR authority despite being architectural in effect.

---

## 5. Security findings

| # | Finding | Severity |
|---|---|---|
| S-1 | **ADR immutability guard is bypassable via Bash.** `guard-adr.mjs` is registered on `matcher: "Edit\|Write"` only; `guard-commit.mjs` has no ADR check. `sed -i` rewrites an Accepted ADR with no prompt and no commit-time detection. **[verified]** | **CRITICAL** |
| S-2 | **No `UNIQUE (tid, oid)` specified** for external identities (ADR-0009). Two rows with the same `oid` is an account-takeover primitive. | HIGH |
| S-3 | **Session token hashing never specified** (ADR-0010), combined with a `UUID` `session_id` column in an append-only, decade-retained audit table. The dangerous reading writes a bearer token into permanent storage. | HIGH |
| S-4 | **Revocation TTL undefined** (ADR-0010). If the Redis cache holds role/scope/employment status, "immediate revocation" is false — the exact window JWTs were rejected for. | HIGH |
| S-5 | **`X-Request-Id` trust boundary undecided** (ADR-0004). A client-supplied header reaching `audit_event.correlation_id` is audit-trail poisoning into an append-only table. | HIGH |
| S-6 | **Outbox accountability columns are mutable.** `actor_user_id` and `correlation_id` are outside the immutability trigger. **[verified]** | HIGH |
| S-7 | **Two competing column registries** (ADR-0005 field registry vs `audit_column_policy`) with no default for an unlisted column — a field-mask bypass surface. | MEDIUM |
| S-8 | **`local_auth_enabled=false` may coexist with a live `password_hash`** — the CHECK binds a flag, not the credential. | MEDIUM |
| S-9 | **403 vs 404 stated with opposite polarity** in two context files; nothing requires a scope-denial 404 to be indistinguishable from a real 404. | MEDIUM |
| S-10 | **`Bash(psql *)` allow-listed with no prompt**, unscoped by host, database or role. Harmless today; not bounded by ADR-0014's product-framed prohibitions. | MEDIUM |
| S-11 | **The authz commit-guard branch is explicitly disabled**, has no regression test, gates on a relative `existsSync('packages/authz')`, and only checks that *some* matrix file is staged. | MEDIUM |
| S-12 | **No maker-checker or step-up for payroll rule authoring** (ADR-0012) — a fraud path. `requireStepUp('PT15M')` is required by two documents and **decided by no ADR**. | MEDIUM |

---

## 6. Data-integrity findings

| # | Finding | Severity |
|---|---|---|
| D-1 | **Must-Know Rule 3 has zero mechanical enforcement.** In-place `UPDATE` of a historical policy period is accepted today. `fn_block_mutation()` exists and was simply never applied to the three policy tables. **[verified]** | **CRITICAL** |
| D-2 | **ADR-0006's anti-overdraw mechanism never fires the CHECK**, and `SELECT ... FOR UPDATE` on a non-existent row locks nothing — failing precisely at new-year and new-hire boundaries. | **CRITICAL** |
| D-3 | **Outbox retention is structurally impossible** — DELETE blocked, table unpartitioned. Unbounded growth with no remediation path. **[verified]** | HIGH |
| D-4 | **Poison messages are unresolvable** — `CHECK (attempts <= 100)` makes the worker's own error-handling UPDATE fail at attempt 100; no dead-letter state; DELETE blocked. **[verified]** | HIGH |
| D-5 | **Policy resolvers fail soft** — `fn_attendance_policy_asof('2019-06-15')` returns NULLs, not an error. Any pre-2020 date silently resolves to nothing. | HIGH |
| D-6 | **`company.timezone` is mutable** with a seed comment admitting "Changing it re-attributes punches" — fails ADR-0019's own dividing test. | HIGH |
| D-7 | **`leave_type` is mutable** while carrying `reduces_attendance` / `is_paid` — historical derivation inputs. | HIGH |
| D-8 | **Attendance partition key unstated**; a timestamptz key under `TimeZone=UTC` misroutes 00:00–05:29 IST punches to the prior month's partition. | HIGH |
| D-9 | **Partition exhaustion is a hard error with no scheduled provisioner.** `fn_ensure_month_partition` has no caller; `audit_event` bounds end 2027-01-01. **[verified]** | HIGH |
| D-10 | **`payable_day_fraction` type unspecified** — sole payroll multiplicand; a float violates Rule 4 by proxy. | HIGH |
| D-11 | **No money type or rounding policy in ADR-0012**; rounding outside the versioned rule silently alters historical recomputation. | HIGH |
| D-12 | **Outbox ordering unspecified** — identity values are allocated pre-commit, so commit order ≠ id order; `approved` can precede `submitted`. | MEDIUM |
| D-13 | **Idempotency key depends on an unrecorded assumption** — `uq_audit_event_outbox` is `(occurred_at, outbox_event_id)`; dedupe holds only if the subscriber derives `occurred_at` deterministically. **[verified]** | MEDIUM |
| D-14 | **`db:verify` is destructive and untransacted** — zero `BEGIN;`/`ROLLBACK;` in any verify script. It has already written 4 fabricated `people.employee.hired` rows into the permanently undeletable audit log, one per run, and `audit_event_p203007` persists in the dev DB. T9 runs `UPDATE outbox_event SET processed_at = now()` **with no WHERE**. It honours `PGHOST`/`PGDATABASE`, so pointed at production it would rewrite production policy history. **[verified: no BEGIN/ROLLBACK]** | HIGH |

---

## 7. Missing tests

- **No test for `tg_outbox_no_delete`**, though T1/T2 test the equivalent on `audit_event`.
- **T10 is not a test** — it asserts nothing, and captures only the first `EXPLAIN` row, discarding the
  scan node. Its own comment claims the partial index "is actually used, not a seq scan"; that claim is
  unverified, over a 2-row table.
- **No test that the ADR guard blocks non-Edit/Write paths.** T14–T19 send only `tool_name: 'Edit'` —
  they probe the guard's parsing, never its reach.
- **No test that a historical effective-dated period cannot be updated in place** (Rule 3).
- **No test for resolver behaviour outside the policy epoch** — the NULL-return failure mode is
  untested.
- **No test that outbox accountability columns are immutable.**
- **No concurrency test of any kind** — appropriate now, mandatory before Phase 6.
- **General pattern:** the suites are strong where they were written adversarially (T11–T13, C5, L3–L8
  are genuinely good) and absent exactly where the implementation and the test share an author's
  assumption.

---

## 8. Missing documentation

| File | Referenced by | Status |
|---|---|---|
| `packages/authz/authz-matrix.yaml` | CLAUDE.md Forbidden Actions, ADR-0005, `guard-commit.mjs` | Missing — **rule cannot currently be complied with** |
| `docs/privacy/data-inventory.md` | CLAUDE.md Forbidden Actions, ADR-0017 | Missing — **and already being violated**: migrations 0001–0003 shipped unclassified personal-data columns (`source_ip`, subject/actor ids) with `audit_column_policy` holding 0 rows |
| `docs/standards/api-conventions.md` | Phase 1 deliverables, ADR-0004 | Missing — needed before T9 |
| `docs/standards/coding-standards.md` | Phase 1 deliverables | Missing — substantially duplicated by `ai/context/engineering-guidelines.md` |
| `docs/architecture/system-overview.md` | Phase 1 deliverables | Missing |
| `docs/architecture/module-map.md` | Phase 1 deliverables | Missing — generator is Phase 2 T13; cannot close in Phase 1 |
| `docs/runbooks/partition-maintenance.md` | ADR-0011 | Missing |
| Backup script + restore runbook | ADR-0013's principal accepted risk | Missing, **and not in OPEN_RISKS** |
| "drift checks D1–D9" | `scripts/README.md` | Enumerated nowhere |
| Processing registry | ADR-0017 | Appears once in the repo — in ADR-0017 |
| `comp_viewer` definition | ADR-0016 | Undefined anywhere; no glossary entry |
| "Tier 1" data classification | five normative places | Undefined; the formal vocabulary is a four-class scheme |

Also stale: `.claude/state/SESSION_HANDOFF.md` describes 24 DB checks and two migrations. There are
**33 checks and three migrations** — `0003_leave_policy_configuration.sql` landed in `582b355` and was
never written up. **[verified]**

---

## 9. Required amendments

**Before accepting anything:**

- **A-0 — Fix the ADR guard.** Register `guard-adr.mjs` on `Bash` as well as `Edit|Write`, or add an
  ADR check to `guard-commit.mjs`, and add a regression test that sends `tool_name: 'Bash'`. Without
  this, acceptance does not mean what the corpus says it means.

**Per ADR (all are text changes unless marked):**

| ADR | Required change |
|---|---|
| 0001 | Change present-tense ESLint claim to reference OR-05/T13. |
| 0002 | Replace the closed table list with a rule; state the Rule 3 enforcement mechanism. **+ migration** applying `fn_block_mutation` to the three policy tables. |
| 0003 | Disambiguate the two "drift detection" meanings; enumerate D1–D9 or drop the reference; remove or implement the commit-guard claim. |
| 0004 | Decide the `X-Request-Id` trust boundary; reconcile UUIDv7 vs shipped `gen_random_uuid()`; write `api-conventions.md`. |
| 0005 | State `scope()` for resources in neither graph; decide as-of semantics for `user_role`; state the relationship to `audit_column_policy` and the default for an unlisted column. |
| 0006 | State what writes `leave_account`; handle the missing-row lock case; name the Rule 6 exception; require the resolved policy version on the ledger row; state the unit and numeric type. |
| 0007 | Promote `workflow-rules.md`'s invariants into the ADR; bound "configuration, not deployment"; state transition-firing precedence vs ADR-0005. |
| 0008 | **+ migration** for partitioning or a retention path; add a dead-letter state; extend the immutability trigger to `actor_user_id`/`correlation_id`; state at-least-once + ordering explicitly; name the Rule 2 exception; fix `outbox_events` → `outbox_event`. |
| 0009 | Specify `UNIQUE (tid, oid)`; bind the CHECK to the credential not the flag; resolve the break-glass contradiction; name the Rule 12 exception. |
| 0010 | Define exactly what is cached and its TTL; **state that the session token is stored hashed**; reconcile the 256-bit identifier with the `UUID` column. |
| 0011 | State the partition key as `business_date`; replace `pg_partman` with the shipped function or install it; add a degradation strategy; specify `payable_day_fraction` as `numeric`; model `shift_roster` as effective-dated. |
| 0012 | **Hold** — see §11. If accepted: define "as of" precisely, mandate money type + rounding-as-part-of-the-rule, specify engine expressiveness, permit retrospective recompute + arrears. |
| 0013 | Add a backup script and restore runbook, or add an OPEN_RISKS entry; document the PGDATA mount path; fix present-tense image-digest claim. |
| 0014 | Change present-tense module wording so it does not outrank the ten-module list; bound the dev-time/runtime line operationally. |
| 0015 | State that comp-off is gated by `attendance_day.worked_minutes`, not work logs; specify the variance report's authorization and privacy posture; give `work_policy` a home. |
| 0016 | Name the Rule 8 exception or route the join through a module interface; specify the DB role; specify rate component + divisor + money type; define `comp_viewer` and add a glossary entry. |
| 0017 | Put a number on retention; create the processing registry or drop the reference; add a k-threshold; address erasure; soften the DPDP legal claim to a design posture pending OR-03. |
| 0018 | Refresh the Context for OR-07. |
| 0019 | **+ migration** moving `company.timezone` and `leave_type`'s derivation flags to effective-dated; make resolvers RAISE outside the policy epoch; fix the present-tense auditing claim. |

**Independent of the ADRs, recommended now:** wrap the verify scripts in `BEGIN; … ROLLBACK;` and add
a host guard, so `db:verify` stops writing permanent garbage into the audit log and cannot be pointed
at production.

---

## 10. Recommended acceptance order

Sequenced so that each ADR is accepted only after the ones it depends on, and so the cheapest,
least-reversible-value decisions go first.

**Gate 0 — fix A-0 (the guard bypass).** Nothing below is meaningful until this lands.

| Wave | ADRs | Rationale |
|---|---|---|
| **1** | 0018, 0001, 0013, 0014 | Constraints and structural decisions with the fewest dependents. 0018 verified clean; the other three need only text amendments. |
| **2** | 0002, 0019 | **Accept together** — they share findings, both need the Rule 3 migration, and the corpus flags them as the most expensive to reverse. Everything temporal depends on them. |
| **3** | 0003, 0004 | Depend on 0002 being settled. 0004 should follow `api-conventions.md` being written, before T9. |
| **4** | 0005, 0009, 0010 | The security spine. Accept as a set — the account-linking, revocation and scope questions are interlocking. Required before Phase 3. |
| **5** | 0008, 0007 | Outbox before workflow; 0007's precedence question needs 0005 settled first. |
| **6** | 0006 | Needs 0002, 0007 and 0019 settled. Required before Phase 6. |
| **7** | 0015, 0016, 0017 | **Accept as a set, not individually** — every material gap lives *between* them. Required before Phase 7. |
| **8** | 0011 | Required before Phase 8. |
| **9** | 0012 | **Only after Q10 is answered.** See §11. |

---

## 11. Blockers

| # | Blocker | Blocks | Owner |
|---|---|---|---|
| **B-A** | **ADR guard bypassable via Bash** — acceptance does not confer immutability. | **All 19** | Claude (small fix) |
| **B-B** | **Plan Q10 — build payroll or integrate a provider?** OR-07 records GreytHR ESS already includes Salary. If "buy", ADR-0012 is void, not deferred. | 0012 | Human / HR |
| **B-C** | **OR-03 — no named DPDP/legal contact.** ADR-0017 asserts a "defensible DPDP position" nobody is authorised to assert. | 0017 (soften, don't block) | Human |
| **B-D** | **`data-inventory.md` does not exist**, and migrations 0001–0003 already shipped unclassified personal-data columns. The Forbidden Action is live and currently unsatisfiable. | 0017, work module | Claude + Human |
| **B-E** | **`authz-matrix.yaml` does not exist**, and the guard branch that would enforce it is explicitly disabled. | 0005 (Phase 3) | Claude |

Explicitly **not** blockers: absence of application code; OR-07 for ADR-0018 (anticipated and
accepted); the counsel dependency for ADR-0012's *principle* (it changes values and timing, not the
decision — Q10 is the real blocker); OR-06 and OR-08 for ADR-0006 (they bear on leave *arithmetic*,
not on the integrity mechanism).

---

## 12. Final recommendation

**Do not accept any ADR today.** Not because the architecture is wrong — it is not, and this corpus is
better than most — but because the mechanism that gives acceptance its meaning is currently
bypassable, and because 18 of 19 ADRs contain at least one specific, cheap, nameable defect that is
free to fix now and permanent to fix later.

The recommended sequence:

1. **Fix the guard (A-0)** and add the regression test. Half an hour.
2. **Apply the text amendments in §9.** Most are one or two sentences. This is the bulk of the work and
   it is genuinely small.
3. **Write the three migrations** flagged in §9 (Rule 3 enforcement on policy tables; outbox retention
   + dead-letter + extended immutability; `company.timezone` and `leave_type` moved to effective-dated).
   These are class-C changes and should go through the full gate.
4. **Accept in the wave order of §10**, reading each ADR personally before flipping its status —
   the guard makes the flip one-way.
5. **Hold ADR-0012** until Q10 is answered.

Two governance points deserve a decision of their own, because neither belongs to any single ADR:

- **The four authority-order traps (§4.1).** Decide, for each, whether the ADR names an exception or
  the Must-Know Rule is reworded. Doing this *in the same change as acceptance* is what keeps the
  authority order honest.
- **The change-class gate cannot see configuration-as-data.** It derives class from changed file
  paths, so a `wf_state` row or a `leave_policy` period — class C by content — passes as no change at
  all. This will matter more as configuration replaces code.

**Confidence in this report: HIGH** on findings marked **[verified]** and on the corpus-level
structural findings, which were reproduced independently. **MEDIUM** on single-source line-number
citations, which were not all re-checked. **The ADR-0012 verdict is the one genuine reviewer
disagreement and the one most deserving of an independent human read.**

### Limits of this review

- No network access: ADR-0012's premise about the Labour Codes' commencement position could not be
  checked against any external source, and must not be inferred.
- ADR-0006's proposed generated-column CHECK was not tested for PostgreSQL legality.
- The five specialist reviewers each saw only their own group; cross-group contradictions rest mainly
  on the red team's single pass, though several were reproduced independently.
- Reviewers ran read-only. No claim here about runtime behaviour has been tested against an
  application, because there is no application.

---

*Produced by six independent reviewers (five domain specialists, one adversarial red team) with
subsequent independent verification of the highest-severity findings. No ADR status was changed. No
repository file was modified other than the creation of this report.*
