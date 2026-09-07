# ai/ - AI engineering assets

The **authoritative specs** for how Claude works on this repo. `.claude/` holds thin runtime
adapters; the substance lives here.

| Path | Holds |
|---|---|
| `REGISTRY.md` | Source of truth for every agent and skill |
| `agents/` | Full agent specs: allowed-paths, forbidden-paths, required-context, escalation rules |
| `context/` | The standards agents must read before working. Changing these needs architecture review |
| `evaluations/` | Eval fixtures, including the seeded-bug set that proves the reviewer still works |

**Why the split:** combined agent descriptions compete for a limited context budget, so
`.claude/agents/*.md` stays terse and points here, where specs can be as long as they need to be.
