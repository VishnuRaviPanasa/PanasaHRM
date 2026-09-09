# Current Slice

**Slice ID:** MST-01 — HR masters (employee, department, designation)
**Status:** **DONE and verified end to end** — HR creates → PostgreSQL → PDF in MinIO →
employee retrieves only their own → PDF downloads byte-identical → cross-employee access
proven denied.
**Track:** Full product build, foundation first (DEC-031)
**Class:** **C** — schema + authorization + file upload. Full gate.

---

## Verified baseline — the regression bar. No slice may land that breaks any of it

| Suite | Result |
|---|---|
| `node scripts/migrate.mjs status` | **26/26** applied |
| `npm run db:verify` | **262 PASS, 0 FAIL** (order-independent: re-checked after every mutating suite) |
| `npm run authz:test` | **423 passed, 0 failed** (50 actions, 300 cells both directions) |
| `npm run upload:test` | **45 passed, 0 failed** |
| `npm run docs:test` | **52 passed, 0 failed** |
| `npm run privacy:test` | **20 passed, 0 failed** |
| `npm run settings:test` | **15 passed, 0 failed** |
| `npm run reports:test` | **63 passed, 0 failed** |
| `npm run payslip:test` | **80 passed, 0 failed** (idempotent, and leaves the seeded payslips alone) |
| `npm run masters:test` | **49 passed, 0 failed** |
| `npm run nav:test` | **21 passed, 0 failed** (needs the web server on :3100) |
| `npm run demo:test` | **ALL DEMO STEPS PASSED** |
| `npm run punch:test` | **PUNCH FLOW OK** (18 checks) |
| `node testing/hooks/guards.test.mjs` | **61 passed, 0 failed** |
| `api:build` · `web:build` · `authz:build` | clean |

**1,109 automated checks, 0 failures** (262 DB + 423 authz + 80 payslip + 63 reports + 61 hooks
+ 52 docs + 49 masters + 45 upload + 21 nav + 20 privacy + 18 punch + 15 settings, plus the
demo walkthrough). Every number above was observed in this session, not carried
forward: `db:verify` counts `NOTICE:  PASS` on stderr, so count it with
`npm run db:verify > log 2>&1` and grep the file - redirecting only stdout reports 0.

**And check the COUNT, not just the absence of failures.** 0019's W14/W15 silently skipped for a
while and the only symptom was 230 where 232 was expected (DEC-079). `db:verify` is re-run after
the app suites for the same reason - it must be order-independent.

## Modules delivered so far

| # | Module | State |
|---|---|---|
| 1 | Employee & Core HR | Lifecycle schema (0014/0015) + ESS `/profile`. **No write endpoints** |
| 2 | Identity & Access | Identity/roles schema (0016) + `packages/authz`. **Tested; enforced only in Documents** (OR-19) |
| 3 | Organization | Structure schema (0017). **No endpoints or UI** (OR-22) |
| 4 | **Employee Documents** | **Complete and working end to end** — schema, storage, endpoints, authz, audit |

## Module 4 — what landed

### Migration 0018 + 19 verify checks

- **`document_type`** — reference data carrying `data_class`. The TYPE is the unit of access
  control, because content is unstructured and `fieldMask` cannot reach inside a PDF.
  12 types; `offer_letter` / `contract` / `appraisal` / `disciplinary` are RESTRICTED.
- **`employee_document`** (logical, mutable metadata, withdrawn-never-deleted) +
  **`employee_document_version`** (append-only, one object each, DB-assigned version numbers).
- **Five controls in the database**, not just the handler: MIME allowlist as a CHECK with **SVG
  absent**; quarantine gate (`current_version_id` cannot point at a non-`clean` version);
  `sha256_hex` per version; immutable versions apart from scan bookkeeping; **no PII in object
  keys**, asserted against real rows by check **D15**.
- **`fn_audit_document`** — records subject, type and data **class**, never content or filename.

### `packages/authz/upload-validation.ts` + 45 checks

Magic bytes must agree with the **declared type AND the extension**. Catches: a PNG named and
declared `.pdf`; `payload.pdf.exe` (last-dot resolution); an SVG smuggled inside a `.docx`
declaration; MZ and ELF binaries (**named** in the alert, not "unknown"); a JPEG declared as PNG
(both allowed types — the allowlist alone is not enough); DOCX/XLSX decompression bombs by ratio
**and** absolute size. Every rejection carries an `alert` flag, because a polyglot attempt is an
attack signal and downgrading it to a validation message loses the detection.

### Object storage — real, verified

MinIO on 59000. Bytes round-trip **byte-identical**. Objects on disk are keyed by two UUIDs with
no PII in the path (confirmed by inspecting `/data/hrm-documents`). SHA-256 is **re-verified on
the way out**; a mismatch refuses to serve and alerts (OWASP A08).

**No presigned URLs** (DEC-046) — content streams through the API, so revocation works, every
access is audited, and no credential-bearing URL can reach a log.

### THIS IS THE FIRST MODULE THAT ENFORCES `packages/authz`

`assertCan` for the act, `scope()` composed **into** the list query, `maskRow` at serialisation,
and the document class travelling on the ref. `apps/api/src/authz.ts` is the binding — a
`DbGraphPort` over 0014's resolvers plus an audit sink writing every deny. **It is the pattern
the remaining 29-route retrofit follows.**

A **line manager gets nothing** here (DEC-049) — the one place the reporting graph is narrowed,
because a manager has no business reading a report's Aadhaar or medical certificate.

## Exact next action

1. **The route retrofit (OR-19)** — still the highest-value work. `apps/api/src/documents.ts` and
   `authz.ts` now demonstrate the whole pattern end to end, so this is mechanical rather than
   exploratory: convert 29 routes to `@Authorize`, compose `scope()`, delete the inline SQL role
   checks in `hr.ts:43,51` · `leave.ts:175,201` · `work.ts:375,394,431,443`, add the fail-closed
   global guard and the boot assertion (`assertPolicyCoverage` already exists and is tested).
2. **AUDIT-01** — domain events + outbox in the same transaction as every write. `fn_audit_security`
   and `fn_audit_document` are the working patterns; `audit_column_policy` still holds 0 rows.
3. **A documents UI** — there is no screen at all yet; the module is API-only.
4. **Migration 0019** — `project_member` effective-dated (OR-17).

## Traps confirmed on this machine

- **`docker exec` needs `-i`** for a heredoc, or psql silently produces nothing.
- **Long/complex `bash` heredocs break.** Write the script to a file and run it — a Python patch
  script with apostrophes in prose failed with `unexpected EOF` even inside a quoted heredoc.
- **Windows reserves TCP 56291–56390** — swallowed the Redis default 56379 (now 55379, DEC-037).
- **A migration adding a column AND a CHECK on it must backfill in between** (0016 refused first).
- **Any new table referencing `employee` breaks the seed**, which deletes it. 0014, 0016, 0017 and
  0018 all hit this. 0018 additionally has a **circular FK** (document ↔ current version), so the
  seed nulls `current_version_id` first.
- **A verify check must create its own fixture** — 0014's L13 and 0017's G5 both went vacuous
  against seed state they did not create.
- **Catch the right SQLSTATE.** 0018's D12 expected `restrict_violation` from a TRUNCATE trigger,
  but the FK refuses first with `feature_not_supported`.
- Migrations are checksum-enforced (DEC-012): a defect in an **applied** migration is fixed by the
  next one. An unapplied one can still be edited.
- Backgrounded servers get reaped between turns — restart with `nohup node dist/main.js` from
  `apps/api`, after killing whatever holds port 4000.
