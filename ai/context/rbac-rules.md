# Authorization Rules

**Authority:** implements ADR-0005. **Read before any endpoint, query or UI gate that touches
permissions.** Editing this file requires architecture review.

> Broken Access Control is **A01 in OWASP Top 10:2025** and the highest-impact failure mode for
> HR software. The design goal here is that the insecure version does not compile or does not
> boot — not that it gets caught in review.

## Rule 1, above all others

**Every authorization decision goes through `AuthorizationService`. No inline role checks
anywhere outside `packages/authz`.**

```ts
// FORBIDDEN, anywhere in apps/ — CRITICAL finding
if (user.role === 'hr_admin') { ... }
if (user.roles.includes('manager')) { ... }

// REQUIRED
await authz.assertCan(ctx, 'employee.compensation.read', { type: 'employee', id });
```

A role comparison outside `packages/authz` is unauditable and untestable: you cannot answer
"who can do X" without reading every file, and a missed check is invisible.

## The three concerns — never conflate them

| Concern | Method | Prevents |
|---|---|---|
| May they act at all? | `can(ctx, action, ref)` / `assertCan` | Privilege escalation |
| **Which rows?** | `scope(ctx, action, type)` → SQL predicate | IDOR, over-broad lists |
| **Which fields?** | `fieldMask(ctx, action, ref)` | Salary leaking through a legitimate list response |

### `scope()` is the one most designs omit — and where bulk leakage actually happens

It returns a **SQL predicate composed into the query**, not a filter applied afterwards.

```ts
// WRONG — leaks via counts, pagination totals and timing even though rows are removed
const all = await repo.findAll();
return all.filter((e) => canSee(ctx, e));

// RIGHT — the query is physically incapable of returning out-of-scope rows
const predicate = await authz.scope(ctx, 'employee.read', 'employee');
return repo.findAll(predicate);
```

### `fieldMask()` is default-deny

A field with **no entry in the field registry is never serialized**, for any role, in any
response. Adding a column therefore makes it invisible until someone consciously classifies it —
the safe failure direction.

Per-role DTOs were rejected: they multiply combinatorially and **fail open** the moment one DTO
spreads the entity.

## The two scope graphs — orthogonal, never merged

This is the rule most likely to be got wrong, because both feel like "people I can see".

| Graph | Source | Governs |
|---|---|---|
| **Reporting hierarchy** | `reporting_relationship` → `reporting_closure_current` | Employee record, leave, attendance, documents, performance |
| **Project membership** | `project_member` (effective-dated) | Work logs, effort entries, timesheets, project reports |

A project manager's scope is `project ∈ my projects` — **not** `employee ∈ my reports`. It
returns rows *about work on that project*, and widens to nothing else about those people.

In an IT services organization the line manager and the project manager are routinely different
people. Merging the graphs is how a project lead ends up reading someone's disciplinary file.

## Deny-overrides — evaluated first, cannot be beaten by any allow

```ts
definePolicy({
  action: 'employee.compensation.read',
  denyOverrides: [ isAncestorOfActor ],            // never your own manager's compensation
  allow: [
    { role: 'employee', when: isSelf },
    { role: 'manager',  when: isDirectReport },    // depth 1 ONLY, not the whole subtree
    { role: 'hr_admin', when: always,
      obligations: [requireStepUp('PT15M'), auditRead()] },
  ],
});
```

Deny-overrides are what make *"a manager who is also an HR admin still cannot see their own
manager's salary"* **true**, rather than accidentally true.

Note the asymmetry, and it is deliberate: a manager sees **attendance** for their whole subtree
but **compensation** only for direct reports.

## Temporal decay

Manager authority resolves **as of the record's date**, not today. A rolled-off manager therefore
loses access automatically, and a manager who *did* manage someone in March retains access to
March's records. Never cache a role grant as a substitute — the graph is the truth.

## Structural integrity — enforced by the database, not by service methods

Service-layer checks get bypassed by the next code path, a job, a migration or an admin script.

1. **No self-approval** — `CHECK (decided_by_employee_id <> subject_employee_id)`, backed by a
   trigger asserting the denormalised subject still matches its parent
2. **Approval chain frozen at submission** — a later reorg cannot retarget an in-flight approval
3. **Step ordering** — `UNIQUE (request_id, step_no)` plus a BEFORE INSERT trigger asserting all
   prior steps are terminal
4. **Delegation is bounded** — `CHECK (from <> to)`, and the delegate is re-checked against the
   subject at decision time
5. **Tier 1 tables behind a separate DB role** — `hrm_app` has *no grant at all* on compensation,
   bank or government-ID tables, so a SQL injection in the leave module physically cannot read
   salary

## Fail-closed route coverage

A global guard **denies any route lacking `@Authorize(action)` metadata**, and a boot assertion
walks the route registry and **refuses to start** if any route is unannotated. The same assertion
runs in CI.

This converts "someone forgot the check" — historically the most common cause of A01 — from the
most likely bug in the system into an impossible one.

## Error semantics

Return **404, not 403**, for a record outside the caller's scope. A 403 confirms the record
exists, which is itself a disclosure. Use 403 only where the caller already provably knows of
the resource.

## Testing — the highest-value suite in the repo

`authz-matrix.yaml` enumerates `(role × action × resource)` → `allow | deny | conditional`.
CI generates a test per cell asserting **both directions**, and **fails if any registered route
has no matrix entry.**

Fixtures exist to pin specific threats, not to be representative:

```
CEO ─ DeptHeadA ─ ManagerM1 ─ {E1, E2}     plus: HR Admin, HR Ops, Finance, Auditor,
    └ DeptHeadB ─ ManagerM2 ─ {E3}               Terminated T1 (was M1's report),
                                                 Transferred X1 (M1 → M2),
ProjectP1: owner M2, contributors {E1, E3}       ProjectP2: owner M1, contributor E3
```

Required negative cases — each pins a named threat:

| Case | Expect | Pins |
|---|---|---|
| M1 → DeptHeadA compensation | **deny** | Upward escalation |
| M1 → E3 (not their report) | **deny** | Lateral escalation |
| M1 → T1 records after termination date | **deny** | Temporal decay |
| M1 → X1 records after transfer | **deny** | Temporal decay |
| E1 → E2 record | **deny (404)** | Peer IDOR |
| M2 (owner of P1) → E1's leave balance | **deny** | **Cross-graph leak** |
| M2 → E3's effort on P2 | **deny** | Project scope does not widen |
| M1 (no role on P1) → P1 effort report | **deny** | Reporting scope does not widen |

## Review checklist

- [ ] No role comparison outside `packages/authz`
- [ ] Every new route has `@Authorize` and a matrix entry with allow **and** deny tests
- [ ] Every list query composes `scope()`; no fetch-then-filter
- [ ] No response path serializes an entity without the field mask
- [ ] Work resources resolve through `project_member`; HR resources through the reporting graph
- [ ] Out-of-scope reads return 404, not 403
- [ ] Approval integrity is enforced by constraint, not by an `if`
