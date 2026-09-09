# Deployment runbook

**The deployment runbook is [`/DEPLOY.md`](../../DEPLOY.md) at the repository root.**

It lives there rather than here for parity with the other apps on the same host (`hr-agent` and
friends each keep a `DEPLOY.md` beside their `deploy.sh`), and because `deploy.sh` refers to it.

## Why this file is a pointer and not a runbook

An earlier version of this file documented a different topology: the stack's own nginx binding
host `:80`/`:443` and terminating TLS from a mounted certificate, i.e. PanasaHRM owning the whole
VM. **That is not how it is deployed.** The VM already runs several applications behind one nginx
that terminates TLS on `:7777` and path-routes to loopback ports, so this stack publishes
`127.0.0.1:4787` and speaks plain HTTP, with TLS ending one hop upstream.

Two runbooks describing two topologies is how somebody follows the wrong one at 2am, which is
exactly what this directory's README says a runbook exists to prevent. The good parts of that
version - the one-shot migration image, the profiled destructive seed, the owner/application role
split, the pinned MinIO release - were folded into the live stack rather than discarded.

See `docs/governance/decisions.md`, DEC-105.
