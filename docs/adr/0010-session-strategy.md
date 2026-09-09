# ADR-0010: Sessions - Opaque Server-Side, Not JWT

## Status

Proposed

> Only a human may set this to Accepted. Once Accepted this file is immutable and
> `.claude/hooks/guard-adr.mjs` will refuse edits - supersede it with a new ADR instead.

## Date

2026-09-08

## Context

An offboarded employee must lose access immediately. HR terminations are the highest-likelihood, highest-impact security event in an HR system, and a token that stays valid until expiry is a window during which a former employee retains their access.

## Options considered

| Option | Summary | Why not chosen |
|---|---|---|
| Stateless JWT | Signed token, no server lookup | Cannot be revoked before expiry without a lookup - and once a lookup happens on every request, statelessness is gone and only the signing key remains to protect |
| JWT plus a revocation table | Token signed, jti checked against a store | Performs the lookup anyway, so it buys nothing over an opaque id while still requiring a signing key to secure |
| **Opaque server-side session (chosen)** | 256-bit random id, state in Postgres cached in Redis | - |

## Decision

An opaque 256-bit random session identifier in a `__Host-hrm_session` cookie (HttpOnly, Secure, SameSite=Lax, Path=/), with session state held as set out in the amendment below - **Redis is authoritative for the session record**; PostgreSQL holds the durable identity and role data that is read fresh on every request.

Role, scope and employment status are read fresh, so a termination or a role change takes effect on the **next request** rather than at token expiry.

### Amended 2026-09-08 (pre-acceptance) - what "cached" and "fresh" actually mean

"State in PostgreSQL cached in Redis" plus "read fresh" is a contradiction unless the split is
stated. If the cache holds authorization inputs with a TTL, revocation is delayed by that TTL and
"immediate" is false - which reintroduces exactly the window that made stateless JWTs unacceptable
in the Options table. The split is therefore binding:

| Data | Where | Revocation |
|---|---|---|
| Session existence, expiry, absolute lifetime, CSRF material | Redis, authoritative, TTL = session lifetime | Deleting the key ends the session immediately |
| **Role, scope, employment status, account-enabled** | **PostgreSQL, read on every request. Never cached with a TTL.** | Takes effect on the next request |

If these are ever memoised, it may only be **within a single request**, never across requests.
A cross-request cache of an authorization input requires a superseding ADR, because it silently
converts this decision into the one it rejected.

**The session token is stored hashed.** The cookie carries a 256-bit random value; what is
persisted is **SHA-256 of that value**, never the value itself. A database or backup disclosure
must not yield usable session tokens. Lookup is by hash; there is no reversible form anywhere.

**`audit_event.session_id` is not the session token.** That column is `UUID` (128 bits) in migration
0001, while the session identifier here is 256-bit - so they cannot be the same value, and the
mismatch must not be resolved by widening one to fit the other. `audit_event.session_id` holds a
**non-secret surrogate session id** generated per session for correlation. **The bearer token, and
any hash of it, must never be written to `audit_event`** - an append-only table with a decade of
retention is the worst possible place for credential material.

The `__Host-` prefix prevents a subdomain from setting or overwriting the cookie. `SameSite=Lax` is deliberate rather than `Strict`, because the OIDC redirect return requires it; CSRF is covered separately by origin validation.

## Consequences

### Positive

- Revocation is immediate and unconditional - the decisive property for offboarding
- No session signing key exists, so there is one fewer secret to protect and rotate
- Session state can carry more than a token comfortably would

### Negative / trade-offs

- A lookup per request. Immaterial on a single VM at this scale, but it is a real dependency on Redis and Postgres availability
- Horizontal scaling requires shared session storage - already true here

## Reconsider when

Never for this system. The revocation requirement is not negotiable in an HR context.
