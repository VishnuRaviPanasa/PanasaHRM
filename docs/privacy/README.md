# docs/privacy/

## data-inventory.md (Phase 2)

For **every table and column**: classification, purpose, lawful basis, retention period, and
whether it leaves the system.

**A CI check fails if a migration adds a column that is not classified here.** That turns "do we
know what personal data we hold?" from an annual audit panic into a build-time invariant.

Classifications: `PUBLIC_INTERNAL` | `PERSONAL` | `SENSITIVE` | `RESTRICTED`.

Jurisdiction is India: **DPDP Act 2023 + DPDP Rules 2025** (notified 13 Nov 2025; hard
enforcement widely expected around May 2027). Data-principal rights are built as product
features, not manual processes. Erasure is **selective** - statutory retention (payroll, tax,
PF/ESI) overrides an erasure request, and that distinction is encoded per column here.

**Open:** no named legal contact yet (OR-03). Until there is one, DPDP compliance is an accepted
risk with no owner - recorded as a conscious decision, not an oversight.
