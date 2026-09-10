-- =============================================================================
-- 0037  The assistant gains a `pay` routing domain
-- =============================================================================
--
-- ADR-0021 lets the catalogue report pay - own payslip for everybody, everybody's for `hr_admin`
-- and `finance`, and the annexure CTC for the four roles in the approval chain. The router picks
-- ONE domain before selecting a tool (DEC-127), records it on the transcript, and
-- `ck_assistant_message_domain` is a closed set, so the two lists have to move together. 0036's
-- header states the failure mode and it is unchanged: the transcript INSERT happens at the END
-- of a turn, so a domain the router can reach but the constraint rejects answers the user and
-- then fails its own audit row.
--
-- WHY `pay` IS ITS OWN DOMAIN AND NOT PART OF `me`. A payslip question is about the asker most of
-- the time, which is an argument for `me` - but not always, and the exception is the whole point:
-- `hr_admin` and `finance` may ask about anybody, and `me` is described to the router as *"the
-- asker's own record"*. Routing "what did Priya earn in August" to a domain whose blurb says
-- "your own record" is asking the router to contradict itself. A separate domain also keeps pay
-- tools out of the candidate list for every leave and attendance question, which is the selection
-- noise DEC-127 exists to remove.
--
-- IT CARRIES NO CAPABILITY. A routing label decides which tools a model may choose from; it
-- decides nothing about access. Who may read a figure is `payroll.payslip.read` and
-- `onboarding.annexure.read`, unchanged by this migration and by ADR-0021 - the subject always,
-- `hr_admin` and `finance` for everyone, and `isAncestorOfActor` still denying a manager their
-- own report's payslip. Where the figure may GO is ADR-0021 section 2, enforced in the API by a
-- tool composing its own sentence so no provider call is made.
--
-- `payroll` IS STILL REFUSED, and deliberately not reused as the name here. Check A6 of the
-- assistant verification asserts that value is rejected, on the grounds that *"there is no
-- payroll domain, and a tool catalogue that could route there is exactly what ADR-0014 forbids"*.
-- ADR-0014's prohibition on AI input to a compensation DECISION is not relaxed by ADR-0021 -
-- only the lookup of a figure somebody may already read is - so the value that check pins stays
-- pinned, and the new domain gets a different name rather than quietly occupying the one an
-- earlier decision refused.
--
-- WIDENS AND REMOVES NOTHING. Every value accepted before is accepted still, so no existing row
-- can become invalid and there is no data to migrate.
--
-- 0035 AND 0036 ARE NOT EDITED - applied and checksum-enforced (DEC-012), forward-only
-- (DEC-011).
-- =============================================================================

BEGIN;

ALTER TABLE assistant_message
    DROP CONSTRAINT ck_assistant_message_domain;

ALTER TABLE assistant_message
    ADD CONSTRAINT ck_assistant_message_domain
        CHECK (route_domain IS NULL OR route_domain IN
            ('me', 'leave', 'attendance', 'work', 'people', 'documents', 'cross', 'meta',
             'onboarding', 'pay'));

COMMENT ON CONSTRAINT ck_assistant_message_domain ON assistant_message IS
    'The closed set of routing domains, mirrored by DOMAINS in apps/api/src/assistant/catalog.ts. '
    'A domain the API can route to but this constraint rejects fails the transcript INSERT at the '
    'END of a turn, after the answer has already been given - so the two lists must move together. '
    'onboarding was added by 0036 and pay by 0037 (ADR-0021). "payroll" remains refused: '
    'ADR-0014 forbids AI input to a compensation DECISION and ADR-0021 relaxes only the lookup.';

COMMIT;
