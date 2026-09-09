-- =============================================================================
-- 0034  An issued offer can be retracted
-- =============================================================================
--
-- 0032 gave `offer_issued` exactly two ways out: the candidate accepts, or the candidate declines.
-- Both require the candidate to answer. **Nothing handled the case where they never do**, and it
-- is not a rare one - people go quiet, a budget is pulled, a role is cancelled after the letter
-- goes out.
--
-- The consequences were worse than an untidy record, because `ux_salary_annexure_one_live` counts
-- `offer_issued` as live:
--
--   * HR could not retract the offer - `withdraw` had no transition from that state;
--   * HR could not prepare a new annexure for the same person, because the stuck one still held
--     the single live slot;
--   * so a silent candidate froze that person's onboarding permanently, with no way out through
--     the product at all.
--
-- FOUND BY THE BROWSER SUITE getting stuck on exactly that state and being unable to clear it -
-- its cleanup withdraws whatever is in flight, and discovered there was no such move. A test
-- unable to reset itself turned out to be the same problem a person would hit.
--
-- WITHDRAWING IS NOT DECLINING, and the distinction is the reason this is a separate move rather
-- than reusing `decline_offer`. Declining is the CANDIDATE's answer and drives the employee to the
-- `offer_declined` terminal (0031); withdrawing is the COMPANY retracting, and says nothing about
-- what the candidate would have said. Recording a retraction as a decline would put words in
-- somebody's mouth in a record that outlives everyone who remembers.
--
-- `ck_sae_reason_required` already covers `withdraw`, so a retraction cannot be recorded without
-- saying why.
-- =============================================================================

BEGIN;

INSERT INTO salary_annexure_status_transition (event_type, from_status, to_status) VALUES
    ('withdraw', 'offer_issued', 'withdrawn');

COMMIT;
