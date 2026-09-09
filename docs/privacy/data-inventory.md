# Data Inventory

**Status:** first version, 2026-09-08. Written because CLAUDE.md's Forbidden Actions bar adding a
personal-data column without a classification here, and the geolocation punch feature adds the
most sensitive columns in the system so far.

**Jurisdiction:** India — DPDP Act 2023 + DPDP Rules 2025.

> **This is an engineering classification, not a compliance opinion.** No named legal or
> compliance contact exists (OR-03), so nothing here has been reviewed by anyone qualified to
> confirm it. Where a judgement was needed, the *more* restrictive option was taken, so being
> wrong costs a foreclosed feature rather than an exposure. A named contact must review this
> before go-live (Phase 9).

**Classifications:** `PUBLIC_INTERNAL` · `PERSONAL` · `SENSITIVE` · `RESTRICTED`

**Not yet built:** the CI check that fails a migration adding an unclassified column. Until it
exists this file is maintained by discipline, which is weaker than the README claims. Tracked as
OR-12.

---

## Location data — the most sensitive thing here

Employee location is the reason this file finally exists. Three decisions were taken deliberately:

**1. The purpose is presence verification at a work location, and nothing else.** Not movement
tracking, not a productivity signal, not a commute analysis. `attendance_punch` records a location
only at the moment an employee chooses to punch in or out. There is no background collection, no
continuous tracking, and no location on any other table.

**2. The verdict is stored, not just the coordinates.** `matched_location_id`, `distance_m` and
`location_verified` answer the actual question ("was this at the office?") without anything
downstream needing to re-derive it from raw coordinates. A report that needs presence
verification reads the verdict; only an audit of a disputed punch needs the coordinates.

**3. Coordinates are stored at reduced precision — `numeric(9,6)`, about 0.1 m.** That is enough
to confirm an office match and to audit a dispute, and it is capped so the column cannot become a
higher-resolution movement trace than the purpose requires.

**Refusing to share location does not block a punch.** The punch is recorded with
`location_source = 'denied'` and `location_verified = false`, and the UI says so. A system that
forces a location grant to record attendance makes consent meaningless, and an employee on a
device with no GPS would be unable to work.

---

## `attendance_punch` — raw punches (immutable)

| Column | Class | Purpose | Retention | Leaves system |
|---|---|---|---|---|
| `id` | `PUBLIC_INTERNAL` | Surrogate key | With row | No |
| `employee_id` | `PERSONAL` | Whose punch | With row | No |
| `punched_at` | `PERSONAL` | The instant, for late/OT derivation | 3 years* | No |
| `business_date` | `PERSONAL` | The day it counts for (Rule 5: DATE) | 3 years* | No |
| `direction` | `PERSONAL` | in / out | 3 years* | No |
| `latitude` | **`SENSITIVE`** | Presence verification only | **12 months**, then nulled | No |
| `longitude` | **`SENSITIVE`** | Presence verification only | **12 months**, then nulled | No |
| `accuracy_m` | `PERSONAL` | Whether the fix was trustworthy | 12 months | No |
| `matched_location_id` | `PERSONAL` | Which office matched | 3 years* | No |
| `distance_m` | `PERSONAL` | How far from that office | 3 years* | No |
| `location_verified` | `PERSONAL` | The verdict downstream reads | 3 years* | No |
| `location_source` | `PERSONAL` | browser / denied / unavailable | 3 years* | No |
| `note` | `PERSONAL` | Employee's own explanation | 3 years* | No |
| `created_at` | `PUBLIC_INTERNAL` | Audit | With row | No |

**Coordinates are nulled at 12 months while the punch itself is kept.** The verdict survives, so
attendance history stays explainable; the raw location does not outlive its purpose. This is the
one retention rule in the system that shortens a column rather than a row.

\* The 3-year figure is **an engineering placeholder, not a statutory citation.** CLAUDE.md
forbids inferring legal requirements, and no retention schedule has been confirmed. Muster-roll
retention under the applicable labour code must be established before this is treated as settled.

## `work_location` — office geofences

| Column | Class | Purpose | Retention | Leaves system |
|---|---|---|---|---|
| `id`, `code`, `name`, `address` | `PUBLIC_INTERNAL` | Company premises, not personal data | Indefinite | No |
| `latitude`, `longitude`, `radius_m` | `PUBLIC_INTERNAL` | Geofence definition | Indefinite | No |

## `attendance_day` — derived verdict

| Column | Class | Purpose | Retention | Leaves system |
|---|---|---|---|---|
| `employee_id`, `business_date`, `status` | `PERSONAL` | Attendance record | 3 years* | No |
| `first_in_at`, `last_out_at`, `worked_minutes` | `PERSONAL` | Derivation inputs | 3 years* | No |
| `payable_day_fraction` | `PERSONAL` | The only value payroll consumes | 8 years* | No |
| `attendance_policy_id`, `note` | `PERSONAL` | Explainability | 3 years* | No |

## `employee` / `employment`

| Column | Class | Purpose | Retention | Leaves system |
|---|---|---|---|---|
| `full_name`, `employee_number`, `work_email` | `PERSONAL` | Identification | Employment + 8 years* | No |
| `personal_phone` | `PERSONAL` | Contact | Employment + 1 year | No |
| `date_of_birth` | **`SENSITIVE`** | Statutory age checks, gratuity | Employment + 8 years* | No |
| `gender` | **`SENSITIVE`** | Statutory reporting, gender-restricted leave | Employment + 8 years* | No |
| `joined_on`, `exited_on`, `status` | `PERSONAL` | Lifecycle, service length | Employment + 8 years* | No |
| `employment.*` | `PERSONAL` | Effective-dated assignment history | Employment + 8 years* | No |

### Added by migration 0014 / 0015 — the employment lifecycle

| Column | Class | Purpose | Retention | Leaves system |
|---|---|---|---|---|
| `confirmed_on`, `probation_end_on` | `PERSONAL` | Probation and confirmation dates; drive entitlement | Employment + 8 years* | No |
| `resigned_on`, `notice_days`, `last_working_day` | `PERSONAL` | Notice-period and final-settlement arithmetic | Employment + 8 years* | No |
| `exit_type` | `PERSONAL` | resignation / termination / end_of_contract / retirement / death | Employment + 8 years* | No |
| `exit_reason` | **`RESTRICTED`** | Free text justifying an exit. **Never in a list endpoint, never logged, never exported** | Employment + 8 years* | No |
| `personal_email` | `PERSONAL` | Contact after the work account is revoked | Employment + 1 year | No |
| `address_line1`, `address_line2`, `city`, `state_region`, `postal_code` | `PERSONAL` | Statutory records, correspondence | Employment + 8 years* | No |
| `emergency_contact_name`, `emergency_contact_phone`, `emergency_contact_relation` | `PERSONAL` | **Third-party data — see below** | Employment + 1 year | No |
| `blood_group` | **`SENSITIVE`** | Health data. Emergency response only — **purpose unconfirmed, see below** | Employment + 1 year | No |
| `updated_at` | `PUBLIC_INTERNAL` | Change detection | With row | No |

**Three things about this set deserve to be called out rather than buried in a table.**

**1. Emergency contact is data about somebody who is not our employee.** The contact never
supplied it, never consented, and has no relationship with the company. It is collected from the
employee about a third party. It is therefore **purpose-bound to an actual emergency** and must
not be used for any other contact, must never appear in a list or export, and must not be
retained past employment + 1 year. Whether DPDP notice obligations reach a third party named in
an employee record is a question for the legal contact who does not yet exist (OR-03).

**2. `blood_group` is health data with an unconfirmed purpose.** It is a conventional field on
Indian HR forms and plausibly belongs beside the emergency contact, which is why it was added
rather than refused. But no emergency-response process has been described, and health data
collected without a stated purpose is exactly what purpose limitation forbids. **Treated as
`SENSITIVE` and flagged for HR confirmation.** If HR has no emergency-response use for it, the
column should be dropped, not left classified — being wrong here costs a foreclosed field rather
than an exposure.

**3. `marital_status` was deliberately NOT added.** `security-guidelines.md` classifies it and
it is an ordinary HR field, but it is also the precise input Employee Handbook §1.3.4.5 would
consume, and CLAUDE.md's Forbidden Actions bar implementing that clause in any form. Migration
0014's verify suite (check L24) asserts the column is absent, so it cannot be reintroduced
casually. If HR needs it for statutory reporting that is a decision and a DEC entry, not a
column.

## `employment_event` — the append-only lifecycle log

| Column | Class | Purpose | Retention | Leaves system |
|---|---|---|---|---|
| `employee_id` | `PERSONAL` | Whose lifecycle | With row | No |
| `event_type`, `from_status`, `to_status` | `PERSONAL` | What happened | Employment + 8 years* | No |
| `effective_on`, `last_working_day` | `PERSONAL` | When it took effect (Rule 5: DATE) | Employment + 8 years* | No |
| `exit_type` | `PERSONAL` | Why they left | Employment + 8 years* | No |
| `reason` | **`RESTRICTED`** | Free text. On a termination this may describe conduct, performance or health | Employment + 8 years* | No |
| `employment_id` | `PERSONAL` | Which assignment period the event opened | With row | No |
| `recorded_by` | `PERSONAL` | Which employee recorded it | With row | No |
| `recorded_at` | `PUBLIC_INTERNAL` | When we learned of it (bitemporal pair with `effective_on`) | With row | No |

`employment_event.reason` carries the same hazard as `leave_request.reason`: it is free text a
human wrote about another human, and on a termination it is the most sensitive narrative in the
HR module. It is `RESTRICTED`, and `employee.exit_reason` is derived from it (migration 0015),
so there is one value to protect rather than two that can drift apart.

**The table is append-only and its triggers are `ENABLE ALWAYS`**, so it inherits the erasure
tension already recorded in gap 2 below — a DPDP erasure request cannot be satisfied selectively
here. The lifecycle log is arguably the strongest case for that tension being unavoidable: an
employment history that can be edited is not an employment record.

## `employee_document` / `employee_document_version` / `document_type` - migration 0018

**Employee documents are the hardest thing in this inventory to classify, and the reason is
structural: the content is UNSTRUCTURED.** A salary figure in a `numeric` column is masked by the
field registry. The same figure inside an offer-letter PDF is as invisible to the registry as the
font it is set in. So the unit of classification is the DOCUMENT TYPE, and
`document_type.data_class` is what the authorization layer actually reads.

| Column | Class | Purpose | Retention | Leaves system |
|---|---|---|---|---|
| `employee_document.employee_id` | `PERSONAL` | Whose document | With row | No |
| `document_type_code` | `PERSONAL` | Reveals a category - that somebody holds a *medical* certificate is itself information | Employment + 8 years* | No |
| `title`, `issuing_authority` | `PERSONAL` | Identification of the document | Employment + 8 years* | No |
| `issued_on`, `expires_on` | `PERSONAL` | Expiry tracking (Rule 5: DATE) | Employment + 8 years* | No |
| `note` | `PERSONAL` | Free text | Employment + 8 years* | No |
| `withdrawn_reason` | `PERSONAL` | Why it was withdrawn | Employment + 8 years* | No |
| `version.original_name` | `PERSONAL` | The uploader's filename - often contains a name or a number | Employment + 8 years* | No |
| `version.object_key`, `bucket` | `PUBLIC_INTERNAL` | **Contains no personal data by construction** - two UUIDs | With row | **Yes, to object storage** |
| `version.sha256_hex`, `size_bytes`, `content_type` | `PUBLIC_INTERNAL` | Integrity and serving | With row | No |
| `version.scan_status`, `scan_detail` | `PUBLIC_INTERNAL` | Quarantine state | With row | No |
| **the object content itself** | **as `document_type.data_class`** | The document | Per type | **Yes, to object storage** |

**Per-type classification** (`document_type.data_class`, the authoritative list):

| Class | Types |
|---|---|
| `PERSONAL` | `address_proof`, `education`, `experience`, `other` |
| **`SENSITIVE`** | `id_proof` (Aadhaar/passport), `pan_card`, `bank_proof`, `medical` (health data) |
| **`RESTRICTED`** | `offer_letter`, `contract`, `appraisal`, `disciplinary` |

**Four things worth stating rather than leaving implicit.**

**1. The object key deliberately carries no personal data.** It is `<document_id>/<version_id>` -
two UUIDs. This matters more than it looks: object storage backups, bucket listings and S3 access
logs all travel *differently* from the database, on different retention and different access
controls. An employee number in a key would leak through all three. `objectKeyFor()` in
`packages/authz` refuses to build a key from anything that is not a UUID, and migration 0018's
check **D15** asserts against the real rows that no key contains an employee number, name or
email.

**2. Document content leaves the database.** It is the only category in this inventory that does.
It goes to MinIO on the same VM - not to a third party - but it is outside PostgreSQL's access
controls, its backups and its audit triggers. Object-storage credentials are therefore equivalent
to a bulk document export, and MinIO's own retention and encryption-at-rest posture is **not**
established (OR-24).

**3. Every document READ is audited, which is unusual and deliberate.** Most reads are not
recorded. For a document the read *is* the disclosure, so `fn_audit_document` writes a row per
access carrying the subject, the document type and the data **class** - never the content, never
the filename, and never a presigned URL. `security-guidelines.md` lists bulk export as an
alerting signal, and the only way to notice one is to have the individual accesses.

**4. `RESTRICTED` documents are not visible to the employee they are about.** An employee cannot
retrieve their own appraisal or disciplinary record through this API. That is the narrow default
rather than a considered position: whether an employee has a right of access to their own
appraisal is an HR and legal question, not an engineering one. **OR-25.**

## `app_user` / `session`

| Column | Class | Purpose | Retention | Leaves system |
|---|---|---|---|---|
| `email` | `PERSONAL` | Login identifier | With account | No |
| `password_hash` | **`RESTRICTED`** | Credential. Never logged, never exported | With account | No |
| `session.token_hash` | **`RESTRICTED`** | SHA-256 of the cookie value; the value itself is never stored | Session lifetime | No |
| `last_login_at`, `is_enabled`, `role` | `PERSONAL` | Access control and audit | With account | No |

## Leave, work and audit

| Table | Class | Notes |
|---|---|---|
| `leave_request`, `leave_ledger`, `leave_account` | `PERSONAL` | `reason` is free text an employee wrote and may reveal health or family circumstances — treat as `SENSITIVE` in any export |
| `work_log`, `work_log_entry` | `PERSONAL` | `description` is narrative. ADR-0017: purpose-bound, employee-visible, **24-month** retention, no productivity scoring |
| `audit_event.source_ip` | `PERSONAL` | Security audit. Append-only, so it cannot be erased selectively — a known tension with erasure rights |
| `audit_event` actor/subject ids | `PERSONAL` | Append-only, decade retention |
| `outbox_event.payload` | Varies | Carries whatever the domain event carries. **Not classified per-event yet** — a gap |

---

## Known gaps, stated rather than hidden

1. **No CI check.** The README promises a build-time failure for an unclassified column. Not
   built, and there is no CI pipeline at all (OR-13 area). Discipline only.
2. **`audit_event` and `leave_ledger` are append-only**, so an erasure request cannot be
   satisfied selectively there. The interaction between append-only integrity and DPDP erasure is
   undecided and needs a decision, not a workaround.
3. **`outbox_event.payload` is unclassified**, because it is polymorphic. Per-event-type
   classification is needed before the drain worker fans out to anything external.
4. **Retention is not enforced anywhere.** No job nulls coordinates at 12 months or drops
   narrative at 24. The numbers above are commitments, not controls.
5. **`blood_group` has no confirmed purpose** and `emergency_contact_*` is third-party
   data with no notice mechanism. Both arrived with the lifecycle columns of migration 0014 and
   both need HR or the legal contact to confirm or remove them, not a developer's judgement.
6. **Every retention figure marked \* is an engineering placeholder** awaiting a confirmed
   retention schedule and a named legal owner (OR-03).

---

## Pay data — `payslip`, `payslip_line` (migration 0024)

Pay is the second most sensitive thing in this system after location, and it is the only category
with its own **database role boundary**.

**1. The purpose is issuing and retrieving a wage slip, and nothing else.** Not benchmarking, not
a performance signal, not an input to any ranking. Nothing in this system computes pay: HR records
a payroll result finalised elsewhere and attaches the issued PDF. ADR-0012 is **BLOCKED** on
build-versus-buy and owns the engine decision, so no rate, threshold or formula is stored here.

**2. `hrm_app` has no grant at all on these tables**, per `rbac-rules.md` structural integrity
item 5 — "so a SQL injection in the leave module physically cannot read salary". This is *not* the
default: migration 0008 sets `ALTER DEFAULT PRIVILEGES … GRANT SELECT ON TABLES TO hrm_app`, so
every new table is readable by that role unless a migration revokes it. 0024 revokes explicitly
and check **PS20** asserts it. A future compensation table that forgets this inherits the grant
silently, which is why the check enumerates the tables rather than trusting the migration.

**3. The reach is narrower than for any other HR resource.** The subject (a wage slip is theirs),
`hr_admin` and `finance` — and nobody else. **A line manager gets nothing**, unlike every other
operational resource where they read their subtree; `hr_ops` gets nothing either, although it
holds every other HR resource unconditionally. `is_ancestor_of_actor` is a **deny-override**, so
no one reads the payslip of somebody above them in their own reporting line even while holding
`hr_admin` — the rule `rbac-rules.md` states explicitly about compensation.

**4. The audit trail deliberately holds no amounts.** Every read and every write emits an
`audit_event` recording the period, the resulting status and the data class touched. It records no
figure, because `audit_event` is append-only with decade retention — logging net pay there would
create a second, permanent salary register in the one table nobody can redact. Check **PS23**
asserts `fn_audit_payslip` references no money column.

### `payslip`

| Column | Class | Purpose | Retention | Leaves system |
|---|---|---|---|---|
| `id` | `PUBLIC_INTERNAL` | Surrogate key | With row | No |
| `employee_id` | **`RESTRICTED`** | Whose pay | 8 years | No |
| `period_start`, `period_end` | **`RESTRICTED`** | The pay period (Rule 5: DATE) | 8 years | No |
| `pay_date` | **`RESTRICTED`** | When it was paid | 8 years | No |
| `status` | **`RESTRICTED`** | draft / issued / void — "there is no payslip for March" is itself information about somebody's pay | 8 years | No |
| `declared_net_minor` | **`RESTRICTED`** | Net pay as printed on the PDF, integer paise (Rule 4) | 8 years | No |
| `currency_code` | **`RESTRICTED`** | ISO 4217 | 8 years | No |
| `document_id` | **`RESTRICTED`** | The issued PDF | 8 years | No |
| `note` | **`RESTRICTED`** | HR's own note | 8 years | No |
| `source` | `PUBLIC_INTERNAL` | `manual_entry` — keeps the ADR-0012 boundary legible | With row | No |
| `void_reason` | **`RESTRICTED`** | Why it was withdrawn | 8 years | No |
| `created_by`, `issued_by`, `voided_by` | `PERSONAL` | Which HR user acted — about the ACTOR, not the subject | 8 years | No |
| `created_at`, `issued_at`, `voided_at`, `updated_at` | `PUBLIC_INTERNAL` | Bookkeeping | With row | No |

### `payslip_line`

| Column | Class | Purpose | Retention | Leaves system |
|---|---|---|---|---|
| `id`, `payslip_id` | `PUBLIC_INTERNAL` | Keys | With row | No |
| `component_code` | **`RESTRICTED`** | Which earning or deduction. Discloses more than the amount does — an `advance_recovery` line says somebody took a salary advance, and `lwp_recovery` says they lost pay | 8 years | No |
| `amount_minor` | **`RESTRICTED`** | Integer paise, signed (Rule 4) | 8 years | No |
| `note` | **`RESTRICTED`** | Line explanation | 8 years | No |

### `payslip_event`

| Column | Class | Purpose | Retention | Leaves system |
|---|---|---|---|---|
| `payslip_id`, `event_type`, `from_status`, `to_status` | **`RESTRICTED`** | The append-only transition log | 8 years | No |
| `subject_employee_id` | **`RESTRICTED`** | Denormalised so no-self-issue can be a CHECK | 8 years | No |
| `actor_employee_id` | `PERSONAL` | Who acted | 8 years | No |
| `reason` | **`RESTRICTED`** | Why a payslip was voided | 8 years | No |

### `payslip_component_type`

Configuration, not personal data: the catalogue of what *may* appear on a payslip.
`PUBLIC_INTERNAL` as a table — but reading it is gated on `payroll.payslip.manage`, because the
vocabulary of the pay register is not something an employee needs.

### The PDF itself

Stored as an `employee_document` of type `payslip`, classified **`RESTRICTED`** and not
self-uploadable. **Retention is 8 years**, which is the longest in this inventory and is the one
number here that a qualified person must confirm: it was chosen to sit alongside the existing
8-year document types rather than derived from a statutory retention period for wage records.
Object content is the only data in this inventory that leaves PostgreSQL, so OR-24 (MinIO's
encryption-at-rest, retention and access-log posture) applies to payslips with more force than to
anything else already stored there.

**Open question for a qualified reviewer (OR-03):** an employee's right of access to their own pay
records, and the interaction between the 8-year retention above and a deletion request under the
DPDP Act. Wage records are ordinarily retained under statute regardless of consent, but which
statute and for how long is not an engineering judgement.
