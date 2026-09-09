-- =============================================================================
-- 0021  Fix: fn_document_compliance counted a document that does not exist
-- =============================================================================
--
-- THE DEFECT, found by running 0020 against real data rather than by reading it.
--
-- `fn_document_compliance` reported `pending_scan = 1` for every employee who has NO documents
-- at all. Verified: EMP002 holds zero `employee_document` rows and the report claimed one
-- awaiting a scan.
--
-- The cause is the classic `count(*)` over a LEFT JOIN. For an employee with no documents the
-- join produces one row with every `d.*` column NULL, and the filter
--
--     count(*) FILTER (WHERE d.withdrawn_at IS NULL AND d.current_version_id IS NULL)
--
-- is TRUE for that phantom row - because NULL IS NULL is true, twice. `count(*)` counts rows,
-- and there is a row, so it counted it.
--
-- WHY THIS MATTERS MORE THAN A COSMETIC MISCOUNT: this is a COMPLIANCE report. It would have
-- told HR that all five employees had a document stuck in quarantine, sending them to look for
-- four files that were never uploaded - and, worse, it would have masked the real signal, since
-- an employee genuinely waiting on a scan looked identical to one who had uploaded nothing.
--
-- The fix is `count(d.id)`, which ignores NULLs, so a phantom row contributes nothing. The
-- `expiring_soon` and `expired` counters were already safe by accident: their filters test
-- `d.expires_on IS NOT NULL`, which a phantom row fails. Safe by accident is still worth
-- correcting, so all four now count the key rather than the row.
--
-- Class C. Verified by testing/db/0020_reporting.verify.sql (checks R7 and R8).
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION fn_document_compliance(p_expiring_within_days integer DEFAULT 60)
RETURNS TABLE (
    employee_id     uuid,
    filed_types     integer,
    pending_scan    integer,
    expiring_soon   integer,
    expired         integer
)
LANGUAGE sql STABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
    SELECT e.id,
           -- COUNT(d.id), not COUNT(*): a LEFT JOIN with no match yields one all-NULL row, and
           -- COUNT(*) counts it. Every counter here counts the KEY so an employee with no
           -- documents scores zero on all four.
           count(DISTINCT d.document_type_code) FILTER (
                WHERE d.id IS NOT NULL
                  AND d.withdrawn_at IS NULL
                  AND d.current_version_id IS NOT NULL)::integer,
           count(d.id) FILTER (
                WHERE d.withdrawn_at IS NULL
                  AND d.current_version_id IS NULL)::integer,
           count(d.id) FILTER (
                WHERE d.withdrawn_at IS NULL
                  AND d.expires_on IS NOT NULL
                  AND d.expires_on >= public.fn_business_date()
                  AND d.expires_on <= public.fn_business_date() + p_expiring_within_days)::integer,
           count(d.id) FILTER (
                WHERE d.withdrawn_at IS NULL
                  AND d.expires_on IS NOT NULL
                  AND d.expires_on < public.fn_business_date())::integer
      FROM public.employee e
      LEFT JOIN public.employee_document d ON d.employee_id = e.id
     GROUP BY e.id;
$$;

COMMENT ON FUNCTION fn_document_compliance(integer) IS
    'Per-employee document posture. Counts only, no titles and no types - a compliance report '
    'that named the document types would tell a reader who holds a MEDICAL certificate, which is '
    'information about health. Counts the KEY, never the row: COUNT(*) over the LEFT JOIN '
    'reported a phantom pending scan for every employee with no documents (0021).';

COMMIT;
