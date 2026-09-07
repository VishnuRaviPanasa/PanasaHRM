# AI Registry

> **Authoritative index of every agent and skill in this repo.**
> **Rule:** update in the same PR that adds, removes, renames or revalidates one.
> If `ai/agents/README.md` and this file disagree, **this file wins**.

**Totals:** 0 agents, 0 skills. Populated in Task 2.

## Status definitions

| Status | Meaning |
|---|---|
| `validated` | Spec and eval fixtures complete; suite passes; envelope output spot-checked; escalation rules tested |
| `draft` | Spec written, behaviour not pinned by evals. Safe to use under human review |
| `stub` | Placeholder. Do not invoke for production work |
| `deprecated` | Superseded; see the Successor note |

## Agents

Planned roster (plan section 25) - **hard cap of 8**. Adding a ninth requires deleting one or a
DEC entry justifying the exception.

| Name | Status | Writes? | Model / effort | Purpose |
|---|---|---|---|---|
| `spec-adversary` | not created | No | opus / xhigh | Attack the spec before class-C work |
| `migration-author` | not created | **Yes** (migrations + schema mirror only) | opus / high | SQL migration, Drizzle mirror, pgTAP constraint tests |
| `test-author` | not created | **Yes** (tests and fixtures only) | sonnet / high | Generate tests for a diff, run the suite, report the delta |
| `reviewer` | not created | No | opus / high | Adversarial review against the 14-item checklist |
| `security-reviewer` | not created | No | opus / high | OWASP Top 10:2025 review on sensitive paths |
| `authz-auditor` | not created | No | opus / high | Inline role checks, missing guards, matrix coverage, field-mask diff |
| `slice-verifier` | not created | No | sonnet / medium | Prove the slice actually works end to end |

**Structural rule:** only two agents write, and **neither writes production application code**.
Application code is written by the main session under the developer's eye. With no peer
reviewer, an agent writing business logic that another agent approves is a closed loop with no
human in it.

## Skills

| Name | Status | Purpose |
|---|---|---|
| - | - | Populated in Task 2 |
