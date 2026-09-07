---
name: check-authz
description: Authorization sweep over a diff or the whole codebase. Finds inline role checks, unguarded routes, unscoped list queries, missing matrix entries and cross-graph leaks.
disable-model-invocation: true
argument-hint: [staged | working | <commit-range> | full]
---

# /check-authz - authorization sweep

Scope is `$ARGUMENTS`, defaulting to `staged`. `full` sweeps the whole codebase.

Dispatch the **authz-auditor** agent against that scope. It works from
`ai/agents/authz-auditor.md`.

Report separately on the two scope graphs, because conflating them is the defect this catches:

- **Reporting hierarchy** - employee records, leave, attendance, documents
- **Project membership** - work logs, timesheets, project reports

And confirm these five negative cases are covered by tests, naming the test for each. A missing
one is a finding, not an omission to mention in passing:

1. project manager → contributor's leave balance = **deny**
2. project manager → same person's effort on another project = **deny**
3. line manager → a project they hold no role on = **deny**
4. manager → their own manager's compensation = **deny** (the deny-override must beat any allow)
5. employee → a peer's record = **deny, as 404 not 403**

Any CRITICAL blocks. Report the matrix coverage percentage and name every route with no entry.
