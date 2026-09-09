-- =============================================================================
-- 0026  A department cannot be placed inside its own subtree
-- =============================================================================
--
-- THE GAP, found while building the department master that would have been the first thing able
-- to reach it.
--
-- 0017 forbids a department being its OWN parent (`ck_department_period_not_self`), and check G9
-- proves that `fn_department_subtree_asof` TERMINATES when it meets a cycle. Those are two
-- different guarantees, and neither is "a cycle cannot exist". Reproduced through exactly the
-- path HR would take - a forward close followed by a re-parent:
--
--     A (root), B under A
--     close A's placement at business_date + 1
--     insert A under B, effective business_date + 1        -- ACCEPTED
--
-- and now A is under B while B is under A. Nothing raised. The traversal survives because it is
-- depth-capped and path-guarded, but it returns the WRONG ANSWER: `fn_department_subtree_asof(A)`
-- reported 1 row where 2 exist, because the walk stops when it re-meets a department it has
-- already seen.
--
-- WHY THAT MATTERS MORE THAN A TIDY TREE: the subtree function is what
-- `fn_department_headcount_asof` rolls up, and the reporting module composes headcount into HR's
-- figures. A cycle therefore does not produce an error anybody can act on - it produces a
-- headcount that is quietly too low, in a report that looks completely normal. The failure is
-- silent, which is the worst class.
--
-- WHY A TRIGGER RATHER THAN A CHECK. A CHECK constraint sees one row; this question needs a
-- traversal ("is the proposed parent already somewhere beneath me?"). It is enforced in the
-- database rather than in the new controller because a migration, a backfill or the next code
-- path would each have to remember the rule independently - and the whole point of the placement
-- being effective-dated is that it is written from several places over time.
--
-- THE CHECK IS AS OF `valid_from`, not as of today. A placement can be future-dated, and whether
-- it creates a cycle depends on the structure in force on the day it takes effect - the same
-- as-of discipline every other query here follows.
--
-- Class C - it changes what the effective-dated org structure will accept.
-- Verified by testing/db/0017_organization_structure.verify.sql, checks G19-G21.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION fn_department_no_cycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
DECLARE v_conflict text;
BEGIN
    IF NEW.parent_department_id IS NULL THEN
        RETURN NEW;                       -- a root placement can never close a loop
    END IF;

    /*
     * Is the proposed parent already inside MY subtree, as of the day this placement starts?
     *
     * The row being inserted is not visible to this query - it is a BEFORE trigger - which is
     * exactly right: the question is about the structure the new placement would join, not the
     * one it creates. `fn_department_subtree_asof` is itself depth-capped and path-guarded, so
     * this is safe to call even if some earlier data already contains a loop.
     */
    SELECT d.code INTO v_conflict
      FROM public.fn_department_subtree_asof(NEW.department_id, NEW.valid_from) s
      JOIN public.department d ON d.id = s.department_id
     WHERE s.department_id = NEW.parent_department_id;

    IF v_conflict IS NOT NULL THEN
        RAISE EXCEPTION
            'department % cannot be placed under %, which is already inside its own subtree',
            (SELECT code FROM public.department WHERE id = NEW.department_id), v_conflict
            USING HINT = 'Move the descendant out first, or choose a parent outside this subtree.',
                  ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION fn_department_no_cycle() IS
    'Refuses a department placement whose parent already sits inside that department''s own '
    'subtree as of valid_from. 0017 forbade only SELF-parenting; a two-step loop was accepted, '
    'and its cost was not an error but a silently understated headcount - the subtree walk stops '
    'when it re-meets a department, so the rollup under-reports and the report looks normal.';

CREATE TRIGGER tg_department_period_no_cycle
    BEFORE INSERT ON department_period
    FOR EACH ROW EXECUTE FUNCTION fn_department_no_cycle();
-- ENABLE ALWAYS (DEC-030): a plain ENABLE trigger is switched off by
-- session_replication_role = 'replica', which a restore or a replication tool sets - and a
-- restore is precisely when nobody is watching.
ALTER TABLE department_period ENABLE ALWAYS TRIGGER tg_department_period_no_cycle;

COMMIT;
