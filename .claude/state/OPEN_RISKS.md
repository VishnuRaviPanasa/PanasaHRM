# Open Risks and Deferred Items

Reviewed at every slice close. Anything still open after two slices gets escalated to the human.

| ID | Item | Why it matters | Owner | Review by |
|---|---|---|---|---|
| OR-01 | **Handbook contradictions C1-C12 unresolved** (plan Appendix A8). Highest impact: **C3** (is "a minimum of 6 CL/SL every 6 months" actually a *maximum*?) and **C8** (no grace period, no half-day threshold defined anywhere) | Leave and attendance engines cannot be built correctly without these. Both are one-line answers from HR | Human (HR) | Before Phase 6 |
| ~~OR-02~~ | ~~2026/2027 holiday calendars missing~~ **RESOLVED 2026-09-08** - 2026 recorded from live GreytHR in `docs/requirements/holiday-calendar-2026.md`. 2027 still outstanding (H-06) | - | - | Closed |
| OR-03 | **No named legal/compliance contact** for DPDP sign-off | DPDP compliance is currently an accepted risk with no owner | Human | Before go-live |
| OR-04 | **Nothing pushed to the remote** - the sandbox has no network access | The repo exists only locally | Human | Next non-sandboxed run |
| OR-05 | **ESLint not configured** - deferred until there is code to lint (DEC-002) | Module-boundary enforcement (Must-Know Rule 8) is currently documentation, not mechanism | Claude | Phase 2 |
| OR-06 | **Holiday election questions H-01..H-06** raised by the 2026 calendar - notably the optional allowance (2 in 2025, at least 3 in 2026) and what happens to leave already approved on a date that later becomes a holiday | The election cap is a hard input to the leave engine; the retroactive-holiday case is a ledger reversal path | Human (HR) | Before Phase 6 |
| OR-07 | **GreytHR covers more ground than assumed** - its ESS today includes Leave, Attendance, Salary, Document Center, People, Helpdesk, Request Hub and Workflow Delegates. Replacing it is a materially larger scope than complementing it | Directly affects O12 (retire or coexist) and the MVP cut line | Human | Before Phase 7 |
