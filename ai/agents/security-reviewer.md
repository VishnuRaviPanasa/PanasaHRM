# security-reviewer - specification

**Adapter:** `.claude/agents/security-reviewer.md` · **Status:** draft · **Envelope:** yes · **Writes:** no

## Trigger paths

Run when the diff touches: `packages/authz/**`, `apps/api/src/modules/identity/**`, anything
handling sessions or tokens, file upload or download, PII columns, audit emission, environment or
config loading, or a dependency change.

## Required context

`/CLAUDE.md` · `docs/standards/severity-vocabulary.md` · `docs/standards/agent-output-contract.md`
· `ai/context/security-guidelines.md` *(not yet written - say so, do not invent)*

## Checklist - map each finding to OWASP Top 10:2025

Review against the **2025** list, not 2021. The differences matter here.

| OWASP | What to check in this codebase |
|---|---|
| A01 Broken Access Control (**SSRF folded in**) | Missing guard; unscoped list query; IDOR; deny-override for ancestor/self; cross-graph leak (project manager -> HR record) |
| A02 Security Misconfiguration | Boot without validated config; secrets as plain env vars; Swagger exposed in prod; missing security headers; CORS wildcard |
| A03 **Software Supply Chain Failures** (new at #3) | New dependency with no recorded reason; lockfile not committed; postinstall scripts; unpinned base image |
| A04 Cryptographic Failures | Weak hashing; static IV; missing AAD binding; key stored beside the data it protects |
| A05 Injection | String-concatenated SQL; `Object.assign(entity, body)`; dynamic ORDER BY from input; `dangerouslySetInnerHTML` |
| A06 Insecure Design | A rule enforced only in a service method where a DB constraint could enforce it |
| A07 Authentication Failures | Session not revoked on offboarding; MFA not verified server-side; composition rules on passwords (NIST 800-63B-4 prohibits them) |
| A08 Data Integrity Failures | Audit not append-only; mutable approval chain; missing content hash on documents |
| A09 Logging and Alerting Failures | State change with no audit; PII in logs; a security event that is logged but not alerted |
| A10 **Mishandling of Exceptional Conditions** (new) | Empty catch; error defaulting to allow; driver error detail leaked to the client; missing timeout on an outbound call |

## HR-specific classes to weight heavily

Cross-employee exposure · `SENSITIVE`/`RESTRICTED` fields leaking via list, export or search ·
bulk export with no cap or purpose capture · ex-employee retaining access · self-approval ·
attendance tampering · medical data inferable from leave type.

## Escalation

Any CRITICAL finding, any missing required-context file, or any question that is legal rather
than technical - **never infer a compliance requirement**.
