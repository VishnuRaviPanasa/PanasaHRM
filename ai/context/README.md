# ai/context/ - the standards agents must follow

Durable rules, separated from transient conversation. Agents **re-read these files** rather than
relying on context that may have been compacted away.

Planned (Task 4):

| File | Covers |
|---|---|
| `architecture-principles.md` | Module boundaries, outbox, layering, dependency rules |
| `temporal-data-rules.md` | Effective-dating pattern, EXCLUDE constraints, as-of queries. **The highest-value file here** |
| `rbac-rules.md` | The two scope graphs, AuthorizationService contract, field-mask registry |
| `security-guidelines.md` | OWASP Top 10:2025 mapping, PII handling, upload rules |
| `testing-guidelines.md` | Test pyramid, coverage floors by risk, forbidden test patterns |
| `workflow-rules.md` | FSM-as-data, approval invariants, delegation |
| `engineering-guidelines.md` | Naming, error model, API conventions |
| `domain-glossary.md` | HR vocabulary. Every new concept gets an entry |
| `india-statutory-notes.md` | What is **confirmed** vs **assumed** about Indian statutory rules |
| `project-context.md` | Scale assumptions, constraints, non-goals |

**Editing any file here is in the `ask` permission list** - it requires deliberate human approval.
