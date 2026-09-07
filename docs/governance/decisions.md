# Decision Log (DEC-NNN)

Non-architectural decisions: waived findings, deferred scope, accepted risks, convention picks.
**Architectural** decisions go in `docs/adr/` instead.

Every waiver needs a reason, an owner and a review date. Silence is not a waiver.

| ID | Date | Decision | Reason | Owner | Review by |
|---|---|---|---|---|---|
| DEC-001 | 2026-09-08 | `CLAUDE.md` carries **no phase or status line** | The plan (section 24.2) requires zero mutable state in `CLAUDE.md`; a hardcoded phase is exactly the line that goes stale and misleads a future session. Status lives in `.claude/state/`. This supersedes the plan section 48 wording for Task 1 | Claude | - |
| DEC-002 | 2026-09-08 | **ESLint deferred to Phase 2** | There is no TypeScript to lint, and `eslint-plugin-boundaries` needs the module paths that Phase 2 creates. Configuring it now would be speculative and untested | Claude | Phase 2 |
| DEC-003 | 2026-09-08 | **Hooks deferred to Task 2** | Hooks ship together with their scripts so each can be tested the moment it is added. A hook entry pointing at a missing script fails silently, which is worse than no hook | Claude | Task 2 |
