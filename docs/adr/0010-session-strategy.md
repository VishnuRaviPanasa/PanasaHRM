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

An opaque 256-bit random session identifier in a `__Host-hrm_session` cookie (HttpOnly, Secure, SameSite=Lax, Path=/), with session state in PostgreSQL cached in Redis.

Role, scope and employment status are read fresh, so a termination or a role change takes effect on the **next request** rather than at token expiry.

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
