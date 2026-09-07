# Severity Vocabulary

**Status:** Active · **Owner:** Engineering
**Applies to:** every agent, script, review or report that emits a finding in this repo.

Exactly four levels exist. **Aliases are forbidden** — not `Info`, `Warning`, `Blocker`, `Major`,
`Minor`, `Nit`, `P0`/`P1`/`P2`, `sev1`, or emoji. A single vocabulary is what lets CI count
findings without parsing prose, and lets a human trust that two reviews mean the same thing.

## The four levels

| Level | Means | Gate effect |
|---|---|---|
| `CRITICAL` | A correctness, security or data-integrity defect that **will** cause harm if merged. Wrong money, wrong balance, leaked personal data, lost history, bypassed authorization, destroyed data | **Blocks merge. No waiver.** |
| `HIGH` | A real defect or a violation of a Must-Know Rule that will cause harm under conditions that are likely to occur | **Blocks merge** unless explicitly waived with a DEC entry naming a reason, an owner and a review date |
| `MEDIUM` | A genuine problem that should be fixed, but whose failure mode is bounded, recoverable, or unlikely in practice | Does not block. Tracked |
| `LOW` | Style, clarity, naming, minor duplication, a better available idiom | Does not block. May be ignored |

## Field names — exact, no variants

```json
"severity_counts": {
  "critical_count": 0,
  "high_count": 0,
  "medium_count": 0,
  "low_count": 0
}
```

Per-finding, the field is `"severity"` and its value is the **upper-case** level string.

## Calibration — the part that actually matters

A vocabulary is worthless if two reviewers rate the same defect differently. These are the
calls that get made wrong most often in this codebase.

### Always CRITICAL

- A float used for money or a leave balance
- A date-only value stored as a timestamp (`joined_on`, `work_date`, `leave_date`, `business_date`)
- A route with no authorization check, or a role check written outside `packages/authz`
- A list endpoint not scoped by `scopeFor` — one employee can read another's rows
- A `SENSITIVE` or `RESTRICTED` field reaching a caller not entitled to it, including via list,
  export or search
- An effective-dated row **updated in place** instead of closing the period and opening a new one
- A leave balance mutated without a ledger entry
- A state change with no audit record, or one emitted outside the write transaction
- A destructive migration with no `-- IRREVERSIBLE:` marker
- Any `EXCLUDE` constraint added without the companion `CHECK (NOT isempty(...))` — an empty
  range slips past the constraint silently, and the row then vanishes from every as-of query

### Usually HIGH, not CRITICAL

- A missing index on a query that will be hot at 5,000 employees but is fine at 50
- A missing negative (deny) test on a matrix cell whose positive case passes
- An N+1 query in a repository
- A missing `Idempotency-Key` on a balance-affecting endpoint
- Business logic that belongs in configuration but is hardcoded

The distinction: **CRITICAL is "this is wrong now"; HIGH is "this will be wrong soon, or is
unprovable."**

### Deliberately not HIGH

- Test coverage below a floor, where the untested paths are genuinely low-risk — coverage is a
  diagnostic, not a goal
- Naming that is merely not your preference
- Any finding you cannot point at with a `file:line` that exists in the diff

## The rule that keeps this honest

> **A finding you cannot locate is not a finding.** Every emitted finding carries a `file`, a
> `line` that exists in the diff, and a `rule_ref` anchor that exists in the cited document.
> `scripts/verify-findings.mjs` asserts all three. A fabricated finding fails mechanically,
> which is the only defence against a confident review of code that was never read.

## Escalating and de-escalating

Raise a level when the same defect class has already escaped once — record it as a DEC entry so
the raise is visible and reversible. Never lower a level to get a build green; waive it in the
DEC log instead, where it leaves a trace.
