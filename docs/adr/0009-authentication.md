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

### Scoped exception to Must-Know Rule 12

Must-Know Rule 12 says *never call an external service from the request path; publish an event and
let a worker handle it*. OIDC cannot satisfy that literally: the authorization-code exchange and
JWKS retrieval are synchronous calls to Microsoft Entra, and there is no version of federated
sign-in in which they are not. The exception is therefore stated explicitly and **bounded to the
narrowest possible surface**:

> **Permitted exception to Must-Know Rule 12.** Synchronous outbound calls to the external identity
> provider are permitted **only** during identity establishment, and **only** for these operations:
>
> - the OIDC authorization-code + PKCE token exchange, at sign-in;
> - JWKS key retrieval for token signature validation, served from a **cached key set** with a
>   bounded refresh, so the common path performs no network call at all;
> - OIDC discovery metadata, cached on the same basis;
> - back-channel logout / token revocation, if implemented.
>
> **No other request may synchronously depend on the IdP.** Once a session exists, authentication
> and authorization for every subsequent request are resolved entirely from local state - the
> session store and the local `user` / `user_identity` / `user_role` tables. A request that is
> already authenticated **must never** block on Entra: not for group membership, not for profile
> refresh, not for account-status revalidation, not for token introspection.

**Why the boundary sits exactly there.** Rule 12 exists so that an external outage degrades one
feature rather than the whole application. Under this exception an Entra outage prevents *new*
sign-ins and leaves *existing* sessions fully functional - which is the failure mode the ADR's own
Consequences already describe, and is only true if the boundary is enforced. Any change that puts
an IdP call on an authenticated request path would silently convert an Entra outage into a total
outage, and is not covered by this exception.

**Corollary for offboarding.** Because revocation cannot depend on a synchronous IdP check, the
kill-switch must be driven *into* this system - a local disable that takes effect on the next
request - rather than discovered by asking Entra during one. The propagation mechanism and its
latency budget are ADR-0010's concern, not this one.

### Identity linking, stated rather than implied

This ADR said how an `oid` must *not* arrive. It did not say how it *does*, and the gap is an
account-takeover primitive rather than a documentation lapse.

> **`user_identity` carries `UNIQUE (tenant_id, subject)`.** Two rows sharing an Entra `oid` must be
> impossible at the database level. Without that constraint, anyone able to create a second row
> claiming an existing `oid` inherits that person's account on their next sign-in.

**A link is created only by an authenticated administrative action**, never by a login. An
unrecognised `oid` presented at sign-in is refused and alerted on - it is never upgraded into a new
account or attached to an existing one by matching email, display name, or any other attribute a
directory administrator or the user themselves can influence.

### The local-credential CHECK binds the credential, not a flag

`CHECK (entra_object_id IS NULL OR local_auth_enabled = false)` constrains a **boolean**, so a row
with `local_auth_enabled = false` may still hold a live `password_hash` - and a later bug, migration
or admin screen that flips the flag re-arms a credential nobody audited. The constraint is therefore
written against the credential itself:

```sql
CHECK (entra_object_id IS NULL OR password_hash IS NULL)
```

Disabling local authentication means **destroying the hash**, not hiding it behind a flag.

### Break-glass accounts are a named exception

The Decision says local authentication "exists only for employees"; the Consequences rely on
"sealed break-glass accounts" surviving an Entra outage. Both cannot be true as written. The
exception, bounded:

> A small, explicitly enumerated set of **break-glass accounts** may hold local credentials without
> being employees. They are sealed (credentials held offline, split if practical), MFA-enforced,
> excluded from bulk administration, and **every authentication by one raises an alert** rather than
> merely an audit row. They are the only non-employee local credentials permitted, and their number
> is a reviewed figure, not an emergent one.

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
