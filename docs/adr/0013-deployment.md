# ADR-0013: Deployment - Docker Compose on a Single VM

## Status

Proposed

> Only a human may set this to Accepted. Once Accepted this file is immutable and
> `.claude/hooks/guard-adr.mjs` will refuse edits - supersede it with a new ADR instead.

## Date

2026-09-08

## Context

One organization, at most a few thousand employees, operated by one developer who also writes the code. Infrastructure that is not actually operated is worse than simpler infrastructure that is.

## Options considered

| Option | Summary | Why not chosen |
|---|---|---|
| Kubernetes | Orchestrated, self-healing, multi-node | A platform to learn and operate, for a workload that fits comfortably on one machine. Unsustained complexity is less reliable than simplicity that is actually maintained |
| Managed PaaS | App platform plus managed database | Reasonable, but moves employee PII into a third party - which turns a currently-simple DPDP cross-border position into an assessment |
| **Docker Compose on a company VM (chosen)** | One host, nginx, Postgres, Redis, MinIO, app containers | - |

## Decision

Docker Compose on a single company-controlled VM: nginx (TLS, headers, rate limiting), the API, the web app, a worker, PostgreSQL, Redis, MinIO, and an observability stack.

Migrations run as a **separate one-shot container**, never on app boot - an app-boot migration means replicas race and a failed migration takes the app down.

Deployment is by **image digest**, built in CI, never built on the production host.

## Consequences

### Positive

- One host to understand, patch and back up
- No cloud egress of employee data, which keeps the DPDP position simple
- Cheap, and the cost is predictable

### Negative / trade-offs

- **A single point of failure with no HA.** Host loss is a full outage until restore. This is an accepted trade, not an oversight
- Backups, patching and secrets management are all our responsibility
- **Full-disk encryption protects a stolen disk and nothing else** - anything running on the host sees plaintext. The controls that actually protect data at rest here are off-host encrypted backups and application-level encryption of the narrow Tier 1 field set

## Reconsider when

A genuine HA requirement, a failed restore drill, or growth past ~20,000 employees. The escalation path is managed Postgres plus a second app host - a Compose and DNS change, not a rewrite.
