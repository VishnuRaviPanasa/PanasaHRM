# ADR-0020: The Onboarding Boundary — Where Hiremate Ends and This System Begins

## Status

Proposed

> Only a human may set this to Accepted. Once Accepted this file is immutable and
> `.claude/hooks/guard-adr.mjs` will refuse edits - supersede it with a new ADR instead.

## Date

2026-09-09

## Context

The request was "can we implement Hiremate (candidate onboarding) application's features here".

Hiremate is a working application on the same machine, with an FRD and a 19-state
`OnboardingStatus` enum. Its domain is: candidate, candidate documents, background verification
(BVG, its checks and its document requests), onboarding tasks, training modules and progress,
equipment requests, onboarding communications, reminders, approval workflow and workflow
transitions, notifications, and its own users and auth.

**Copying it is permitted; coupling to it is not.** ADR-0018 says so directly - other systems on
this machine are "reference material only. Copying a *pattern* is encouraged; creating a *coupling*
requires a superseding ADR." So the question this ADR answers is not *may we* but **how much of
that domain belongs here at all**, because three things make "port it" the wrong shape:

**1. The mission says post-hire.** `CLAUDE.md` scopes this product to "post-hire HR: employee
master data with history, org structure, leave, daily work management, attendance, documents,
approvals and audit." Of Hiremate's nineteen states, thirteen are pre-offer - `created`,
`password_reset_pending`, `documents_pending`, `documents_submitted`, `documents_under_review`,
`documents_approved`, `documents_rejected`, `finance_review_pending`, `finance_approved`,
`delivery_review_pending`, `delivery_approved`, `offer_sent`, and the terminal `offer_declined`.
Porting those makes this an applicant-tracking system as well as an HRM, which is a product
decision and not an engineering one.

**2. It would be an eleventh bounded context.** `ai/context/architecture-principles.md` enumerates
ten, each owning its own tables, with a stated dependency rule and no cycles. `onboarding` is not
among them. ADR-0014's amendment established that changing that list is an architectural act: its
seam 3 was written as though an `ai` module existed, and had to be corrected precisely because an
Accepted ADR outranks `ai/context/` and would have silently invalidated the ten-module list.

**3. Roughly half of Hiremate duplicates capabilities this system already has, in stronger form.**
Its `approvalWorkflow` and `workflowTransition` are a hand-rolled state machine with a
`STATUS_RANK` table and a `STATUS_PREDECESSOR` fallback map; ADR-0007 already provides a generic
FSM defined as data, shared by leave, timesheets, attendance corrections and reimbursement. Its
`candidateDocument` is an Azure-Blob-backed store; the `documents` module already has MinIO,
versioning, expiry, retention classes and a `docs/privacy/data-inventory.md` classification
requirement. Its `notification` and `notificationPreference` tables duplicate `notifications`. Its
`user`, `refreshToken` and `passwordResetToken` duplicate `identity` under ADR-0009 and ADR-0010.
A port would therefore mean deleting about half of what was ported, and the half that survives is
the half nobody has built here.

### What the existing ADRs already decide, so this one need not

- **ADR-0018**: employee records **originate here**. "New hires are created by HR directly, or
  seeded through the bulk importer with dry-run validation." The duplicate data entry that implies
  is a price that ADR already accepted, by name.
- **ADR-0018** also draws the infrastructure/application line that settles two of Hiremate's three
  integrations: an **SMTP relay is infrastructure and permitted**; **JIRA Cloud is an application**,
  so `jira_triggered` cannot be reproduced as an API call without superseding ADR-0018. Azure Blob
  is moot - this system has MinIO.
- **Must-Know Rule 12**: no external call on the request path. Hiremate calls JIRA and SMTP
  synchronously and swallows failures in try/catch. Anything equivalent here goes through the
  transactional outbox to a worker.
- **ADR-0014**: forbidden regardless of any later decision - "any AI input to hiring, promotion,
  compensation, performance rating, discipline or termination". Candidate evaluation is the single
  most tempting place to breach that.

## Options considered

| Option | Summary | Why not chosen |
|---|---|---|
| Port all 19 states | Rebuild candidate sourcing, document collection, finance and delivery review, offer issue and background verification here | Turns an HRM into an applicant-tracking system, contradicts the post-hire mission, duplicates a working application, and puts candidate evaluation - the thing ADR-0014 most wants kept away from automation - inside the system that also holds every employee record |
| Integrate with Hiremate | Read its database, or subscribe to a webhook when a candidate is hired | Forbidden by ADR-0018 without superseding it, and the coupling is the expensive kind: this system's employee record would become downstream of another application's schema |
| Do nothing | Leave all onboarding in Hiremate | The post-offer tail - employee ID, induction training, equipment, first-day tasks - is *already* post-hire HR work, and leaving it outside means the new joiner's first two weeks are tracked in a system that knows nothing about their leave, their manager or their documents |
| Boundary at `offer_accepted` | Hiremate owns everything up to and including the accepted offer; this system owns the tail | **Proposed by the first draft and REJECTED by the product owner.** It leaves the approval chain - the part with three people and a signature in it - in a system that does not hold the employee record |
| **The approval chain here, on a pre-boarding employee (chosen)** | Annexure, finance approval, delivery approval and offer letter live here; candidate sourcing and background verification stay in Hiremate | - |

## Decision

> **REVISED 2026-09-09, BEFORE ACCEPTANCE.** The first draft of this ADR proposed the boundary at
> `offer_accepted` - Hiremate keeping candidates, documents, background verification, the finance
> and delivery reviews and the offer, and this system taking only the post-offer tail. **The
> product owner rejected that boundary** and specified the chain directly: *"Employee creation,
> documents upload, payslip creation, send payslip to finance head for approval, delivery head
> approval, offer letter creation. So we need finance head user type, delivery head user type."*
>
> The Context above is unchanged and still argues honestly for the narrower line; it is left in
> place because the reasoning against this scope is the thing a future reader most needs, and
> deleting it would make the decision look easier than it was. What follows is the decision that
> was actually taken.

**The approval chain lives here, and it hangs off a pre-boarding EMPLOYEE rather than a
candidate.** `pre_boarding` was already a lifecycle state with `pre_boarding --joined--> active` in
`employment_status_transition`, so there is no second person-entity: the joiner is an employee from
the moment HR creates them, and an employee whose joining date has not arrived is exactly what
"pre-boarding" already meant.

### What was built

| Piece | Where |
|---|---|
| A seventh role, `delivery_head` | 0031. `finance` already existed and is reused as the finance head |
| Any granted role can now be given a login | 0031 - `ck_app_user_role` permitted three values while the grant table permitted six, so a finance head could not sign in at all |
| `offer_declined`, terminal, from `pre_boarding` only | 0031 |
| The salary annexure, its components, its FSM-as-data and its event log | 0032 |
| A decline may precede the joining date | 0033 - the one lifecycle event whose meaning is *there will be no joining date* |
| Four separate authorization actions | `packages/authz`, 413 matrix cells |

### It is an ANNEXURE, not a payslip

This was the one question whose answer changed the schema, and it was asked before any table
existed. A payslip is a statement of what was **paid**: it carries a pay period, an 8-year
retention class, and 0024's invariant reconciling the summed net against a net typed separately
from the printed document. Before somebody joins, nothing has been paid and there is no document to
reconcile against. What finance approves pre-offer is the **compensation being offered** - the CTC
breakup that the offer letter will quote.

**Nothing is calculated.** ADR-0012 is *"Proposed - BLOCKED, do not accept"*, so no statutory or
gross-to-net computation may exist in this product. Components are entered; the total is a sum of
what was typed; and the annual CTC is typed a second time and must agree with that sum before the
annexure may go to finance. That reconciliation is the same device 0024 uses, for the same reason:
a component out by a factor of ten is silent otherwise, and it is the number the offer letter will
carry.

### Separation of duty is the point, and it is enforced twice

HR prepares, the finance head approves the money, the delivery head approves the hire, HR issues
the letter. Four matrix actions rather than one, because a single `decide` would mean the two
approvers hold the same permission and only the application remembers which is which. **`hr_admin`
is denied both approvals**: they typed the figures, and an approval by the author is not an
approval.

The database says the same thing from the other side, so neither layer is the only thing standing
between a package and its own author signing it: `ck_sae_no_self_approval` refuses an event whose
actor is its subject, the event log carries a composite foreign key onto the whole
`(event_type, from_status, to_status)` triple so a step nobody designed cannot be taken, and
`trg_sac_draft_only` freezes the components the moment the annexure leaves draft - because if
approved figures can be edited, the approval is decorative.

### What is still Hiremate's, and why the coupling rule is unchanged

Candidate sourcing, screening and background verification stay there. Nothing in this decision
creates an integration: there is no endpoint, token, webhook, scheduled sync, cross-system read or
`hiremate_candidate_id` column, and ADR-0018 continues to hold in full. HR re-enters the joiner
here, which is the duplicate data entry that ADR-0018 already priced and accepted by name.

**JIRA still cannot come across.** ADR-0018 classifies an SMTP relay as *infrastructure* and
permits it, but JIRA is an *application*, so reproducing Hiremate's `jira_triggered` as an API call
would need a superseding ADR. Equipment and access provisioning belongs here as a request a human
fulfils.

### The eleventh context

`onboarding` is a new bounded context and a **leaf**: it may depend on `people`, `documents`,
`identity` and `audit`, and nothing may depend on it. `ai/context/architecture-principles.md` must
go from ten contexts to eleven **if and only if** this ADR is Accepted - the list and the ADRs must
not disagree, and by authority order the ADR wins.

### Carried prohibitions

Everything ADR-0014 forbids stays forbidden. No AI input to hiring, promotion or compensation, and
no scoring of any kind - which stays easy to honour, because no candidate evaluation happens in
this system at all.

## Consequences

### Positive

- The post-hire mission stays intact, and the eleventh context is a leaf that cannot create a cycle
- Onboarding tasks reuse the FSM, the document store, the notification dispatcher and the audit
  trail rather than growing parallel versions - which is most of the work already done
- A new joiner's first two weeks are visible beside their leave, manager, documents and attendance
- Zero coupling, so Hiremate can change, be replaced, or be retired without touching this system
- Background verification data - the most sensitive category in Hiremate, and about people who may
  never join - never enters the employee system of record

### Negative / trade-offs

- **A person who declines an offer is an employee record that can never be deleted.**
  `employment_event` is append-only and holds a foreign key to `employee`, so the row is permanent.
  `offer_declined` is terminal and reachable only from `pre_boarding`, and every count of "our
  people" must now exclude it. The as-of headcount reports already do, because a non-joiner never
  opens an employment period - the directory lists employees directly and will show them until it
  filters
- Two more roles is two more columns in every future authorization decision; the matrix grew from
  354 cells to 413 for one role

- **HR types the new joiner's details twice**, once in Hiremate and once here. This is the explicit
  price of ADR-0018 and it is not mitigated, only accepted. It is the single most likely reason
  somebody will later ask for an integration
- Two systems know about one person during their first weeks, and neither is authoritative for the
  whole span. The boundary is discoverable only by knowing this ADR
- `training_completed` and `onboarded` become this system's states, so a Hiremate report on
  "onboarded candidates" will go stale unless it is retired
- The `onboarding` module is genuinely new work - tables, endpoints, UI, tests - not a port

### Neutral

- Hiremate's SMTP use is reproducible here (ADR-0018 permits SMTP as infrastructure) but must go
  through the outbox to a worker, which does not yet exist. Until it does, onboarding notifications
  are in-app only

## Reconsider when

- HR reports the duplicate entry as a real cost rather than a theoretical one. The answer is still
  not an integration: it is a **CSV export from Hiremate imported through the existing bulk
  importer with dry-run validation**, which is data movement by a human, not a coupling
- Panasa decides to retire Hiremate. Then the pre-offer states become a live question and this ADR
  is the thing to supersede
- A ticket system becomes load-bearing for equipment provisioning. That is a coupling and needs a
  superseding ADR, not a config flag
