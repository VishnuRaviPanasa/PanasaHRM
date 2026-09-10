# Domain Glossary

**Read before any naming task or user-facing text.** One word per concept, used identically in
the schema, the API, the UI and conversation. **A new concept gets an entry here in the same
commit that introduces it.**

## People

| Term | Means | Not to be confused with |
|---|---|---|
| **Person** | A human being. Survives rehire | Employee. One person may have two employments over time |
| **Employee** | One employment relationship with the group. Has an employee number and a lifecycle | Person; User |
| **User** | A login. Not every user is an employee (external auditor, service account); not every employee has one (shop-floor staff) | Employee |
| **Employment** | The effective-dated assignment: legal entity, org unit, designation, grade, location, schedule, manager, valid over a period | Employee. This is where org history lives |
| **Assignment slot** | Distinguishes concurrent employments. Slot 1 is primary | - |
| **`hired_on`** | Date this employment began | `service_start_on` |
| **`service_start_on`** | Continuous-service start. **Differs from `hired_on`** after a contract-to-permanent conversion | `hired_on`. Gratuity depends on this one, and conflating them underpays by years |
| **Reporting relationship** | Effective-dated manager link, typed `solid` / `dotted` / `functional` | Project membership - a different graph entirely |

## Organization

**Legal entity** - a registered company. **Org unit** - department/team/BU, hierarchical.
**Location** - a physical site, carrying the state that drives the holiday calendar.
**Designation** - job title. **Grade** - compensation band.

## Leave

| Term | Means |
|---|---|
| **Leave type** | CL, SL, ML, comp-off, LWP, WFH |
| **Leave policy** | Effective-dated rules for a type: accrual, caps, carry-forward, expiry |
| **Leave year** | 1 Jan - 31 Dec. Explicit, never implied from a date expression |
| **Entitlement** | What the policy grants for a year |
| **Accrual** | A credit posting to the ledger |
| **Ledger** | Append-only record of every credit and debit. **Authoritative** |
| **Balance** | Derived: `accrued + carried_in + adjusted - taken - pending - encashed - lapsed` |
| **Hold** | Balance reserved by a submitted-but-unapproved request. A real ledger entry |
| **Carry-forward** | Unused CL moved to the next year, capped |
| **Lapse** | Entitlement lost to a cap or an expiry date |
| **Lot** | A credit with an expiry, consumed FIFO by `expires_on` |
| **Comp-off** | Earned by approved work on a week-off or holiday. Expires in 3 months |
| **Sandwich rule** | Whether holidays/week-offs *between* leave days count as leave. **Currently OFF** |
| **Optional holiday** | A holiday the employee elects from a pool. Also "restricted holiday" |

## Attendance

**Punch** - one immutable clock event. **Business date** - the date a punch is attributed to,
**computed at ingest and stored**, because the IST offset makes UTC truncation wrong before
05:30. **Attendance day** - the derived daily verdict. **Payable day fraction** - 0, 0.5 or 1.0;
**the only value payroll consumes**. **Regularization** - an approved correction to a day.
**Shift** / **Roster** / **Week-off**.

## Work

**Project** - a client engagement or internal initiative. **Project member** - effective-dated
assignment of a person to a project; **this is the project authorization graph**.
**Work log** - one row per employee per day. **Work log entry** - a line item: project, task,
**minutes**, description. **Timesheet period** - the approvable, lockable unit (weekly or
monthly), *not* the individual day. **Effort** - always integer minutes; never decimal hours.
**Effort cost** - money derived at report time from effort x an effective-dated rate; it is
never stored on a work log entry (ADR-0016). Reading it is the action
**`work.effort_cost:read`**, resolved through `AuthorizationService` - not a `comp_viewer`
flag, which was an earlier name for this and must not appear in code.

## Workflow

**Definition** (versioned, immutable once published) · **Instance** (one running approval) ·
**Task** (one step assigned to one approver) · **Actor rule** (how an approver is resolved) ·
**Delegation** (time-bounded reassignment) · **Escalation** (an SLA-breach action).

## Cross-cutting

**Outbox event** - a domain event written in the same transaction as its domain change.
**Audit record** - append-only, who did what to whom, when and why.
**As-of date** - the date a temporal query resolves against.
**Effective date** - the date a change takes business effect (may be past or future).
**Change class** - A, B or C; determines review ceremony.
**Slice** - one unit of work, with acceptance criteria written as test names.

## Assistant (ADR-0020)

| Term | Means | Not to be confused with |
|---|---|---|
| **Assistant** | The in-product AI feature: the chat panel and the module behind it. Answers questions about data the asker may already see | "Bot", "chatbot", "copilot" - none of which appear in the schema or the API |
| **Tool** | One entry in the assistant's fixed catalogue: a parameterised, read-only query bound to exactly one existing authz action | An API endpoint. A tool has no route of its own and adds no permission |
| **Catalogue** | The whole set of tools. Filtered per actor by `assertCan` before the model ever sees it | The tools a given actor can reach, which is a subset and differs per request |
| **Domain router** | The first model call, which narrows the catalogue to one domain before tool selection | The tool selection itself, which is the second call |
| **Refusal code** | The closed-set reason an assistant turn produced no answer - `no_tool`, `not_permitted`, `forbidden_purpose`, `ambiguous`, `too_many_rows`, `timeout`, `no_rows` | An HTTP status. A refusal is a successful turn that declined |
| **Answer** (assistant) | The sentence above a result table, written by the model **from the masked rows** since DEC-140. It states the figures that answer the question | The data itself. The table below it comes from Postgres and is the check on the answer, never derived from it. Before DEC-140 this was called **Narration** and was written from column names and a row count only |
| **Suppressed** | What an aggregate returns when its group is smaller than k=5 (ADR-0017) | Zero, empty, or null - all of which state a fact about the data, which is the thing being withheld |

## Words we deliberately do not use

| Avoid | Use | Why |
|---|---|---|
| "Vacation" | Leave | The handbook and Indian practice say leave |
| "PTO" | Leave, by type | Types have different rules; the abstraction hides them |
| "Manager" (unqualified) | **Line manager** or **project manager** | Two different graphs. This ambiguity is a security bug waiting to happen |
| "Timesheet" for attendance | Work log (effort) vs attendance (presence) | ADR-0015 - conflating them is how payroll becomes indefensible |
| "Delete" for records | Archive, close, supersede | Transactional records are never deleted |
| "Active employee" (in a query) | State the as-of date | A global `status = active` filter is what makes historical reporting impossible |
| "Chatbot" / "copilot" / "bot" | **Assistant** | One name in the schema, the API, the UI and conversation. `assistant` is also the module and the table prefix |
| "The AI knows X" | **A tool returned X** | The model never sees data. Saying it "knows" invites the belief that it remembers, which it must not and does not |
| "Text-to-SQL" (of what shipped) | **Tool calling** | ADR-0020 rejected text-to-SQL. Calling this that would make the next reader look for a sandbox that does not exist |
