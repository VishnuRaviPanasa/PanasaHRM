# docs/standards/

Machine-consumable contracts. Written for agents and CI first, humans second. Planned (Task 2):

| File | Purpose |
|---|---|
| `agent-output-contract.md` | The envelope every agent wraps output in - **v2**, adding `checks_performed[]`, `files_examined[]`, `unverified_claims[]` and a per-finding `rule_ref`. `confidence_score` is a triage hint, **not a gate input** |
| `severity-vocabulary.md` | Only `CRITICAL` / `HIGH` / `MEDIUM` / `LOW`. Exact field names. Aliases forbidden |
| `api-conventions.md` | REST naming, pagination, RFC 9457 errors, idempotency, ETags |
| `coding-standards.md` | Naming, error model, module layering |

## Why the envelope is v2

Self-reported confidence is nearly worthless as a safety signal: a model that misreads a diff
will misreport its certainty about the misreading with equal serenity. So the gate condition is
`critical_count == 0` **plus deterministic checks passing** - never a confidence threshold.

`rule_ref` and `checks_performed[]` exist to make findings **mechanically verifiable**: a script
asserts every cited `file:line` exists in the diff and every rule anchor exists in the cited
file, so a fabricated finding fails automatically.
