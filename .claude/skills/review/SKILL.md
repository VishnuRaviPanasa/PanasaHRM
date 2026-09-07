---
name: review
description: Run the adversarial review gate over a diff. Dispatches reviewer, and on sensitive paths also security-reviewer and authz-auditor. Use before pushing.
disable-model-invocation: true
argument-hint: [staged | working | <commit-range>]
---

# /review - the review gate

Scope is `$ARGUMENTS`, defaulting to `working`. Accepts `staged`, `working`, or a range like
`main..HEAD`.

## 1. Determine the change class

Derive it from the **changed file paths**, not from anyone's assertion:

- **C** if the diff touches `infrastructure/db/**`, `packages/authz/**`, anything effective-dated,
  the workflow engine, audit emission, or leave / attendance / work arithmetic
- **B** if it is a feature slice inside an existing module with no schema change
- **A** otherwise - copy, styling, non-authz UI, docs, tests-only, dependency patches

State the class and why before proceeding.

## 2. Dispatch

| Class | Agents |
|---|---|
| A | `reviewer` only |
| B | `reviewer`, then `slice-verifier` |
| C | `reviewer`, `security-reviewer`, `authz-auditor` **in parallel** - they read the same finished diff and share nothing - then `slice-verifier` |

Each returns the envelope in `docs/standards/agent-output-contract.md`.

## 3. Verify the findings before you trust them

For every finding, confirm the cited `file:line` exists in the diff and the `rule_ref` anchor
resolves. **A finding that fails this check is discarded and reported as a fabrication**, because
a confident review of code that was never read is worse than no review.

## 4. Verdict

- **Any `CRITICAL` → blocked.** No waiver exists for CRITICAL.
- **Any `HIGH` → blocked** until fixed, or waived by adding a DEC entry in
  `docs/governance/decisions.md` with a reason, an owner and a review date.
- `MEDIUM` / `LOW` → report, do not block.

Append the outcome to `.claude/state/gate-history.jsonl`:
`{"at":"<iso>","class":"<A|B|C>","verdict":"...","critical":N,"high":N,"medium":N,"low":N}`

Then present: the class, the counts, every CRITICAL and HIGH in full, and a one-line verdict.
If the trailing-20 approve rate is above ~70% with no HIGH findings, say so - that is a smell
worth investigating, not a victory.
