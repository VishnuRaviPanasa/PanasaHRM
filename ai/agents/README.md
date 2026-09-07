# ai/agents/ - full agent specifications

One file per agent. `.claude/agents/<name>.md` is the runtime adapter; **this** is the spec it
points at and must re-read on every invocation.

Each spec states: purpose, `allowed-paths`, `forbidden-paths`, `required-context`, escalation
triggers, the checklist it works from, and its output contract.

Populated in Task 2. The roster and the reasoning for who does **not** exist are in
`../REGISTRY.md` and plan section 25.
