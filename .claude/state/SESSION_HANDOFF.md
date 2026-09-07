# Session Handoff

**Last updated:** 2026-09-08
**Last session did:** Task 5 (requirements docs) and the first half of Phase 2 - dev stack,
baseline migration and migration runner, **all verified against real PostgreSQL 18.6**.

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

## Tasks 3 and 4 added

- **18 ADRs**, `docs/adr/0001`-`0018`, all **Proposed**. `docs/adr/README.md` indexes them with
  why each is load-bearing. **A human must Accept them** - no agent may, and the guard enforces
  immutability from that moment.
- **All 10 `ai/context/` files.** The agents' required-context now resolves, so real review is
  possible for the first time.
- ADR-0018 was added beyond the plan's 0001-0017: the standalone/no-dependency constraint (D5)
  is genuinely architectural and deserved a record.

## What does NOT exist yet

- `packages/authz/authz-matrix.yaml` and `docs/privacy/data-inventory.md` - both arrive with
  Phase 2 code; `CLAUDE.md` says so explicitly so nobody invents them
- No application code, no migrations, no dependencies installed
- No ESLint config (deferred until there is TypeScript to lint and module paths for
  `eslint-plugin-boundaries` to enforce)
- No application code, no migrations, no dependencies installed

## Requirements captured so far

- `docs/requirements/holiday-calendar-2026.md` - the real 2026 calendar from GreytHR ESS.
  11 fixed + 6 optional. Closes OR-02. Raises H-01..H-06.
- `docs/requirements/greythr-current-state.md` - what GreytHR covers today. Scope intelligence
  only; **no dependency** (D5).

## Phase 2 so far - VERIFIED, not just written

- `infrastructure/compose/docker-compose.dev.yml` - postgres 18 / redis 7 / minio / adminer.
  **Confirmed running.** Ports default to a high range (55432 etc, DEC-009) because a local
  PostgreSQL owns 5432 on this machine.
- `infrastructure/db/migrations/0001_baseline.sql` - extensions, `schema_migration`,
  `outbox_event`, `audit_event` (monthly partitions, current + 3 ahead), `audit_column_policy`,
  append-only triggers, `fn_ensure_month_partition`. **Applied clean to a fresh DB.**
- `scripts/migrate.mjs` - status / up / verify. Forward-only (DEC-011), checksum-enforced
  (DEC-012), `psql`-only so it works before `npm install` (DEC-013). **Drift detection tested by
  editing an applied migration and confirming it refuses.**
- `testing/db/0001_baseline.verify.sql` - **13 adversarial checks, all passing.**

Commands: `npm run db:up` · `db:status` · `db:migrate` · `db:verify` · `db:down`

## Two bugs found by running it, not by reading it

1. `fn_block_mutation` used `format('%s ... %', ...)` - an invalid specifier. It only surfaced
   when the trigger actually fired.
2. The PG18 image refuses to start if the volume mounts at `/var/lib/postgresql/data`. It must
   mount at `/var/lib/postgresql` (DEC-010).

## Exact next action

**Human action still outstanding: accept the ADRs** (T3a). Everything built so far rests on
decisions that are still `Proposed`.

Then finish Phase 2, in this order:

1. **T9 NestJS bootstrap** - `npm install` first (the registry IS reachable; only git DNS is
   blocked in the sandbox). Zod-validated config, typed error hierarchy, RFC 9457 filter,
   request-id middleware, OpenAPI, `/health/live` + `/health/ready`.
2. **T8b the outbox drain worker** - needs the app to exist.
3. **T7b the Drizzle mirror** of `0001_baseline.sql`, plus schema-drift detection.
4. **T11 test harness** - Vitest + Testcontainers. Docker works here, so this is testable.
5. **T10 observability**, **T12 CI**, **T13 ESLint + boundaries**.

## Traps and notes for the next session

- **Long heredocs get truncated** by the Bash tool on this machine. Write long prose files
  with the Write tool; keep Bash heredocs to short config files.
- **No network access in the sandbox** - `git clone`/`push` fail on DNS. The remote is wired
  but nothing is pushed. Pushing needs a human or a non-sandboxed run.
- `gh` CLI is **not installed**. `pnpm` and `bun` are **not installed** - use npm.
- `CLAUDE.md` deliberately carries **no phase or status line**. Status lives here and in
  `CURRENT_SLICE.md` so it cannot silently go stale.
