# Security Guidelines

**Read before touching auth, sessions, uploads, PII, state-changing endpoints, audit or secrets.**
Review against **OWASP Top 10:2025** - not the 2021 list. Editing requires architecture review.

## Data classification - drives masking, logging and export

| Class | Examples | Default visibility |
|---|---|---|
| `PUBLIC_INTERNAL` | Name, work email, designation, department, work location | All authenticated users |
| `PERSONAL` | Personal phone/email, address, DOB, emergency contact | Self, `hr_ops`+ |
| `SENSITIVE` | Bank account, PAN, government IDs, marital status, dependants | Self (masked), `hr_ops`+ with purpose, `finance` for payroll |
| `RESTRICTED` | Compensation, performance ratings, disciplinary records, medical, exit reason | Explicit grant only. **Never in list endpoints** |

**A field with no classification is never serialized.** Default-deny (ADR-0005).

## The 2025 list, mapped to this codebase

| OWASP | Concretely here |
|---|---|
| **A01 Broken Access Control** (SSRF folded in) | See `rbac-rules.md`. No user-supplied URLs exist; if one is ever added, allowlist, resolve-then-validate against link-local (`169.254.169.254`) and RFC1918, pin the resolved IP, no redirects |
| **A02 Security Misconfiguration** | Zod config validated at boot; secrets file-backed not env vars; non-root read-only containers; Postgres/Redis publish no host ports; nonce-based CSP; **no Swagger in production** |
| **A03 Software Supply Chain** (new at #3) | Committed lockfile; `npm ci` only; `--ignore-scripts` with an explicit allowlist (postinstall is the primary npm attack vector); base images pinned **by digest**; builds in CI, never on the production host |
| **A04 Cryptographic Failures** | Argon2id for passwords; AES-256-GCM with record id as AAD for Tier 1 fields; HMAC blind indexes for exact-match lookup; **the KEK must live outside the VM**, or encryption only protects a stolen disk |
| **A05 Injection** | Parameterised queries only; string-concatenated SQL banned by lint; **`Object.assign(entity, body)` forbidden** - DTO allowlists; dynamic `ORDER BY` through a fixed enum map |
| **A06 Insecure Design** | A rule enforceable by a DB constraint must not live only in a service method |
| **A07 Authentication Failures** | See ADR-0009/0010. NIST 800-63B-4: no composition rules, no forced rotation, breach blocklist. **SMS OTP does not meet AAL2** |
| **A08 Data Integrity Failures** | Append-only audit; immutable approval chains; document content hashes; deploy by digest |
| **A09 Logging and Alerting Failures** | See below. Alerted, not merely logged: bulk export, permission-deny bursts, privilege grants, break-glass use, termination-invariant violations |
| **A10 Mishandling of Exceptional Conditions** (new) | No empty catch; **fail closed** on authz errors; driver detail stripped; timeouts on every outbound call |

## Never logged, under any circumstance

Full name · personal contact details · address · DOB · PAN/Aadhaar/UAN/passport · bank details ·
salary · performance ratings · medical or disciplinary text · biometric templates · session
cookie · `Authorization` header · OIDC `code`/tokens · passwords · presigned URL query strings ·
full request bodies.

**Logged instead:** internal UUID, correlation id, action, authorization decision + reason code,
resource type and id, and field **classes** touched - never values.

Enforced by pino redaction, a typed `LogSafe` contract so an entity cannot reach the logger, and
a lint rule banning entity interpolation.

> The internal employee UUID **is still personal data** under DPDP because it is linkable.
> Application logs therefore carry a retention schedule and access controls. They are not exempt
> infrastructure exhaust.

## File uploads - the highest-risk surface

Employee documents contain Tier 1 data in unstructured form, defeating column-level controls.

- **Allowlist**: PDF, JPEG, PNG, DOCX, XLSX. **SVG is banned outright** - no HR use case, and it
  is an HTML-equivalent stored-XSS vector
- **Magic-byte inspection** must agree with the declared content type *and* the extension. A
  mismatch is rejected **and alerted** - a polyglot attempt is an attack signal, not a user error
- **Re-encode images** through `sharp`: strips EXIF (a photographed ID card carries GPS) and
  destroys polyglot payloads in one step
- Size caps enforced **before** stream consumption; decompression-ratio caps on DOCX/XLSX
- **Quarantine then promote**: upload lands in a quarantine bucket, a job scans it, only a clean
  verdict promotes it
- Private ACLs, random opaque keys, **never on a volume served by nginx**
- Download via a 90-second single-use presigned URL bound to the requesting user, served from a
  **distinct hostname** so residual stored-XSS cannot reach the app origin's cookies

*Honest limitation: malware scanning catches commodity threats. A targeted document will pass.*

## CSRF

**Primary control is origin validation**: every state-changing request must present
`Sec-Fetch-Site: same-origin` or an exact-match `Origin`. Absent both, reject. Simpler and harder
to misimplement than token plumbing; a signed double-submit token is the secondary layer.

**Invariant: no GET ever changes state.** That is the specific gap `SameSite=Lax` leaves, and it
is closed by discipline rather than configuration.

## Rate limiting

Keyed on **user/session id** wherever authenticated. Per-IP limiting alone is worthless here
because server-side rendering makes all SSR-originated requests share one container IP - so
`/auth/*` and all mutations go **directly browser-to-API**, never through SSR, and `trust proxy`
is set to the **exact** hop count. Setting it to `true` lets an attacker spoof `X-Forwarded-For`
and bypass limiting entirely.

## Secrets

File-backed Docker secrets on tmpfs, mode 0400, with a `_FILE` config convention. **Never plain
environment variables** - they are visible in `docker inspect`, `/proc/<pid>/environ`, child
processes, crash handlers, and one careless `console.log(process.env)`. Never a build arg; they
persist in image layers.

## What we consciously accept

Host root compromise is total and largely undetectable on-box - only off-host immutable backups
and audit shipping constrain it. Application-level encryption defeats database dumps, backups,
snapshots and SQLi exfiltration; it **does not** protect a live host. There is no segregation of
duties. Detection latency is hours to days. These are documented trade-offs of a single-VM,
solo-operator deployment (ADR-0013), not oversights.
