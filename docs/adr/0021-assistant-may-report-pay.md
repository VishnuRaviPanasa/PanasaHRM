# ADR-0021: The Assistant May Report Pay, and the Figures Do Not Leave the Country

## Status

Proposed

> Only a human may set this to Accepted. Once Accepted this file is immutable and
> `.claude/hooks/guard-adr.mjs` will refuse edits - supersede it with a new one instead.

## Date

2026-09-10

## Supersedes

**ADR-0020 (A Runtime AI Assistant) section 6, first bullet only** - *"No tool reads
compensation. The catalogue contains no payslip entity."* Everything else in ADR-0020 section 6
stands unchanged and is restated below, because a partial supersession that leaves the reader
guessing which half survived is worse than none.

## Context

The product owner asked for this directly, in these words:

> "everybody should have the option to see their salary. and hr have option to see everyibnes
> salary. this is what we want"

The request arrived from a real failure, which matters because it shows the prohibition was not
merely inconvenient, it was producing wrong answers. An employee asked **"salary of onboarded
candidate"**. It was not refused - the pay phrase-block enumerates who a third party might be
(`EMP\d+|everyone|the team|my colleague`) and "onboarded candidate" is not on that list, and
every other pattern needs a verb. So it routed to `onboarding_upcoming_joiners`, which returned
the joiner with no money column (the registry working exactly as designed), and the answer was
**"I have nothing for the salary of the onboarded candidate."**

Nothing leaked. But the reply is a statement about the records made because of a prohibition, and
this is the third time in two days the same shape has been reported (DEC-165, DEC-169, DEC-170).
The pattern is now unmistakable: **a capability the product HAS, withheld only from the
assistant, comes out as a confusing sentence about absent data rather than an honest limit.**

### What the authorization model already says

This is the fact that makes the request small rather than large. **No policy needs to change**:

| | |
|---|---|
| `payroll.payslip.read` ([policies.ts](../../packages/authz/src/policies.ts)) | the SUBJECT always - *"a wage slip is something the person paid is entitled to see"* - plus `hr_admin` and `finance` for everyone. `denyOverrides: [isBreakGlassActor, isAncestorOfActor]`, so a manager cannot read the payslip of somebody who reports to them |
| Field registry `PAY()` | `RESTRICTED`, roles `['hr_admin','finance']`, `self: true` |
| `onboarding.annexure.read` | `orgRows(hr_admin, finance, delivery_head, auditor)` = ALLOW_ALL for those four, DENY_ALL otherwise |

"Everybody their own, HR everyone's" is therefore **already the product's policy**, with a screen
behind it (`/payslips`) and 80 passing payslip checks. The assistant was the only place it did
not hold, and only because ADR-0020 removed the capability rather than trusting the gate.

### Why ADR-0014's prohibition does not cover this

ADR-0014 forbade *"any AI input to hiring, promotion, **compensation**, performance rating,
discipline or termination"*, and ADR-0020 carried it forward verbatim. Read in context, that
clause is about **AI participating in a compensation DECISION** - recommending a raise, scoring
somebody for a promotion, ranking people by cost. It sits in a list with "performance rating" and
"attrition prediction on named individuals", and ADR-0014's own reasoning is about automated
judgement of people.

**Reading somebody their own payslip is not an input to a decision about them.** It is a lookup
of a figure they are legally entitled to, through the same predicate the screen uses. The clause
that genuinely bites is the one about ranking and scoring, and **that one is not relaxed here.**

This ADR takes the narrow reading deliberately and says so, so that a future reader can see the
distinction was made consciously rather than eroded.

## Decision

**1. The catalogue may contain tools that report pay figures**, restricted to the actions and
scopes that already exist. Three areas, all requested:

- **Payslips** - net, gross, deductions and period, through `payroll.payslip.read`. Own for
  everybody; everybody's for `hr_admin` and `finance`. `hr_ops` and `auditor` hold no grant and
  get none here.
- **The payslip document** - a pointer to the PDF the subject can already download, never the
  bytes and never a presigned URL.
- **The onboarding annexure CTC and its components** - through `onboarding.annexure.read`, so
  the four roles in the approval chain only. This is what the failing question actually wanted.

**2. NO PAY FIGURE IS SENT TO A MODEL PROVIDER.** This is the condition on which the rest rests,
and it is not a preference.

DEC-140 has the assistant write its answers *from the masked row values*, which are transmitted
to the provider (`gpt-4o-mini`, outside India) to compose a sentence. ADR-0020 section 3 already
names `question_text` as *"the only column in this database transmitted outside India"*; pay
figures must not become the second. So a tool that carries money **composes its own sentence in
our code**, and the controller never builds an answer payload for it:

- no `buildAnswerPayload`, no `llm.chat`, no `modelPayload` - the machine-checkable form of the
  guarantee, and the red team asserts the payload is absent rather than trusting the intent;
- the figure travels from PostgreSQL to the authenticated caller's browser and nowhere else;
- the existing `HRM_LLM_ANSWER_FROM_ROWS=false` was considered and rejected as the mechanism: it
  is a global degraded mode that answers *"open the relevant screen to read them"* and shows no
  figure at all, which does not deliver the request.

The cost is honest: pay sentences are written by hand and read a little flatter than model prose.
That is the price of the figures staying in India, and it was accepted deliberately.

**3. Nothing else in ADR-0020 section 6 moves.** Restated in full, unweakened:

- **No tool ranks, scores or orders people**, and the model controls no `ORDER BY`. A comparison
  across people is refused whatever grant the asker holds - "who earns the most" is a ranking
  question, not a pay question, and stays a flat refusal.
- **No narrative work-log content reaches anyone but its author.**
- **`k = 5` minimum group size** on any aggregate crossing an individual boundary. No pay tool
  aggregates: each returns rows for people the caller may already read individually.
- **No write path.** Every tool is a `SELECT`. The assistant cannot change a payslip or an
  annexure.
- **No AI input to a compensation DECISION.** No tool proposes, compares, benchmarks or comments
  on what somebody should be paid.

**4. The pay phrase-block is dismantled, and that is a consequence rather than a separate
decision.** `FORBIDDEN_PURPOSE` refused pay questions before any model call, and ADR-0020 was
explicit that the list *"was never more than a way of giving a clear no instead of a confusing
one"* - the real control being that no pay tool existed. With tools present a role-blind phrase
list cannot decide these questions: *"what is Priya's salary"* must be answered for `hr_admin`
and refused for an employee, and only `AuthorizationService` knows which. The patterns that
remain are the ones forbidden for **everybody**: ranking, scoring, leaderboards, "who earns the
most", hiring and firing recommendations, sentiment.

**This moves pay from a phrase list to the authorization layer, which is where CLAUDE.md rule 1
says every such decision belongs.** An employee asking about a colleague now meets DEC-142(b)'s
refusal - *"Priya Menon is outside what your account can see"* - which is more accurate than the
compensation refusal it replaces, and is produced by the gate rather than by a regex.

## Consequences

### Positive

- The product's own policy finally holds in the assistant too. The subject's right of access
  (DEC-076) stops being a right they can exercise on one screen and not by asking.
- The class of bug reported three times in two days is gone at its root: there is no longer a
  capability that exists everywhere except here, so no answer has to talk around one.
- Pay answers are deterministic. They cannot be paraphrased, softened, or invented by a model,
  which for a compensation figure is a better property than fluency.
- One fewer regex list standing in for an authorization decision.

### Negative / trade-offs

- **Pay sentences are hand-written** and will read more flatly than the rest of the assistant.
  They also need maintaining as columns change - a real cost, accepted for section 2.
- **A pay question now reaches the authorization layer**, so the quality of the refusal depends
  on the gate rather than on a phrase list. That is the correct direction and it does mean the
  refusal wording for pay is no longer special-cased.
- **`question_text` is still transmitted**, and a question can contain a figure the asker typed
  ("is my salary 50000?"). Section 2 constrains what the SYSTEM sends, not what a user writes,
  and ADR-0020 section 3 plus DEC-130's 90-day retention already govern that column.
- **The narrow reading of ADR-0014 is a judgement**, recorded here so it can be disagreed with
  openly. If a reviewer holds that "no AI input to compensation" was meant to cover lookups too,
  this ADR is the thing to reject - not the code.

### Neutral

- Tier 1 database isolation (migration 0024, DEC-073) is unaffected: `hrm_app` still holds no
  grant on the payslip tables and OR-29 is unchanged. The assistant reads pay through the same
  connection the payslip screen uses, so it inherits whatever that isolation becomes.

## Reconsider when

- A model is hosted inside India, or on-premises. Section 2's constraint is about a cross-border
  transfer, not about model prose being untrustworthy, so a local model would let pay answers be
  written the same way as everything else.
- Anybody asks for a pay COMPARISON, a benchmark, a distribution or a "who is paid more than"
  answer. That is section 3, it is refused, and it needs its own ADR - not an argument that this
  one already allows it.
- `hr_ops` or `auditor` are asked to be given pay visibility. That is a matrix change with its
  own reasoning; this ADR grants nothing beyond the cells that already exist.
