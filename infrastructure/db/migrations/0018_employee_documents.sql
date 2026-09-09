-- =============================================================================
-- 0018  Employee documents
-- =============================================================================
--
-- Module 4, and `ai/context/security-guidelines.md` calls file upload "the highest-risk
-- surface" for a specific reason worth restating: employee documents contain Tier 1 data in
-- UNSTRUCTURED form, which defeats column-level controls entirely. A salary figure in a
-- `numeric` column can be masked by the field registry; the same figure inside an offer-letter
-- PDF cannot. So the unit of access control here is the DOCUMENT TYPE, and its classification
-- is what the authorization layer reads.
--
-- FIVE CONTROLS, AND THEY LIVE IN THE DATABASE RATHER THAN ONLY IN THE UPLOAD HANDLER
--
--   1. MIME ALLOWLIST as a CHECK. PDF, JPEG, PNG, DOCX, XLSX. **SVG is absent deliberately** -
--      it is HTML-equivalent and a stored-XSS vector with no HR use case. This is NOT
--      configuration and does not belong in a settings table: Must-Know Rule 11 forbids
--      hardcoding POLICY (rates, thresholds, approval chains), and an executable-content
--      allowlist is a security CONTROL, not policy. A control an administrator can widen from a
--      web form is not a control.
--
--   2. QUARANTINE-THEN-PROMOTE, enforced structurally. A version lands `scan_status = 'pending'`
--      and cannot become the document's current version until it is `clean`. The trigger checks
--      this, so an unscanned upload is not merely un-served by the application - it is
--      unreachable through the data model.
--
--   3. CONTENT HASH. `sha256_hex` on every version (OWASP A08). Detects silent object-store
--      corruption or substitution, and makes de-duplication possible without trusting a filename.
--
--   4. IMMUTABLE VERSIONS. A version row is append-only apart from scan bookkeeping. Correcting
--      a document means uploading a NEW version; the old one is never rewritten, because a
--      document trail whose history can be edited is not evidence of anything.
--
--   5. NO PII IN THE OBJECT KEY. The key is `<document_id>/<version_id>` - two UUIDs. Object
--      storage backups, bucket listings and access logs travel differently from the database,
--      and an employee's name or number in a key would leak through all three.
--
-- SIZE CAPS are enforced BEFORE stream consumption in the application (security-guidelines);
-- the CHECK here is the backstop for anything that reaches the database by another path.
--
-- WHAT IS DELIBERATELY NOT HERE
--
--   * No `is_deleted` hard delete. A document is withdrawn (`withdrawn_at`), never removed:
--     statutory records have retention obligations, and `document_type.retention_years` is what
--     a future retention job reads. Nothing enforces retention yet - stated, not implied.
--   * No virus scanner. `scan_status` is the state machine a scanner will drive; there is no
--     scanner. Until one exists, promotion to `clean` is an explicit administrative act rather
--     than something a background job did, and OR-23 records that the quarantine gate is real
--     but currently has nothing intelligent behind it.
--
-- Class C. Verified by testing/db/0018_employee_documents.verify.sql.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Document types - the unit of classification, as data
-- -----------------------------------------------------------------------------
--
-- The TYPE carries the data class, because the content is opaque. `security-guidelines.md`'s
-- classification table is the source: an offer letter is RESTRICTED because it states
-- compensation; a PAN card is SENSITIVE; a medical certificate is SENSITIVE health data.

CREATE TABLE document_type (
    code             text PRIMARY KEY,
    name             text NOT NULL,
    description      text,

    -- Drives the authorization decision. There is no per-document override: a type's class is
    -- the whole basis on which access is granted, so allowing a caller to lower it per row
    -- would make the control advisory.
    data_class       text NOT NULL,

    -- Whether an expiry date is meaningful (a passport expires; an offer letter does not).
    tracks_expiry    boolean NOT NULL DEFAULT false,
    -- Whether the employee may upload it themselves, or only HR may.
    self_uploadable  boolean NOT NULL DEFAULT false,
    retention_years  integer,

    display_order    smallint NOT NULL DEFAULT 100,
    archived_at      timestamptz,

    CONSTRAINT ck_document_type_code CHECK (code ~ '^[a-z][a-z0-9_]*$'),
    CONSTRAINT ck_document_type_class CHECK (data_class IN
        ('PUBLIC_INTERNAL', 'PERSONAL', 'SENSITIVE', 'RESTRICTED')),
    CONSTRAINT ck_document_type_retention
        CHECK (retention_years IS NULL OR (retention_years >= 1 AND retention_years <= 99))
);

COMMENT ON TABLE document_type IS
    'Document types with their data classification. The TYPE is the unit of access control '
    'because document content is unstructured and opaque - a field mask cannot reach inside a '
    'PDF. Reference data (Rule 11): adding a type is configuration, not a migration.';

COMMENT ON COLUMN document_type.retention_years IS
    'What a retention job WOULD read. NULL means no schedule has been established. Nothing '
    'enforces this yet (OR-23) - the figures are commitments, not controls.';

INSERT INTO document_type
    (code, name, data_class, tracks_expiry, self_uploadable, retention_years, display_order, description) VALUES
    ('id_proof',        'Identity proof',        'SENSITIVE',  true,  true,  8,  10, 'Aadhaar, passport, driving licence'),
    ('pan_card',        'PAN card',              'SENSITIVE',  false, true,  8,  20, 'Permanent Account Number card'),
    ('address_proof',   'Address proof',         'PERSONAL',   false, true,  3,  30, NULL),
    ('education',       'Education certificate', 'PERSONAL',   false, true,  8,  40, 'Degree and marksheets'),
    ('experience',      'Experience letter',     'PERSONAL',   false, true,  8,  50, 'From a previous employer'),
    ('offer_letter',    'Offer letter',          'RESTRICTED', false, false, 8,  60, 'States compensation - RESTRICTED for that reason'),
    ('contract',        'Employment contract',   'RESTRICTED', false, false, 8,  70, NULL),
    ('appraisal',       'Appraisal record',      'RESTRICTED', false, false, 8,  80, 'Performance rating'),
    ('medical',         'Medical certificate',   'SENSITIVE',  true,  true,  3,  90, 'Health data - sick-leave substantiation'),
    ('disciplinary',    'Disciplinary record',   'RESTRICTED', false, false, 8, 100, NULL),
    ('bank_proof',      'Bank account proof',    'SENSITIVE',  false, true,  8, 110, 'Cancelled cheque or passbook page'),
    ('other',           'Other',                 'PERSONAL',   false, true,  3, 200, NULL);

-- -----------------------------------------------------------------------------
-- 2. The logical document
-- -----------------------------------------------------------------------------

CREATE TABLE employee_document (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id        uuid NOT NULL REFERENCES employee(id),
    document_type_code text NOT NULL REFERENCES document_type(code),

    title              text NOT NULL,
    -- Rule 5: both are DATE. An expiry that drifted a timezone would expire a passport a day
    -- early or late, and the reminder job would fire on the wrong day.
    issued_on          date,
    expires_on         date,
    issuing_authority  text,
    note               text,

    -- Set by trigger once a version passes the quarantine gate. NULL means nothing is servable.
    current_version_id uuid,

    uploaded_by        uuid REFERENCES employee(id),
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),

    -- Withdrawn, never deleted. Statutory retention outlives the employee's interest in it.
    withdrawn_at       timestamptz,
    withdrawn_by       uuid REFERENCES employee(id),
    withdrawn_reason   text,

    CONSTRAINT ck_employee_document_expiry
        CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on),
    CONSTRAINT ck_employee_document_withdrawn
        CHECK ((withdrawn_at IS NULL) = (withdrawn_reason IS NULL)),
    CONSTRAINT ck_employee_document_title CHECK (btrim(title) <> '')
);

CREATE INDEX ix_employee_document_employee
    ON employee_document (employee_id, document_type_code) WHERE withdrawn_at IS NULL;
CREATE INDEX ix_employee_document_expiring
    ON employee_document (expires_on)
    WHERE expires_on IS NOT NULL AND withdrawn_at IS NULL;

CREATE TRIGGER tg_employee_document_updated_at
    BEFORE UPDATE ON employee_document
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- -----------------------------------------------------------------------------
-- 3. Versions - append-only, one object each
-- -----------------------------------------------------------------------------

CREATE TABLE employee_document_version (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id    uuid NOT NULL REFERENCES employee_document(id),
    version_no     integer NOT NULL,

    -- The object store coordinates. NO PII: two UUIDs, so a bucket listing, a backup or an
    -- access log reveals nothing about whose document it is.
    bucket         text NOT NULL,
    object_key     text NOT NULL,

    content_type   text NOT NULL,
    size_bytes     bigint NOT NULL,
    sha256_hex     text NOT NULL,
    original_name  text,

    -- Quarantine state machine. A scanner will drive this; none exists yet (OR-23).
    scan_status    text NOT NULL DEFAULT 'pending',
    scanned_at     timestamptz,
    scan_detail    text,

    uploaded_by    uuid REFERENCES employee(id),
    created_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT uq_document_version UNIQUE (document_id, version_no),
    CONSTRAINT uq_document_object UNIQUE (bucket, object_key),

    CONSTRAINT ck_dv_version_positive CHECK (version_no >= 1),

    /*
     * THE MIME ALLOWLIST. Deliberately a CHECK and deliberately not configurable.
     * SVG is absent because it is HTML-equivalent - a stored-XSS vector with no HR use case.
     */
    CONSTRAINT ck_dv_content_type CHECK (content_type IN (
        'application/pdf',
        'image/jpeg',
        'image/png',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')),

    -- 25 MiB. The application caps before consuming the stream; this is the backstop.
    CONSTRAINT ck_dv_size CHECK (size_bytes > 0 AND size_bytes <= 26214400),

    -- A sha256 is 64 lowercase hex characters. Anything else is not a hash.
    CONSTRAINT ck_dv_sha256 CHECK (sha256_hex ~ '^[0-9a-f]{64}$'),

    CONSTRAINT ck_dv_scan_status CHECK (scan_status IN ('pending', 'clean', 'infected', 'failed')),
    -- A terminal scan verdict must say when it was reached.
    CONSTRAINT ck_dv_scanned_at
        CHECK ((scan_status = 'pending') = (scanned_at IS NULL)),
    -- An adverse verdict must say why.
    CONSTRAINT ck_dv_scan_detail
        CHECK (scan_status NOT IN ('infected', 'failed') OR scan_detail IS NOT NULL)
);

CREATE INDEX ix_dv_document ON employee_document_version (document_id, version_no DESC);
CREATE INDEX ix_dv_pending ON employee_document_version (created_at) WHERE scan_status = 'pending';
CREATE INDEX ix_dv_sha ON employee_document_version (sha256_hex);

COMMENT ON TABLE employee_document_version IS
    'Append-only document versions, one object each. Correcting a document means a NEW version; '
    'the old one is never rewritten. A document trail whose history can be edited is not '
    'evidence of anything.';

COMMENT ON COLUMN employee_document_version.object_key IS
    'Contains NO personal data - it is <document_id>/<version_id>. Object storage backups, '
    'bucket listings and access logs all travel differently from the database.';

ALTER TABLE employee_document
    ADD CONSTRAINT fk_employee_document_current_version
        FOREIGN KEY (current_version_id) REFERENCES employee_document_version(id);

-- -----------------------------------------------------------------------------
-- 4. Version numbering, assigned by the database
-- -----------------------------------------------------------------------------
--
-- Computed here rather than by the caller, because two concurrent uploads that both read
-- `max(version_no) + 1` would collide - and the UNIQUE constraint would surface that as an
-- opaque error on a user's upload rather than as a correct next version.

CREATE OR REPLACE FUNCTION fn_document_version_assign()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
BEGIN
    IF NEW.version_no IS NULL OR NEW.version_no = 0 THEN
        -- The row lock serialises concurrent uploads for the same document.
        PERFORM 1 FROM public.employee_document d WHERE d.id = NEW.document_id FOR UPDATE;
        SELECT COALESCE(max(v.version_no), 0) + 1 INTO NEW.version_no
          FROM public.employee_document_version v
         WHERE v.document_id = NEW.document_id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_dv_assign_version
    BEFORE INSERT ON employee_document_version
    FOR EACH ROW EXECUTE FUNCTION fn_document_version_assign();

ALTER TABLE employee_document_version ENABLE ALWAYS TRIGGER tg_dv_assign_version;

-- -----------------------------------------------------------------------------
-- 5. Append-only, except scan bookkeeping
-- -----------------------------------------------------------------------------
--
-- Same shape as the outbox drain columns in 0006: the row is immutable apart from the narrow set
-- of columns the scanner legitimately advances. Naming them explicitly means a future column
-- is immutable by default rather than writable by accident.

CREATE OR REPLACE FUNCTION fn_document_version_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
DECLARE v_changed text[];
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
            'employee_document_version is append-only; a version is superseded, never deleted'
            USING ERRCODE = 'restrict_violation',
                  HINT = 'Upload a new version, or withdraw the document.';
    END IF;

    SELECT coalesce(array_agg(e.k ORDER BY e.k), '{}')
      INTO v_changed
      FROM pg_catalog.jsonb_each(to_jsonb(OLD)) AS e(k, v)
     WHERE e.v IS DISTINCT FROM to_jsonb(NEW) -> e.k;

    IF cardinality(v_changed) = 0 THEN RETURN NEW; END IF;

    IF v_changed OPERATOR(pg_catalog.<@) ARRAY['scan_status', 'scanned_at', 'scan_detail'] THEN
        -- A verdict is terminal. Re-scanning a clean file into 'infected' would silently change
        -- what an already-served document was, so the transition is one-way out of 'pending'.
        IF OLD.scan_status <> 'pending' AND NEW.scan_status <> OLD.scan_status THEN
            RAISE EXCEPTION
                'scan verdict is terminal: % cannot become %', OLD.scan_status, NEW.scan_status
                USING ERRCODE = 'restrict_violation',
                      HINT = 'Upload a new version instead of re-judging an existing one.';
        END IF;
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'employee_document_version is immutable apart from scan bookkeeping; attempted change '
        'to: %', array_to_string(v_changed, ', ')
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER tg_dv_immutable
    BEFORE UPDATE OR DELETE ON employee_document_version
    FOR EACH ROW EXECUTE FUNCTION fn_document_version_guard();

ALTER TABLE employee_document_version ENABLE ALWAYS TRIGGER tg_dv_immutable;

CREATE TRIGGER tg_dv_no_truncate
    BEFORE TRUNCATE ON employee_document_version
    FOR EACH STATEMENT EXECUTE FUNCTION fn_block_mutation();

ALTER TABLE employee_document_version ENABLE ALWAYS TRIGGER tg_dv_no_truncate;

-- -----------------------------------------------------------------------------
-- 6. THE QUARANTINE GATE
-- -----------------------------------------------------------------------------
--
-- `current_version_id` is what the download path serves, so this is the control that decides
-- whether an unscanned file can ever reach a user. Enforced by trigger, because a service-layer
-- check is bypassed by the next code path, a job, a migration or an admin script.

CREATE OR REPLACE FUNCTION fn_document_current_version_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
DECLARE v_doc uuid; v_status text;
BEGIN
    IF NEW.current_version_id IS NULL THEN RETURN NEW; END IF;

    SELECT v.document_id, v.scan_status INTO v_doc, v_status
      FROM public.employee_document_version v WHERE v.id = NEW.current_version_id;

    IF v_doc IS NULL THEN
        RAISE EXCEPTION 'current_version_id does not exist'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- A version of a DIFFERENT document must never be servable here: that would hand one
    -- employee's file out under another employee's document record.
    IF v_doc <> NEW.id THEN
        RAISE EXCEPTION
            'current_version_id belongs to a different document'
            USING ERRCODE = 'restrict_violation',
                  HINT = 'This would serve one employee''s file under another''s record.';
    END IF;

    IF v_status <> 'clean' THEN
        RAISE EXCEPTION
            'version has scan_status %, so it cannot become the current version', v_status
            USING ERRCODE = 'restrict_violation',
                  HINT = 'Quarantine-then-promote: only a clean version is servable.';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_document_current_version
    BEFORE INSERT OR UPDATE OF current_version_id ON employee_document
    FOR EACH ROW EXECUTE FUNCTION fn_document_current_version_guard();

ALTER TABLE employee_document ENABLE ALWAYS TRIGGER tg_document_current_version;

-- -----------------------------------------------------------------------------
-- 7. Document audit emission
-- -----------------------------------------------------------------------------
--
-- Every document READ is an event worth recording, which is unusual - most reads are not. A
-- document access is a Tier 1 disclosure: `security-guidelines.md` lists bulk export as an
-- alerting signal, and the only way to notice one is to have recorded the individual accesses.

CREATE OR REPLACE FUNCTION fn_audit_document(
    p_event_type       text,
    p_document_id      uuid,
    p_actor_user       uuid    DEFAULT NULL,
    p_actor_employee   uuid    DEFAULT NULL,
    p_session          uuid    DEFAULT NULL,
    p_correlation      uuid    DEFAULT NULL,
    p_source_ip        inet    DEFAULT NULL,
    p_reason           text    DEFAULT NULL,
    p_roles            text[]  DEFAULT NULL,
    p_version_id       uuid    DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
DECLARE v_id bigint; v_subject uuid; v_type text; v_class text;
BEGIN
    IF p_event_type IS NULL OR btrim(p_event_type) = '' THEN
        RAISE EXCEPTION 'a document audit row needs an event_type'
            USING ERRCODE = 'restrict_violation';
    END IF;

    SELECT d.employee_id, d.document_type_code, t.data_class
      INTO v_subject, v_type, v_class
      FROM public.employee_document d
      JOIN public.document_type t ON t.code = d.document_type_code
     WHERE d.id = p_document_id;

    INSERT INTO public.audit_event (
        source, event_type, actor_kind, actor_user_id, actor_employee_id, actor_roles,
        subject_employee_id, subject_type, session_id, correlation_id, source_ip, reason,
        row_pk, table_name, field_classes, after)
    VALUES (
        'application', p_event_type,
        CASE WHEN p_actor_user IS NULL THEN 'system' ELSE 'user' END,
        p_actor_user, p_actor_employee, p_roles,
        v_subject, 'employee_document', p_session, p_correlation, p_source_ip, p_reason,
        p_document_id::text, 'employee_document',
        -- The field CLASSES touched, never the values (security-guidelines).
        CASE WHEN v_class IS NULL THEN NULL ELSE ARRAY[v_class] END,
        jsonb_build_object('document_type', v_type, 'version_id', p_version_id))
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

COMMENT ON FUNCTION fn_audit_document IS
    'Emits a document audit row. Records the document type and the data CLASS touched, never the '
    'content, never a filename, and never a presigned URL - security-guidelines bars presigned '
    'URL query strings from logs, and audit_event is append-only with decade retention.';

-- -----------------------------------------------------------------------------
-- 8. Grants
-- -----------------------------------------------------------------------------
--
-- No DELETE on versions (append-only) and none on document_type (reference data changed by
-- migration or by an admin screen, not by a request path deleting rows).

GRANT INSERT, UPDATE ON employee_document         TO hrm_app;
GRANT INSERT, UPDATE ON employee_document_version TO hrm_app;
GRANT SELECT           ON document_type           TO hrm_app;

COMMIT;
