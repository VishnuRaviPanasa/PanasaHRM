# Open Risks and Deferred Items

Reviewed at every slice close. Anything still open after two slices gets escalated to the human.

| ID | Item | Why it matters | Owner | Review by |
|---|---|---|---|---|
| OR-01 | **Handbook contradictions - no longer blockers.** C3 and C8 answered by HR; C1, C2, C4, C5, C6, C12 are now **settings with badged defaults** (DEC-019/020). Only **C7** remains genuinely absent - there is no overtime policy to configure from | 16 fields carry engineering defaults badged `unconfirmed`. Nothing is blocked, but a badged value must not be presented as settled policy | Human (HR) | Confirm via the settings screen |
| OR-08 | **Two residual sub-questions from the C3/C8 answers**: (a) is the 6-month cap window calendar halves or rolling? (b) should `full_day_minutes` be 465 rather than 480, so the 15-min grace does not cost half a day? Defaults chosen for both; each is a one-line change | Wrong defaults would be quietly wrong rather than loudly wrong | Human (HR) | Before Phase 8 |
| ~~OR-02~~ | ~~2026/2027 holiday calendars missing~~ **RESOLVED 2026-09-08** - 2026 recorded from live GreytHR in `docs/requirements/holiday-calendar-2026.md`. 2027 still outstanding (H-06) | - | - | Closed |
| OR-03 | **No named legal/compliance contact** for DPDP sign-off | DPDP compliance is currently an accepted risk with no owner | Human | Before go-live |
| OR-04 | **Nothing pushed to the remote** - the sandbox has no network access | The repo exists only locally | Human | Next non-sandboxed run |
| OR-05 | **ESLint not configured** - deferred until there is code to lint (DEC-002) | Module-boundary enforcement (Must-Know Rule 8) is currently documentation, not mechanism | Claude | Phase 2 |
| OR-06 | **Holiday election questions H-01..H-06** raised by the 2026 calendar - notably the optional allowance (2 in 2025, at least 3 in 2026) and what happens to leave already approved on a date that later becomes a holiday | The election cap is a hard input to the leave engine; the retroactive-holiday case is a ledger reversal path | Human (HR) | Before Phase 6 |
| OR-07 | **GreytHR covers more ground than assumed** - its ESS today includes Leave, Attendance, Salary, Document Center, People, Helpdesk, Request Hub and Workflow Delegates. Replacing it is a materially larger scope than complementing it | Directly affects O12 (retire or coexist) and the MVP cut line | Human | Before Phase 7 |
