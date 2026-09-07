# docs/architecture/

Hand-written intent, plus generated artefacts.

| File | Source |
|---|---|
| `system-overview.md` | Hand-written (Task 3) |
| `module-map.md` | **Generated** from the boundaries lint |
| `database-design.md` | Hand-written narrative |
| `erd.md` | **Generated** from live schema introspection |

CI regenerates the derived files and **fails on a stale artefact**.
