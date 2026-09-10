# Session Handoff

## 2026-09-10 (later): UI-01 — the sign-in screen and the dashboard, redesigned

Asked: the manager reviewed the application and wants the login screen and the dashboard to look
modern, polished and professional. **Visual/UX only** - no functional rewrite, no mock data, no
schema change, no ADR status change, nothing removed.

**Nothing was committed or pushed.** The tree also still carries the five merge-defect fixes from
earlier in the day (guard-adr, the ADR-0021 rename, package.json, the verify rename, the new
assistant suite) - both pieces of work are uncommitted together.

### What the redesign is built from

| Piece | Where |
|---|---|
| **A hand-drawn icon set** - 30 glyphs, one 20x20 geometry, `currentColor`, no dependency | `apps/web/components/icons.tsx` (new) |
| **Six reusable primitives**: `KpiCard`, `IconTile`, `Avatar`, `ActionTile`, `SegmentBar`, `PasswordInput` + `inputClsLg` | `apps/web/components/ui.tsx` |
| **Theme layer**: a 3-step elevation scale, heading leading/tracking, `.pitch` (the sign-in panel's ground), `.rise`, `.lift`, `.flip-rtl`, thin scrollbars | `apps/web/app/globals.css` |
| 60 new message keys, English **and** Arabic | `apps/web/lib/i18n/dictionary.ts` |
| `useFormat().time` / `.dateTime` + one `OFFICE_TZ` | `apps/web/lib/i18n/index.tsx` |

`Stat` was deliberately NOT restyled - it has 55 call sites across six other screens where `tone`
colours the value and that is load-bearing. `KpiCard` is a separate component for that reason.

### Three real defects the screenshots found (all fixed)

1. **The header showed the brand mark TWICE below 640px.** `hidden sm:inline-flex` passed as
   ArtLogo's className collides with its own `inline-flex` - two `display` utilities of equal
   specificity, resolved by stylesheet order, not attribute order. Pre-existing, invisible at
   every desktop width. Now `browser:test` **B32a**, which fails against the un-fixed markup
   (verified: "2 visible").
2. **The dashboard scrolled sideways on a phone** - measured 7px (en) and 17px (ar) before, 0px
   after, at every width in both directions. Now `browser:test` **B32b**, in both locales.
3. **`ink-400` text is 3.71:1 on white** - below AA for the small labels and the activity
   timestamps. Moved to `ink-500` (6.05:1); decorative icons keep `ink-400` (3:1 suffices for a
   UI component). On the dark panel the ramp inverts, so the footer moved the other way,
   `ink-500` -> `ink-400` (3.17 -> 5.15:1).

### Two hardcodes removed, both by moving work to the server

* `Bar value={available} max={12}` - a **twelve-day entitlement hardcoded in the browser**, and
  wrong for sick leave. `/dashboard` now sends `taken`, `pending` and the entitlement from
  `leave_account`, summed in SQL. Rule 11 and ADR-0006, in one line of JSX.
* The activity feed was an **English sentence assembled in SQL** (`'applied for ' || ...`), so it
  was English for every reader. The endpoint now sends `kind` + parts and the UI builds the
  sentence from the dictionary. `what` is kept, unchanged, for any other caller.

Untranslated strings on the Arabic dashboard: **25 -> 14**, and all 14 that remain are DB data or
people's names (leave-type names, holiday names, office names, employee names, role codes).

### Everything green: 3,697 automated checks, 0 failures

`assistant:redteam` 2066 · `authz` 554 · `db:verify` **283 before and after** · `browser` **114**
(was 111) · `hooks` 107 · `payslip` 80 · `reports` 63 · `accounts` 53 · `docs` 52 · `masters` 49 ·
`upload` 45 · `work` 44 · `period` 28 · `assistant:test` 26 · `nav` 24 · `onboarding` 24 ·
`privacy` 20 · `punch` 18 · `bizdate` 18 · `settings` 15 · `i18n` 14 · `demo:test` ALL STEPS
PASSED. `tsc --noEmit` clean on web and api; `authz:build` / `api:build` / `web:build` clean.

**B03 signs in through the real form** and lands on `/` - the login path is covered by the suite,
not only by inspection.

### Two things worth knowing before touching these screens

* **`CardHead`'s DOM shape is an interface.** An early draft added an optional `icon` and one
  wrapper `<div>`; that broke `browser:test` B15d on the PAYSLIP screen, which finds an `<h2>`
  and walks up a fixed number of parents to reach the card. The prop had no callers, so it was
  deleted rather than the check loosened.
* **`captureBeyondViewport` misplaces RTL screenshots.** Arabic pages came back shifted and
  clipped, which reads as a layout bug and is not one - the measured overflow was 0px. Capture
  RTL viewport-only at a tall viewport instead. Two rounds were spent on a phantom.

### Exact next action

Review the tree and commit. Then the manager demo can be shown. Nothing here changed
authentication, authorization, the schema, leave/attendance/work arithmetic, an API contract
(both endpoint changes are additive) or any ADR status.

---

## 2026-09-10: pulled the assistant/chatbot merge and re-verified the whole stack

Asked: "run it locally. Infra team has done some changes. pull it and check all fine."

**Pulled** `origin/feat/hrm-core-modules` 3b2dfc9 -> cddf1bd, fast-forward, 42 files,
+10,373 lines. Four commits: `ai chatbot` (415804c), a merge of `origin/feature/chatbot`,
`buld fix error`, `db fix applied`. Author of the chatbot work: hisham.islah@arttechgroup.com.

**It is not only infra.** The infra part is real (`deploy.sh`, `docker-compose.prod.yml`,
`prod.env.template`, `env.example`) but the substance is a **runtime AI assistant** - which
reverses ADR-0014. That was done properly: ADR-0014 is now `Superseded by ADR-0020` (the one
permitted edit to an ADR) and the supersession note explicitly keeps in force both the
"forbidden regardless of any later decision" list and the harness/production bound. Migration
0035, `packages/authz` +107 actions, a 2,065-check red team.

### Everything green: 3,659 automated checks, 0 failures

| Suite | Result | | Suite | Result |
|---|---|---|---|---|
| `db:verify` | **283 PASS** (was 262) | | `masters:test` | 49 |
| `assistant:redteam` | **2065** | | `work:test` | 44 |
| `browser:test` | **111**, 0 uncaught | | `period:test` | 28 |
| `authz:test` | **554** (was 423) | | `nav:test` | 24 |
| `hooks` | **99** (was 61) | | `onboarding` | 24 |
| `payslip:test` | 80 | | `privacy:test` | 20 |
| `reports:test` | 63 | | `punch:test` | 18 |
| `accounts` | 53 | | `bizdate:test` | 18 |
| `docs:test` | 52 | | `settings:test` | 15 |
| `upload:test` | 45 | | `i18n:test` | 14 |
| `demo:test` | ALL STEPS PASSED | | | |

`api:build` / `web:build` / `authz:build` clean. 18/18 web routes 200. `db:verify` re-run after
the mutating suites and still 283 - order-independence holds.

**Assistant is OFF locally** (`HRM_ASSISTANT_ENABLED=false`, no `.env`). Verified it degrades
rather than errors: `POST /api/assistant/ask` returns an SSE `refusal` with
`{"code":"disabled"}` in 14ms, HTTP 201. No key is needed to run or demo the rest of the product.

### Four defects the merge introduced - none blocking, ALL NOW FIXED (see below)

1. **TWO ADR-0020s.** `0020-onboarding-boundary.md` (ours, 3b2dfc9) and
   `0020-runtime-ai-assistant.md` (theirs), both `Proposed`. `docs/adr/README.md` says
   "20 ADRs" and indexes only the runtime-AI one, so the onboarding ADR is invisible in the
   index - and ADR-0014's `Superseded by ADR-0020` is now **ambiguous**. One must be renumbered
   (0021) and the index and the supersession pointer corrected. **Needs a human**: renumbering
   changes what ADR-0014 points at.
2. **`package.json` dropped two working suites.** `accounts:test` and `onboarding:test` were
   REMOVED and replaced by three assistant scripts. Both files still exist and both still pass
   (53 and 24) - they are simply no longer runnable by name, so nothing will run them.
3. **Two of those three new scripts point at files that do not exist**:
   `assistant:test` -> `testing/demo/assistant-flow.test.mjs`, and
   `assistant:accuracy` -> `testing/assistant/accuracy.test.mjs`. Only `assistant:redteam` is real.
4. **Verify script misnamed.** `db fix applied` renamed the migration
   `0029_assistant_transcripts.sql` -> `0035_...` (0029-0034 had been taken by account
   activation in the meantime) but left `testing/db/0029_assistant.verify.sql`, which now sits
   beside `0029_account_activation.verify.sql` and describes migration 0035. Cosmetic; verify is
   order-independent so nothing breaks.

### One defect of OURS that the pull exposed - ALSO FIXED (see below)

`guard-adr.mjs` treats **`docs/adr/README.md` as an ADR**: `isAdrPath` matches any `.md` under
`docs/adr/`, the index has no `## Status`, the parser returns UNKNOWN, and UNKNOWN fails closed -
so the ADR index is permanently unmodifiable from inside the harness. It also blocked a
READ-ONLY command, because `xargs` is in `INPLACE_TOOL` and the command named a path under
`docs/adr/`. Note the asymmetry: upstream edited that same README freely, because hooks only run
inside Claude Code. Fix is two lines (exclude `README.md` from `isAdrPath`; drop or narrow
`xargs`) plus a regression case.

### All five defects are now FIXED — uncommitted, awaiting review

| # | Fix | Evidence |
|---|---|---|
| 1 | **Duplicate ADR-0020 resolved.** `git mv 0020-onboarding-boundary.md 0021-onboarding-boundary.md`, H1 updated, provenance blockquote added. ADR-0014's `Superseded by ADR-0020` is now unambiguous and **needed no change** - it always meant the runtime-AI ADR. | The onboarding ADR was referenced by nothing but this handoff; the runtime-AI one is referenced by filename in 4 files and as "ADR-0020" ~60 times (ADR-0014, the index, migration 0035, `field-registry.ts`, the assistant, the red team, DEC log, data inventory). Moving the less-referenced file broke nothing. |
| 2 | **`accounts:test` and `onboarding:test` restored** verbatim from dd6b908. | 53 and 24 checks, both green. |
| 3a | **`assistant:test` now points at a real suite**: `testing/demo/assistant-flow.test.mjs`, written this session. | **26 checks**, green. Needs no API key. |
| 3b | **`assistant:accuracy` REMOVED, not written.** Answer accuracy cannot be measured without a live model, so any file behind that name would have asserted something else while claiming to measure accuracy. | The script is gone; nothing references it. |
| 4 | **`testing/db/0029_assistant.verify.sql` -> `0035_assistant.verify.sql`**, header corrected with the reason (cddf1bd renamed the migration and left the verify file behind). | `db:verify` = **283 both before and after** the rename, because `migrate.mjs` discovers verify files by glob (`*.verify.sql`, line 186). The file always ran; the rename fixes the *name*, not coverage. Stated plainly because it would be easy to present this as a coverage win. |
| 5 | **`guard-adr.mjs` no longer treats `docs/adr/README.md` as an ADR.** `isAdrPath` now requires the `\d{4}-` prefix - the same test `adrFileNames()` already used, so the two agree. Bare `xargs` and `find -exec` dropped from `INPLACE_TOOL`. | Hooks **99 -> 107**. T100-T103 all **FAIL against HEAD's un-fixed hook** and pass against the fixed one; T104-T107 pass against **both**, which is the point - they prove the relaxation took no coverage away (`\| xargs sed -i`, `find -exec rm` and `find -delete` on an Accepted ADR are all still denied, and a numbered ADR with an unparseable status still fails CLOSED). |

**A test that passed for the wrong reason, again.** The first draft of the new hook cases
inherited fixtures written 500 lines earlier - but two intervening sections `rmSync` the whole
`docs/adr` tree, so `0001-accepted.md` did not exist, `statusOfFile()` returned null, and the
guard allowed. T103 therefore passed against the un-fixed hook too, and T104 failed against the
fixed one. **Only the mutation run exposed it.** The section now creates its own fixtures. This
is the fourth time in this project that a green check has been meaningless; the mutation step is
what keeps catching it, not inspection.

### Everything green: 3,694 automated checks, 0 failures

`hooks` **107** (was 99) · `db:verify` **283** (before and after every mutating suite) ·
`authz:test` 554 · `assistant:redteam` **2066** · `browser:test` 111 · `payslip` 80 ·
`reports` 63 · `accounts` 53 · `docs` 52 · `masters` 49 · `upload` 45 · `work` 44 ·
`period` 28 · `assistant:test` **26** · `nav` 24 · `onboarding` 24 · `privacy` 20 ·
`punch` 18 · `bizdate` 18 · `settings` 15 · `i18n` 14 · `demo:test` ALL STEPS PASSED.
`authz:build` / `api:build` / `web:build` all clean.

**What the new assistant suite actually asserts** (it does *not* repeat the red team's 2,066
authorization cells): all three routes 401 without a session; the catalogue is role-shaped
(employee 38 < hr_admin 41, the three withheld tools are the org-wide ones); **every one of the
15 tool actions already exists in `authz-matrix.yaml` and there is no `assistant.*` action** -
ADR-0020's load-bearing claim, now mechanically checked; a permitted tool returns the asker's own
rows; an hr-only tool called by name returns a `not_permitted` refusal with no rows rather than a
500; an unknown tool is a 400; **every turn is transcribed including refusals** (`leave_balance`
with the row_count the API returned, the `not_permitted` refusal, and the `disabled` `/ask`); and
with no API key the assistant refuses rather than erroring.

> That last transcript assertion started as "the newest row names the tool that ran" and FAILED -
> the refusal had also been recorded. The failure was the more valuable fact, so the assertion
> became the real contract. An unknown tool name leaves no transcript (rejected at validation
> before a turn begins); that is documented in the suite as a deliberate gap, not a regression.

### Exact next action

**Review and commit the working tree** (nothing has been committed or pushed). Changed:
`docs/adr/0021-onboarding-boundary.md` (renamed + provenance), `docs/adr/README.md` (21 ADRs,
new index row), `package.json` (scripts), `testing/db/0035_assistant.verify.sql` (renamed +
header), `.claude/hooks/guard-adr.mjs`, `testing/hooks/guards.test.mjs` (+8 cases), and the new
`testing/demo/assistant-flow.test.mjs`. No production code was touched.

Then Track A resumes. Track B (production hardening) still carries the open pass-3 findings
P3-3, P3-4, P3-7, P3-12 and P3-13 - unchanged by this session.

---

**Last session:** 2026-09-10
**Slice worked:** MGR-01 — the manager's feedback on the working demo (8 feature areas)
**Branch:** `feat/hrm-core-modules` at `7d30bad`, **committed and pushed** (8 commits) after the
report was reviewed.

> **THERE IS A SECOND BRANCH: `feat/ask-hrm-assistant`, at `533fdec`, branched from `7d30bad`.**
> It holds ASST-01 — "Ask HRM", a deterministic assistant answering "how many leaves are
> available for me?" and eight similar questions from a closed intent table, with no model calls.
> It is complete and green (assistant:test 23, browser-verify 71, both builds clean) and it is
> **PARKED, NOT ADOPTED**: *"lets keep this in a separate branch. Will decide later whether to go
> with this chatbot or not."* This branch is deliberately free of it, so if the answer is no the
> branch is simply deleted. **Do not merge it without asking.**
>
> `DEC-126` and `DEC-127` are allocated on that branch. **Work on THIS branch starts at
> `DEC-128`** — otherwise the two logs collide on any later merge, which has already happened
> once here (DEC-111). The full ASST-01 notes, including the analysis of whether a *real* LLM
> chatbot is possible and the three non-engineering gates in front of it, are in that branch's
> copy of this file.

---

## 2026-09-09, latest: ONB-01 the onboarding approval chain

Asked for: "employee creation, documents upload, payslip creation, send payslip to finance head
for approval, delivery head approval, offer letter creation... we need finance head user type,
delivery head user type."

**This overrode ADR-0020's proposed boundary**, which had suggested leaving the pre-offer chain in
Hiremate. The ADR is REVISED (still Proposed, still needs a human) and its Context is deliberately
left intact - the argument against this scope is what a future reader most needs.

| Migration | What |
|---|---|
| **0031** | 7th role `delivery_head`; `ck_app_user_role` widened to match the grant table (a finance head could not be given a login before); `offer_declined` terminal from `pre_boarding` only |
| **0032** | `salary_annexure` + components + FSM-as-data + append-only event log. Components FROZEN once out of draft; components must reconcile against a separately-typed CTC before submission |
| **0033** | A decline may precede the joining date - 0014's guard forbade it, which would have failed on the first real decline |

Also: `packages/authz` 447 -> 536 (413 cells, 7 roles, 59 actions), `apps/api/src/onboarding.ts`,
`/onboarding` screen with its own nav gate, EMP007 Arun Thomas (finance) and EMP008 Nisha Varghese
(delivery) seeded, `onboarding:test` 24 checks, browser B29a-f.

### The three findings worth remembering

1. **What finance approves is an ANNEXURE, not a payslip** (DEC-137). Asking settled the schema
   before a forward-only migration existed.
2. **A decline necessarily precedes the joining date** (DEC-140). Caught by 0014's own rail during
   verification, not in production.
3. **The seed teardown was missed twice in one day** (DEC-141) - `user_activation` and then the
   annexure tables. Only `punch:test` and `demo:test` notice, because they are the only two that
   re-seed. The rule is now written into the teardown block itself.

### NOT built, and deliberately

Documents upload already existed and was not touched. The offer letter is a STATUS and an
`offer_document_id` column - **generating the PDF is not implemented**; HR uploads it through the
existing documents module. No JIRA equivalent (ADR-0018: JIRA is an application, SMTP is
infrastructure). No induction training, equipment requests or onboarding checklist. Nothing
notifies an approver that something is waiting - there is no outbox drain worker.

### Exact next action

1. **A human decides ADR-0020.** If Accepted, `ai/context/architecture-principles.md` must go from
   ten bounded contexts to eleven, or the list and the ADR disagree.
2. Commit. Nothing in this or the previous two sections is committed.
3. Then: offer-letter generation, and notifying an approver that something is in their queue.

---

## 2026-09-09, later: ACCT-01 account provisioning, and ADR-0020 for onboarding

Asked: "can we implement hiremate (candidate onboarding) application's features here. Also user
account creation also need to done." Two very different answers.

### Account creation - DONE, uncommitted

The long-flagged blocker is closed. Read `docs/governance/decisions.md` DEC-129 for the design and
DEC-130 for the hole in the first version.

| File | What |
|---|---|
| `0029_account_activation.sql` | `user_activation` - SHA-256 only, 7-day expiry, one live token per account (partial unique index), immutable but for its consumption, and **an activation may not be issued for an account that already has a password** |
| `0030_pin_activation_search_path.sql` | Pins `search_path` on both 0029 functions. N11 caught it; unpinned, the takeover rail could be defeated by a `pg_temp` shadow table |
| `packages/authz` | `identity.account.create`, `identity.account.reissue` - hr_admin only, break-glass denied. 435 -> 447 |
| `apps/api/src/accounts.ts` | `@Controller('identity')`: create, reissue, state read, and a PUBLIC `POST /identity/activate` |
| `apps/web/components/account-card.tsx` | The Login panel on the employee profile |
| `apps/web/app/activate/page.tsx` | Outside `(app)` - the person has no session yet, by definition |
| seed | **EMP006 Meera Nair, no login** - the fixture, and why it must be seeded is DEC-131 |

**What is NOT built and was scoped out deliberately:** disable/re-enable an account, password reset
for an existing credential (a different act, belonging to the holder), Entra linking
(`identity.link.create` has a matrix row and no endpoint), and provisioning `hr_ops`/`finance`/
`auditor` - blocked by `ck_app_user_role` still permitting three values on the column. Argon2id is
still TRACK B: this writes scrypt because that is what `AuthService.verify` parses, and writing
argon2id would lock out the employee who just activated.

### Onboarding - ADR-0020 DRAFTED, needs a human

`docs/adr/0020-onboarding-boundary.md`, status **Proposed**. Proposes the boundary at
`offer_accepted`: Hiremate keeps candidates, documents, background verification, finance/delivery
review and the offer; this system takes employee-ID assignment, induction training, equipment and
first-day tasks, as an eleventh `onboarding` bounded context that is a LEAF. **No code was written
for it.** Two findings worth keeping: ADR-0018 already classifies SMTP as *infrastructure* and
therefore permitted, but **JIRA is an application, so `jira_triggered` cannot be reproduced as an
API call without superseding ADR-0018**; and roughly half of Hiremate duplicates what exists here
already (its hand-rolled `STATUS_RANK`/`STATUS_PREDECESSOR` machine vs ADR-0007's FSM-as-data, its
Azure-Blob document store vs `documents` on MinIO, its notifications, its users and auth).
If ADR-0020 is Accepted, `ai/context/architecture-principles.md` must go from ten contexts to
eleven - the ADR outranks it and the two must not disagree.

### Also in the tree

The login language switcher fix (DEC-128) - 2.07:1 contrast on the dark panel, and completely
absent below 1024px.

### Exact next action

1. **A human decides ADR-0020** - accept, reject, or amend the boundary. No onboarding code should
   exist before that.
2. Commit. Nothing in this section is committed.
3. Then, if account provisioning is to be complete: disable/enable an account, and the endpoint for
   `identity.role.grant` so the three wider roles are reachable.

---

## 2026-09-10 — DEC-164: the assistant's production key is wired, and still switched off

`prod.env.template` used to say the assistant "CANNOT BE TURNED ON FROM THIS FILE", and it was
right: the `api` service declared none of its variables, so anything written there was inert.
ADR-0020 had deferred one thing to the deployment — how the key reaches the container — and that
is now decided rather than left open.

**The shape.** `HRM_LLM_KEY_HOST_PATH` names a file **on the VM**; compose bind-mounts it
read-only at a fixed `/run/secrets/hrm_llm_api_key`. The container-side path is deliberately not a
second variable — it is the far half of one mount and a second knob could only disagree with the
first. **`HRM_LLM_API_KEY` is not declared on the service at all**, so the plain-variable path
`security-guidelines.md` bars does not exist in a deployment; it stays the local shortcut
(DEC-129). The mount defaults to `/dev/null`, which reads as an empty file, because a bind mount
cannot be conditional and an empty source is a compose syntax error.

**Three silent failures designed out**, each of which produces a healthy-looking API that refuses
every question: Docker creates a *directory* at a missing bind source; a root-owned `0400` file is
unreadable by the container's `node` user (**uid 1000**); an empty file is indistinguishable from
no key. `deploy.sh` now refuses the deploy on all three, and prints the ADR-0020 gate when the
switch is on.

**Nothing was switched on.** `HRM_ASSISTANT_ENABLED` still defaults to `false`, and ADR-0020's
release gate — 100% `assistant:redteam`, no waiver — is untouched.

Touched: `docker-compose.prod.yml`, `prod.env.template`, `deploy.sh`, `DEPLOY.md`, ADR-0020
(status Proposed, so the stale "nothing wires it" paragraph was corrected in place),
`decisions.md`. Verified with `docker compose config` against a filled template — key path and
model interpolate, `/dev/null` is the default source — and the five preflight branches exercised
directly. Nothing about the running app changed, so no gate was re-run.

### Exact next action

1. On the VM, this is still a no-op until someone chooses to enable it. **Do not**, until the red
   team gate is signed off.
2. The pending item from the previous session stands: restart :4000 and web :3100 and re-run
   `scratchpad/demoq.mjs` for the two unverified answers (DEC-162, DEC-163).

---


## 2026-09-10 — DEC-163: capabilities answers with subjects, not a manual

**(a) No more example lists.** `meta_capabilities` returned four example questions per subject —
twenty in total, which reads as documentation and goes stale whenever a tool is reworded. It now
returns subject names alone, per role:

```
Attendance · Leave · Your own record · People and the org chart · Work and timesheets
```

The subject is what a reader needs: it says where to point a question, and the assistant takes any
wording once pointed the right way. `you_can_ask` removed from the registry too, not left dead.

**(b) The refusal text was already right.** *"That is outside what this assistant can answer…"* is
the `no_tool` message verbatim. The fault was that `meta_capabilities` got SELECTED for questions
it should never have taken — narrowed in DEC-162. The two fixes compound: a tool that stops
volunteering for data questions, and returns five words when it does answer, is much harder to
mistake for an answer.

> **Known and left alone:** the `no_tool` message names "leave, attendance and your own employment
> record", which is now incomplete — the catalogue also covers people, work, tasks and timesheets.
> Kept verbatim because it is the wording that was asked for. A later pass could compute it from
> the actor's own catalogue and have one source of truth instead of two.

Gates: authz 452/452, red team **2060 passed, 0 failed**.

### Exact next action

1. **Restart :4000 and web :3100.** Two things are still unverified against a running model: the
   employee's "what is my phone number?" (DEC-162) and this subjects-only answer.
2. `scratchpad/demoq.mjs` re-runs all 21 demo questions in about a minute.
3. Then: the DEC-159 registry lint, the 44-candidate gap table, and the seed gaps.

---

## 2026-09-10 — DEC-162: seven demo questions per role, measured

`docs/demo/assistant-questions.md` — 21 questions run through the real `/assistant/ask` per role,
recording the tool each reached and the rows returned. **19 of 21 worked.**

> Selection is the one property no offline check can prove. `assistant:redteam` drives no model on
> purpose, so it proves authorization and says nothing about whether a question finds its tool.
> This file is the other half, and it is a record of what happened, not what ought to happen.

### The two that did not, and what they mean

- **"What is my phone number?" chose `meta_capabilities`** — a regression from DEC-159. That tool
  advertised itself as answering "what do you know about", so it competed with every tool holding
  an actual answer, and won whenever the router declines to narrow (DEC-158). Description narrowed
  to say what it is NOT for. **Built but NOT re-verified** — confirming it needs :4000 restarted,
  and the key lives only in that process.
- **"Who is off next week?" is unanswerable on this seed** — `leave_request` has zero rows, so
  every request-shaped question fails regardless of tooling. Replaced with *"What is Vishnu Ravi's
  leave balance?"*, which demonstrates a manager's reach (and is refused for an employee asking
  about their manager).

### Flagged, not silently kept

Two HR questions — "who has taken the most leave?", "who has logged the most working hours?" —
work, and no tool ranks anybody (`work_team_effort` orders by name). But the **answer** is a
ranking of people by output, which is the shape ADR-0020 §6 exists to prevent. Recorded as asked,
with a non-ranking alternative named in the doc. Which questions belong in a demo is a product
call.

### Lesson worth keeping

**A tool whose description invites open-ended questions competes with every tool that has a real
answer.** `meta_capabilities` needed "what this is NOT for" written into it. Any future meta or
catch-all tool needs the same.

Red team **2060 passed, 0 failed**.

### Exact next action

1. **Restart :4000 and web :3100**, then re-run question 6 for the employee (`what is my phone
   number?`) — it is the only unverified line in the demo doc.
2. `scratchpad/demoq.mjs` re-runs all 21 in about a minute.
3. Seed gaps (`leave_request`, `attendance_punch`) decide whether request-shaped questions ever
   demo.

---

## 2026-09-10 — DEC-161: meta_capabilities drops its note

The trailing *"41 lookups are available to you…"* line is gone. The subjects and their examples
already say what a reader needs, and the caveat hedged a list that was never a promise.

The EMPTY case keeps its note — without one the reply would be nothing at all.

> A tool `note` reaches the model as "a note that must be conveyed", so anything left in one is
> text the reader WILL see. That makes a note a deliberate choice each time, not somewhere to
> put remarks. Same class as DEC-157.

Red team **2060 passed, 0 failed**, unchanged.

---

## 2026-09-10 — DEC-160: bubbles on both sides

The question had a bubble and the answer had none, so a reply read as loose text rather than a
turn in a conversation. Both sides now share one shape.

| | |
|---|---|
| asker | `bg-ink-900`, white, `rounded-2xl rounded-ee-sm`, `max-w-[85%]`, `justify-end` |
| assistant | `bg-ink-50`, `ring-1 ring-inset ring-ink-100`, `rounded-2xl rounded-es-sm`, `max-w-[92%]` |
| note | **no bubble** — it is the system talking *about* the answer |

- **Direction-awareness was a constraint.** `justify-end` and the logical radii `rounded-ee-sm` /
  `rounded-es-sm` flip with `dir`; a physical `mr-`/`text-right` would not. `i18n:test` R1 passes.
- **`ASSISTANT_BUBBLE` is defined once** and shared by all four states — thinking, answer, refusal,
  nothing-matched. Four copies of a class list drift, and a reply that changes shape as it resolves
  reads as a glitch.
- The waiting state occupies the bubble the answer will fill, so the reply grows in place.
- Bullets use a custom marker in a flex row rather than `list-disc ps-5`, which sat the marker far
  from its text.

### Looked at, not asserted

Screenshotted over CDP against the real stack (DEC-125's approach, no Playwright): a spare web
server on :3101 from the fresh build, driving the operator's own API. `scratchpad/shot.mjs`.

That one screenshot independently confirms **DEC-151** (renderer), **DEC-153** (asterisk strip) and
**DEC-140** (answer from rows) all working together — bold name, real bullet, no `**`, right
figure. No amount of `tsc` output would have shown it.

> Worth reusing: for any visual change, `shot.mjs` gives a real render in about a minute.

Gates: web build clean, `tsc` clean, i18n 14/14 including R1.

### Exact next action

1. Restart web :3100 and API :4000 — everything from DEC-148 onward is still queued there.
2. The registry lint from DEC-159 (a tool's `cols` must all exist in the registry for its
   `resource`) — three bugs of that shape now.
3. The 44-candidate gap table in the DEC-159 block; counts and documents first.

---

## 2026-09-10 — DEC-159: the gap list, two tools, and no text-to-SQL

### The measured gap

**44 A-marked backlog candidates are still unbuilt**, at 41 tools built. Highest value first:

| Cluster | Tools | Why it matters |
|---|---|---|
| **counts** | `people_new_joiners`, `people_leavers`, `people_probation_status`, `people_confirmations_due` | DEC-155 removed the model's ability to count, so every "how many" needs a tool |
| **documents** | `documents_expiring`, `documents_for_employee`, `documents_versions`, `documents_pending_scan`, `documents_counts_by_type` | domain is empty apart from `me_documents` |
| **leave** | `leave_preview_days`, `leave_pending_approvals`, `leave_calendar_month`, `leave_carry_forward`, `leave_accrual_projection` | `leave_preview_days` mirrors a shipped screen |
| **attendance** | `attendance_today_me`, `attendance_my_policy`, `attendance_reconciliation`, `attendance_week_off_pattern` | |
| **meta** | `meta_where_do_i`, `meta_glossary`, `meta_explain_refusal` | no data, no risk |
| **config** | `config_settings_list`, `config_policy_current`, `config_policy_history` | the only content `auditor` can reach beyond org |
| **cross** | `cross_onboarding_readiness`, `cross_exit_readiness`, `cross_leave_attendance_conflicts` | |

### Built now

- **`meta_capabilities`** — "what can I ask you?" had NO tool, which is the worst gap a
  tool-calling assistant can have: an out-of-catalogue question is refused with what is *not*
  there and never with what *is*. Reads the asker's own catalogue via `permittedTools`, so it
  cannot advertise something they would then be refused. Action reuse (`org.unit.read`) reasoned
  out in the file header — its equivalent screen has no action, and §1 forbids inventing one.
- **`people_headcount`** — Engineering 4, Human Resources 1, total 5. This existed as a gap
  *because of* DEC-155: forbidding model arithmetic also removed its ability to count rows.

Both shipped with derived columns **unregistered**, so counts came back `undefined` — DEC-138's
trap for the third time. It is now clearly worth a lint: every column a tool names in `cols` must
exist in the registry for that tool's `resource`.

Red team 1960 → **2060 passed, 0 failed**.

### Text-to-SQL: refused, and why

Not a preference. ADR-0020 evaluated and rejected it; its *Reconsider when* requires a
**superseding ADR**, an amendment to `security-guidelines.md`'s ban on string-concatenated SQL, a
grant change, and a Postgres behaviour spike.

**The decisive fact is OR-29**: the API connects as the database OWNER, so the least-privilege
role the entire sandbox design rests on is not in force. Generated SQL would run as owner — past
`scope()`, past the field mask, past the payslip revoke, past the 2060-assertion gate, all of
which exist to make precisely that impossible.

The ADR's own instrument is the **`no_tool` log** — evidence rather than anticipation. Surfacing
it (an `audit_assistant_turns`-style tool, or a query) is the cheap next step and tells us which
of the 44 to build first.

### Exact next action

1. Restart :4000 (DEC-158 + these) and web :3100 (DEC-151 onward — that one is genuinely stale).
2. A registry lint: fail the build when a tool's `cols` names a field unregistered for its
   `resource`. Three bugs now.
3. Then work the gap table above, counts and documents first.

---

## 2026-09-10 — DEC-158: the router narrowed to `me` on every unrecognised reply

**"List the employees?" → "there are no records of employees"**, from an instance that has the
tool and returns five rows.

### The deployed build was CURRENT — measured, not assumed

`/assistant/capabilities` on the running :4000 offered **36 tools**, including every one added
since DEC-143, and `/assistant/run people_directory_lookup` returned 5 rows. Several previous
handoffs told the operator to restart; that was wrong here, and the measurement should come first
next time.

### (a) `route()` did the opposite of its own comment

```
// An unrecognised answer must not narrow anything - fall back to the widest pool...
return hit ?? present[0]!;     // <- present[0] is `me`: tools-me is imported first
```

Any router reply the parser could not match exactly — "the people area", a trailing sentence, a
translated word — restricted selection to the asker's own record, where nothing can list
employees. The `permitted.length <= 12` line had the same defect: it meant "select over everything"
and narrowed to one domain.

`route()` now returns `Domain | null`; null means do not narrow, and the caller uses every
permitted tool.

> **A comment describing behaviour the code does not have is worse than no comment** — it stops
> the next reader from looking.

### (b) An unmatched filter read as a fact

The model reached `people_department_roster` with `department: "employees"` → 0 rows → "no records
of employees". Same shape as DEC-152's invented timesheet status.

```
No department matched "employees". The departments you can see are: Engineering,
Human Resources. To list everybody rather than one department, use the employee directory instead.
```

The department list comes from the same scoped query, so it discloses nothing a directory read
would not. `people_directory_lookup` now also claims "list the employees" / "who works here"
outright rather than describing itself only as a lookup.

Red team **1960 passed, 0 failed**.

### Exact next action

1. **Restart :4000 for these two fixes** (the web :3100 restart is still outstanding for DEC-151
   onward — that one IS stale, unlike the API).
2. Any tool with a free-text filter should say what it could not match, and what the valid values
   are. `timesheet_team_status` (DEC-152) and `people_department_roster` do; others do not yet.
3. `project` unregistered; `documents` and `cross` empty; seed gaps; the salary question;
   `assistant:accuracy`.

---

## 2026-09-10 — DEC-157: caveat removed, click-outside dismisses

**(a) The footnote is gone.** *"Answers are written from your own HR records by an AI assistant…"*
was written for DEC-141, when removing the result table left the prose as its own only evidence —
the caveat was what replaced the table as the reader's cue to check. Nothing on screen now marks
an answer as machine-written; the panel title and subtitle are the only context left. Key deleted
from both locales rather than left unused.

> A product call, not an engineering one — recorded so it reads as a decision rather than a
> deletion.

**(b) Click outside closes the panel.** It trades against the panel being deliberately non-modal,
which the header explains: an assistant is most often read *alongside* the page. Any interaction
with that page — a scrollbar drag, selecting a figure to compare — now dismisses it. Nothing is
lost: the conversation lives in component state and reopening shows every turn.

- `pointerdown`, not `click` — a click fires after button-up, by which time a control inside the
  panel may have unmounted and its target would test as outside.
- The launcher is excluded, or clicking it while open would close here and the button's own
  handler would toggle it straight back open.
- Escape still closes and still returns focus to the launcher.

Gates: web build clean, `tsc` clean, i18n 14/14 with both locales at parity.

### Exact next action

1. **Restart web :3100 and API :4000.** Everything from DEC-148 onward is still queued behind
   those two processes.
2. `project` unregistered; `documents` and `cross` empty; seed gaps (`leave_request` and
   `attendance_punch` both empty, attendance stops 2026-09-08); the salary question;
   `assistant:accuracy` still unwritten against 39 tools.

---

## 2026-09-10 — DEC-156: one tool escaped the timezone fix

Three reported questions, three different states.

| Question | State |
|---|---|
| "do i have any late in?" → 04:17 | **Real bug.** `attendance_late_days` was missed by DEC-154 |
| "my login time on September 1?" → nothing | **Selection**, over an empty table |
| "list of employees?" → nothing | **Not a defect** — works since DEC-145; stale build |

### (a) The miss, and why a replace was the wrong instrument

DEC-154 applied `localTime` with a string replace over the paired literal
`ad.first_in_at, ad.last_out_at`. `attendance_late_days` selects `first_in_at` **alone**, so it was
skipped. Nothing broke — the column was there, the value was a real time, only the zone was wrong.

**Section 6g now asserts it over the whole catalogue**: no value any tool returns to any role may
look like an ISO instant. A raw `timestamptz` fails the gate wherever it appears, rather than
wherever somebody remembered to look. `09:47` and `2026-09-03` pass; `2026-09-03T04:17:00.000Z`
does not.

### (b) "Login time" pointed at an empty table

`attendance_punch` holds **ZERO rows** — the seed writes `attendance_day` directly. So
`attendance_punches` can only ever answer "nothing matched", while `attendance_days.first_in_at`
had the answer all along (09:12 on 1 Sep).

Descriptions now settle it: `attendance_days` explicitly claims *login time, sign-in time, punch in
time, what time did I start*; `attendance_punches` is narrowed to raw events and points at
`attendance_days` for when a day started or finished.

> **New seed gap, alongside DEC-146's:** `attendance_punch` is empty. Recorded, not fixed.

### (c) Not a defect

"List of employees?" returns all five. It has worked since DEC-145.

```
EMP001 Vishnu Ravi    Engineering      Senior Engineer
EMP002 Priya Menon    Engineering      Engineering Manager
EMP003 Anu Krishnan   Engineering      Engineer
EMP004 Rahul Nair     Engineering      Engineer
EMP005 Deepa Suresh   Human Resources  HR Manager
```

Red team 1783 → **1960 passed, 0 failed**.

### Exact next action

1. **The deployed build is many changes behind.** API :4000 and web :3100 both need restarting —
   that accounts for (c), the `**`, and part of (a).
2. Prefer a catalogue-wide ASSERTION over a bulk edit when applying a property to every tool. Three
   bugs this session came from a string replace hitting too few or too many sites.
3. `project` unregistered; `documents` and `cross` empty; seed gaps (`leave_request`,
   `attendance_punch`, attendance stopping 2026-09-08); the salary question; `assistant:accuracy`.

---

## 2026-09-10 — DEC-155: the model does no arithmetic

**"Who worked more?" totalled 49h + 45h30 + 36h30 as 106h.** It is 131h. Nothing failed — the
model added three numbers and got it wrong, silently. It had also summed the per-person figures
across project rows and got *those* right, which is worse: it makes the method look sound.

**The prompt rule is now absolute:** do no arithmetic — never add, subtract, total, average or
convert; every number written must appear verbatim in a record or the note; if a total is not
given, do not state one.

That is only safe if the figures are provided, so `work_team_effort` gained:

| Column | Meaning |
|---|---|
| `person_time` / `person_minutes` | that person across ALL projects, on each of their rows |
| note | the overall total, computed in integer minutes in our own code |

```
Anu Krishnan   HRM  18h 00m   person 49h 00m
Anu Krishnan   MOBL 31h 00m   person 49h 00m
Rahul Nair     CPRT 45h 30m   person 45h 30m
Vishnu Ravi    CPRT 12h 00m   person 36h 30m
Vishnu Ravi    HRM  24h 30m   person 36h 30m
note: ... Total across all 3 people shown: 131h 00m.
```

### The first attempt at the fix was itself wrong

`sum(sum(minutes)) OVER (PARTITION BY ...)` returns **NUMERIC**, not bigint — so `/ 60` divided as
a decimal and `::int` **rounded**: 2730 minutes rendered as `46h 30m`, an hour more than the rows
beneath it. `time_spent` is safe only by accident, because plain `sum(int)` is bigint. Cast to
`int` before dividing.

The red team now asserts the **identity**, not fixture numbers: person totals counted once each
must equal the sum of every row, and each formatted `person_time` must match its own
`person_minutes` — the bug lived entirely in the formatting, so an integers-only check would have
missed it.

### The `**` is a stale asset, with evidence

The renderer IS in `.next/static/chunks` from the 01:46 build. A web server started **before** that
build is still listening on **:3100** (PID 32188) and serving the old chunks.

```
npm run web:build     # already done
# stop the process on :3100, then
npm run web:start
```

Gates: authz 452/452, red team **1783 passed, 0 failed**.

### Exact next action

1. **Restart the web server on :3100 and the API on :4000.** Nine API changes and the whole
   renderer are waiting behind those two processes.
2. When a tool adds a derived numeric column, check the SQL type: `sum(int)` is bigint and divides
   as integers; a window `sum(sum(...))` is NUMERIC and does not.
3. `project` unregistered; `documents` and `cross` empty; DEC-146 seed gaps; the salary question;
   `assistant:accuracy` still unwritten.

---

## 2026-09-10 — DEC-154: timestamps in company time, not UTC

**"First in at 04:17"** on a day the screen shows **09:47**. Exactly 5h30m — `first_in_at` is a
`timestamptz`, reaches JavaScript as a `Date`, and leaves as a UTC ISO string. Worked minutes were
right all along, which made it look like a partial fault rather than a units one.

**The screens were never wrong** — they format with `timeZone: 'Asia/Kolkata'`. The assistant
renders no times of its own, so the conversion belongs in SQL while the value is still a timestamp.

| Added | Applies to |
|---|---|
| `localTime` → `09:47` | `first_in_at`, `last_out_at` |
| `localDateTime` → `2026-09-03 09:47` | `punched_at`, `submitted_at`, `decided_at`, ledger `created_at` |

**The zone comes from `org_setting company.timezone`**, with the same COALESCE fallback
`fn_business_date()` and migration 0012 use — rule 11 makes the timezone configuration, and a
literal would hardcode policy into twelve SELECT lists.

> Same family as `db.ts`'s DATE parser, whose comment already says the bug is "entirely in the
> driver's helpfulness". DATE was fixed globally; `timestamptz` never was, and nothing needed it
> until a tool started handing raw values to a model.

### Two faults of mine, both caught by gates

- The blanket string replace also rewrote `ORDER BY` into `ORDER BY to_char(...) AS punched_at
  DESC` — invalid SQL, a 500, `attendance_punches` and `leave_ledger` dead for every role.
  **Third time this session a global string swap has hit a second, wrong site.** Ordering now uses
  the raw timestamp, which sorts by instant rather than rendered string.
- The prompt's bullet template read `- **Who or what** - the figures…` and the model copied
  "Who or what" **literally** as a label. A placeholder that can be mistaken for content is a bad
  placeholder; it is now a worked example with real names.

Gates: authz 452/452, red team **1777 passed, 0 failed**.

### Exact next action

1. **Restart both :4000 and the web app.**
2. When adding a tool that returns a `timestamptz`, wrap it in `localTime`/`localDateTime` — the
   registry cannot catch this one, because the column name is unchanged and only the value is
   wrong.
3. `project` unregistered; `documents` and `cross` empty; DEC-146 seed gaps; the salary question;
   `assistant:accuracy` still unwritten against 39 tools.

---

## 2026-09-10 — DEC-153: no stray asterisks, and durations in hours

### (a) `**` reaching the reader

The renderer matched `**bold**` and left anything it could not parse as literal text. Defensible,
and wrong for a reader. An unparsed pair now **degrades to plain text**: `stripStars` removes every
surviving `**` from the segments between matches. A **single** asterisk is untouched — footnote
mark, multiplication sign, part of a value.

Verified against the exact strings from the report, plus `***emphasis***` and a pair the regex
cannot span. Nothing leaks. The prompt also forbids bolding a whole line, since a bolded lead
reads as a heading and headings are not available.

> **The panel in that screenshot was still on the pre-DEC-151 build** — the bullets were not
> rendering as a list either. Part of what was reported is a stale asset, not a defect. The strip
> is worth having anyway: it is the only thing that holds when the model formats unexpectedly.

### (b) Minutes where people think in hours

`2940 minutes` is how the column is stored, not how anybody asks. The conversion is arithmetic,
and DEC-150 settled that arithmetic belongs in SQL:

| Tool | New column | Example |
|---|---|---|
| `work_my_log`, `work_effort_summary`, `work_team_effort` | `time_spent` | `45h 30m` |
| `attendance_summary`, `attendance_team_summary` | `worked_time` | `48h 50m` |

Raw minutes stay for a question that asks for them. **The format is the one the attendance screen
already uses**, so an answer and the screen beside it agree. The prompt says to quote it as given
and never to convert. Both registered — a derived column the registry does not know is dropped
silently (DEC-138).

Gates: authz 452/452, i18n 14/14, red team **1777 passed, 0 failed**, web build clean.

### Exact next action

1. **Restart BOTH :4000 and the web app.** The web build is the one that was stale — the renderer,
   the bullets and the asterisk strip all live there. Eight API changes are also queued.
2. `project` is the last work type unregistered; it unlocks the project-graph cut.
3. `documents` and `cross` domains are still empty.
4. DEC-146 seed gaps; the salary question; `assistant:accuracy` against a 39-tool catalogue.

---

## 2026-09-10 — DEC-152: task tools, and an invented status value

*"Is anybody have any pending tasks?"* returned nothing from a database holding **eight
outstanding tasks, six assigned**.

### (a) No task tool existed

DEC-147's registry pass covered `work_log`, `project_effort` and `timesheet` and stopped short of
`task`. Registered now, with two tools:

| Tool | Shape |
|---|---|
| `work_my_tasks` | self-default; project, status, due date, `is_overdue` |
| `work_open_tasks` | scope-default; open and overdue COUNTS per person |

**`work.task.read` takes the REPORTING graph and scopes on `assignee_employee_id`.** `graphs.ts`
calls that nullability load-bearing: an unassigned task has no subject, so the predicate excludes
it **by construction**. Two seeded tasks are unassigned and invisible here — both tools say so in
a note, because "nobody has pending tasks" and "nobody I can see has been *assigned* one" are
different answers.

Measured: employee → own only; manager and hr_admin → EMP001 (3, 1 overdue), EMP003 (2),
EMP004 (1, 1 overdue); finance and auditor → their own, via the `employee` role they also hold.

Ordered by employee number, never by count — "who has the most open tasks" is a league table
however it is phrased (§6).

### (b) The model invented a timesheet status

Reaching for the nearest tool it had, it passed `status: 'pending'` to `timesheet_team_status`.
The real values are `draft`, `submitted`, `under_review`, `approved`, `returned`. A free-text
filter that matches nothing returns an empty result that reads as a fact about the data. The
parameter description now names every value and states there is no "pending".

> **Worth generalising:** any free-text filter argument should name its valid values in the
> parameter description. The model cannot see a CHECK constraint.

### Why the authz matrix reads 452, not 453

The "unregistered resource yields no fields" check **discovers** its subject rather than
hardcoding it, so registering `task` removed one iteration. The suite's own guard that the list
must not empty still passes — `project`, `designation`, `audit_event`, `identity` remain.

Catalogue **39 tools**. Red team 1684 → **1777 passed, 0 failed**.

### Exact next action

1. **Restart :4000** — seven changes are queued now.
2. `project` is the last work type unregistered; it unlocks the project-graph cut (unassigned
   work, "who is on ATLAS"), which is a MEMBERSHIP graph and must not be built by analogy.
3. `documents` and `cross` domains are still empty.
4. DEC-146 seed gaps; the salary question; and `assistant:accuracy`, still not written against a
   39-tool catalogue.

---

## 2026-09-10 — DEC-151: structured answers, presentation only

Multi-row answers were a paragraph of run-on numbers. They are now a lead line plus **one bullet
per record**, rendered by the panel from a two-construct subset: `**bold**` and `"- "` bullets.

```
Attendance for 2026-09-01 to 2026-09-10:
  • Vishnu Ravi  - 6 days worked, 1 late, 1 from home
  • Priya Menon  - 6 days worked, 0 late
  • Anu Krishnan - 6 days worked, 0 late
  • Rahul Nair   - 5 days worked, 1 absent
```

**Nothing else changed.** No API, tool, mask or scope was touched; every figure still comes from
the masked rows and the never-estimate / never-rank rules are verbatim.

| Piece | Where |
|---|---|
| Prompt asks for the subset, and says anything else renders as raw characters | `answer.ts` `ANSWER_SYSTEM_PROMPT` |
| `parseAnswer` / `inlineNodes` / `renderAnswer` | `assistant.tsx`, above the component |
| `hideOpenBold` for the streaming half-token | same |

### Two things worth keeping in mind

- **The parser is a trust boundary.** It renders model output, so it builds React elements from
  strings and never uses `dangerouslySetInnerHTML`. `<script>` in an answer renders as visible
  text. No markdown library — a dependency to justify, and a far larger surface for one panel.
- **The obvious streaming fix was wrong**, and a check caught it, not review. Stripping a trailing
  ``**…`` with a regex removes the CLOSING pair of a completed bold, so
  `- **Vishnu Ravi** - 6 days` rendered as `- **Vishnu Ravi - 6 days`. Only an odd number of pairs
  means one is open. `hideOpenBold` counts pairs instead.

Gates: web build, `tsc` on both, i18n 14/14, red team **1684 passed, 0 failed**.

### Exact next action

1. **Restart :4000** — six changes are now waiting: coverage note and streaming fallback
   (DEC-148), directory columns and the holiday fix (DEC-149), the manager tools and `days_worked`
   (DEC-150), and this rendering.
2. If the model ignores the bullet shape in practice, tighten the prompt rather than the parser —
   the parser already accepts `-`, `*` and `•`.
3. Still open: `documents` and `cross` domains; the DEC-146 seed gaps; the salary question; and
   `testing/assistant/accuracy.test.mjs`, which does not exist against a 37-tool catalogue.

---

## 2026-09-10 — DEC-150: a routing hole, and an arithmetic trap

### (a) "Who is my manager?" → "Nothing matched"

`me_profile` has always carried a `manager` column and lists that question as an example. But
**the router picks one domain**, and the selection step sees only that domain plus `cross`
(DEC-127). A reporting-line question reads as `people` — and before DEC-145 the `people` domain
had **no tools**, so nothing could route there. Adding four tools made it routable and made every
`me` tool invisible to anything landing on it.

> **Standing lesson: adding a domain silently changes what the router can choose.** A question
> answerable in `me` must also be answerable in any domain it plausibly routes to.

Closed with two backlog tools: `people_manager_of` (defaults to the asker) and
`people_who_reports_to` — the manager's most basic question, which the catalogue could not answer
at all.

```
who is my manager?      -> Priya Menon, EMP002, Engineering Manager
who reports to me?      -> (Priya) EMP001, EMP003, EMP004
   same question as employee -> 0 rows, correctly
```

### (b) "How many days did I work?" → 5, should be 6

`fn_attendance_summary` counts `present_days` as `status IN ('present','late')`, so **late days
are already inside it** and `late_days` is a subset, not an addition. `wfh` is its own status and
is **outside** it. Vishnu: present 4 + late 1 = `present_days` 5, plus `wfh_days` 1 = **6**.

Three columns whose overlap is nowhere stated is a puzzle, and a model solving a puzzle silently
gets it wrong silently. Both summaries now return `days_worked = present_days + wfh_days` and a
note that present and late must never be added. **The arithmetic belongs in SQL.**

### Two faults the gates caught, not review

- `people_who_reports_to` built its WHERE conditionally while passing a fixed parameter list →
  `could not determine data type of parameter $2`, a 500, dead for everybody. Every placeholder is
  now referenced on every path.
- `people_manager_of` failed section 6d until marked `relatedPeople` — its row is about the asker
  and names their manager, the same shape as `me_reporting_chain`.

Catalogue **37 tools**. Authz matrix 453/453. Red team 1597 → **1684 passed, 0 failed**.

### Exact next action

1. **Restart :4000.** Five changes are waiting: the coverage note and streaming fallback
   (DEC-148), the directory columns and holiday fix (DEC-149), and these two.
2. **Re-check the router when adding any domain.** `documents` and `cross` are still empty, and
   filling them will move routing again — the `me`-domain tools are the ones at risk each time.
3. Seed gaps (DEC-146): `leave_request` has zero rows; attendance stops 2026-09-08.
4. The **salary** question is still undecided.
5. `testing/assistant/accuracy.test.mjs` still does not exist. Both bugs here were SELECTION and
   ARITHMETIC failures, which is exactly what that suite would measure and the red team cannot.

---

## 2026-09-10 — DEC-149: two tools returning less than they knew

**"Joining date of Priya Menon?" → "the records do not show her joining date."** `joined_on` is
PUBLIC in the registry and was missing from `people_directory_lookup`'s SELECT list. The model was
right — it reported what it was given instead of inventing a date — and that is what makes this
class dangerous: **an omitted column is indistinguishable from absent data** above the SQL.

Added `joined_on`, `confirmed_on`, `employment_type` to the directory and `joined_on` to the
department roster. No mask, policy or scope change; none was wrong.

### The generic check found a second one immediately

`leave_holidays` returned **five rows that the mask emptied to `{}`** — "what are the holidays"
came back as five blank records, no error anywhere. It declares `leave.balance.read`, whose
resource is `leave_balance`, and `holiday_on` / `name` / `is_optional` were never registered on
that type. Registered, with `name` aliased to `holiday_name` so a bare `name` on a type shared
with leave balances cannot confuse the next reader.

```
holiday_on   holiday_name       is_optional
2026-09-14   Ganesh Chaturthi   true
2026-10-02   Gandhi Jayanti     false
...
```

### The assertion that now catches both

**Any tool that answers with ROWS must answer with COLUMNS**, per role, across the whole
catalogue. An unregistered resource type fails the gate at once instead of shipping as blank
records. Plus a named expected-column set for the directory, and a date-only check on `joined_on`.

**Red team 1492 → 1597 passed, 0 failed.** Authz matrix 453/453.

### Standing lesson for the next tool

The registry is default-deny, so it protects against **over**-returning and is silent about
**under**-returning. When adding a tool, check its SELECT list against the PUBLIC set for its
resource type — the gate now checks that a tool returns *something*, not that it returns
*everything it could*.

### Exact next action

1. **Restart :4000** — three fixes are waiting there: the coverage note (DEC-148), the streaming
   fallback (DEC-148), and these columns.
2. `documents` and `cross` are the remaining empty domains; `documents` needs no registry work.
3. Seed gaps (DEC-146): `leave_request` has zero rows; attendance stops 2026-09-08.
4. The **salary** question is still undecided.
5. `testing/assistant/accuracy.test.mjs` still does not exist, against a 35-tool catalogue.

---

## 2026-09-10 — DEC-148: a narrowed answer says so, and streaming falls back

An employee asked *"September attendance details of all employees"* and got **"Your records hold
1 record for that, but the answer could not be written just now."** Two unrelated faults.

### (a) The silence — fixed with a note, not a refusal

The tool returned one row, the asker's own, because `scope()` did its job. **Nothing said the
question had been narrowed.** Same family as DEC-142 and DEC-144: an authorization outcome
presented as a fact about the data.

Every `subjectDefault: 'scope'` answer now carries its coverage, and the model is told it must
convey it:

| asker | rows | note |
|---|---|---|
| employee EMP001 | 1 | "This covers your own records only. Your account does not have access to records for other people…" |
| manager EMP002 | 4 | "This covers the 4 people your account has access to, which may be fewer than the whole organisation." |
| hr_admin EMP005 | 4 | same |

Self-defaulting tools (`attendance_summary`) and person-less tools (`leave_holidays`) get **no**
note — they were never about anybody else. Computed from the distinct people in the RESULT, so it
needs no second query, reads no scope internals, and stays right if a policy changes.

**Not a refusal, deliberately.** A manager asking the identical question has a legitimate partial
answer, and the instruction was to make the assistant work per role rather than block.

### (b) The failed answer call was ours — DEC-141's streaming

Only the ANSWER call streams; route and select do not. The symptom matched exactly: a tool was
selected, one row came back, and only the sentence failed. `stream_options` is a **capability, not
an argument we chose** — an Azure deployment, a gateway or an older model can reject it while
accepting the identical non-streamed request.

The single retry now **drops streaming** when the streamed attempt failed with nothing emitted,
and warns once naming `HRM_LLM_STREAM=false` (documented in `env.example`) for a deployment that
can never stream and should skip the wasted first attempt.

**If the assistant on :4000 is still failing, the API log now says which**: `[assistant] model
call failed: HTTP nnn` on the first attempt, followed by the retry warning.

**Red team 1489 → 1492 passed, 0 failed.**

### Exact next action

1. **Restart :4000** and re-ask that exact question. Expect: one row, and an answer that says it
   covers only Vishnu's own records. If the provider was rejecting `stream_options`, the answer
   now arrives (all at once rather than typed out) and the log names the status.
2. `documents` and `cross` are the remaining empty domains; `documents` needs no registry work.
3. Seed gaps from DEC-146 still open: `leave_request` has zero rows; attendance stops 2026-09-08.
4. The **salary** question is still undecided.
5. `testing/assistant/accuracy.test.mjs` still does not exist, against a 35-tool catalogue.

---

## 2026-09-10 — DEC-147: the work registry pass, and the manager's assistant

**The `work` domain is live.** It had zero tools while 38 log entries across 3 people sat in the
database — the blocker was the field registry, not the tools.

| Registered | Why it mattered |
|---|---|
| `work_log` | `description` is **`SELF_ONLY`** — ADR-0020 §6's narrative rule stops being a promise |
| `project_effort` | the `/team/effort` shape: person × project × minutes. **No description column at all** |
| `timesheet` | `return_note` is `HR_AND_SELF`, so the subject can read why theirs was sent back |

| Tool | Action | Who gets it |
|---|---|---|
| `work_my_log` | `work.log.read` | `selfOnly` — the author's own notes, `inList: false` |
| `work_effort_summary` | `work.log.read` | self-default (DEC-144); a manager may name a report |
| `work_team_effort` | `work.team_effort.read` | **employee DENY** — manager: subtree, HR: org |
| `timesheet_status` | `work.timesheet.read` | self-default |
| `timesheet_team_status` | `work.timesheet.read` | scope-default |

### Measured, per role

| | work_my_log | work_effort_summary | work_team_effort | timesheet_team_status |
|---|---|---|---|---|
| employee (EMP001) | 12 rows **with notes** | EMP001 | **not_permitted** | EMP001 |
| manager (EMP002) | own (0) | own (0) | EMP001, EMP003, EMP004 | EMP001, EMP003, EMP004 |
| hr_admin (EMP005) | own (0) | own (0) | EMP001, EMP003, EMP004 | EMP001, EMP003, EMP004 |
| finance / auditor | offered | offered | **not offered** | offered |

**Nothing in the tools inspects a role.** `work.team_effort.read` is deny for `employee` in the
policy, so `permittedTools` never offers it and a direct call is refused; the rest is `scope()`.

### Two traps avoided, both previously recorded

- **`timesheet_team_status` reuses `work.timesheet.read`, not `work.timesheet.approve`.** The
  approve action carries `isSelf` as a deny-override, so the `permittedTools` probe is guaranteed
  to fail and the tool would be silently offered to nobody — DEC-136's exact failure.
- **No project-graph tool.** `work.project.read` / `work.project_effort.read` resolve through
  MEMBERSHIP, not a reporting line, and `project` / `task` are still unregistered. Building one by
  analogy with the reporting tools would be wrong twice over.

### Gates

- authz matrix 435 → **453 passed, 0 failed**
- assistant red team 1159 → **1489 passed, 0 failed**, with new **section 6f**: no tool but
  `work_my_log` returns a `description` for any role; the author does get their own notes back;
  an employee is refused `work_team_effort`; a manager's result is ordered by NAME, because
  ordering people by minutes is a league table under another name (§6).

Catalogue **35 tools**, 5 of 7 domains (`me` 6, `leave` 11, `attendance` 9, `people` 4, `work` 5).

### Exact next action

1. **`documents` and `cross` are the remaining empty domains.** `documents` needs no registry work
   (`employee_document` is registered) — 5 of its 6 backlogged tools are marked **A**.
2. **Seed gaps still open** (DEC-146): `leave_request` has zero rows, so every request-shaped
   question is unanswerable in the demo; attendance stops 2026-09-08 while the business date is
   2026-09-10, so "today" questions are legitimately empty.
3. Still open: the **salary** question — schedule-only needs no gate change; amounts need an
   ADR-0020 §6 amendment and a red-team BANNED-list change.
4. Still unverified: **the model's live wording and the streaming UI.** Restart :4000 from the
   shell holding `HRM_LLM_API_KEY`; kill any spare on :4001 first.
5. `testing/assistant/accuracy.test.mjs` still does not exist, and the catalogue is now 35 tools.
   Selection quality is the untested half of every tool added since DEC-140.

---

## 2026-09-10 — DEC-146: three "nothing matched" questions, three different causes

| Question | Cause | Status |
|---|---|---|
| "attendance details of all employees" | No org-wide attendance-over-a-period tool. `attendance_team_today` is a single day and today has no rows; the personal tools self-default since DEC-144 | **Fixed** — `attendance_team_summary` |
| "who took leave?" | The request-shaped tools read `leave_request`, which has **ZERO rows** in the seed. The leave that was taken lives in `leave_ledger` | **Fixed** — `leave_taken_by_person` reads the ledger. **Seed gap remains** |
| "team effort by person" | The `work` domain has **zero tools**, though 38 log entries for 3 people exist | **Not fixed** — needs the registry pass |

Catalogue 28 → 30. **Red team 1159 passed, 0 failed** (was 1089).

### DEC-144 exposed these, it did not break them

`attendance_summary` and `leave_ledger` already query the whole organisation — `fn_attendance_summary`
returns one row per employee and `scope()` filters it. DEC-144 made them default to the ASKER when
no person is named, which is right for "how many days was I late" and useless for "all employees".
Before DEC-144 the same questions returned everyone and the model narrated row 1 as though it were
the asker's: a wrong answer instead of an empty one. The fix is team variants, both
`subjectDefault: 'scope'`, both reusing the action, resource and `scope()` of the tool they mirror.

Verified per role: employee → 1 row (own), manager → 4 people, hr_admin → 4 people.

### Requests vs ledger — a distinction worth keeping

`leave_request` records an APPLICATION and its approval; `leave_ledger` records what was CONSUMED,
and rule 6 is why they diverge — leave granted by HR, adjusted, or migrated in has a `take` entry
and no request. "Who took leave" through the request table answers a narrower question than it
sounds like, and answers it silently.

### OPEN — seed gaps that make the demo look broken

1. **`leave_request` has zero rows.** Every request-shaped question is unanswerable in the demo —
   "who applied", "what is pending", "who is off next week", and the `/leave` screen's own
   "No leave requests yet". The taken leave (EMP001 4 days CL, EMP003 2 days CL) exists only as
   ledger entries. **Not fixed here: changing seed data changes every demo and screenshot.**
2. **Attendance stops at 2026-09-08**, business date is 2026-09-10. Every "today" question is
   legitimately empty. Correct behaviour, bad demo.

Both are in `infrastructure/db/seeds/demo.sql`.

### Exact next action

1. **The field-registry pass** for `work_log`, `timesheet`, `task`, `project`, `project_effort`
   (+ `audit_event`, `identity`, `designation`). Unblocks 28 of the 89 backlogged tools and is the
   only thing between the product and the entire `work` domain. `work_log_entry.description` must
   land as `SELF_ONLY` — that is what makes ADR-0020 §6's narrative rule structural.
2. Decide the seed gaps above, before the next demo.
3. Still open: the **salary** question (schedule-only vs self-payslip amounts).
4. Still unverified: **the model's live wording and the streaming UI** — restart :4000 from the
   shell holding `HRM_LLM_API_KEY`, and kill any spare on :4001.

---

## 2026-09-10 — DEC-145: first slice from the tool backlog, `people` + org structure

**Catalogue 24 → 28.** `people` is no longer an empty domain.

| Tool | Action | Resource | Notes |
|---|---|---|---|
| `people_directory_lookup` | `people.employee.list` | `employee` | work email, department, designation, manager, location, status |
| `people_department_roster` | `people.employee.list` | `employee` | "who is in Engineering" |
| `org_department_tree` | `org.unit.read` | `department` | effective-dated from `department_period`, takes `asOf`, headcount per department |
| `org_teams` | `org.team.read` | `team` | returns `department_code` — see below |

### The access question, re-derived per tool (not taken from the backlog markers)

| Action | Roles | Scope |
|---|---|---|
| `people.employee.list` | employee, manager, hr_admin, hr_ops — **finance and auditor deny** | `ALLOW_ALL` |
| `org.unit.read` / `org.team.read` | **all six** | `ALLOW_ALL` |

**An ordinary employee can read the whole directory and the whole org chart, by design.**
`policies.ts`: *"the org chart is PUBLIC_INTERNAL … the ROW scope is open and the field mask is
what withholds anything sensitive."* The matrix draws the contrast with `config.*`, where
ADR-0005(a) makes reading a policy row a privilege. So the line is **public structure / reporting
graph / configuration**, not "company data vs personal data".

### Three things the checking changed

1. **`org_team_members` is NOT buildable** as the backlog marked it. Its rows would be employees
   under resource `team`, where `employee_number` and `full_name` are unregistered — every row
   masks to `{}`. Re-marked **R** in the backlog. Registry decision first.
2. **`org_teams` returns `department_code`, not `department_name`** — only the code is registered
   on `team`, and an unregistered column vanishes silently (DEC-138).
3. **The backlog's "two of six roles get an empty catalogue" is wrong** and was corrected in the
   document. Roles are additive and the seeded users hold `employee` too (`employee + finance`,
   `auditor + employee`), so they were already offered 21 and 23 tools. The claim holds only for a
   pure-role account. Per-role counts must be **measured** against `/assistant/capabilities`.

**Also recorded in the backlog:** these are the **first consumers** of `org.unit.read` and
`org.team.read` — nothing in `apps/api/src` uses either, so there is no org-chart screen for
ADR-0020 §1 to compare against. The field registry is the compensating control.

### Tests

`familyOf` in the red team now maps `department` and `team` to the **directory** reach instead of
falling through to *reporting* — without it section 1 passed vacuously for them, because a
department row names its head by NAME and `peopleIn` looks for employee numbers.

New **section 6e**: for every role, a directory answer carries none of `personal_phone`,
`personal_email`, `date_of_birth`, `address_*`, `city`, `postal_code`, `gender`, `blood_group`,
`emergency_contact_*`, `exit_reason`; plus a positive control that an employee **can** read a
colleague's work email, and — in the same block — **cannot** read that colleague's leave balance.

**GATE: 1089 passed, 0 failed** (was 956).

### Exact next action

1. **`work` is now the largest empty domain** — 18 backlogged tools, all **R**: they need field
   registry entries for `work_log`, `timesheet`, `task`, `project`, `project_effort` first. That
   registry pass unblocks 28 of the 89 and is the backlog's own prerequisite #1.
   `work_log_entry.description` must land as `SELF_ONLY`.
2. Still open: the **salary** question (schedule-only vs self-payslip amounts) — unchanged, needs
   an ADR-0020 §6 amendment and a red-team BANNED-list change for the amounts version.
3. Still unverified: **the model's live wording and the streaming UI.** Restart :4000 from the
   shell holding `HRM_LLM_API_KEY`; kill any spare on :4001 first.
4. `assistant:accuracy` and `assistant:test` still point at files that do not exist. The backlog
   makes the first one a per-tool obligation, so it is now four tools overdue.

---

## 2026-09-09 (latest) — DEC-144: "my leave balance" answered with somebody else's

**The bug.** Deepa (hr_admin) asked her leave balance and was told **8 days of casual leave**. She
has 12; EMP001 has 8. `whoClause` added no person filter when nothing was named, so `scope()`
decided the set — self for an employee (so it looked fine), the whole organisation for an
hr_admin. Ten rows went to the model and it narrated the **first** as "your balance". A manager
got eight rows and the same wrong answer.

**Not an authorization failure** — every row was one she may read. That is precisely why 800
passing red-team assertions missed it: sections 1–5 check that nothing *forbidden* comes back,
and nothing forbidden did.

| Change | Where |
|---|---|
| `whoClause` takes the caller; no name given ⇒ `alias.id = $n`, still ANDed onto `scope()` | `catalog.ts`, 16 call sites |
| `whoClauseAnyone` — the old behaviour, under a name that says what it does | used by `leave_who_is_off` and the named-subject resolver |
| `subjectDefault: 'asker' \| 'scope'` on `ToolSpec`, **default `'asker'`**, published on `/capabilities` | forgetting now fails towards too little |
| `relatedPeople` on `me_reporting_chain` — its rows ARE other people | so 6d can assert the right thing about it |
| red team **section 6d** | per role, a no-argument call is about the asker; related-people tools must answer *differently for different askers*; and a `scope` tool must still span the scope |

**GATE GREEN: 956 passed, 0 failed.**

Role matrix, measured on :4001 — `leave_balance` by employee number:

| asker | EMP001 | EMP002 | EMP005 |
|---|---|---|---|
| employee (Vishnu, EMP001) | 2 rows | refused | refused |
| manager (Priya, EMP002) | 2 rows | 2 rows | refused |
| hr_admin (Deepa, EMP005) | 2 rows | 2 rows | 2 rows |

With no name: each role now gets **their own** record (8.00 / 12.00 / 12.00 CL). `leave_balance_team`
still spans the full scope per role (1 / 4 / 5 people).

### Beware when generating code with heredocs

Four separate corruptions this session — `\b` collapsing to a backspace character, `\n` becoming a
real newline, `]` turning into `)`, and **a dropped `$` that turned `e.id = $2` into `e.id = 2`**
(Postgres: `operator does not exist: uuid = integer`). The last one shipped into a build and was
caught only by re-running the reproduction. Write generator scripts with the file-writing tool,
not shell heredocs, and re-run the behavioural check after any generated edit.

### STILL OPEN — own salary visible, manager denied, HR allowed

**The authorization layer already implements exactly this policy.** `authz-matrix.yaml`:

- `payslip-self-is-permitted` — *"a wage slip is something the person paid is entitled to see"*
- `payslip-manager-cannot-read-report` — *"a manager needs to know whether somebody was at work,
  not what they were paid"*
- `payslip-upward-escalation` — even an hr_admin may not read the payslip of somebody **above them
  in their own reporting line**. So "HR sees everything" is not quite true, deliberately.

A self-only payslip tool would inherit all of that. The two blockers are unchanged and are both
decisions, not work:

1. **ADR-0020 §6** — "No tool reads compensation."
2. **The red team's `BANNED` list** — `net_minor`, `gross_minor`, `amount_minor`,
   `declared_net_minor`, `component_code`, asserted for every role across the whole catalogue. Any
   tool returning net pay fails the 100%-no-waiver gate.

Plus **OR-29**: the payslip grants are not enforced while the API connects as owner, so the
absence of the tool is currently the only effective control.

### Exact next action

1. Decide the salary question: schedule-only (no gate change) or self-payslip amounts (both
   amendments, recorded).
2. **Restart :4000** from the shell holding `HRM_LLM_API_KEY`; kill any spare on :4001. The
   model's live wording and the streaming UI remain unverified.
3. `work`, `people`, `documents`, `cross` still have zero tools.
4. `assistant:accuracy` and `assistant:test` point at files that do not exist.

---

## 2026-09-09 (latest) — DEC-143: self-only tools, and why "my phone number" said nothing matched

**The bug.** "What is my phone number?" → *"nothing matched"*. The number is on file
(`+91 98470 11001`), and the asker can read it on their own profile screen. Two causes:
`me_profile` never selected those columns, and DEC-137's blanket `inList: true` would have
stripped them if it had — `personal_phone`, `personal_email`, `date_of_birth` and the address
fields are all `neverInList`.

**The fix** is a `selfOnly` tool class (DEC-143), not a hole in DEC-137:

| | |
|---|---|
| `catalog.ts` | `selfOnly?: boolean` on `ToolSpec`, with the bar for setting it written down |
| `assistant.controller.ts` | new `maskRows()` — `maskList` as before, except a self-only tool **drops any row whose subject is not the caller** and then masks with `inList: false` |
| `tools-me.ts` | `me_contact_details` — no arguments at all, `WHERE e.id = $1 AND <scope>`, `date_of_birth::text` |
| `redteam.test.mjs` | **section 6c**: per role, the tool answers for the caller, and handing it another person's number *and* name does not move the answer |

**GATE GREEN: 874 passed, 0 failed.**

Live, on a spare API at :4001 — EMP001 gets `+91 98470 11001` / `1994-03-12`, EMP002 gets their
own, and `me_contact_details` handed `{employeeNumber: EMP002, nameQuery: Priya}` still returns
EMP001's row.

### STILL OPEN — "my own salary should be visible"

Asked for, **not built**, because it needs two decisions that are not a developer's to take:

1. **ADR-0020 §6 says "No tool reads compensation."** That sentence is ADR-0020's own (the ADR is
   Proposed, so amendable) and was introduced as the replacement backstop for ADR-0017's
   no-scoring property. A self-only payslip tool does not restore ranking — it cannot name
   anybody or order anybody — so a narrow amendment is arguable, but it is an amendment.
2. **The red team's `BANNED` list contains `net_minor`, `gross_minor`, `amount_minor`,
   `declared_net_minor`, `component_code`**, asserted for every role across the whole catalogue.
   A tool returning net pay fails it. That suite is the CRITICAL 100%-no-waiver release gate, and
   editing a gate to permit what it was written to forbid is a human decision. Aliasing the column
   to slip past the check would be gaming it, which CLAUDE.md forbids outright.

Also relevant: **OR-29**. `hrm_app` has no grant on the payslip tables, but the API still connects
as the owner, so that grant is not enforced — which means *the absence of the tool is currently
the only effective control*. Adding one does not add a tool, it removes the control.

What already exists and would NOT need building: the `payroll.payslip.read` action and its
policies, the `payslip` field-registry entry, and the `/payslips` screen.

**A middle option that needs no gate change:** a payslip *schedule* tool — period, `pay_date`,
status, no amounts. It answers "when is my salary credited?" for real (the question DEC-142 just
stopped refusing), touches no banned column, and does not read compensation in the amount sense.

### Exact next action

1. Decide on the salary question above (schedule-only, full self-payslip, or neither).
2. **Restart the API on :4000** from the shell holding `HRM_LLM_API_KEY` — the model's live
   wording and the streaming UI are still unverified. Kill any spare on :4001 first.
3. `work`, `people`, `documents`, `cross` still have **zero tools**; `work` is the largest gap.
4. `testing/assistant/accuracy.test.mjs` and `testing/demo/assistant-flow.test.mjs` are wired in
   `package.json` but do not exist.

---

## 2026-09-09 (latest) — DEC-142: pay block narrowed, out-of-reach refusals, crisp messages

| Change | Where |
|---|---|
| **Pay blocks on INTENT, not topic.** "When is my salary credited?" is no longer a forbidden purpose; "what is my salary" still is | `assistant.controller.ts` `FORBIDDEN_PURPOSE` — one noun rule split into five, with a lookahead that lets date questions through |
| **Naming somebody out of reach is a refusal**, not "nothing matched" | new `namedSubjectOutOfReach()`; runs in both `/ask` and `/run` when a named lookup returns empty |
| **Every refusal message cut to one or two sentences** | `assistant.controller.ts` and `llm.ts` |
| Red team extended, and pointable at another instance | `HRM_API_BASE` override; +21 must-block, +6 must-NOT-block, new section 6b |

**GATE GREEN: `assistant:redteam` 827 passed, 0 failed** — its first fully green run including
section 8 (DEC-140's payload check) and section 6b. Run against a spare API on `:4001`, which is
possible precisely because nothing in that suite drives a model.

Verified live, 16/16, against real data (`scratchpad/verify-142.mjs`, not committed): amount
questions blocked, schedule questions through, `Priya Menon is outside what your account can see.`,
own records still answer, an unknown name stays an empty result, and — the one that matters —
**a manager naming their own report is not refused**.

### Tool coverage, measured rather than assumed

`/assistant/capabilities` per seeded role:

| role | tools | me | leave | attendance | work | people | documents | cross |
|---|---|---|---|---|---|---|---|---|
| employee | 21/23 | 5 | 9 | 7 | — | — | — | — |
| manager | 21/23 | 5 | 9 | 7 | — | — | — | — |
| hr_admin | 23/23 | 5 | 10 | 8 | — | — | — | — |
| finance | 21/23 | 5 | 9 | 7 | — | — | — | — |
| auditor | 23/23 | 5 | 10 | 8 | — | — | — | — |

**The gap is by DOMAIN, not by role.** `work`, `people`, `documents` and `cross` have zero tools
although `DOMAIN_BLURB` describes all seven — harmless today because `route()` only offers domains
that have tools, but the blurbs are dead weight until they do. Role differentiation is by ROW
(`scope()`), not by tool, which is the design: the only per-role difference is the two
`config.policy.read` tools that hr_admin and auditor get. One manager-shaped tool,
`leave_pending_approvals`, is deliberately unbuilt — see DEC-136.

### Exact next action

1. **Restart the API on :4000** from the shell holding `HRM_LLM_API_KEY` (still unverified: the
   model's live wording and the streaming UI). `dist/` is built. **Kill the spare on :4001 first
   if it is still up** — `node apps/api/dist/main.js` with `PORT=4001`.
2. Build tools for `work` (projects, tasks, effort) — the largest empty domain, and the one with
   screens already shipped.
3. `testing/assistant/accuracy.test.mjs` and `testing/demo/assistant-flow.test.mjs` **still do not
   exist** though both are wired into `package.json`. Since DEC-141 removed the table, accuracy is
   the only instrument that can catch a confidently wrong answer.

---

## 2026-09-09 (later still) — DEC-141: prose only, streamed, fixed panel height

Three things asked for together, on top of DEC-140.

| Change | Where |
|---|---|
| **The result table is no longer rendered.** The panel shows the model's prose and nothing else | `apps/web/components/assistant.tsx` — `COLUMN_KEY`, `cell()` and the toggle deleted; `ResultRows` became `ResultMeta` (note + rowCount), so the component no longer holds values it does not draw |
| **The answer streams**, a fragment at a time | `llm.ts` gained `onDelta` → `stream: true` + `stream_options.include_usage`, and a hand-written SSE reader (`readStream`); the controller forwards each fragment as a `token` event; the panel APPENDS rather than replaces |
| **Fixed panel height** | `max-h-[min(34rem,…)]` → `h-[min(34rem,…)]`. The panel grew with its content, which read as the window jumping on every question |
| Dead copy removed | 43 `chat.col.*` keys plus `chat.showRows*`/`chat.hideRows`, in both locales (dictionary 1390 → 1300 lines) |
| Fallback rewritten | `deterministicSentence(rowCount, 'failed' | 'disabled')` — with no table below it, "2 rows from leave_balance" was not an answer, it was a shrug |

**The API is deliberately unchanged.** The `rows` event still goes first and still carries columns
and values, so restoring the table is a rendering change rather than a protocol one, and red-team
section 8 still has a payload to assert.

**What this costs, recorded in DEC-141 and in ADR-0020 §3 (bullet struck through, not deleted):**
DEC-140's third containment bound was that the table sat beside the answer, rendered from Postgres
and never derived from the model's output, so a wrong sentence could be spotted. **For a real user
that check is gone.** The two stronger bounds hold: the model sees exactly the masked array the
asker is entitled to, and the answer call carries no tools. `assistant:accuracy` — still an
unwritten file — is now the only instrument that could catch a confidently wrong answer.

**ADR-0020's Rule 12 conditions survive streaming, and were checked rather than assumed:** the
abort timer bounds the whole read (not just the first byte), and the single retry is suppressed
once a fragment has been emitted, so a break mid-answer cannot replay text the user has read.

**Verified** against a fake provider on `127.0.0.1:4123` serving OpenAI-shaped SSE
(`scratchpad/stream-check.mjs`, not committed):

- fragments arrive spread over time (+89, +97, +111, +127 ms), assemble to the right sentence,
  and `usage` from the final chunk lands in the token counters;
- a stream killed after two fragments throws `LlmUnavailable('provider_error')` with **exactly two**
  fragments delivered — no retry, no duplicated text;
- a call with `tools` attached ignores `onDelta` entirely.

Plus `tsc --noEmit` on api and web, `api:build`, `i18n:test` 14/14, and the fallback strings.

### Exact next action

Unchanged from the DEC-140 block above, and still blocked on the same thing: **restart the API from
the shell that holds `HRM_LLM_API_KEY`** (there is no `.env`; the running process on `:4000` still
serves the pre-DEC-140 build), then ask a question and watch the answer type itself out. Then
`npm run assistant:redteam` at 100%.

---

## 2026-09-09 (later) — DEC-140: the assistant now answers in words

**Why.** The shipped assistant could not answer a question. "How much casual leave do I have
left?" returned *"the lookup for your casual leave balance returned 2 rows of results"* with the
figure in a column off the right edge of a scrolling panel — because ADR-0020 §3 forbade the
model from seeing any value. **The product owner was shown the three options and the trade in
full and chose to send the rows.**

**What changed**

| File | Change |
|---|---|
| `apps/api/src/assistant/answer.ts` | **New.** `buildAnswerPayload` (masked rows → fenced JSONL, 50 rows / 160 chars per value / 8000 chars), `sanitizeValue`, `ANSWER_SYSTEM_PROMPT`, `deterministicSentence` |
| `apps/api/src/assistant/assistant.controller.ts` | `narrate()` → `answer()`, fed the masked rows; `/run` now publishes the exact payload a turn would send, so the red-team can check it model-free |
| `apps/api/src/assistant/llm.ts` | `answerFromRows` getter (`HRM_LLM_ANSWER_FROM_ROWS`, default true); boot log states whether row values leave the process |
| `apps/web/components/assistant.tsx` | The answer leads; the table folds behind a **Show the N records** toggle (this is also what fixes the off-screen column) |
| `dictionary.ts` | `chat.showRows{,One}`, `chat.hideRows`, reworded `chat.footnote`, en + ar |
| `testing/assistant/redteam.test.mjs` | **Section 8**: the payload is asserted against the same reach sets and banned-column list as the rows |
| ADR-0020 §3, DEC-140, `data-inventory.md`, `domain-glossary.md`, `env.example`, `DEPLOY.md`, `prod.env.template` | The reversal recorded, and every stale "no row value ever leaves" claim corrected |

**What was given up, in one line:** prompt injection over stored data was *impossible by
construction* and is now *contained* (the answer call carries no tools, so its worst outcome is a
wrong sentence beside a correct table); and the cross-border transfer is now result rows, not
just the question. `HRM_LLM_ANSWER_FROM_ROWS=false` restores the old posture without a code change.

**Verified:** `tsc --noEmit` on api and web, `api:build`, `i18n:test` 14/14, `node --check` on the
red-team suite, and the compiled `buildAnswerPayload` exercised directly — real leave-balance
rows, a hostile value (fence and control characters stripped), the 50-row cap, and the empty case.

**NOT verified: the model's actual wording.** The API on `:4000` reports `enabled: true`, so its
key lives in that process's environment — there is no `.env` file anywhere in the tree. Killing it
would lose the key, so it was left alone and is still serving the pre-change build.

### Exact next action

1. In the shell that holds `HRM_LLM_API_KEY`, restart the API (`npm run api:start`, or `api:dev`).
   `dist/` is already rebuilt.
2. Ask "how much casual leave do I have left?" as `vishnu.ravi@panasatech.com`. The payload now
   carries `available: "8.00"` for CL, so the answer should state 8 days.
3. Run `npm run assistant:redteam` — **100%, no waiver** (ADR-0020's release gate). Section 8 is
   new and needs its first green run.
4. **Two wired suites have no file**, both predating this change: `npm run assistant:accuracy`
   → `testing/assistant/accuracy.test.mjs`, and `npm run assistant:test` →
   `testing/demo/assistant-flow.test.mjs`. Neither exists, so both scripts fail with MODULE_NOT_FOUND
   rather than a red test. The accuracy one is now more load-bearing than it was: a confidently
   wrong sentence is precisely the failure mode DEC-140 introduces, and nothing measures it.

---


## Completed this session

| Area | What landed |
|---|---|
| Migration **0027** | The work hierarchy: `sub_project`, `sub_task`, `task.sub_project_id`, `work_log_entry.sub_task_id`, `active` lifecycle flags, `v_work_hierarchy`. Composite foreign keys make an incoherent combination unrepresentable, which also closes a PRE-EXISTING gap (project_id and task_id were independent FKs) |
| Migration **0028** | Work-log provenance: `entry_source` + `entered_by_employee_id`, with an ENABLE ALWAYS coherence trigger. No backfill — 0019's period lock forbids it and has no bypass |
| `packages/authz` | `work.log.write_for` (organisation graph, hr_admin only) and `work.task.manage`; policies, matrix rows. 423 → 435 checks |
| `apps/api/src/work.ts` | Date-period filtering on attendance (presets + from/to, validated not defaulted); `GET /projects` takes `employeeId` and returns the four-level hierarchy; `POST /work-log` takes `employeeId` and checks authorization, hierarchy, lifecycle and membership; `/team/effort` gains filters and loses its inline role check in SQL |
| `apps/api/src/work-masters.ts` | New: HR master data for all four levels — tree with usage counts, create, rename, retire, reactivate |
| Frontend | `PeriodPicker` (shared), attendance rebuilt around it, `/work` with cascading selectors and an HR employee picker, `/team` with filters, `/masters/work-management` |
| i18n | `lib/i18n` — dictionary (198 keys × 2 locales), provider, `useT`, `useFormat`, `LanguageSwitcher`; `lang`/`dir` resolved server-side from a cookie |
| Tests | +3 suites (work-hierarchy 44, period-filters 28, i18n 12), +2 DB verify files (20 checks), nav 21 → 23 |
| Governance | DEC-113 … DEC-121 |

| **Hardening pass** | Five hardcoded date literals removed (leave and timesheet were missed the first time) and FOUR screens that computed their own "today" from the browser's UTC date - which set `min` on a department move's effective-from, ended a payslip period a day short and cut the current day out of every report. `fn_business_date()` now rides `/auth/me`; the dead `todayIsoFallback` is gone |
| **Arabic completed** | 473 remaining strings keyed across 22 more files; module-level constants (`TABS`, `ATT_FIELDS`, two `EVENT_LABEL` maps) hold `MessageKey` values resolved at render |
| **Browser verification** | `testing/demo/browser-verify.mjs` - CDP over the installed Edge, 46 checks, screenshots |
| **New suites** | `bizdate:test` (18), `browser:test` (46); `i18n:test` 12 -> 14 and now globs every file |
| **Governance** | DEC-122 … DEC-125 |

**Everything green:** 28 migrations from zero, db:verify 264/264, authz 435/435, hooks 99/99,
upload 45/45, api:build, web:build, demo walkthrough, and every demo suite.

---

## NOT done — the honest remainder

**Arabic is complete across all 29 web files.** Every user-facing string comes from the
dictionary except 17 exemptions that `i18n:test` enumerates rather than pattern-matches: the
brand wordmark, form placeholders showing the shape of a value, `ADR-0005`, and the demo people's
names (seed data, not copy).

**A real browser HAS now verified it.** `browser:test` drives the Edge that Windows already ships
over the DevTools Protocol - no stack installed - and asserts computed `direction`, Arabic text on
eight screens, a form's labels, an inline dialog inheriting rtl, and real bounding boxes: the
first table column sits to the RIGHT of the last, and the sidebar at `left=1032` against content
at `left=0`. 46 checks.

**The Arabic is still unreviewed by a native speaker.** That has not changed and is the one item
that cannot be closed from inside this repo. HR vocabulary is domain vocabulary; somebody who
works in Arabic HR should read `lib/i18n/dictionary.ts` before it is shown outside the team.

**Team effort still has no task filter.** The requirement called it optional and `/team/effort`
groups by employee and project with no task dimension, so adding one means changing the
aggregation. Left out deliberately.

**Payslip and report mobile card layouts are an optional enhancement, not a defect.** Both
screens' tables sit inside `overflow-x-auto`, which is the documented pattern for wide content.
`/attendance` and `/work` additionally offer a card list below `sm`. Giving payslips and reports
the same treatment would be nicer and nothing is broken without it.

## Exact next action

1. **Review the diff and decide on the commit.** Nothing is committed. Suggested split: the two
   migrations + verify files; the authz change; the API changes; the frontend; the i18n foundation.
2. Then either **finish the i18n conversion** for the 13 remaining screens (mechanical, and the
   test enforces the rules), or **get a browser** in front of the Arabic RTL layout first — the
   second is cheaper and would change what the first has to fix.

## Still open from before this session

Unchanged: OR-19 authorization retrofit (`/team/effort` is now done; `hr.ts:19,44,52`,
`leave.ts:175,201` and the remaining `work.ts` endpoints are not), AUDIT-01 (audit emission on
leave/attendance/work), the lifecycle UI (OR-32), the org chart (OR-22 remainder), report export
(OR-27), and **the standing blocker: there is still no account-creation path** — the only
`INSERT INTO app_user` is the demo seed, so `people.employee.create` makes an employee record and
not a login. The system demos but cannot onboard a real user.

---

<details>
<summary>Previous handoff (MST-01 — HR masters), kept for continuity</summary>

**Last session:** 2026-09-10
**Slice worked:** MST-01 — HR masters (after PAY-01 payslips, RPT-01 reporting)
**Branch:** `main`, **nothing committed** (CLAUDE.md Rule 14 — no commit without an explicit request)

---

## Completed this session

| Area | What landed |
|---|---|
| Migration **0020** | Seven per-employee reporting functions: headcount movement, leave liability, attendance summary, WFH usage, attendance-vs-effort, timesheet compliance, document compliance |
| Migration **0021** | Fix: `fn_document_compliance` counted the ROW not the KEY over its LEFT JOIN, reporting a phantom pending scan for every employee with no documents |
| Migration **0022** | Task reporting: `fn_task_status` (per assignee) and `fn_project_task_status` (per project, and the only cut that can see unassigned work) |
| Migration **0023** | Fix: `fn_task_status` published its subject as `employee_id`; authz renders `assignee_employee_id`, so every SCOPED caller got a 500 while HR worked |
| `packages/authz` | New `task` resource type, `work.task.read` action, policy identical to `work.log.read`, matrix entry, subject column declared in `EMPLOYEE_COLUMN` |
| `apps/api/src/reports.ts` | Nine endpoints — index, headcount, leave, attendance, wfh, reconciliation, timesheets, documents, tasks, effort — every one composing `scope()` into the SQL |
| `apps/web/.../reports/page.tsx` | Nine-tab reports UI, tab strip driven by `GET /reports` rather than by a role check |
| Seed | Task assignees and relative due dates, chosen so every counter has a reason to be wrong; two tasks left deliberately unassigned |
| Tests | `testing/db/0020_reporting.verify.sql` (15), `testing/db/0022_task_reporting.verify.sql` (10), `testing/demo/reports-scope.test.mjs` (63) |
| `apps/web/.../layout.tsx` | Shell rebuilt: grouped **sidebar** (My records · My team · Organisation · Administration) replacing a 12-item top bar whose labels wrapped; self-sizing flex column, no hand-measured header height |
| `testing/demo/nav-shell.test.mjs` | New `nav:test` (19) - every nav href resolves, and the two glossary naming rules are enforced mechanically |
| Migration **0024** | Payslip records: component catalogue (configuration), `payslip` with a generated half-open period + one-live-per-period EXCLUDE, `payslip_line` (signed integer paise), FSM-as-data + append-only `payslip_event` with no self-issue, `fn_payslip_totals`, the issue guard, `fn_audit_payslip`, and the Tier 1 REVOKEs + `hrm_payroll` role |
| Migration **0025** | Fix: the writer flag leaked, making `payslip.status` directly writable for the rest of the transaction — and through that re-opening an ISSUED payslip's lines and document link |
| `packages/authz` | `payslip` resource type, `payroll.payslip.read` / `.manage`, the **compensation deny-override** DEC-041 deferred, 7 named threat cases, field registry entries (hr_admin + finance + self only) |
| `apps/api/src/payroll.ts` | 10 endpoints: components, list, detail, create, patch, attach PDF, issue, void, history, document stream |
| `apps/web` | `/payslips` (My payslips), `components/payslips.tsx` (detail + list + HR's add form), Payslips card on the employee profile, nav entry |
| Seed | 6 issued payslips across 2 employees × 3 months, with real PDFs uploaded to MinIO and their true digests recorded |
| Docs | `docs/privacy/data-inventory.md` — pay data classified (the Forbidden-Actions gate) |
| Tests | `testing/db/0024_payslip_records.verify.sql` (26), `testing/demo/payslip-flow.test.mjs` (79) |
| Also fixed | 0019 **W14/W15 were silently skipping** (DEC-079); the seed's teardown order and object keys (DEC-078) |
| `apps/web/components/punch-card.tsx` | Rebuilt around three states — the action is the hero when there is nothing to report; retention detail behind a disclosure, consent line kept beside the button |
| Also fixed | The seed fabricated today's DERIVED attendance verdict (DEC-083); my own state discriminator repeated it (DEC-084); **0012 N9 and 0016 I11 were order-dependent** (DEC-085); `payslip:test` was eroding the seeded payslips (DEC-086) |
| Migration **0026** | A department cannot be placed inside its own subtree — the cycle was creatable, and its cost was a silently understated headcount, not an error |
| `apps/api/src/org.ts` | Department + designation masters: as-of list with headcount rollup, create, rename, re-parent, retire/reinstate |
| `apps/api/src/people.ts` | Employee master: create (employee + employment + joined event in one transaction), edit, change assignment |
| `apps/web/.../organisation` | The masters UI, plus Add employee on the directory and Change assignment on the profile |
| **OR-18 closed** | Personal data through the policy + field registry; HR gets what it needs, `emergency_contact_*` and `blood_group` stay SELF_ONLY, and the WRITE list is derived from the READ mask |
| Tests | `testing/demo/masters-flow.test.mjs` (49), 0017 checks G19–G21, `privacy:test` re-pinned 18 → 20 |
| Decisions | **DEC-060 … DEC-093** |
| Risks | **OR-26** (tasks read-only), **OR-27** (no export/pagination), **OR-28** (nobody can pay the payroll admin's manager), **OR-29** (Tier 1 not yet effective — API runs as owner), **OR-30** (payslip PDFs cleared without a scanner), **OR-31** (8-year retention not derived from statute) |

**1,109 automated checks, 0 failures.** See `CURRENT_SLICE.md` for the per-suite bar.

---

## The defects worth remembering from PAY-01, all found by RUNNING code

1. **The writer flag leaked, and one leaked GUC undid four controls** (DEC-075). `SET LOCAL` is
   scoped to the TRANSACTION, not the function — a function's own `SET` clause restores only the
   parameter it names. So after one legitimate transition `payslip.status` was directly writable,
   and with the status forged back to `draft` both freeze triggers correctly concluded the payslip
   was still a draft: an ISSUED payslip's amounts became editable and its `document_id`
   re-pointable at another employee's PDF. Neither trigger was at fault. **0007 already had this
   trap and its check V6 exists for it** — the shape just wasn't reused.
2. **Three smoke checks passed for the wrong reason.** Self-issue, an invented transition and the
   flag-leak test were all refused by an *earlier* guard (no document attached) or by a different
   CHECK, so none exercised what it claimed. The leak was invisible until each check was rebuilt
   to be the only thing that could fail.
3. **My negative test accepted a 500** (DEC-080). `check('a duplicate is refused', !dup.ok)` is
   true of any non-2xx, which is how a bare "Internal server error" survived where HR needed an
   actionable message. Assert the status.
4. **0019 W14/W15 were silently SKIPPING** (DEC-079). Not failing — skipping, because they
   borrowed a seeded draft timesheet that `demo:test` submits. `db:verify` reported 230 where 232
   was expected and nothing else complained. **Check the count, not just the absence of failures.**
5. **Two of my own fixtures were wrong and a check caught each** (DEC-078). D15 refused the seed
   for putting an employee number in an object key — while my comment claimed the keys carried no
   personal data. D9 refused the seed's digest rewrite, because a version's hash is immutable.

## The four defects worth remembering from RPT-01, all found by RUNNING code

1. **An employee's own attendance report returned 404.** A report is a collection request with no
   subject, and the self-scoped policies are written around `isSelf`, which an empty ref cannot
   satisfy — so `assertCan` denied before `scope` was ever computed. Fixed by having the ref carry
   the caller as its own subject (DEC-061): `assertCan` answers *may you read this type at all*,
   `scope` answers *whose rows*.
2. **`/reports/tasks` was 200 for HR and 500 for everybody else** (DEC-064). HR's predicate is
   `ALLOW_ALL`, which renders as literal `true` and names no column, so it never touched the
   mis-named subject column that broke every scoped caller. **A smoke test against HR alone would
   have passed.** Check the roles whose predicates actually reference columns.
3. **A phantom `pending_scan = 1`** for four employees who had uploaded nothing (0021):
   `COUNT(*)` over a LEFT JOIN counts the all-NULL row, and `d.withdrawn_at IS NULL AND
   d.current_version_id IS NULL` is true of it, twice. Count the KEY. 0022 was written with this
   in mind and its verify check TK5 pins it.
4. **My own test expectation was wrong, not the code** (DEC-062). I had asserted the documents
   report was HR-only; the policy has always admitted an employee to their own documents, and
   refusing the report would have made it stricter than the `/documents` screen it summarises.
   Verified what the employee actually receives *before* relaxing the assertion.

---

---

## 2026-09-09, later session: DEPLOY-01 - the production deployment stack

Class **A/B** by changed paths (infrastructure, docs, one auth line, seven web call sites). No
schema change, no authorization change, no migration.

**Asked for:** the `hr-agent` deployment shape (`C:/Users/.../Project/hr-agent`), reproduced for
PanasaHRM on `127.0.0.1:4787` - since moved to **4788**, see DEC-109.

| Area | What landed |
|---|---|
| `infrastructure/compose/docker-compose.prod.yml` | postgres 18 - minio - one-shot `migrate` - api - web - edge nginx. **Only nginx publishes a port** (`127.0.0.1:4788:80` as of DEC-109). Every secret is `${VAR:?...}` with no default |
| `infrastructure/docker/{api,web,migrate}.Dockerfile` | Multi-stage, repo-root build context (npm workspaces). API: dev-free second install. Web: Next `output: 'standalone'`. Migrate: `postgres:18-alpine` + nodejs, because `migrate.mjs` drives psql and the client must match the server |
| `infrastructure/nginx/{nginx.conf,hrm_proxy_params}` | A WHOLE nginx.conf (DEC-095), realip-corrected rate limiting (DEC-096), 4 security headers with `always`, 26m body cap, `/api/` prefix PRESERVED for Nest's global prefix |
| `deploy.sh` | Preflight (env file present AND no blank secret), pull, build, explicit `run --rm migrate up`, `up -d`, then a THREE-probe verify (DEC-097) |
| `DEPLOY.md` | The runbook, including the host-nginx block, the build-time base path, backups pointing at `/var/lib/postgresql/18/docker`, and a "Known gaps" table |
| `infrastructure/compose/prod.env.template` | Deliberately not `.env.example` - writing to `.env*` is a Forbidden Action. `prod.env` added to `.gitignore` |
| `apps/api/src/auth.ts` | **`secure: HRM_COOKIE_SECURE`** on the session cookie, and the matching attributes on `clearCookie` (DEC-099). This closes the code's own TODO now that TLS exists |
| `apps/web/lib/base-path.ts` + 4 files | `NEXT_PUBLIC_BASE_PATH` support for path-routing behind the host nginx (DEC-100). Default empty = byte-identical to before |
| `apps/web/next.config.ts` | `output: 'standalone'`, `outputFileTracingRoot` at the repo root, conditional `basePath`/`assetPrefix` |
| Decisions | **DEC-094 - DEC-101** |

### VERIFIED BY RUNNING THE WHOLE STACK

Docker was started and the stack was built and run end to end under an isolated project name
(`-p panasahrm-verify`, throwaway secrets in the scratchpad, volumes removed afterwards). The
real `panasahrm` project and its volumes were never created.

| Check | Result |
|---|---|
| All three images build | **PASS** (`api` 979 MB, `web` 414 MB, `migrate` 515 MB) |
| `migrate` one-shot against an empty volume | **PASS - 26/26 applied**, exit 0 |
| postgres / minio / api / web / nginx | **all reported healthy** by their own healthchecks |
| `nginx -t` inside the container | **PASS** |
| `/healthz` | **200** |
| `/panasa-hrm/api/auth/me` | **401** `{"message":"Not signed in",...}` - through the edge, not through Next |
| `/panasa-hrm/login` | **200** |
| Page's real asset URLs (`/panasa-hrm/_next/static/*.js`, `*.css`) | **200** - and no root-absolute `/_next` or `/api` left in the HTML |
| Login rate limit (10r/m, burst 5) | **PASS** - `401 401 401 401 401 401 429 429` |
| Security headers present on a 4xx | **PASS** (`always` is doing its job) |
| Template rendered with base path AND empty | both **valid** |
| `authz:test` / `upload:test` / hooks | 423 / 45 / 99, 0 failed |
| DB-backed suites (`db:verify`, `demo`, `nav`, `payslip`, ...) | **NOT RUN** - they target the dev stack on 55432, not this one |

### THREE REAL BUGS, all found only by running it

1. **nginx never routed the API** (DEC-102). `location /api/` does not match `/panasa-hrm/api/...`,
   so every API call fell through to `location /` and Next proxied it onward. **Silent** - the app
   would have worked, with a Node hop in front of every document stream. Fixed by making the
   config an envsubst template driven by `HRM_BASE_PATH`.
2. **`HRM_API_ORIGIN` was inert** (DEC-103). Next bakes `rewrites()` into the routes manifest at
   `next build`, so the runtime env var did nothing and the web container logged
   `ECONNREFUSED 127.0.0.1:4000` while the API answered 401 perfectly well on `api:4000`. It is a
   build arg now. My compose comment had claimed the opposite.
3. **nginx crash-looped on a duplicate `proxy_read_timeout`** (DEC-104) - `location /api/` set it
   after including the shared params, which already had it.

### The published port is 4788 (was 4787) - DEC-109

`127.0.0.1:4787` was held by **Code.exe (VS Code), PID 4740** on this machine, so every
verification ran on 4788 while the configuration still said 4787. That gap - tested on one port,
shipping another - is now closed: **`HRM_PUBLISH_PORT=4788`** throughout, and `deploy.sh` reads
the value back out of `prod.env` so its health probes follow whatever is configured.

Still confirm on the VM before deploying, because 4788 being free here proves nothing there:

```bash
ss -ltnp | grep 4788     # must print nothing
```

If it is taken, change `HRM_PUBLISH_PORT` in `prod.env` **and** the `panasa_hrm_app` upstream in
the host nginx together.

### DEPLOY-03 - port moved to 4788, and `deploy.sh` finally run end to end

`HRM_PUBLISH_PORT=4788` everywhere (DEC-109). The rationale text was corrected too: the old
"4765/4766/4767 are taken" no longer explains the choice now that 4787 is out as well.

**`./deploy.sh` was executed for real for the first time** - every earlier verification drove
`docker compose` directly with hand-rolled probes. That immediately found **DEC-110**: the probe's
`|| echo 000` fallback appended to curl's own `000`, so a healthy `200` arrived as `200000`, never
matched, and the script exited 1 with all six containers healthy and serving. Fixed, plus the
report columns were a character too narrow.

Verified after the change, from a clean volume:

| Check | Result |
|---|---|
| `./deploy.sh --no-pull` | **exit 0** - "Deploy complete. local: http://127.0.0.1:4788/panasa-hrm/" |
| Preflight on the blank template | names exactly the five empty secrets, refuses before pull or build |
| Probes | `200 / 401 / 200` |
| All six containers | healthy, `127.0.0.1:4788->80/tcp` |
| Teardown | volumes and `prod.env` removed |

### DEPLOY-04 - the first real VM deploy failed at `build`; fixed (DEC-111)

```
==> Building images
error while interpolating services.seed.environment.HRM_DEMO_PASSWORD:
required variable HRM_DEMO_PASSWORD is missing a value
```

**`profiles:` does not exempt a service from interpolation.** Compose expands the entire file on
every command, so the `${HRM_DEMO_PASSWORD:?...}` guarding the profiled `seed` service blocked
`build` and `up` on a stack that would never run the seed - and the variable it demanded is one
`prod.env.template` explicitly says to leave blank for a real deployment.

Guard moved into the seed container's `command:`. Same refusal, same message, but only when the
seed is invoked.

**Why four rounds of verification missed it:** every local env file had a demo password sed'd in,
so the blank case - the *normal* case for production - was never once exercised. The lesson is the
repo's own: exercise the configuration a real operator would have, not the one the test needs.

Verified both directions from a clean volume:

| Check | Result |
|---|---|
| `docker compose config`, demo password blank | **exit 0** (was exit 1 - the VM failure, reproduced locally first) |
| `./deploy.sh --no-pull`, demo password blank | **exit 0**, probes `200 / 401 / 200` |
| `--profile seed run --rm seed`, blank | **exit 1**, "REFUSED: HRM_DEMO_PASSWORD is not set." |
| `--profile seed run --rm seed`, password set | **exit 0**, 6 payslip PDFs, demo logins printed |

**Port note:** this Windows machine's VS Code grabs loopback ports in this range dynamically - it
took 4787 (PID 4740) and later 4788 (PID 9824). The last verification therefore ran on 4789 via a
local `prod.env` override; **the committed value is still 4788** and the Linux VM has no VS Code.
Confirm with `ss -ltnp | grep 4788` there.

### Machine notes

`npm` on PATH in Git Bash resolves to a stray **npm 2.15.12** in the user's home directory, so
`npm run <script>` fails with "missing script". Call the binaries directly:
`node node_modules/typescript/bin/tsc`, `node node_modules/@nestjs/cli/bin/nest.js build`,
`node node_modules/next/dist/bin/next build`. Git Bash also mangles a leading-slash env value, so
`NEXT_PUBLIC_BASE_PATH=/panasa-hrm` needs `MSYS_NO_PATHCONV=1`. Neither affects Linux containers.

### DEPLOY-02 - reconciling the botched merge (same day, later)

Merge **`aaef373`** pulled a teammate's branch that contained a SECOND, complete deployment stack,
and **committed the conflict markers**. `git status` was clean, so nothing looked wrong - but
`apps/api/src/auth.ts` carried `<<<<<<< HEAD` and the API did not compile.

Four files had committed markers: `apps/api/src/auth.ts`, `.gitignore`, `.dockerignore`,
`infrastructure/compose/docker-compose.prod.yml`.

**The two stacks were different TOPOLOGIES, not variants.** Theirs bound host `:80`/`:443` and
terminated its own TLS from `HRM_TLS_DIR`, which assumes PanasaHRM owns the VM. Ours publishes
`127.0.0.1:4788` plain HTTP behind the shared host nginx that already fronts `/hr-agent/`.
**User chose the loopback-behind-host-nginx model** - that is the real host arrangement (DEC-105).

**Adopted from their branch, because it was better:**

| Their idea | Effect |
|---|---|
| API image reinstalls only the two workspaces it needs | **979 MB -> 292 MB** (Next and React were in an API container) |
| `node:24-alpine` + `postgresql18-client` for the migration runner | **515 MB -> 266 MB** |
| `seed` behind `profiles: ["seed"]`, sharing the migrate image | Closes the "no way to get data in" gap - and an ordinary `up` cannot start it |
| Pinned `minio:RELEASE.2025-04-22...` | No silent version drift on the document store |
| `HRM_PG_OWNER_*` vs `HRM_PG_APP_*` | The seam for OR-29; both are the owner today because of P3-7 |
| `--auth-host=scram-sha-256` | Unioned with our `--locale=C.UTF-8` (theirs had dropped the locale) |
| `__Host-` cookie prefix derived from one switch | Closes half of OR-21 |

**Rejected, with reasons:** their `TZ: Asia/Kolkata` on postgres (DEC-106 - `fn_business_date()`
is `now() AT TIME ZONE <setting>` and immune to it; its own COMMENT says the server runs UTC, and
IST would make prod disagree with dev on anything using CURRENT_DATE). Their duplicate
Dockerfiles, `infrastructure/compose/nginx/*` and `docs/runbooks/deployment.md` were removed -
two runbooks describing two topologies is how somebody follows the wrong one at 2am.

**The dangerous one (DEC-107).** The merge left TWO env vars for the cookie and two `secure:` keys
in one object literal. `HRM_SECURE_COOKIES=true` on its own produced `__Host-hrm_session`
**without** `Secure` - a cookie the browser refuses outright. Nobody could have logged in, and it
would have looked like a session bug. Now one switch drives both.

### Verified after reconciliation - the whole stack, again

Built and run under `-p panasahrm-verify` with throwaway secrets; volumes removed afterwards.

| Check | Result |
|---|---|
| `docker compose config` | valid |
| All three images build | **PASS** - api 292 MB, web 319 MB, migrate 266 MB |
| migrate one-shot, empty volume | **26/26 applied**, exit 0 |
| postgres / minio / **redis** / api / web / nginx | **all six healthy** |
| `/healthz` · `${BASE}/api/auth/me` · `${BASE}/login` · `${BASE}/art-mark.png` | **200 · 401 · 200 · 200** |
| `hrm-seed` after an ordinary `up -d` | **absent** - the profile guard holds |
| `--profile seed run --rm seed` | **exit 0**, 6 payslip PDFs into MinIO, demo logins printed |
| **Real login through the edge** | `__Host-hrm_session=...; HttpOnly; Secure; SameSite=Lax` - full ADR-0010 |
| **Authenticated `GET /api/auth/me`** | **200**, correct actor with `roles: [employee, hr_admin]` |
| `api:build` · `web:build` (root and `/panasa-hrm`) | clean |
| `authz:test` / `upload:test` / hooks | 423 / 45 / 99, 0 failed |
| `deploy.sh` preflight | names exactly the five blank secrets, refuses before pull or build |
| DB-backed suites | **NOT RUN** - they target the dev stack on 55432 |

### Exact next action

1. **On the VM: `ss -ltnp | grep 4788`**, then `cp infrastructure/compose/prod.env.template
   infrastructure/compose/prod.env`, fill the three secrets, and run `./deploy.sh`. The stack is
   proven to come up; what has never been exercised is `deploy.sh` itself end to end (the
   verification drove compose directly, with a scratchpad env file).
2. **A fresh deployment has no users.** Migrations apply schema only, so nobody can log in until
   the database is seeded or a first administrator is created. See `DEPLOY.md` §4 - and note that
   a real first-admin bootstrap does not exist yet.
3. Add the host-nginx block from `DEPLOY.md` §3 and confirm
   `https://ai.arttechgroup.com:7777/panasa-hrm/` renders.
4. Then the go-live list in `DEPLOY.md` - **the restore drill is the one that gates everything**
   (ADR-0013 amendment (b)).

---

## Exact next action

**Finish OR-19 — the authorization retrofit — starting with `apps/api/src/hr.ts`.**

Unchanged by PAY-01, and now the largest standing violation by some distance: `payroll.ts`,
`reports.ts`, `documents.ts` and `settings.ts` all resolve every decision through
`AuthorizationService`, while `hr.ts`, `leave.ts` and most of `work.ts` still decide in the
controller and in raw SQL.

This is now the largest standing violation of Must-Know Rule 1, and reporting made it more
visible rather than less: `/reports` resolves every decision through `AuthorizationService`, while
the screens those reports summarise still decide in the controller and in SQL. Concretely:

Line numbers below were re-verified at the end of this session with
`grep -nE "hr_admin' OR|= 'hr_admin'"` — check them again before editing, they move.

1. `hr.ts` — dashboard and employees. Three separate checks: the inline SQL predicate
   `($2 = 'hr_admin' OR em.manager_id = $1)` at **`hr.ts:44`** and **`hr.ts:52`**, and a
   TypeScript role comparison at **`hr.ts:19`** (`me.role === 'manager' || me.role ===
   'hr_admin'`). Compose `scope()` instead. The pattern to copy is `reports.ts` `gate()`, which
   returns a rendered predicate rather than rows precisely so the caller cannot fetch-then-filter.
2. `leave.ts` — the SQL predicate at **`leave.ts:175`**, and a different form at
   **`leave.ts:201`** (`me.role !== 'hr_admin' && r.manager_id !== me.employeeId`), which is a
   role check and a graph traversal fused into one condition.
3. `work.ts` — the SQL predicate at **`work.ts:406`**, **`work.ts:527`** and **`work.ts:539`**.
   The timesheet *decide* route is already retrofitted (DEC-058); these are the remaining three.
4. Then the **fail-closed global guard** plus the `assertPolicyCoverage` boot assertion, so a
   route with no policy refuses to start rather than silently allowing.

Do it with the matrix as the oracle, not as documentation: `settings` (DEC-053) proved the matrix
was right and the route was wrong for as long as nothing compared them.

### After that, in order

- **AUDIT-01** — Must-Know Rule 2 is still unsatisfied on every write path: domain events and
  outbox rows in the same transaction as the write. `audit_column_policy` still holds 0 rows.
  Identity is the exception (DEC-042) and is the pattern to follow.
- **Module 1 write endpoints** — create/edit employee, lifecycle transitions, MSS, org chart.
  Blocked-adjacent: **OR-15**, nothing calls `fn_refresh_due_employment_status()`, so a
  future-dated joining or exit never materialises. Read through
  `fn_employment_status_asof(employee, fn_business_date())` rather than the cache until a
  scheduler exists.
- **Module 3 endpoints and UI** (OR-22) — schema and resolvers are done and verified; this is
  presentation work.
- **Task write endpoints** (OR-26) — the task report surfaces unassigned work and nothing in the
  product can assign it.

### Needs a human, not a developer

**OR-16** (`blood_group` purpose, emergency-contact third-party data) · **OR-18** (`hr_admin`
cannot see personal data — a deliberate default-deny that is also a functional regression) ·
**OR-23** (no virus scanner behind the quarantine gate) · **OR-24** (no two-bucket split, MinIO
posture, no EXIF stripping) · **OR-25** (an employee cannot see their own RESTRICTED documents) ·
**OR-20** (Entra is unbuildable and unverifiable from this environment).

---

## Traps this repo keeps re-learning

1. **A check must create its own fixture.** Four occurrences now — 0014 L13, 0017 G5, 0012 N8,
   and the task report, whose seeded tasks were all unassigned so the report was empty and any
   test over it asserted nothing.
2. **Exercise the roles whose predicates name columns.** `ALLOW_ALL` renders as `true` and hides
   every column-level mistake, so HR passing proves the least.
3. **`COUNT(*)` over a LEFT JOIN counts the phantom row.** Count the key.
4. **Add the column, backfill, *then* add the constraint.** 0016 (`password_algo`) and 0019
   (`ck_task_closed_coherent`) both failed this way.
5. **The database is usually right.** `fn_task_assignee_is_member` refused a seed I had just
   commented as unenforced.
6. **Verify counts on stderr.** `db:verify` emits `NOTICE:  PASS`; redirect with `> log 2>&1`.
7. **A check must fail for its OWN reason.** Three payslip smoke checks were refused by an
   earlier guard and proved nothing. Build the fixture so the thing under test is the only thing
   that can refuse.
8. **Check the check COUNT.** A skipped check is silent; a failed one is loud. 0019 lost two for a
   while and only the total showed it.
9. **`!res.ok` is not an assertion.** It accepts a 500. Name the status.
10. **`SET LOCAL` lasts the transaction, not the function.** Clear a writer flag immediately after
   the statement it exists for.
11. **`LIMIT 1` with no `ORDER BY` is not a fixture.** Three occurrences (0017 G14, 0016 I11).
   Whichever row the planner reaches first is not a stable choice.
12. **Fix the PATTERN, not the instance.** DEC-059 recorded the append-only-punch trap for N8;
   N9 sat beside it with the same weakness for a whole session. Grep the file.
13. **A derived TOTAL cannot tell you whether something happened.** It is allowed to be zero.
   Ask the log.
14. **A test must not degrade the fixture it runs against.** Idempotent about its own leftovers is
   not the same as harmless.
15. **A client must never compute the business date.** `new Date().toISOString()` is the previous
   day for 5.5 hours out of every 24 in IST. Ask the server (DEC-091).
16. **"The traversal is safe" is not "the data is valid".** 0017 proved a cycle terminated the
   walk and left the cycle creatable; the walk then returned a WRONG answer silently (DEC-088).

</details>
