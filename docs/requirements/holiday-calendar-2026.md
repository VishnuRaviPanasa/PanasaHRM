# Holiday Calendar 2026

**Status:** Recorded from source · **Resolves:** OR-02, C9, Q4f
**Source:** Live GreytHR ESS — `panasa.greythr.com/v3/portal/ess/leave/holiday-calendar`,
captured 2026-09-08. Screenshot is of one employee's view, so **elected** optional holidays shown
are that employee's, not policy.

## The calendar

17 holidays published. All fall Monday–Friday.

| Date | Day | Holiday | Type |
|---|---|---|---|
| 01 Jan 2026 | Thu | New Year's Day | Fixed |
| 15 Jan 2026 | Thu | Pongal | **Optional** |
| 26 Jan 2026 | Mon | Republic Day | Fixed (national) |
| 20 Mar 2026 | Fri | Id-ul-Fitr (Ramzan) | Fixed |
| 02 Apr 2026 | Thu | Maundy Thursday | **Optional** |
| 03 Apr 2026 | Fri | Good Friday | Fixed |
| 09 Apr 2026 | Thu | **Election — Kerala** | **Optional** · *ad-hoc, government-ordered* |
| 15 Apr 2026 | Wed | Vishu | Fixed |
| 01 May 2026 | Fri | May Day | Fixed |
| 27 May 2026 | Wed | Id-ul-Ad'ha (Bakrid) | **Optional** |
| 25 Aug 2026 | Tue | First Onam **/ Milad-i-Sherif\*** | **Optional** · *two festivals, one date* |
| 26 Aug 2026 | Wed | Thiruvonam | Fixed |
| 14 Sep 2026 | Mon | Ganesh Chaturthi | **Optional** |
| 02 Oct 2026 | Fri | Gandhi Jayanti | Fixed (national) |
| 20 Oct 2026 | Tue | Mahanavami | Fixed |
| 25 Dec 2026 | Fri | Christmas | Fixed |
| 31 Dec 2026 | Thu | New Year's Eve | Fixed (company) |

**11 fixed · 6 optional.** Months with **no** holidays: February, June, July, November.

Optional holidays are identified by the ESS offering an `Apply` action; elected ones show
`APPLIED`. In the captured view three were applied (Maundy Thursday, Election — Kerala, First
Onam) and three remained available.

## What changed since the 2025 handbook

| | 2025 handbook | 2026 live |
|---|---|---|
| Fixed | 10 | 11 |
| Optional | 5, **"employees can avail 2"** | 6, **at least 3 elected** |
| Republic Day | **Absent** | **Present** (26 Jan) |
| Ad-hoc holidays | none | **Election — Kerala** added |

## Design implications

1. **The optional allowance is per-year configuration, not a constant.** It moved from 2 (2025)
   to at least 3 (2026), and the pool from 5 to 6. `holiday_calendar` is keyed by
   `calendar_year` and must carry the allowance as a column. Hardcoding "2" would have been
   wrong within one year.

2. **Holidays are added mid-year by government order.** "Election — Kerala" is not a festival on
   any almanac — it appeared because polls were called. Consequences:
   - The calendar must be **editable in-year** by HR, not seeded once.
   - Adding a holiday **retroactively** must trigger an attendance recompute for the affected
     dates (already an input to `input_fingerprint`).
   - **Open question for HR:** if an employee had already taken *approved leave* on a date that
     later becomes a holiday, is that leave refunded to the balance? This is a real reversal case
     and the answer changes the ledger logic.

3. **Two festivals can share one date.** `First Onam / Milad-i-Sherif` occupies 25 Aug. The
   planned schema has `UNIQUE (holiday_calendar_id, holiday_date)`, which permits only one row
   per date.
   **Recommendation: keep the unique constraint** — it prevents a whole class of duplicate-day
   bugs — and store the combined label with a `notes` column for the asterisk. This only breaks
   if the two festivals are ever **separately electable**, which the ESS does not suggest.
   Confirm with HR before Phase 6.

4. **No holiday falls on a Saturday or Sunday in 2026**, so the "holiday on a week-off" rule is
   both undefined and untested. It will occur eventually. **Open question:** is it observed on
   the next working day, lost, or converted to a comp-off?

5. **Republic Day's 2025 absence looks like a handbook error**, since it is present in 2026.
   Closes C11 as a live-data question; still worth a sentence from HR for the record.

## Concrete cases to put to HR alongside C1 (the sandwich rule)

The 2026 calendar produces exactly the ambiguous shapes the handbook contradicts itself on.
Asking with real dates gets a faster, less ambiguous answer than asking in the abstract:

- **Thu 2 Apr + Fri 3 Apr are both holidays**, followed by the weekend. An employee takes leave
  on **Wed 1 Apr** and **Mon 6 Apr**. Under a sandwich rule that counts intervening holidays and
  week-offs, that is 2 days of leave or 6. **Which?**
- **Tue 25 Aug + Wed 26 Aug are both holidays.** Leave on **Mon 24 Aug** — does anything change?
- If an employee elects **Pongal (15 Jan)** as an optional holiday but a colleague does not, they
  have different working calendars in the same team. **Confirm** attendance and leave both
  resolve the calendar **per employee**, not per department.

## Open items

| Ref | Question | Blocks |
|---|---|---|
| H-01 | **How many optional holidays may an employee elect in 2026?** Screenshot shows 3 applied of 6; the handbook said 2 of 5 for 2025 | Leave engine — the election cap |
| H-02 | Is elected-optional-holiday choice **locked** once applied, or changeable during the year? | Election model |
| H-03 | Leave already approved on a date that later becomes a holiday — refunded or not? | Ledger reversal logic |
| H-04 | Holiday falling on a Saturday/Sunday — observed, lost, or comp-off? | Attendance derivation |
| H-05 | Are co-dated festivals ever separately electable? | Schema unique constraint |
| H-06 | Is there a published **2027** calendar yet? | Year-close testing |

## Seed data note

This calendar is suitable as **realistic test data** for Phase 6 and Phase 8 and should be
seeded in `infrastructure/db/seeds/`. It is genuinely useful for testing because it contains
consecutive holidays, an ad-hoc mid-year addition, co-dated festivals, months with zero
holidays, and a per-employee election mechanism — the exact edge cases a synthetic calendar
would omit.
