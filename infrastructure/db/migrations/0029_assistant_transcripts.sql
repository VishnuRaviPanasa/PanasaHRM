-- =============================================================================
-- 0029  Assistant transcripts - what was asked, what was chosen, never what was returned
-- =============================================================================
--
-- WHY. ADR-0020 reverses ADR-0014 and lets the product call a model, confined to one `assistant`
-- module implemented as tool calling. Two things have to be recorded for that to be operable:
--
--   1. WHICH QUESTIONS THE CATALOGUE COULD NOT SERVE. ADR-0020 parks text-to-SQL and names this
--      log as the trigger to revisit it (DEC-126). Without it, "what should the assistant learn
--      next" is a guess. A turn that matched no tool is stored with `refusal_code = 'no_tool'`
--      and the question that produced it.
--   2. WHAT THE ASSISTANT ACTUALLY DID, for support and for the audit trail. `fn_audit_assistant`
--      writes the audit row; this table holds the operational detail that does not belong in
--      `audit_event`, whose `reason` is a closed-set code and never a data value.
--
-- WHAT THIS TABLE DELIBERATELY CANNOT HOLD: A RESULT.
--
-- There is no column capable of storing a returned row, and check A7 enumerates the column list
-- so that adding one later FAILS rather than passing review. DEC-133 has the reasoning; the short
-- version is that storing answers would create a second copy of leave, attendance and work data
-- with different retention, no field masking and different access rules - and replaying a stored
-- answer would disclose rows to a user whose roles had since been revoked, which is exactly what
-- ADR-0010 and DEC-042 exist to prevent. `tool_args` is capped at 2 KB and must be a JSON object
-- precisely so it cannot become that column by accident.
--
-- QUESTION TEXT IS PERSONAL DATA, AND IT IS THE ONLY COLUMN IN THIS SYSTEM THAT LEAVES INDIA.
-- The user typed it, so it routinely names a colleague ("how much leave does Priya have left")
-- and can disclose the asker's own circumstances by implication. `data-inventory.md` classifies
-- it PERSONAL and records the cross-border transfer as gap 7 against OR-03. It is length-capped
-- here as well as at the API, because an unbounded free-text column holding personal data is how
-- a chat log becomes an unreviewable disclosure surface.
--
-- RETENTION IS A MUTABLE SETTING, NOT AN EFFECTIVE-DATED POLICY. ADR-0019's dividing test is
-- "would a historical recomputation give a different answer if this value changed?" Nothing
-- computes from a transcript, so the answer is no and it belongs in `org_setting` (Class 2).
-- 90 days is DEC-130's badged-unconfirmed default. **Nothing enforces it yet - there is no job**,
-- which is true of every retention figure in this repository and is stated rather than implied.
--
-- THE DELETE RAIL IS UNUSUAL AND DELIBERATE. `assistant_message` is append-only against UPDATE
-- outright, but DELETE is permitted *only for rows past the retention window*. Every other
-- append-only table here (audit_event, leave_ledger, employment_event, payslip_event) forbids
-- DELETE entirely, because those are records somebody may later have to stand behind. A chat
-- transcript is the opposite: keeping it forever is the harm. So the rail enforces the direction
-- that actually matters here - you may delete what has expired, and nothing else.
--
-- NO NEW DATABASE ROLE, NO GRANT CHANGES. That was the text-to-SQL design (DEC-126). Tool calling
-- runs on the existing connection with the existing grants, because every statement it issues is
-- one this repository wrote.
--
-- NOT DESTRUCTIVE. Two new tables, one function, one trigger, one org_setting row, four
-- audit_column_policy rows. Nothing dropped, no existing row changed.

-- Atomic, like every migration from 0017 onward.
BEGIN;

-- ---------------------------------------------------------------- retention setting

-- Class 2 (ADR-0019): mutable, because no derivation reads it. Category 'company' because the
-- CHECK admits only company/notification/integration/feature and this is none of the other three
-- - it is not a feature flag, since ADR-0020 puts enablement on HRM_ASSISTANT_ENABLED where an
-- operator rather than HR decides it.
INSERT INTO org_setting (key, value, value_type, category, label, description)
VALUES (
    'assistant.transcript_retention_days',
    '90'::jsonb,
    'number',
    'company',
    'Assistant transcript retention (days)',
    'How long an assistant question is kept before it may be deleted. DEC-130: an engineering '
    'default badged UNCONFIRMED, awaiting HR and the named legal owner OR-03 does not yet have. '
    'Long enough to build the no_tool backlog ADR-0020 depends on, short enough that a chat log '
    'is not a standing disclosure risk. Nothing enforces it yet - there is no deletion job.')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------- conversation

CREATE TABLE assistant_conversation (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES app_user(id),
    -- NULL for a break-glass actor, who has no employee row. Such an actor reaches no tool at
    -- all (every scope predicate needs an employee id and returns DENY_ALL without one), so the
    -- conversation exists only to record that they asked.
    employee_id      UUID REFERENCES employee(id),
    locale           TEXT NOT NULL DEFAULT 'en',
    started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_message_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_assistant_conversation_locale CHECK (locale IN ('en', 'ar'))
);

CREATE INDEX ix_assistant_conversation_user ON assistant_conversation (user_id, started_at DESC);

COMMENT ON TABLE assistant_conversation IS
    'One assistant session. Owns no answer and no result - see assistant_message.';

-- ---------------------------------------------------------------- message

CREATE TABLE assistant_message (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id    UUID NOT NULL REFERENCES assistant_conversation(id),
    seq                INTEGER NOT NULL,
    asked_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- PERSONAL. The only column in this database transmitted outside India (ADR-0020 section 3).
    question_text      TEXT NOT NULL,

    -- What the router and the selector decided. NULL route means the router itself declined.
    route_domain       TEXT,
    tool_name          TEXT,
    -- Arguments the MODEL chose, never a result. Capped and shape-checked below.
    tool_args          JSONB,

    refusal_code       TEXT,
    -- Rows the caller was already entitled to see. A count, never the rows.
    row_count          INTEGER,

    model              TEXT,
    prompt_tokens      INTEGER,
    completion_tokens  INTEGER,
    latency_ms         INTEGER,

    CONSTRAINT uq_assistant_message_seq UNIQUE (conversation_id, seq),

    -- A turn must have an outcome. Both may be set: a tool can be chosen and then refused for
    -- returning more rows than the cap, and flattening that to one column would lose which tool
    -- it was - the single most useful fact when the cap fires.
    CONSTRAINT ck_assistant_message_outcome
        CHECK (tool_name IS NOT NULL OR refusal_code IS NOT NULL),

    CONSTRAINT ck_assistant_message_domain
        CHECK (route_domain IS NULL OR route_domain IN
            ('me', 'leave', 'attendance', 'work', 'people', 'documents', 'cross', 'meta')),

    -- Closed set, mirrored in the API. 'no_rows' is deliberately absent: a tool that matched and
    -- returned nothing is a successful turn with row_count = 0, and calling that a refusal would
    -- put it in the no_tool backlog where it does not belong.
    CONSTRAINT ck_assistant_message_refusal
        CHECK (refusal_code IS NULL OR refusal_code IN
            ('no_tool', 'not_permitted', 'forbidden_purpose', 'too_many_rows',
             'invalid_args', 'timeout', 'provider_error', 'disabled')),

    CONSTRAINT ck_assistant_message_row_count CHECK (row_count IS NULL OR row_count >= 0),
    CONSTRAINT ck_assistant_message_seq_positive CHECK (seq >= 1),

    -- Bounds the stored personal data, and matches the API's input cap. An unbounded free-text
    -- column holding PERSONAL data is how a chat log becomes an unreviewable disclosure surface.
    CONSTRAINT ck_assistant_message_question_len
        CHECK (char_length(question_text) BETWEEN 1 AND 2000),

    -- THE TWO CONSTRAINTS THAT STOP tool_args BECOMING A RESULT COLUMN. An object, not an array,
    -- and small enough that no result set fits.
    CONSTRAINT ck_assistant_message_args_object
        CHECK (tool_args IS NULL OR jsonb_typeof(tool_args) = 'object'),
    CONSTRAINT ck_assistant_message_args_size
        CHECK (tool_args IS NULL OR pg_column_size(tool_args) <= 2048)
);

CREATE INDEX ix_assistant_message_conversation ON assistant_message (conversation_id, seq);
-- The no_tool backlog query (DEC-126). Partial, because that is the only cut anybody reads.
CREATE INDEX ix_assistant_message_no_tool ON assistant_message (asked_at DESC)
    WHERE refusal_code = 'no_tool';
CREATE INDEX ix_assistant_message_asked_at ON assistant_message (asked_at);

COMMENT ON TABLE assistant_message IS
    'One assistant turn. Holds the question, the routing decision, the chosen tool and its '
    'arguments, and counters. HOLDS NO RESULT ROW AND HAS NO COLUMN THAT COULD - check A7 '
    'enumerates the column list so that adding one fails. See DEC-133.';

COMMENT ON COLUMN assistant_message.question_text IS
    'PERSONAL (data-inventory.md). Written by the user, so it may name a colleague. This is the '
    'only column in this database sent outside India - the model needs it to route and select. '
    'No value from any row is ever sent; see ADR-0020 section 3.';

COMMENT ON COLUMN assistant_message.tool_args IS
    'Arguments the MODEL chose, before validation. Kept because a wrong answer is almost always a '
    'wrong argument, and the question alone does not show which. Never a result: object-shaped '
    'and capped at 2 KB by CHECK.';

COMMENT ON COLUMN assistant_message.row_count IS
    'How many rows the tool returned - rows the caller was already entitled to see through the '
    'equivalent screen. A count, never the rows.';

-- ---------------------------------------------------------------- append-only + retention rail

CREATE OR REPLACE FUNCTION fn_assistant_message_immutable() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_days INTEGER;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION
            'assistant_message is append-only - a transcript is what was asked, not what somebody '
            'later wished had been asked'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- DELETE is allowed, but only past the retention window. Unlike every other append-only table
    -- here, keeping a transcript forever is the harm rather than the safeguard - so the rail
    -- enforces the direction that matters: you may delete what has EXPIRED, and nothing else.
    SELECT (value #>> '{}')::INTEGER INTO v_days
      FROM public.org_setting WHERE key = 'assistant.transcript_retention_days';

    IF v_days IS NULL THEN
        RAISE EXCEPTION
            'cannot delete an assistant transcript: org_setting '
            '''assistant.transcript_retention_days'' is missing, so the retention window is '
            'unknown and deleting would be guessing'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.asked_at > now() - make_interval(days => v_days) THEN
        RAISE EXCEPTION
            'assistant transcript % is inside the % day retention window (asked %) - it may not '
            'be deleted yet', OLD.id, v_days, OLD.asked_at::date
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN OLD;
END $$;

COMMENT ON FUNCTION fn_assistant_message_immutable() IS
    'Refuses every UPDATE, and refuses a DELETE of a row still inside the retention window read '
    'from org_setting. Deliberately NOT delete-proof: DEC-130 keeps transcripts 90 days and then '
    'removes them.';

CREATE TRIGGER trg_assistant_message_immutable
    BEFORE UPDATE OR DELETE ON assistant_message
    FOR EACH ROW EXECUTE FUNCTION fn_assistant_message_immutable();

-- DEC-030: the rail must survive a restore or a bulk load, not only ordinary traffic.
ALTER TABLE assistant_message ENABLE ALWAYS TRIGGER trg_assistant_message_immutable;

-- ---------------------------------------------------------------- audit

CREATE OR REPLACE FUNCTION fn_audit_assistant(
    p_event_type       text,
    p_message_id       uuid,
    p_actor_user       uuid    DEFAULT NULL,
    p_actor_employee   uuid    DEFAULT NULL,
    p_subject_employee uuid    DEFAULT NULL,
    p_subject_type     text    DEFAULT NULL,
    p_session          uuid    DEFAULT NULL,
    p_correlation      uuid    DEFAULT NULL,
    p_source_ip        inet    DEFAULT NULL,
    p_reason           text    DEFAULT NULL,
    p_roles            text[]  DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
DECLARE
    v_id        bigint;
    v_tool      text;
    v_refusal   text;
    v_rows      integer;
    v_domain    text;
BEGIN
    IF p_event_type IS NULL OR btrim(p_event_type) = '' THEN
        RAISE EXCEPTION 'an assistant audit row needs an event_type'
            USING ERRCODE = 'restrict_violation';
    END IF;

    SELECT m.tool_name, m.refusal_code, m.row_count, m.route_domain
      INTO v_tool, v_refusal, v_rows, v_domain
      FROM public.assistant_message m
     WHERE m.id = p_message_id;

    INSERT INTO public.audit_event (
        source, event_type, actor_kind, actor_user_id, actor_employee_id, actor_roles,
        subject_employee_id, subject_type, session_id, correlation_id, source_ip, reason,
        row_pk, table_name, after)
    VALUES (
        'application', p_event_type,
        CASE WHEN p_actor_user IS NULL THEN 'system' ELSE 'user' END,
        p_actor_user, p_actor_employee, p_roles,
        p_subject_employee, p_subject_type, p_session, p_correlation, p_source_ip,
        -- A closed-set reason code, never a data value and never the question. The question is
        -- PERSONAL and lives in assistant_message, which has a retention window; audit_event
        -- has decade retention and cannot be erased selectively.
        p_reason,
        p_message_id::text, 'assistant_message',
        -- The SHAPE of what happened. No question text, no argument values, no result.
        jsonb_build_object(
            'route_domain', v_domain,
            'tool', v_tool,
            'refusal_code', v_refusal,
            'row_count', v_rows))
    RETURNING id INTO v_id;

    RETURN v_id;
END $$;

COMMENT ON FUNCTION fn_audit_assistant(text, uuid, uuid, uuid, uuid, text, uuid, uuid, inet, text, text[]) IS
    'Audit sink for one assistant turn. Records the tool, the refusal code and the row COUNT - '
    'never the question, never an argument value, never a result. The question is PERSONAL and '
    'audit_event has decade retention with no selective erasure, so putting it here would create '
    'a permanent copy of the one column that leaves the jurisdiction.';

-- ---------------------------------------------------------------- audit column policy

-- ADR-0005 amendment (c): two registries exist and BOTH default closed. "A column absent from the
-- authz registry is NOT visible, and a column absent from audit_column_policy is NOT exempt from
-- audit. Whoever adds a column must register it in both, and the absence of an entry is never
-- permission."
--
-- EVERY column of both tables is declared, not just the interesting ones, and check A12 asserts
-- the coverage is total. That is what makes a column added later fail rather than pass quietly.
-- This table has held 0 rows since migration 0001 (see the handoff); these are the first.
INSERT INTO audit_column_policy (table_name, column_name, mode, rationale) VALUES
    -- The one that matters.
    ('assistant_message', 'question_text', 'omit',
     'PERSONAL free text, and the only column in this database transmitted outside India. '
     'audit_event has decade retention and no selective erasure, while the transcript has a '
     '90-day window (DEC-130) - so recording the question in audit would defeat that window '
     'permanently and create the durable copy the window exists to prevent.'),
    ('assistant_message', 'tool_args', 'redact',
     'May carry an employee number or a name fragment the user supplied. The tool NAME is audited '
     'through fn_audit_assistant; the argument VALUES are not.'),
    -- Outcome shape. No subject data in any of these.
    ('assistant_message', 'tool_name', 'full',
     'Which capability was exercised. The field that makes the audit trail answerable.'),
    ('assistant_message', 'route_domain', 'full', 'Closed-set routing decision.'),
    ('assistant_message', 'refusal_code', 'full', 'Closed-set outcome code.'),
    ('assistant_message', 'row_count', 'full',
     'A count of rows the caller was already entitled to see. Never the rows.'),
    -- Identifiers and telemetry.
    ('assistant_message', 'id', 'full', 'Surrogate key; travels as audit_event.row_pk.'),
    ('assistant_message', 'conversation_id', 'full', 'Groups turns into one session.'),
    ('assistant_message', 'seq', 'full', 'Turn ordering within a conversation.'),
    ('assistant_message', 'asked_at', 'full', 'When the turn happened; drives retention.'),
    ('assistant_message', 'model', 'full', 'Provider model id. Operational, no subject data.'),
    ('assistant_message', 'prompt_tokens', 'full', 'Cost telemetry.'),
    ('assistant_message', 'completion_tokens', 'full', 'Cost telemetry.'),
    ('assistant_message', 'latency_ms', 'full', 'Latency telemetry.'),
    ('assistant_conversation', 'id', 'full', 'Surrogate key.'),
    ('assistant_conversation', 'user_id', 'full',
     'Linkable identifier, and already the actor on every audit row.'),
    ('assistant_conversation', 'employee_id', 'full',
     'Linkable identifier. NULL for a break-glass actor, who reaches no tool.'),
    ('assistant_conversation', 'locale', 'full', 'en or ar. Not personal.'),
    ('assistant_conversation', 'started_at', 'full', 'Session start.'),
    ('assistant_conversation', 'last_message_at', 'full', 'Session activity.')
ON CONFLICT (table_name, column_name) DO NOTHING;

-- ---------------------------------------------------------------- grants

-- SELECT and sequence usage arrive from 0008's ALTER DEFAULT PRIVILEGES. Write grants are always
-- a deliberate act (DEC-073 is the proof of why we never lean on defaults for those).
GRANT INSERT, UPDATE ON assistant_conversation TO hrm_app;  -- UPDATE only bumps last_message_at
GRANT INSERT         ON assistant_message      TO hrm_app;

-- Deliberately NO DELETE for the application. Retention deletion is an operator or job action,
-- and the trigger above will refuse it before the window anyway. Giving the request path the
-- ability to erase its own trail is the shape of problem this repository keeps avoiding.

COMMIT;
