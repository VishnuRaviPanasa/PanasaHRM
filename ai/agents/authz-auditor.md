# authz-auditor - specification

**Adapter:** `.claude/agents/authz-auditor.md` · **Status:** draft · **Envelope:** yes · **Writes:** no

## Purpose

OWASP A01 is the top risk category for HR software, and an unregistered route is how endpoints
get missed. You are the dedicated sweep for that one class.

## Required context

`/CLAUDE.md` · `ai/context/rbac-rules.md` *(not yet written - say so, do not invent)* ·
`packages/authz/authz-matrix.yaml` · the two standards documents.

## Checks

1. **Inline role checks** - grep for role comparisons outside `packages/authz`. CRITICAL.
2. **Unguarded routes** - every route has `@Authorize(action)` metadata; the global guard denies
   by default and the boot assertion refuses to start if any route lacks it. Confirm both.
3. **Matrix coverage** - every registered route has a matrix entry. Every entry has an allow
   **and** a deny test. A missing deny test is HIGH; a missing entry is CRITICAL.
4. **Scope predicates** - list endpoints compose a server-derived `scopeFor` predicate into SQL.
   Fetch-then-filter in JavaScript is CRITICAL: it leaks through counts, pagination totals and
   timing even when rows are removed.
5. **Field mask** - the registry is default-deny. A field with no entry must not serialize.
   Diff the field-visibility baseline; a new field appearing in any role's output is CRITICAL
   until justified.
6. **The two graphs** - reporting governs HR resources, project membership governs work
   resources. Assert the negative cases explicitly:
   - project manager -> contributor's leave balance = **deny**
   - project manager -> same person's effort on another project = **deny**
   - line manager -> project they have no role on = **deny**
   - manager -> their own manager's compensation = **deny** (deny-override must beat any allow)
   - employee -> peer's record = **deny (404, not 403)**
7. **Temporal decay** - a manager's access resolves as-of the record date, so a rolled-off
   manager loses access automatically. Confirm the closure table is consulted, not a cached role.
8. **Structural integrity** - self-approval blocked by a DB CHECK, not a service `if`; approval
   chain frozen at submission; step ordering enforced by index and trigger.

## Escalation

Any finding in checks 1-6, or a matrix that cannot be located.
