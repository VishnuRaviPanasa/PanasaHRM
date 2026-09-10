# ADR-0020: A Runtime AI Assistant, Built as Tool Calling over the Existing Authorization Layer

## Status

Proposed

> Only a human may set this to Accepted. Once Accepted this file is immutable and
> `.claude/hooks/guard-adr.mjs` will refuse edits - supersede it with a new ADR instead.

## Date

2026-09-09

## Context

**ADR-0014 decided that the product makes no model calls**, on four grounds: prompt injection
over personal data, a cross-border transfer question under DPDP, an evaluation burden, and the
fact that *"the organization has no LLM API key and does not want one."*

The fourth ground no longer holds. An OpenAI key has been funded and `gpt-4o-mini` is available.
ADR-0014 anticipated exactly this and wrote its own reversal condition:

> **Reconsider when.** If the organization decides to fund an API key. The first feature should
> be **personal work summarisation** (an employee summarising their own logs) rather than policy
> Q&A - smallest blast radius, clearest authorization scope, and it degrades gracefully. It would
> require an eval harness with a **100% authorization red-team score as a release gate**.

The requested feature is broader than personal work summarisation: an in-product assistant, on
every screen, answering questions about leave, attendance, work and the organisation, scoped to
what the asker may already see. The request was framed as **text-to-SQL**.

Three of ADR-0014's four grounds therefore still need answering, and the fifth force is new:
this ADR must not quietly weaken **ADR-0017**, which names ADR-0014 as one of its two structural
backstops - *"ADR-0014 removes the easiest scoring path by forbidding runtime AI."* Reversing
0014 without replacing that control would leave 0017 resting on a promise.

## Options considered

| Option | Summary | Why not chosen |
|---|---|---|
| Keep ADR-0014 as it stands | No assistant | The stated reason for it ("no API key and none is wanted") is no longer true, and an ADR whose premise has expired misdirects every decision downstream of it |
| **Text-to-SQL**: the model writes SQL, sandboxed | A dedicated least-privilege role, temp-table materialisation, `SET ROLE` under `BEGIN READ ONLY`, `REVOKE EXECUTE ON pg_catalog.set_config FROM PUBLIC`, a statement validator | Buildable and designed in full (kept under *Reconsider when*), but it requires amending `security-guidelines.md`'s ban on string-concatenated SQL, a global grant change, and a Postgres behaviour spike - and a small model authoring SQL against a 28-migration schema is the least reliable component in it. Highest cost, lowest accuracy |
| Retrieval over document text (RAG) | Embed handbook and document text, answer from passages | The questions people actually ask are about *their data*, not about prose. It also opens the injection channel this design closes, because retrieved text reaches the model |
| **Tool calling over the existing authorization layer (chosen)** | A fixed catalogue of parameterised read tools, each reusing an existing authz action, each composing `scope()` into its own SQL | - |

## Decision

**The product may make model calls, confined to a single `assistant` module, implemented as tool
calling over a fixed catalogue of read-only tools.** There is no dynamic SQL: every statement is
one this repository wrote, parameterised, and already covered by the authorization matrix.

Six properties define it. Each is a constraint, not an intention.

### 1. The assistant defines no new authorization action

Every tool reuses the action its equivalent screen already uses - `leave.balance.read`,
`attendance.day.read`, `work.log.read`, `people.employee.list` and so on. This is the principle
`reports.ts` established: *"A report can therefore never reveal more than the equivalent detail
screen, and it inherits the policy that is already tested."*

**The assistant is therefore incapable of out-reaching the screens it sits beside**, and the
property holds at any catalogue size. A tool that would need a new action is not a tool; it is a
new feature requiring its own decision.

### 2. Authorization is resolved twice, and rows are filtered by `scope()` in SQL

The catalogue offered to the model is filtered by `assertCan` per turn, so an actor is never
shown a tool they cannot call. On execution `assertCan` runs **again** - the model's selection is
untrusted input - and the row filter is `AuthorizationService.scope()` composed **into** the
statement, never applied to a result set. ADR-0005's reasoning applies unchanged: filtering after
the fact *"still leaks via counts, pagination totals and timing."*

A consequence worth stating plainly: **a mis-selected tool is a quality defect, not a security
defect.** Selection quality and authorization correctness are independent, and they are gated by
two separate test suites.

### 3. Row values reach the model, and nothing else does

> **Amended 2026-09-09, DEC-140.** As first written this section said *"No row of employee data
> is sent to the model"*, and it was the strongest claim in this ADR: it closed prompt injection
> **by construction** and reduced the cross-border transfer to the question the user typed. It has
> been **deliberately weakened**, on the product owner's instruction, because the assistant it
> produced could not answer a question. It could only introduce a table — *"the lookup for your
> casual leave balance returned 2 rows"* — while the figure the employee asked for sat in a column
> off the edge of a scrolling panel. An answer in words cannot be written by something that has
> not seen the figures. The original text is preserved below the amendment, because a reader
> needs to see what was given up.

Three calls per turn:

1. **Route** — the question plus seven domain descriptions.
2. **Select** — the question plus the tool schemas of one domain.
3. **Answer** — the question, the tool name, and **the masked result rows**. Streamed back a
   fragment at a time since DEC-141; the Rule 12 conditions in section 4 are unaffected, because
   the timeout still bounds the whole read and the single retry is suppressed once any fragment
   has been sent.

The rows sent at step 3 are the output of `AuthorizationService.scope()` composed into the SQL and
then `maskList` — **the identical array the browser is being shown in the same turn**, neither a
superset nor a pre-mask copy. Four properties bound what that costs:

- **The model never sees more than the asker already sees.** The marginal disclosure is to the
  **provider**. It is never a disclosure between two users of this system, and no authorization
  property in section 2 changes: rows are still filtered in SQL, still masked, still gated twice.
- **The answer call carries no tools.** It is one text completion with no `tools` array, so the
  model at that step cannot select, read or reach anything. **Successful prompt injection through a
  stored value can change the wording of a sentence and nothing else** — there is no scope left to
  widen by the time it runs.
- ~~**The table is rendered from Postgres and streamed before the answer call**, so a manipulated
  or hallucinated sentence sits beside the true rows rather than replacing them.~~ **Withdrawn
  2026-09-09 by DEC-141**, which removed the table from the panel. The `rows` event still reaches
  the browser first and is still never derived from the model's output — so the property holds for
  any client that draws it, and restoring the check is a rendering change — but **the shipped
  panel shows prose only, and a reader has nothing on screen to check it against.** The footnote
  now says the assistant can be wrong instead of pointing at records that are no longer there.
  Of the four bounds in this list this was the weakest as a control and the strongest as a
  safeguard for the *reader*, and losing it makes the accuracy suite the only remaining instrument.
- **Values are fenced, escaped, control-stripped and capped** (`answer.ts`): 50 rows, 160
  characters per value, 8000 characters per payload.

**State the loss plainly.** Prompt injection over stored data was *impossible* and is now merely
*contained*: a work-log description or a name that reads like an instruction now reaches the model.
The containment is that its blast radius is a wrong sentence shown to somebody simultaneously
looking at the correct table — the same failure mode as a mis-selected tool, which DEC-135 already
classes as a quality defect rather than a security one. And the cross-border transfer is no longer
"only what the user typed": it is now leave balances, attendance days and work records, for the
asker and for the people the asker may already see. **OR-03 still has no named legal owner**, and
this ADR is not authorised to give that opinion — it can only make the transfer visible, bounded
and switchable, which is what `HRM_LLM_ANSWER_FROM_ROWS` is for.

**`HRM_LLM_ANSWER_FROM_ROWS=false` restores the original behaviour exactly** — column names and a
row count, a deterministic sentence above the table — without a code change. The pre-amendment
design is therefore still running code, not history.

Name resolution stays server-side. A tool accepts an employee number or a name fragment and
resolves it **within the caller's scope**, so a question naming a colleague either resolves to
somebody the asker may see or is refused.

> **The original section 3, superseded by the above.** *"No row of employee data is sent to the
> model. Three calls per turn, none carrying a value from the database: route, select, and narrate
> — the tool name, the column names and the row count. Not the values. Rendering of results is
> deterministic and happens in our own code. This also closes the prompt-injection channel by
> construction: no value stored in the database can reach the model, so no value stored in the
> database can instruct it. The only untrusted text in the loop is the question the user typed
> themselves. That is a materially stronger position than ADR-0014 assumed any AI feature could
> take, and it is the single reason this reversal is defensible at all."*

### 4. Named exception to Must-Know Rule 12 - the model call is synchronous

Rule 12 forbids calling an external service from the request path. A chat turn is interactive by
nature; a queue and a poll would add latency and a worker process for no gain in safety, since
the failure mode being guarded against is a hung request rather than a lost one.

> **Permitted exception to Must-Know Rule 12.** The `assistant` module may call the configured
> model provider synchronously from the request path, subject to all of:
>
> 1. **A hard timeout** on every outbound call, below the request budget, with at most one retry.
> 2. **A circuit breaker**: consecutive failures disable the assistant rather than degrading
>    every request that touches it.
> 3. **Failure is contained.** A provider outage returns a refusal from the assistant and affects
>    no other endpoint. No other module may call the provider.
> 4. **No transaction is open across the call.** `architecture-principles.md` forbids an HTTP
>    call inside a transaction, and that is not relaxed here.
> 5. **The feature is off by default** (`HRM_ASSISTANT_ENABLED`), so a deployment that has not
>    chosen this has not taken the dependency.
>
> This authorises one caller, for one purpose, in one direction. No other module may cite it.

### 5. Named exception to Must-Know Rule 8 - the read model crosses module boundaries

The assistant reads leave, attendance, work, people, organisation and document data. Modelled on
ADR-0016's precedent, and bounded the same way:

> **Permitted exception to Must-Know Rule 8.** The `assistant` module may read other modules'
> data for the purpose of answering a question, subject to all of:
>
> 1. **Read-only, one direction.** The assistant never writes to another module, and no module
>    reads the assistant's tables.
> 2. **Through the same query shapes those modules expose**, with the same authz action and the
>    same `scope()` predicate. The assistant is a second caller of an existing read, not a new
>    path to the data.
> 3. **Behind `AuthorizationService`**, always, before the read - never by the tool deciding for
>    itself.
> 4. **Resolved as of the date being asked about**, not as of today, so a question about March
>    reads March.
> 5. **Never persisted.** A result has the lifetime of one response. No result row is written to
>    an assistant-owned table, logged, or sent to the model.
>
> Composite tools that join across domains authorise **per section**: the actor must pass
> `assertCan` for each component, and a component they fail is **omitted from the answer**, not
> cause to refuse the whole of it.

### 6. What the assistant may never do

Carried forward **verbatim and unweakened** from ADR-0014, and this ADR does not have the
authority to relax it:

> Forbidden regardless of any later decision: any AI input to hiring, promotion, compensation,
> performance rating, discipline or termination; attrition prediction on named individuals;
> productivity or sentiment scoring; and any AI write path to employee records.

Made structural rather than aspirational:

- **No tool reads compensation.** The catalogue contains no payslip entity, and `hrm_app` holds
  no grant on the payslip tables (migration 0024) - though note OR-29, which is why the absence
  of the tool is the control that is actually load-bearing today.
- **No tool ranks, scores or orders people**, and the model controls no `ORDER BY`. Because the
  catalogue is fixed, the model cannot compose one. **This is the replacement backstop ADR-0017
  loses**, and it is a stronger one than ADR-0014 provided: 0014 removed the capability by
  removing AI entirely, whereas this removes it by making the operation unrepresentable.
- **No narrative work-log content reaches anyone but its author.** `work_log_entry.description`
  is returned only when the reader is the subject, which is ADR-0017's own rule (*"Employees can
  always read and export their own logs"*).
- **`k = 5` minimum group size** on every tool that aggregates across an individual boundary,
  per ADR-0017 amendment (d). Below the threshold the tool returns *suppressed*, not a number.
- **No write path.** Every tool is a `SELECT`. The assistant cannot apply for leave, approve
  anything, or edit a record.

### Configuration and secrets

The provider key is read from `HRM_LLM_API_KEY_FILE`, a file-backed secret, per
`security-guidelines.md`: *"File-backed Docker secrets on tmpfs, mode 0400, with a `_FILE` config
convention. Never plain environment variables."* A plain `HRM_LLM_API_KEY` is accepted **for
local development only** and the code logs a warning when it is used. The key is never a build
arg and never appears in a log line.

**How the key reaches a production container is a deployment decision, not an architectural one.**
It has since been made and recorded as DEC-164: `docker-compose.prod.yml` bind-mounts a file named
by `HRM_LLM_KEY_HOST_PATH` at a fixed `/run/secrets/hrm_llm_api_key` and does **not** declare
`HRM_LLM_API_KEY` at all, so the plain-variable path does not exist in a deployment. Any other
mechanism - a swarm secret, a secrets agent - satisfies this ADR by mounting its file at the same
path. What this ADR fixes is the shape: a file, read at use, never an environment variable and
never a build arg. A deployment still gets the feature only once an operator supplies both
`HRM_ASSISTANT_ENABLED` and a key, which the release gate below governs.

**`HRM_LLM_ANSWER_FROM_ROWS` (DEC-140).** Defaults to true, which is what makes the assistant answer in words. Set to `false` it restores this ADR as originally written: the model is given column names and a row count, the sentence above each table is written deterministically in our own code, and no row value leaves the process. It is a separate switch from `HRM_ASSISTANT_ENABLED` because the two decisions are different - whether to have an assistant at all, and whether personal data may cross the border to make it useful.

### The release gate

**ADR-0014's condition is adopted unchanged: a 100% authorization red-team score, mechanically
enforced, before this ships.** Concretely, two suites that prove different things:

- **`assistant:redteam`** - every (tool x role) cell asserting the tool's rows **equal** the rows
  the equivalent endpoint returns for that role, plus an adversarial set covering role assertion,
  prompt injection, indirect targeting, forbidden purpose, enumeration, boundary probing,
  argument tampering, multi-turn escalation, obfuscation, k-threshold probing and out-of-scope
  questions. **100%, no waiver** - this is a CRITICAL-severity gate in the
  `severity-vocabulary.md` sense.
- **`assistant:accuracy`** - paraphrase coverage per tool. A **quality** threshold, waivable with
  a DEC entry, and deliberately not conflated with the gate above.

## Consequences

### Positive

- The permission model is not duplicated. There is one authorization implementation, and the
  assistant is one more caller of it - which is precisely the seam ADR-0014 built (*"the single
  control that makes permission-respecting AI possible at all"*).
- Prompt injection over stored data is **contained rather than impossible** since DEC-140. It was impossible while no value reached the model; it is now bounded by the answer call carrying no tools, so its worst outcome is a wrong sentence beside a correct table. This is a real reduction in the strength of this ADR and section 3 says so.
- No dynamic SQL, so `security-guidelines.md`'s ban stands unamended and no database grant
  changes.
- ADR-0017's no-scoring posture is stronger after this ADR than before it.
- The questions the assistant cannot answer are **logged**, producing an evidence-based backlog
  instead of speculation about what to build next.

### Negative / trade-offs

- **The catalogue is a maintenance surface.** A new screen that does not get a tool is invisible
  to the assistant, and the two will drift unless adding a tool is part of adding a feature.
- **Coverage is bounded by anticipation.** A question nobody thought of gets an honest refusal
  rather than an answer. That is the deliberate trade against text-to-SQL, and the `no_tool` log
  is the instrument for correcting it.
- **Selection quality is probabilistic** in a repository that otherwise prefers constraints. The
  containment is that a wrong selection is never an authorization failure - but a confidently
  wrong answer is still a real harm to a user, and the accuracy suite is the only thing standing
  between the product and it.
- **A third-party dependency now sits on an interactive path**, against ADR-0018's preference for
  externals that are "infrastructure, not applications". The feature flag, the circuit breaker
  and the containment of failure to one module are what bound it; the honest statement is that
  this is a coupling the product did not previously have.
- **Per-request cost** now exists, at three calls per turn.
- **The cross-border transfer is now substantial, and it was small.** Until DEC-140 the only personal data leaving the jurisdiction was the question the user typed. It is now the masked result rows as well - leave balances, attendance days, work records - for the asker and for anybody the asker may already see. Nothing about it is unbounded (it is exactly what the screen shows, capped at 50 rows) but it is a different order of thing from a question. **OR-03 still has no named legal owner**, and nobody on this project is authorised to give a compliance opinion (ADR-0017 amendment (a) makes the same point about itself). `HRM_LLM_ANSWER_FROM_ROWS=false` is the lever if that owner, once named, says no.

### Neutral

- `architecture-principles.md` gains an eleventh bounded context, `assistant`. ADR-0014 reserved
  the name `ai` for this seam; `assistant` is used instead because `ai/` at the repository root
  is the development-time Claude Code harness, and reusing the name would make every future
  search ambiguous. The seam is the one ADR-0014 described; only the label differs.
- The assistant owns two tables (`assistant_conversation`, `assistant_message`). They hold the
  question, the routing decision, the tool and its arguments, and counters. **No result row is
  stored** - see exception 5, condition 5.

## Reconsider when

**Text-to-SQL.** Revisit when the `no_tool` log shows a sustained volume of questions the
catalogue cannot serve *and* those questions are not answerable by adding tools. The design is
not lost - the sandbox is: a dedicated least-privilege role with no `USAGE` on schema `public`;
per-request temp tables materialised through `scope()` so the reachable data is bounded to rows
the actor may already see; `SET LOCAL ROLE` under `BEGIN READ ONLY` with a statement timeout;
the extended query protocol so multi-statement injection is impossible at the wire level;
`REVOKE EXECUTE ON pg_catalog.set_config(text,text,boolean) FROM PUBLIC` so the role change
cannot be undone from inside a single statement; and a lexical validator as the last layer rather
than the first. That work also requires amending `security-guidelines.md` and a Postgres
behaviour spike, and it should arrive as a **superseding ADR, not a feature ticket.**

**The forbidden list in section 6 is not reconsiderable here.** ADR-0014 placed it beyond later
decisions and this ADR inherits that limit rather than the power to lift it.
