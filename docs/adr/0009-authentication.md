# ADR-0009: Authentication - Entra ID OIDC with a Constrained Local Fallback

## Status

Proposed

> Only a human may set this to Accepted. Once Accepted this file is immutable and
> `.claude/hooks/guard-adr.mjs` will refuse edits - supersede it with a new ADR instead.

## Date

2026-09-08

## Context

Most staff have Microsoft 365 identities. Some - contractors, and site staff without corporate accounts - do not. Running two authentication paths is a known source of account-takeover and offboarding-desync bugs, so the second path must be tightly constrained rather than merely added.

## Options considered

| Option | Summary | Why not chosen |
|---|---|---|
| Entra ID only | Single IdP | Excludes staff without an M365 identity, who still need self-service access |
| Local accounts only | Self-contained auth | Discards tenant MFA, conditional access and centralised offboarding - all of which are already operating and better run by IT than by this application |
| **Entra ID primary + constrained local fallback (chosen)** | Both, with structural limits on the fallback | - |

## Decision

**Entra ID OIDC (authorization code + PKCE) is primary.** Identity is linked on the immutable `oid` claim with a verified `tid` - **never on email**, which is a display attribute an attacker can influence. No just-in-time provisioning: an unknown `oid` is an anomaly to alert on, not an account to create.

**Local password authentication exists only for employees**, and is constrained by a database CHECK:

```sql
CHECK (entra_object_id IS NULL OR local_auth_enabled = false)
```

That single constraint eliminates the MFA-downgrade attack - the otherwise-attractive path of using the password route to bypass conditional access on a privileged account.

Password policy follows **NIST SP 800-63B Rev 4**: length plus a breached-password blocklist, **no composition rules, no forced rotation**. Argon2id hashing with a bounded-concurrency semaphore, because at 19 MiB per verification a login flood would otherwise starve Postgres on a shared VM.

## Consequences

### Positive

- Corporate staff get tenant MFA and conditional access at no cost to this project
- Mutual exclusivity is structural, not procedural - it cannot be bypassed by a code path
- The local path stays small enough to reason about

### Negative / trade-offs

- Two paths is more auth surface to secure, test and reason about
- An Entra outage locks out everyone except sealed break-glass accounts
- Depends on tenant admin cooperation for app registration and, ideally, group claims

## Reconsider when

If every user eventually gains an Entra identity, retire the local path entirely.
