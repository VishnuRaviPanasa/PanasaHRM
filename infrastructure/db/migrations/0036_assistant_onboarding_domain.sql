-- =============================================================================
-- 0036  The assistant gains an `onboarding` routing domain
-- =============================================================================
--
-- The assistant routes a question to ONE domain before it selects a tool (DEC-127: flat-listing
-- fifty tools measurably degrades selection on a small model, and the failure is silent). The
-- domain the router chose is then recorded on the transcript row, and
-- `ck_assistant_message_domain` is a closed set - so a tool in a domain the constraint does not
-- know about does not degrade gracefully. It routes, it selects, it runs, it answers, and the
-- INSERT at the end of the turn fails on a check violation.
--
-- ONBOARDING IS ITS OWN DOMAIN AND NOT A CORNER OF `people`, for the reason ADR-0020 (the
-- onboarding boundary) gives when it calls onboarding "a new bounded context and a leaf": the
-- questions are about an approval chain and a proposed joining date, not about the employee
-- directory. Routing them through `people` would put annexure tools in front of the router every
-- time somebody asked who works in Engineering, which is the selection noise DEC-127 exists to
-- remove.
--
-- `cross` WAS THE OTHER CANDIDATE AND IS WORSE. `cross` tools are added to the candidate list for
-- EVERY routed domain, so parking onboarding there would hand three extra tools to every question
-- in the product - the opposite of narrowing.
--
-- THIS WIDENS A CHECK AND REMOVES NOTHING. Every value the constraint accepted before is still
-- accepted, so no existing row can become invalid and there is no data to migrate. `payroll` is
-- still refused, which is what check A6 of the assistant verification asserts and what ADR-0014
-- forbids by name - the new value is a routing label for questions about an approval chain, and
-- carries no capability of its own.
--
-- WHAT MAKES THIS SAFE TO ADD IS ELSEWHERE, and is worth naming here because a reader of this
-- file will reasonably ask whether an onboarding domain lets the assistant read compensation:
-- it cannot, and the control is not this constraint. ADR-0020 (the runtime assistant) carries
-- ADR-0014's prohibition forward "verbatim and unweakened" - *no AI input to compensation* - and
-- makes it structural with "no tool reads compensation". The field registry in `packages/authz`
-- registers `salary_annexure` WITHOUT `declared_annual_ctc_minor`, without `amount_minor` and
-- without `ctc_at_decision_minor`, and the mask is default-deny, so a money column cannot be
-- returned by a tool even if a SELECT list asks for it. A routing label cannot widen that.
--
-- 0035 IS NOT EDITED. It is applied and checksum-enforced (DEC-012), migrations are forward-only
-- (DEC-011), and DEC-167 is the reason this file is 0036 rather than a second 0029.
-- =============================================================================

BEGIN;

ALTER TABLE assistant_message
    DROP CONSTRAINT ck_assistant_message_domain;

ALTER TABLE assistant_message
    ADD CONSTRAINT ck_assistant_message_domain
        CHECK (route_domain IS NULL OR route_domain IN
            ('me', 'leave', 'attendance', 'work', 'people', 'documents', 'cross', 'meta',
             'onboarding'));

COMMENT ON CONSTRAINT ck_assistant_message_domain ON assistant_message IS
    'The closed set of routing domains, mirrored by DOMAINS in apps/api/src/assistant/catalog.ts. '
    'A domain the API can route to but this constraint rejects fails the transcript INSERT at the '
    'END of a turn, after the answer has already been given - so the two lists must move together. '
    'onboarding was added by 0036.';

COMMIT;
