# apps/

npm workspaces. Created in Phase 2.

| App | Stack | Notes |
|---|---|---|
| `api/` | NestJS 11 on Node 24 | Modules per bounded context. Layering inside each: `interfaces/` -> `application/` -> `domain/` -> `infrastructure/`. **Drizzle is imported only in `infrastructure/repositories/`** |
| `web/` | Next.js 16 App Router | Server components for reads so RESTRICTED fields never reach the browser bundle. Route handlers act as a BFF so the session cookie is never exposed to client JS |

Each gets its own scoped `CLAUDE.md` with localised rules.

**Module boundary rule:** no cross-module imports of internals. Use the public module interface
or a domain event through the outbox. Enforced by `eslint-plugin-boundaries` from Phase 2
(DEC-002) - until then it is documentation, not mechanism.
