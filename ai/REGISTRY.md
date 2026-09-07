# AI Registry

> **Authoritative index of every agent and skill in this repo.**
> **Rule:** update in the same commit that adds, removes, renames or revalidates one.
> If `ai/agents/README.md` and this file disagree, **this file wins**.

**Totals:** 7 agents, 5 skills. **Hard cap: 8 agents** - a ninth requires deleting one or a DEC
entry justifying the exception.

**Combined agent description budget:** 1651 characters (~412 tokens), well under the
15,000-token warning threshold. Keep it that way: every description is paid for in every context.

## Status definitions

| Status | Meaning |
|---|---|
| `validated` | Spec and eval fixtures complete; suite passes; escalation rules tested |
| `draft` | Spec written, behaviour not pinned by evals. Safe under human review |
| `stub` | Placeholder. Do not invoke for production work |
| `deprecated` | Superseded; see the Successor note |

## Agents

| Name | Status | Writes? | Model / effort | Spec | Purpose |
|---|---|---|---|---|---|
| `spec-adversary` | draft | No | opus / xhigh | [spec](agents/spec-adversary.md) | Attack the spec before class-C work |
| `migration-author` | draft | **Yes** - `infrastructure/db/**` + schema mirror only | opus / high | [spec](agents/migration-author.md) | SQL migration, Drizzle mirror, pgTAP constraint tests |
| `test-author` | draft | **Yes** - tests and fixtures only | sonnet / high | [spec](agents/test-author.md) | Generate tests for a diff, run the suite, report the delta |
| `reviewer` | draft | No | opus / high | [spec](agents/reviewer.md) | Adversarial review against the 14-item checklist |
| `security-reviewer` | draft | No | opus / high | [spec](agents/security-reviewer.md) | OWASP Top 10:2025 review on sensitive paths |
| `authz-auditor` | draft | No | opus / high | [spec](agents/authz-auditor.md) | Inline role checks, guards, matrix coverage, both scope graphs |
| `slice-verifier` | draft | No | sonnet / medium | [spec](agents/slice-verifier.md) | Prove the slice actually works end to end |

**Structural rule:** only two agents write, and **neither writes production application code**.
Application code is written by the main session under the developer's eye. With no peer reviewer,
an agent writing business logic that another agent approves is a closed loop with no human in it.

**All seven are `draft`, not `validated`** - the eval fixtures in `ai/evaluations/` do not exist
yet, because there is no code to seed bugs into. They become `validated` when the seeded-bug set
runs and they catch it.

## Skills

| Name | Model-invocable? | Purpose |
|---|---|---|
| `session-brief` | **Yes** | Orient at session start. Injects live git, migration and guard-test state via `!` shell commands |
| `review` | No - manual only | The review gate. Derives change class, dispatches agents, verifies findings, records the verdict |
| `check-authz` | No - manual only | Authorization sweep across both scope graphs |
| `slice` | No - manual only | Start a slice. Acceptance criteria must be test names |
| `close-slice` | No - manual only | Close a slice, only if every named test exists and passes |

Four of five carry `disable-model-invocation: true` deliberately: they have side effects or gate
decisions, and should fire because a human asked, not because a description matched.

## Hooks

| Hook | Event | Script | Prevents |
|---|---|---|---|
| commit guard | PreToolUse `git commit` | `.claude/hooks/guard-commit.mjs` | Committed secrets, unmarked destructive migrations, authz changes with no matrix entry |
| ADR guard | PreToolUse Edit/Write | `.claude/hooks/guard-adr.mjs` | Editing an Accepted ADR |
| dirty tracker | PostToolUse Edit/Write | `.claude/hooks/track-dirty.mjs` | (bookkeeping) Enables incremental checks |
| subagent log | SubagentStop | `.claude/hooks/log-subagent.mjs` | (bookkeeping) Enables the roster prune rule |

**Regression-tested:** `node testing/hooks/guards.test.mjs` - 19 cases, asserting each guard both
blocks what it should and **allows what it should**. The allow cases matter as much: a guard that
cries wolf gets disabled, which costs more than the misses it prevents.

**Deferred, with reason:** a Stop-hook typecheck (no TypeScript exists yet) and a push gate
requiring a `/gate` artifact (needs code to gate). Both land in Phase 2. See DEC-003.
