# docs/

## Authority order - when documents disagree, higher wins

| Rank | Document | Authority |
|---|---|---|
| 1 | `adr/*.md` (status **Accepted**) | Architectural truth. Immutable - supersede, never edit |
| 2 | `/CLAUDE.md` + scoped `CLAUDE.md` | Operating rules for all work |
| 3 | `../ai/context/*.md` | Detailed standards. Changing them needs architecture review |
| 4 | `standards/*.md` | Machine-consumable contracts |
| 5 | `../infrastructure/db/migrations/*.sql` | Schema truth (Drizzle schema is a mirror) |
| 6 | `../packages/contracts` | API contract truth |
| 7 | `governance/decisions.md` | Non-architectural decisions (DEC-NNN) |
| 8 | Generated: OpenAPI, ERD, dependency graph, RBAC matrix | Derived - regenerate, never hand-edit |
| 9 | `guides/`, `runbooks/` | Human-facing procedures |

**Rule: documentation that can be generated must be generated.** Hand-maintained docs are
limited to *decisions and intent* - the things a tool cannot derive.

| Directory | Holds |
|---|---|
| `adr/` | Architecture Decision Records, immutable once Accepted |
| `architecture/` | System overview, database design, module map |
| `governance/` | DEC log |
| `guides/` | Development, testing, deployment, security |
| `privacy/` | Data inventory: per-column classification, purpose, retention |
| `requirements/` | Business rules from the Employee Handbook and HR interviews |
| `runbooks/` | Deploy, restore, incident, offboarding |
| `slices/` | Archived slice cards - the real project history |
| `standards/` | Agent output contract, severity vocabulary, API conventions |
