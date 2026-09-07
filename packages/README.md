# packages/

Shared workspaces. Created in Phase 2.

| Package | Purpose |
|---|---|
| `contracts/` | Zod schemas + derived TS types. **One schema validates the form and the API DTO** - this is what stops client/server drift |
| `authz/` | `AuthorizationService` + `authz-matrix.yaml`. **The only place permission logic may live** (Must-Know Rule 1) |
| `ui/` | Radix-based primitives. **No domain knowledge, no data fetching** |
| `design-tokens/` | Colour, spacing, typography, elevation, motion - CSS vars + TS |
