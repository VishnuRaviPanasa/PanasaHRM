# Agent Output Contract — v2

**Status:** Active · **Schema version:** `2.0` · **Owner:** Engineering
**Applies to:** every agent in `.claude/agents/` that emits findings or a verdict.

## Why this exists, and why v2 differs from the usual pattern

Without a uniform envelope, every agent invents its own shape, every consumer writes bespoke
parsing, and there is no machine signal for *"I am uncertain."*

The common version of this contract makes `confidence_score < 0.60` a blocking condition.
**That control does not work**, and v2 removes its authority. A model that misreads a diff will
misreport its certainty about the misreading with equal serenity — so a self-assessed score only
ever catches the agent honest enough to say it is unsure. It is kept as a triage hint for the
reader's ordering, and nothing more.

v2 replaces it with four fields that are **mechanically checkable**:

| Field | What it makes falsifiable |
|---|---|
| `checks_performed[]` | *Did you actually look?* Each checklist item reports the literal command run and its result |
| `files_examined[]` | *Did you read what you claim?* Diffed against the real changed-file list |
| `rule_ref` per finding | *Does the rule you cite exist?* Anchor must resolve in the cited document |
| `unverified_claims[]` | *What could you not confirm?* An empty array on a complex diff is itself a smell |

**The gate condition is `critical_count == 0` AND the deterministic checks passing.**
Never a confidence threshold.

## The envelope

```json
{
  "schema_version": "2.0",
  "agent": "reviewer",
  "generated_at": "2026-09-08T12:00:00Z",
  "scope": {
    "kind": "diff",
    "ref": "main..HEAD",
    "change_class": "C"
  },
  "inputs_digest": "sha256:...",
  "files_examined": ["apps/api/src/modules/leave/application/apply-leave.ts"],
  "checks_performed": [
    {
      "check": "authz-guard-present",
      "command": "rg '@Authorize' apps/api/src/modules/leave/interfaces",
      "result": "3 endpoints, 3 guards",
      "outcome": "pass"
    }
  ],
  "findings": [
    {
      "id": "F-001",
      "severity": "CRITICAL",
      "category": "authorization",
      "file": "apps/api/src/modules/leave/interfaces/leave.controller.ts",
      "line": 42,
      "rule_ref": "ai/context/rbac-rules.md#no-inline-role-checks",
      "summary": "Inline role check bypasses AuthorizationService",
      "failure_scenario": "A user holding hr_ops but not comp_viewer reaches salary fields, because the branch tests role rather than calling can().",
      "suggested_fix": "Replace with assertCan(ctx, 'employee.compensation.read', ref)."
    }
  ],
  "severity_counts": {
    "critical_count": 1,
    "high_count": 0,
    "medium_count": 0,
    "low_count": 0
  },
  "unverified_claims": [
    "Did not run the test suite; no assertion made about coverage."
  ],
  "confidence_score": 0.82,
  "escalation_flag": false,
  "escalation_reasons": [],
  "verdict": "changes_requested"
}
```

## Field rules

**`schema_version`** — `"2.0"`. Bump on any breaking change to this contract.

**`agent`** — must match the `name` in the agent's frontmatter exactly.

**`scope.change_class`** — `A` | `B` | `C`, derived from changed paths per `/CLAUDE.md`.
An agent must not lower the class it was invoked with.

**`inputs_digest`** — SHA-256 over the canonical input bundle (the diff, then each cited context
file in the order the agent's `required-context` lists them). Proves the agent saw what the
reviewer expects it saw, and lets a repeat run be recognised as a repeat.

**`files_examined[]`** — files actually read. Compared against the diff's file list; a large gap
between "files changed" and "files examined" is reported to the human. Claiming forty and reading
three is detectable laziness.

**`checks_performed[]`** — one entry per checklist item the agent's spec defines, each with
`check`, `command` (the literal command or search run), `result` (what came back), and `outcome`
(`pass` | `fail` | `not_applicable`). **A checklist item with no entry is treated as not
performed**, not as passed.

**`findings[]`** — see `severity-vocabulary.md` for levels and calibration. Every finding needs:
- `file` and `line` that **exist in the diff**
- `rule_ref` as `<path>#<anchor>` resolving to a real anchor in a real file
- `failure_scenario` — concrete inputs or state leading to a wrong outcome. *"This is unsafe"* is
  not a failure scenario; *"a manager who is also hr_ops reaches their own manager's salary"* is.

**`unverified_claims[]`** — assertions the agent could not confirm mechanically. This is the
honesty channel that `confidence_score` pretends to be. Write it before writing the verdict.

**`confidence_score`** — float `[0,1]`, 2dp. **A triage hint for reading order. Not a gate
input.** Scores ≥0.95 are reserved for claims verified against a deterministic source (tests
passed, types check, a constraint exists in the DDL).

**`escalation_flag`** — `true` if **any** of:
1. A `required-context` file could not be read
2. The agent would need to violate its own `forbidden-paths`
3. The change contradicts an Accepted ADR
4. The work is outside the agent's declared scope
5. The requirement is ambiguous in a way that changes the data model

When `true`, `escalation_reasons` is non-empty and **automated progress halts**. Escalations are
never auto-dismissed.

**`verdict`** — `approved` | `changes_requested` | `blocked`.
`blocked` means the agent could not complete its review, which is different from finding problems.

## Consuming the envelope

- **`/gate`** aggregates envelopes, runs `scripts/verify-findings.mjs`, and passes only when
  `critical_count == 0` across all agents **and** every deterministic check passed.
- **`HIGH` findings** block until fixed or waived in `docs/governance/decisions.md`.
- **Verdict distribution** is appended to `.claude/state/gate-history.jsonl`. A trailing-20
  approve rate above ~70% with zero HIGH findings is a **smell to investigate, not a victory** —
  it usually means the reviewer has stopped saying no.

## What this contract cannot do

Stated plainly so nobody over-trusts it:

- It cannot stop an agent reading three files and reasoning plausibly about thirty. It can only
  make the gap **visible** via `files_examined[]`.
- It cannot detect a *missing* finding — only a fabricated one. The defence against misses is the
  monthly seeded-bug eval in `ai/evaluations/`, which is manual and therefore the thing most
  likely to be skipped.
- It cannot substitute for a deterministic check. Anything a type checker, a database constraint
  or a test can prove **must not** be delegated to an agent's judgement.
