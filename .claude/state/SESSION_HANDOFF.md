# Session Handoff

**Last updated:** 2026-09-08
**Last session did:** Task 2 - the review gate, tested. (Task 1 skeleton + harness and the 2026
holiday calendar / GreytHR current state were the sessions before.)

## What exists now

- Repo initialised, `origin` set to `https://github.com/VishnuRaviPanasa/PanasaHRM.git`
  (remote is empty; nothing has been pushed).
- `CLAUDE.md` - operating contract: 15 Must-Know Rules, Forbidden Actions, change classes,
  context-file routing table, session protocol, authority order.
- `.claude/settings.json` - permission allow/ask/deny rails. **No hooks yet** (Task 2).
- `.claude/state/` - this state layer.
- Directory skeleton with a README in each tree explaining what belongs there.
- Root config: `package.json` (npm workspaces), `tsconfig.base.json` (strict + friends),
  `.gitignore`, `.editorconfig`, `.prettierrc.json`, `.nvmrc`.
- Governance stubs: `docs/adr/0000-template.md`, `docs/governance/decisions.md`,
  `ai/REGISTRY.md`, `docs/backlog.md`.

## Task 2 added

- `docs/standards/agent-output-contract.md` (envelope **v2**) and `severity-vocabulary.md`
- **7 agents** - thin adapters in `.claude/agents/`, full specs in `ai/agents/`
- **5 skills** - `session-brief` (auto, with live `!` injection), `review`, `check-authz`,
  `slice`, `close-slice` (all manual-only)
- **4 hooks** with scripts: commit guard (secrets / migrations / authz), ADR guard, dirty
  tracker, subagent log
- **`testing/hooks/guards.test.mjs` - 19 adversarial cases, all passing.** Run it after any
  change to a guard: `node testing/hooks/guards.test.mjs`

## What does NOT exist yet

- No ADRs with content (Task 3 - ADRs 0001-0017 are drafted in the plan, not yet written here)
- No `ai/context/*.md` files - **agents will correctly refuse and escalate if asked to work
  without them**, which is intended behaviour, not a bug
- No ESLint config (deferred until there is TypeScript to lint and module paths for
  `eslint-plugin-boundaries` to enforce)
- No application code, no migrations, no dependencies installed

## Requirements captured so far

- `docs/requirements/holiday-calendar-2026.md` - the real 2026 calendar from GreytHR ESS.
  11 fixed + 6 optional. Closes OR-02. Raises H-01..H-06.
- `docs/requirements/greythr-current-state.md` - what GreytHR covers today. Scope intelligence
  only; **no dependency** (D5).

## Exact next action

Run **Task 4** from `docs/backlog.md`: write `ai/context/*.md`, starting with
`temporal-data-rules.md` and `rbac-rules.md`. The agents already reference these files and will
escalate without them, so they are the binding constraint on doing any real review.

Task 3 (write ADRs 0001-0017) can run in parallel - it needs a human to Accept each one, and
`guard-adr.mjs` will enforce immutability from that moment.

## Traps and notes for the next session

- **Long heredocs get truncated** by the Bash tool on this machine. Write long prose files
  with the Write tool; keep Bash heredocs to short config files.
- **No network access in the sandbox** - `git clone`/`push` fail on DNS. The remote is wired
  but nothing is pushed. Pushing needs a human or a non-sandboxed run.
- `gh` CLI is **not installed**. `pnpm` and `bun` are **not installed** - use npm.
- `CLAUDE.md` deliberately carries **no phase or status line**. Status lives here and in
  `CURRENT_SLICE.md` so it cannot silently go stale.
