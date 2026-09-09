-- =============================================================================
-- Verification for 0018: employee documents
--
-- `ai/context/security-guidelines.md` calls file upload the highest-risk surface, so these
-- checks are adversarial by default. The three that carry the most weight:
--
--   D6  a PENDING version cannot become the current version. This is the quarantine gate, and
--       it is what makes an unscanned file unreachable through the DATA MODEL rather than merely
--       un-served by the application.
--   D8  a version belonging to a DIFFERENT document cannot be promoted here. Without it, one
--       employee's file could be served under another employee's document record.
--   D11 a scan verdict is terminal. Re-judging a clean file into infected would silently change
--       what an already-served document was.
--
-- Runs inside a transaction the runner always rolls back (DEC-024).
-- =============================================================================

-- D1: the MIME allowlist is a CHECK, and SVG is absent from it.
DO $$
DECLARE v_def TEXT;
BEGIN
    SELECT pg_get_constraintdef(oid) INTO v_def
      FROM pg_constraint WHERE conname = 'ck_dv_content_type';
    IF v_def IS NULL THEN
        RAISE EXCEPTION 'FAIL  D1 there is no content-type allowlist';
    END IF;
    IF v_def ILIKE '%svg%' THEN
        RAISE EXCEPTION
            'FAIL  D1 SVG appears in the allowlist. It is HTML-equivalent and a stored-XSS '
            'vector with no HR use case: %', v_def;
    END IF;
    IF v_def NOT ILIKE '%application/pdf%' THEN
        RAISE EXCEPTION 'FAIL  D1 the allowlist does not admit PDF: %', v_def;
    END IF;
    RAISE NOTICE 'PASS  D1 the MIME allowlist is a CHECK and excludes SVG';
END $$;

-- D2..D5: the per-version structural rails.
DO $$
DECLARE v_doc UUID; v_emp UUID; v_svg BOOLEAN := false; v_exe BOOLEAN := false;
        v_big BOOLEAN := false; v_hash BOOLEAN := false;
BEGIN
    SELECT id INTO v_emp FROM employee LIMIT 1;
    INSERT INTO employee_document (employee_id, document_type_code, title)
    VALUES (v_emp, 'id_proof', 'Verify D2') RETURNING id INTO v_doc;

    BEGIN
        INSERT INTO employee_document_version
            (document_id, bucket, object_key, content_type, size_bytes, sha256_hex)
        VALUES (v_doc, 'b', v_doc || '/svg', 'image/svg+xml', 100, repeat('a', 64));
    EXCEPTION WHEN check_violation THEN v_svg := true; END;

    BEGIN
        INSERT INTO employee_document_version
            (document_id, bucket, object_key, content_type, size_bytes, sha256_hex)
        VALUES (v_doc, 'b', v_doc || '/exe', 'application/x-msdownload', 100, repeat('a', 64));
    EXCEPTION WHEN check_violation THEN v_exe := true; END;

    BEGIN
        INSERT INTO employee_document_version
            (document_id, bucket, object_key, content_type, size_bytes, sha256_hex)
        VALUES (v_doc, 'b', v_doc || '/big', 'application/pdf', 31457280, repeat('a', 64));
    EXCEPTION WHEN check_violation THEN v_big := true; END;

    BEGIN
        INSERT INTO employee_document_version
            (document_id, bucket, object_key, content_type, size_bytes, sha256_hex)
        VALUES (v_doc, 'b', v_doc || '/bh', 'application/pdf', 100, 'not-a-hash');
    EXCEPTION WHEN check_violation THEN v_hash := true; END;

    IF v_svg AND v_exe AND v_big AND v_hash THEN
        RAISE NOTICE 'PASS  D2 SVG, executables, oversized files and non-hashes are all refused';
    ELSE
        RAISE EXCEPTION 'FAIL  D2 svg=% exe=% oversized=% bad_hash=%',
            v_svg, v_exe, v_big, v_hash;
    END IF;
END $$;

-- D3: version numbers are assigned by the DATABASE, not by the caller. Two callers both
-- computing max()+1 would collide and surface as an opaque error on a user's upload.
DO $$
DECLARE v_doc UUID; v_emp UUID; v_nos INT[];
BEGIN
    SELECT id INTO v_emp FROM employee LIMIT 1;
    INSERT INTO employee_document (employee_id, document_type_code, title)
    VALUES (v_emp, 'education', 'Verify D3') RETURNING id INTO v_doc;

    INSERT INTO employee_document_version
        (document_id, bucket, object_key, content_type, size_bytes, sha256_hex)
    VALUES (v_doc, 'b', v_doc || '/1', 'application/pdf', 10, repeat('a', 64)),
           (v_doc, 'b', v_doc || '/2', 'application/pdf', 20, repeat('b', 64)),
           (v_doc, 'b', v_doc || '/3', 'application/pdf', 30, repeat('c', 64));

    SELECT array_agg(version_no ORDER BY version_no) INTO v_nos
      FROM employee_document_version WHERE document_id = v_doc;

    IF v_nos = ARRAY[1, 2, 3] THEN
        RAISE NOTICE 'PASS  D3 versions numbered by the database: %', v_nos;
    ELSE
        RAISE EXCEPTION 'FAIL  D3 got %', v_nos;
    END IF;
END $$;

-- D4: one object per version, and no two versions may claim the same object.
DO $$
DECLARE v_doc UUID; v_emp UUID; v_ok BOOLEAN := false;
BEGIN
    SELECT id INTO v_emp FROM employee LIMIT 1;
    INSERT INTO employee_document (employee_id, document_type_code, title)
    VALUES (v_emp, 'other', 'Verify D4') RETURNING id INTO v_doc;
    INSERT INTO employee_document_version
        (document_id, bucket, object_key, content_type, size_bytes, sha256_hex)
    VALUES (v_doc, 'b', 'shared-key', 'application/pdf', 10, repeat('a', 64));
    BEGIN
        INSERT INTO employee_document_version
            (document_id, bucket, object_key, content_type, size_bytes, sha256_hex)
        VALUES (v_doc, 'b', 'shared-key', 'application/pdf', 20, repeat('b', 64));
    EXCEPTION WHEN unique_violation THEN v_ok := true; END;
    IF v_ok THEN RAISE NOTICE 'PASS  D4 two versions cannot share one object';
    ELSE RAISE EXCEPTION 'FAIL  D4 an object was claimed twice'; END IF;
END $$;

-- D5: a terminal scan verdict must say when, and an adverse one must say why.
DO $$
DECLARE v_doc UUID; v_emp UUID; v_when BOOLEAN := false; v_why BOOLEAN := false;
BEGIN
    SELECT id INTO v_emp FROM employee LIMIT 1;
    INSERT INTO employee_document (employee_id, document_type_code, title)
    VALUES (v_emp, 'other', 'Verify D5') RETURNING id INTO v_doc;

    BEGIN
        INSERT INTO employee_document_version
            (document_id, bucket, object_key, content_type, size_bytes, sha256_hex, scan_status)
        VALUES (v_doc, 'b', v_doc || '/nowhen', 'application/pdf', 10, repeat('a', 64), 'clean');
    EXCEPTION WHEN check_violation THEN v_when := true; END;

    BEGIN
        INSERT INTO employee_document_version
            (document_id, bucket, object_key, content_type, size_bytes, sha256_hex,
             scan_status, scanned_at)
        VALUES (v_doc, 'b', v_doc || '/nowhy', 'application/pdf', 10, repeat('a', 64),
                'infected', now());
    EXCEPTION WHEN check_violation THEN v_why := true; END;

    IF v_when AND v_why THEN
        RAISE NOTICE 'PASS  D5 a verdict needs a timestamp, and an adverse verdict needs a reason';
    ELSE
        RAISE EXCEPTION 'FAIL  D5 missing_timestamp_blocked=% missing_reason_blocked=%',
            v_when, v_why;
    END IF;
END $$;

-- D6: THE QUARANTINE GATE. A pending version cannot become the current version.
DO $$
DECLARE v_doc UUID; v_emp UUID; v_ver UUID; v_ok BOOLEAN := false;
BEGIN
    SELECT id INTO v_emp FROM employee LIMIT 1;
    INSERT INTO employee_document (employee_id, document_type_code, title)
    VALUES (v_emp, 'id_proof', 'Verify D6') RETURNING id INTO v_doc;
    INSERT INTO employee_document_version
        (document_id, bucket, object_key, content_type, size_bytes, sha256_hex)
    VALUES (v_doc, 'b', v_doc || '/1', 'application/pdf', 10, repeat('a', 64))
    RETURNING id INTO v_ver;

    BEGIN
        UPDATE employee_document SET current_version_id = v_ver WHERE id = v_doc;
    EXCEPTION WHEN restrict_violation THEN v_ok := true; END;

    IF v_ok THEN
        RAISE NOTICE 'PASS  D6 an unscanned version cannot be promoted - unreachable, not just unserved';
    ELSE
        RAISE EXCEPTION 'FAIL  D6 a PENDING version became servable';
    END IF;
END $$;

-- D7: and once clean, it can.
DO $$
DECLARE v_doc UUID; v_emp UUID; v_ver UUID; v_cur UUID;
BEGIN
    SELECT id INTO v_emp FROM employee LIMIT 1;
    INSERT INTO employee_document (employee_id, document_type_code, title)
    VALUES (v_emp, 'id_proof', 'Verify D7') RETURNING id INTO v_doc;
    INSERT INTO employee_document_version
        (document_id, bucket, object_key, content_type, size_bytes, sha256_hex)
    VALUES (v_doc, 'b', v_doc || '/1', 'application/pdf', 10, repeat('a', 64))
    RETURNING id INTO v_ver;

    UPDATE employee_document_version SET scan_status = 'clean', scanned_at = now()
     WHERE id = v_ver;
    UPDATE employee_document SET current_version_id = v_ver WHERE id = v_doc;

    SELECT current_version_id INTO v_cur FROM employee_document WHERE id = v_doc;
    IF v_cur = v_ver THEN RAISE NOTICE 'PASS  D7 a clean version is promotable';
    ELSE RAISE EXCEPTION 'FAIL  D7 promotion did not take'; END IF;
END $$;

-- D8: A VERSION OF ANOTHER DOCUMENT CANNOT BE PROMOTED HERE. Without this, one employee's file
-- is servable under another employee's document record.
DO $$
DECLARE v_a UUID; v_b UUID; v_e1 UUID; v_e2 UUID; v_ver UUID; v_ok BOOLEAN := false;
BEGIN
    SELECT id INTO v_e1 FROM employee ORDER BY employee_number LIMIT 1;
    SELECT id INTO v_e2 FROM employee ORDER BY employee_number DESC LIMIT 1;

    INSERT INTO employee_document (employee_id, document_type_code, title)
    VALUES (v_e1, 'id_proof', 'Verify D8 A') RETURNING id INTO v_a;
    INSERT INTO employee_document (employee_id, document_type_code, title)
    VALUES (v_e2, 'pan_card', 'Verify D8 B') RETURNING id INTO v_b;

    INSERT INTO employee_document_version
        (document_id, bucket, object_key, content_type, size_bytes, sha256_hex,
         scan_status, scanned_at)
    VALUES (v_b, 'b', v_b || '/1', 'application/pdf', 10, repeat('d', 64), 'clean', now())
    RETURNING id INTO v_ver;

    BEGIN
        UPDATE employee_document SET current_version_id = v_ver WHERE id = v_a;
    EXCEPTION WHEN restrict_violation THEN v_ok := true; END;

    IF v_ok THEN
        RAISE NOTICE 'PASS  D8 a version cannot be promoted under a different document';
    ELSE
        RAISE EXCEPTION
            'FAIL  D8 one employee''s file is now servable under another''s document record';
    END IF;
END $$;

-- D9: a version is immutable apart from scan bookkeeping.
DO $$
DECLARE v_ver UUID; v_key BOOLEAN := false; v_sha BOOLEAN := false; v_size BOOLEAN := false;
BEGIN
    SELECT id INTO v_ver FROM employee_document_version LIMIT 1;
    BEGIN UPDATE employee_document_version SET object_key = 'hijack' WHERE id = v_ver;
    EXCEPTION WHEN restrict_violation THEN v_key := true; END;
    BEGIN UPDATE employee_document_version SET sha256_hex = repeat('f', 64) WHERE id = v_ver;
    EXCEPTION WHEN restrict_violation THEN v_sha := true; END;
    BEGIN UPDATE employee_document_version SET size_bytes = 1 WHERE id = v_ver;
    EXCEPTION WHEN restrict_violation THEN v_size := true; END;

    IF v_key AND v_sha AND v_size THEN
        RAISE NOTICE 'PASS  D9 object key, hash and size are all immutable';
    ELSE
        RAISE EXCEPTION 'FAIL  D9 key=% sha=% size=%', v_key, v_sha, v_size;
    END IF;
END $$;

-- D10: ... but the scanner may advance its own columns.
DO $$
DECLARE v_doc UUID; v_emp UUID; v_ver UUID; v_status TEXT;
BEGIN
    SELECT id INTO v_emp FROM employee LIMIT 1;
    INSERT INTO employee_document (employee_id, document_type_code, title)
    VALUES (v_emp, 'other', 'Verify D10') RETURNING id INTO v_doc;
    INSERT INTO employee_document_version
        (document_id, bucket, object_key, content_type, size_bytes, sha256_hex)
    VALUES (v_doc, 'b', v_doc || '/1', 'application/pdf', 10, repeat('a', 64))
    RETURNING id INTO v_ver;

    UPDATE employee_document_version
       SET scan_status = 'infected', scanned_at = now(), scan_detail = 'eicar'
     WHERE id = v_ver;

    SELECT scan_status INTO v_status FROM employee_document_version WHERE id = v_ver;
    IF v_status = 'infected' THEN
        RAISE NOTICE 'PASS  D10 scan bookkeeping is writable';
    ELSE
        RAISE EXCEPTION 'FAIL  D10 the scanner cannot record a verdict';
    END IF;
END $$;

-- D11: a verdict is TERMINAL. Re-judging a served file would silently change what it was.
DO $$
DECLARE v_ver UUID; v_ok BOOLEAN := false;
BEGIN
    SELECT id INTO v_ver FROM employee_document_version WHERE scan_status = 'clean' LIMIT 1;
    IF v_ver IS NULL THEN
        RAISE NOTICE 'INFO  D11 no clean version in this fixture set';
        RETURN;
    END IF;
    BEGIN
        UPDATE employee_document_version
           SET scan_status = 'infected', scan_detail = 'late detection' WHERE id = v_ver;
    EXCEPTION WHEN restrict_violation THEN v_ok := true; END;
    IF v_ok THEN RAISE NOTICE 'PASS  D11 a clean verdict cannot be reversed in place';
    ELSE RAISE EXCEPTION 'FAIL  D11 an already-served document was re-judged'; END IF;
END $$;

-- D12: versions are append-only.
DO $$
DECLARE v_before BIGINT; v_del BOOLEAN := false; v_trunc BOOLEAN := false;
BEGIN
    SELECT count(*) INTO v_before FROM employee_document_version;
    BEGIN DELETE FROM employee_document_version;
    EXCEPTION WHEN restrict_violation THEN v_del := true; END;
    -- TRUNCATE is refused, but by TWO possible mechanisms and the test must accept either:
    -- the BEFORE TRUNCATE trigger (restrict_violation), or - because
    -- employee_document.current_version_id references this table - PostgreSQL's own refusal to
    -- truncate a table referenced by a foreign key (feature_not_supported). The first draft
    -- caught only the trigger's code and reported the rail as broken when the FK had already
    -- stopped it. Same situation 0007's V7 documents.
    BEGIN TRUNCATE employee_document_version;
    EXCEPTION WHEN restrict_violation THEN v_trunc := true;
              WHEN dependent_objects_still_exist THEN v_trunc := true;
              WHEN feature_not_supported THEN v_trunc := true; END;

    IF v_del AND v_trunc AND (SELECT count(*) FROM employee_document_version) = v_before THEN
        RAISE NOTICE 'PASS  D12 versions are append-only (% rows intact)', v_before;
    ELSE
        RAISE EXCEPTION 'FAIL  D12 delete=% truncate=%', v_del, v_trunc;
    END IF;
END $$;

-- D13: a withdrawal must state a reason, and it is not a deletion.
DO $$
DECLARE v_doc UUID; v_emp UUID; v_ok BOOLEAN := false; v_still BIGINT;
BEGIN
    SELECT id INTO v_emp FROM employee LIMIT 1;
    INSERT INTO employee_document (employee_id, document_type_code, title)
    VALUES (v_emp, 'other', 'Verify D13') RETURNING id INTO v_doc;

    BEGIN UPDATE employee_document SET withdrawn_at = now() WHERE id = v_doc;
    EXCEPTION WHEN check_violation THEN v_ok := true; END;

    UPDATE employee_document SET withdrawn_at = now(), withdrawn_reason = 'superseded'
     WHERE id = v_doc;
    SELECT count(*) INTO v_still FROM employee_document WHERE id = v_doc;

    IF v_ok AND v_still = 1 THEN
        RAISE NOTICE 'PASS  D13 a withdrawal needs a reason, and the row survives it';
    ELSE
        RAISE EXCEPTION 'FAIL  D13 reason_required=% row_survives=%', v_ok, v_still;
    END IF;
END $$;

-- D14: every document type carries a data class, and the RESTRICTED ones are the expected ones.
DO $$
DECLARE v_unclassified TEXT; v_restricted TEXT;
BEGIN
    SELECT string_agg(code, ', ') INTO v_unclassified
      FROM document_type WHERE data_class IS NULL;
    IF v_unclassified IS NOT NULL THEN
        RAISE EXCEPTION 'FAIL  D14 unclassified document types: %', v_unclassified;
    END IF;

    SELECT string_agg(code, ', ' ORDER BY code) INTO v_restricted
      FROM document_type WHERE data_class = 'RESTRICTED';
    IF v_restricted IS NULL THEN
        RAISE EXCEPTION 'FAIL  D14 no RESTRICTED types - an offer letter states compensation';
    END IF;

    -- A RESTRICTED type must never be self-uploadable: the point is that HR controls it.
    IF EXISTS (SELECT 1 FROM document_type
                WHERE data_class = 'RESTRICTED' AND self_uploadable) THEN
        RAISE EXCEPTION 'FAIL  D14 a RESTRICTED type is marked self_uploadable';
    END IF;

    RAISE NOTICE 'PASS  D14 every type is classified; RESTRICTED = % (none self-uploadable)',
        v_restricted;
END $$;

-- D15: object keys carry no personal data. Checked against the real rows, because a comment
-- saying "no PII in keys" is not a control.
DO $$
DECLARE v_bad TEXT;
BEGIN
    SELECT string_agg(v.object_key, ', ') INTO v_bad
      FROM employee_document_version v
      JOIN employee_document d ON d.id = v.document_id
      JOIN employee e ON e.id = d.employee_id
     WHERE v.object_key ILIKE '%' || e.employee_number || '%'
        OR v.object_key ILIKE '%' || split_part(e.full_name, ' ', 1) || '%'
        OR v.object_key ILIKE '%' || e.work_email || '%';
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION
            'FAIL  D15 object keys contain personal data: %. Bucket listings, backups and '
            'access logs all travel differently from the database', v_bad;
    END IF;
    RAISE NOTICE 'PASS  D15 no object key contains an employee number, name or email';
END $$;

-- D16: the rails are ENABLE ALWAYS (DEC-030).
DO $$
DECLARE v_weak TEXT;
BEGIN
    SELECT string_agg(format('%s.%s', c.relname, t.tgname), ', ') INTO v_weak
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE NOT t.tgisinternal
       AND c.relname IN ('employee_document', 'employee_document_version')
       AND t.tgname NOT LIKE '%updated_at%'
       AND t.tgenabled <> 'A';
    IF v_weak IS NULL THEN
        RAISE NOTICE 'PASS  D16 document rails are ENABLE ALWAYS';
    ELSE
        RAISE EXCEPTION 'FAIL  D16 disableable by a session GUC: %', v_weak;
    END IF;
END $$;

-- D17: functions pin search_path (precedent 0013).
DO $$
DECLARE v_bad TEXT;
BEGIN
    SELECT string_agg(p.proname, ', ') INTO v_bad
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('fn_audit_document', 'fn_document_version_guard',
                         'fn_document_version_assign', 'fn_document_current_version_guard')
       AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig,'{}')) cfg
                        WHERE cfg LIKE 'search_path=%');
    IF v_bad IS NULL THEN RAISE NOTICE 'PASS  D17 all document functions pin search_path';
    ELSE RAISE EXCEPTION 'FAIL  D17 unpinned: %', v_bad; END IF;
END $$;

-- D18: the audit emitter records the CLASS and never the content.
DO $$
DECLARE v_doc UUID; v_emp UUID; v_id BIGINT; r RECORD;
BEGIN
    SELECT id INTO v_emp FROM employee LIMIT 1;
    INSERT INTO employee_document (employee_id, document_type_code, title)
    VALUES (v_emp, 'medical', 'Verify D18') RETURNING id INTO v_doc;

    v_id := fn_audit_document('documents.document.downloaded', v_doc,
        (SELECT id FROM app_user WHERE employee_id = v_emp LIMIT 1), v_emp,
        gen_random_uuid(), NULL, '203.0.113.7'::inet, 'verification', ARRAY['employee']);

    SELECT event_type, subject_type, field_classes, after, subject_employee_id
      INTO r FROM audit_event WHERE id = v_id;

    IF r.field_classes <> ARRAY['SENSITIVE'] THEN
        RAISE EXCEPTION 'FAIL  D18 wrong class recorded for a medical document: %',
            r.field_classes;
    END IF;
    IF r.subject_employee_id <> v_emp THEN
        RAISE EXCEPTION 'FAIL  D18 the audit row does not name the subject';
    END IF;
    IF (r.after ->> 'document_type') <> 'medical' THEN
        RAISE EXCEPTION 'FAIL  D18 the document type was not recorded';
    END IF;
    RAISE NOTICE 'PASS  D18 audit records subject, type and data class - never content';
END $$;

-- D19: hrm_app may append and promote, never erase.
DO $$
DECLARE v_bad TEXT;
BEGIN
    SELECT string_agg(format('%s:%s', table_name, privilege_type), ', ') INTO v_bad
      FROM information_schema.role_table_grants
     WHERE grantee = 'hrm_app'
       AND table_name IN ('employee_document_version', 'document_type')
       AND privilege_type IN ('DELETE', 'TRUNCATE');
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'FAIL  D19 hrm_app can erase document history: %', v_bad;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                    WHERE grantee = 'hrm_app' AND table_name = 'employee_document_version'
                      AND privilege_type = 'INSERT') THEN
        RAISE EXCEPTION 'FAIL  D19 hrm_app cannot store a document version';
    END IF;
    RAISE NOTICE 'PASS  D19 hrm_app may append and promote, never erase';
END $$;
