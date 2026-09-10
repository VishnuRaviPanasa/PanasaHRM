/**
 * Domain: onboarding - the salary annexure's APPROVAL CHAIN, and never its figures.
 *
 * THE ACCESS QUESTION, ASKED FIRST, AS EVERY TOOL FILE HERE DOES:
 *
 *   `onboarding.annexure.read`  allow: hr_admin, finance, auditor, delivery_head.
 *                               DENY:  employee, manager, hr_ops.
 *                               graph: organisation.
 *
 * The deny list is the interesting half and it is deliberate, not incidental. The matrix note
 * says so in terms: *"Whoever has to act on it. hr_admin prepares, finance and the delivery head
 * decide. Deliberately NOT the subject, and not their line manager - a package under review is
 * not team information."* So `permittedTools` never OFFERS these tools to an employee or a line
 * manager, and `gateTool` refuses them a second time on execution if the model names one anyway.
 * An employee asking "what stage is my offer at?" gets a refusal, and that is the designed
 * answer rather than a gap.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE TOOLS MAY NOT DO, AND WHY IT IS NOT ENFORCED IN THIS FILE
 * ---------------------------------------------------------------------------
 *
 * ADR-0020 (the runtime assistant) carries ADR-0014's prohibition forward *"verbatim and
 * unweakened"*, and says in terms that it does not have the authority to relax it:
 *
 *     "Forbidden regardless of any later decision: any AI input to hiring, promotion,
 *      compensation, performance rating, discipline or termination"
 *
 * and then makes it structural: **"No tool reads compensation."** An annexure is compensation -
 * ADR-0020 (the onboarding boundary) calls it *"the CTC breakup that the offer letter will
 * quote"* - so the single most important property of this file is a negative one: **no money
 * figure can leave it.**
 *
 * THAT IS NOT ACHIEVED BY THESE SELECT LISTS, and it deliberately does not depend on them. The
 * `salary_annexure` entry in the `packages/authz` field registry omits
 * `declared_annual_ctc_minor`, `amount_minor` and `ctc_at_decision_minor`, and the registry is
 * DEFAULT-DENY: a column with no entry is dropped from every row for every role. So a future
 * edit that adds `sa.declared_annual_ctc_minor` to a query below produces rows WITHOUT it rather
 * than a disclosure - the same device the `attendance_punch` entry uses to make a colleague's
 * coordinates unreturnable. A SELECT list is a preference; the registry is a control.
 *
 * The queries still leave the figures out, because a column that is fetched and then masked has
 * been read out of the database, put in a process's memory and handed to a mask - and the point
 * of ADR-0020's structural claim is that it never gets that far.
 *
 * ONE CONSEQUENCE, STATED SO IT IS NOT READ AS A BUG: **"what is the CTC in John's annexure?"**
 * is refused before any model call, as a `forbidden_purpose`, and **"what is the status of the
 * salary annexure for John?"** is answered. The record's own NAME contains the word `salary`,
 * which is why the pay block needed the narrow carve-out in `assistant.controller.ts` rather
 * than a new tool here.
 *
 * ---------------------------------------------------------------------------
 * WHY FOUR TOOLS AND NOT ONE WITH FOUR ARGUMENTS
 * ---------------------------------------------------------------------------
 *
 * The precedent is `people_department_roster` sitting beside `people_directory_lookup`: *"the
 * two are different questions at selection time and a model given one tool with a person
 * argument AND a department argument reliably fills in the wrong one."* A queue question ("what
 * is waiting on finance"), a person question ("what stage is John at"), a calendar question
 * ("who starts next month") and a history question ("who approved it") are four different
 * shapes, and one tool with `status`, `who`, `from`/`to` and `annexure` arguments would be
 * filled in wrongly most of the time.
 *
 * `subjectDefault: 'scope'` ON ALL FOUR, and unlike most of the catalogue that needs no thought
 * here: DEC-144's default exists because a question naming nobody is usually about the asker,
 * and an annexure is NEVER about the asker. The four roles that may read one are the three who
 * act on it plus the auditor; none of them is the joiner. A no-argument call therefore means
 * "the whole queue I can see", which is what the `/onboarding` screen shows those same people.
 */

import { z } from 'zod';
import {
  defineTool, localDateTime, whoClauseAnyone, zDate, zWho, SCHEMA_WHO, type ToolResult,
} from './catalog';

/*
 * A hiring pipeline is small - `ux_salary_annexure_one_live` permits ONE live annexure per
 * person, so this bounds the number of people being hired at once, not the number of rows in a
 * table. 400 (the figure `tools-people.ts` uses) would be a fantasy about this company; 200 is
 * still far above any real queue and well under `MAX_ROWS_RENDERED`.
 */
const ROW_CAP = 200;

const empty = (columns: readonly string[]): ToolResult => ({ columns, rows: [] });

/**
 * The eight statuses of `ck_salary_annexure_status`, as the model may name them.
 *
 * A CLOSED SET RATHER THAN FREE TEXT, so an invented status ("approved", "pending") is rejected
 * by `zod` as `invalid_args` instead of silently matching no rows - which would be reported as
 * "there are no annexures in that state" and read as a fact about the queue. DEC-150's shape: a
 * fact the system does not hold, presented as one it does.
 */
const STATUSES = [
  'draft', 'finance_review', 'delivery_review', 'delivery_approved',
  'offer_issued', 'offer_accepted', 'offer_declined', 'withdrawn',
] as const;

/*
 * The statuses that mean "somebody still has to do something". Terminal states are excluded, and
 * `draft` is included because it is waiting on HR - a draft nobody submits is the commonest way
 * for a joiner to be quietly stuck, and a "pending" list that hid it would answer the question
 * "is anything stuck?" with "no".
 */
const OPEN_STATUSES = ['draft', 'finance_review', 'delivery_review', 'delivery_approved'] as const;

/**
 * Who is waiting on each open status. Returned as a column so the answer can say *whose* move it
 * is without the model inferring it from a status name - `delivery_approved` means HR must issue
 * the letter, which is not guessable from the word.
 */
const WAITING_ON_SQL = `
  CASE sa.status
    WHEN 'draft'             THEN 'HR (to complete and submit it)'
    WHEN 'finance_review'    THEN 'the finance head (to approve the figures)'
    WHEN 'delivery_review'   THEN 'the delivery head (to approve the hire)'
    WHEN 'delivery_approved' THEN 'HR (to issue the offer letter)'
    ELSE 'nobody - it is closed'
  END`;

/*
 * The joiner's identity and the annexure's process columns. Shared by the three tools that
 * return annexures, so they cannot drift into describing the same record differently.
 *
 * `employee_id` is here because `maskRows` reads `row.employee_id` to decide who a row is about.
 * It resolves to `self: false` for every field on this resource, so it changes no field's
 * visibility - but a row without it would make the mask treat the subject as unknown, and the
 * next resource that DOES set `self` would inherit the omission.
 *
 * NO MONEY COLUMN APPEARS BELOW. See this file's header.
 */
const ANNEXURE_SELECT = `
       sa.employee_id,
       e.employee_number,
       e.full_name,
       sa.status,
       sa.proposed_joining_on,
       pb.full_name                        AS prepared_by_name,
       (sa.offer_document_id IS NOT NULL)  AS has_offer_letter,
       ${localDateTime('sa.updated_at')}   AS updated_at`;

const ANNEXURE_FROM = `
    FROM salary_annexure sa
    JOIN employee e  ON e.id = sa.employee_id
    LEFT JOIN employee pb ON pb.id = sa.prepared_by`;

const ANNEXURE_COLUMNS = ['employee_number', 'full_name', 'status', 'proposed_joining_on',
  'prepared_by_name', 'has_offer_letter', 'updated_at'] as const;

// ---------------------------------------------------------------------------
// onboarding_annexure_status
// ---------------------------------------------------------------------------

/*
 * "What stage is John's offer at?" - the question the three people in the chain ask each other.
 *
 * With no arguments it is the whole queue, which is the `/onboarding` screen's default view. The
 * `status` argument exists so "show me the withdrawn ones" does not have to be answered by
 * returning everything and hoping the model filters correctly in prose.
 */
defineTool({
  name: 'onboarding_annexure_status',
  domain: 'onboarding',
  subjectDefault: 'scope',
  description:
    'THE ONBOARDING QUEUE: salary annexures for new joiners and WHICH STAGE of the approval ' +
    'chain each one has reached. With no arguments it lists every annexure. Name a person to ' +
    'get theirs, or pass a status to filter. Returns the stage, who is waiting on it, the ' +
    'proposed joining date, who prepared it and whether the offer letter has been issued. ' +
    'Use for "what stage is X\'s annexure at", "show me the onboarding queue", "which offers ' +
    'have been issued", "is there an annexure for X". ' +
    'RETURNS NO FIGURES: no CTC, no salary components, no amounts of any kind - this tool ' +
    'reports the PROGRESS of an offer, never its money.',
  examples: [
    'what stage is John\'s annexure at?',
    'show me the onboarding queue',
    'is there an annexure for ALIYAS?',
    'which annexures have been withdrawn?',
    'has the offer letter gone out for EMP006?',
    'what is the status of the salary annexure for Meera?',
    'how many people are being onboarded right now?',
  ],
  action: 'onboarding.annexure.read',
  resource: 'salary_annexure',
  args: z.object({ ...zWho, status: z.enum(STATUSES).optional() }),
  parameters: {
    type: 'object',
    properties: {
      ...SCHEMA_WHO,
      status: {
        type: 'string',
        enum: [...STATUSES],
        description:
          'Filter to one stage of the chain. Omit for every annexure. ' +
          'draft = HR is still preparing it; finance_review = waiting on the finance head; ' +
          'delivery_review = waiting on the delivery head; delivery_approved = both approvals ' +
          'in, waiting for HR to issue the letter; offer_issued/offer_accepted/offer_declined = ' +
          'the letter has gone out and this is the joiner\'s response; withdrawn = cancelled.',
      },
    },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = [...ANNEXURE_COLUMNS, 'waiting_on'] as const;

    /*
     * `whoClauseAnyone`, not `whoClause` - the caller is never the subject here, so defaulting
     * to `sa.employee_id = <caller>` would return nothing for every legitimate question. It is
     * still an AND on top of `scope()` and never a substitute for it (DEC-120).
     */
    const who = whoClauseAnyone(args, 'e', 1);
    let n = 1 + who.params.length;

    const params: unknown[] = [...who.params];
    let statusSql = 'true';
    if (args.status) {
      statusSql = `sa.status = $${n++}`;
      params.push(args.status);
    }

    const scope = ctx.scope('sa', n);
    if (!scope) return empty(cols);

    const rows = await ctx.db.rows(
      `SELECT ${ANNEXURE_SELECT}, ${WAITING_ON_SQL} AS waiting_on ${ANNEXURE_FROM}` +
      ` WHERE ${who.sql} AND ${statusSql} AND ${scope.sql}` +
      // Open work first, then the most recently moved - the queue's own order, so the model is
      // not choosing what matters.
      `  ORDER BY (sa.status = ANY($${n}::text[])) DESC, sa.updated_at DESC` +
      `  LIMIT ${ROW_CAP}`,
      [...params, ...scope.params, [...OPEN_STATUSES]],
    );
    return { columns: cols, rows };
  },
});

// ---------------------------------------------------------------------------
// onboarding_pending_approvals
// ---------------------------------------------------------------------------

/*
 * "What is waiting on me?" - and the reason it is a separate tool rather than
 * `onboarding_annexure_status` with a status argument is that the asker does not know which
 * status is theirs. A finance head asking "what needs my approval?" would have to be routed to
 * `status: 'finance_review'` by the model, which means the model has to know the chain. It does
 * not, reliably, and getting it wrong returns somebody else's queue with no sign anything is
 * missing.
 *
 * `mine: true` resolves the stage from the caller's OWN ROLES instead - server-side, from
 * `ctx.auth.roles`, which is the authenticated fact rather than a model inference.
 */
defineTool({
  name: 'onboarding_pending_approvals',
  domain: 'onboarding',
  subjectDefault: 'scope',
  description:
    'ONBOARDING APPROVALS THAT ARE STILL OUTSTANDING, and who each one is waiting on. Use for ' +
    '"what is waiting for my approval", "which annexures need finance approval", "what is ' +
    'stuck in onboarding", "is anything pending with the delivery head". Set mine=true when ' +
    'the asker says "my" or "me" - the stage is then resolved from their own role rather than ' +
    'guessed. Excludes anything already closed (offer accepted, declined or withdrawn). ' +
    'RETURNS NO FIGURES - the stage and the joining date only, never a CTC or an amount.',
  examples: [
    'what is waiting for my approval?',
    'which annexures need finance approval?',
    'what is pending with the delivery head?',
    'is anything stuck in onboarding?',
    'which onboarding approvals are outstanding?',
    'do I have anything to approve?',
  ],
  action: 'onboarding.annexure.read',
  resource: 'salary_annexure',
  args: z.object({ mine: z.boolean().optional() }),
  parameters: {
    type: 'object',
    properties: {
      mine: {
        type: 'boolean',
        description:
          'True when the question is about the ASKER\'s own queue ("waiting for me", "do I ' +
          'have anything to approve"). The stage is resolved from the asker\'s role by the ' +
          'system. Omit for the whole outstanding list.',
      },
    },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = [...ANNEXURE_COLUMNS, 'waiting_on'] as const;

    /*
     * WHOSE MOVE IS IT - decided from the authenticated roles, never from the question.
     *
     * `hr_admin` appears against two stages because HR genuinely acts twice: it prepares the
     * draft and it issues the letter after both approvals land. An `auditor` holds neither, and
     * `mine: true` for them correctly yields nothing to do rather than the whole queue -
     * reading the chain is not the same as being in it.
     */
    const stagesFor = (roles: readonly string[]): string[] => {
      const out: string[] = [];
      if (roles.includes('hr_admin')) out.push('draft', 'delivery_approved');
      if (roles.includes('finance')) out.push('finance_review');
      if (roles.includes('delivery_head')) out.push('delivery_review');
      return out;
    };

    const stages = args.mine ? stagesFor(ctx.auth.roles) : [...OPEN_STATUSES];

    /*
     * An empty stage list means "nothing is ever mine", which is a real answer for an auditor.
     * Returning early rather than passing `= ANY('{}')` keeps the note attached to it, because
     * an empty result with no explanation reads as "the queue is clear".
     */
    if (stages.length === 0) {
      return {
        columns: cols,
        rows: [],
        note:
          'Your account is not one of the three that act on an annexure - HR prepares, the ' +
          'finance head approves the figures, the delivery head approves the hire - so nothing ' +
          'is ever waiting on you. Ask without "my" to see what is outstanding for everybody.',
      };
    }

    const scope = ctx.scope('sa', 2);
    if (!scope) return empty(cols);

    const rows = await ctx.db.rows(
      `SELECT ${ANNEXURE_SELECT}, ${WAITING_ON_SQL} AS waiting_on ${ANNEXURE_FROM}` +
      `  WHERE sa.status = ANY($1::text[]) AND ${scope.sql}` +
      // Oldest first: the point of a pending list is what has been waiting longest.
      `  ORDER BY sa.updated_at ASC LIMIT ${ROW_CAP}`,
      [stages, ...scope.params],
    );
    return { columns: cols, rows };
  },
});

// ---------------------------------------------------------------------------
// onboarding_upcoming_joiners
// ---------------------------------------------------------------------------

/*
 * "Who starts next month?"
 *
 * THIS IS NOT `people_directory_lookup`, and the distinction is the one migration 0032 makes in
 * its own comment: `proposed_joining_on` is *"the date the offer assumes they start. Not
 * `employee.joined_on`, which is what actually happened; these disagree whenever somebody starts
 * late."* The directory tool answers "when did Priya join" from the employment record. This one
 * answers "when is Meera due to start" from an offer that may not even be accepted yet, and
 * carrying the status alongside the date is what stops the two being confused - a joining date
 * on a `draft` annexure is a plan, not a commitment.
 */
defineTool({
  name: 'onboarding_upcoming_joiners',
  domain: 'onboarding',
  subjectDefault: 'scope',
  description:
    'PEOPLE DUE TO START, by their PROPOSED joining date on an offer - for "who is joining ' +
    'next month", "who starts in October", "when is X due to start", "are there any joiners ' +
    'this week". This is the date the OFFER assumes, which is not the same as the joining date ' +
    'of somebody already employed - use people_directory_lookup for that. The stage is returned ' +
    'beside each date because a date on an unapproved annexure is a plan, not a commitment. ' +
    'RETURNS NO FIGURES.',
  examples: [
    'who is joining next month?',
    'who starts in October?',
    'are there any joiners this week?',
    'when is Meera due to start?',
    'list the upcoming joiners',
    'is anybody joining before the end of the month?',
  ],
  action: 'onboarding.annexure.read',
  resource: 'salary_annexure',
  args: z.object({
    ...zWho,
    from: zDate.optional(),
    to: zDate.optional(),
    includeClosed: z.boolean().optional(),
  }),
  parameters: {
    type: 'object',
    properties: {
      ...SCHEMA_WHO,
      from: {
        type: 'string',
        description: 'Earliest proposed joining date, YYYY-MM-DD. Defaults to today.',
      },
      to: {
        type: 'string',
        description: 'Latest proposed joining date, YYYY-MM-DD. Omit for no upper bound.',
      },
      includeClosed: {
        type: 'boolean',
        description:
          'Include annexures that were withdrawn or whose offer was declined. Defaults to ' +
          'false, because a declined offer is not an upcoming joiner.',
      },
    },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = [...ANNEXURE_COLUMNS] as const;

    // The SERVER's date (DEC-091). A client computing "today" is wrong for 5.5 hours a day.
    const from = args.from ?? ctx.businessDate;

    const who = whoClauseAnyone(args, 'e', 1);
    let n = 1 + who.params.length;
    const params: unknown[] = [...who.params];

    const fromParam = n++;
    params.push(from);

    let toSql = 'true';
    if (args.to) {
      toSql = `sa.proposed_joining_on <= $${n++}::date`;
      params.push(args.to);
    }

    /*
     * A declined or withdrawn offer is not an upcoming joiner, so it is excluded by default -
     * and `offer_accepted` is NOT excluded, because somebody who has accepted is precisely who
     * "joining next month" means. That asymmetry is the reason this is not simply
     * `status = ANY(OPEN_STATUSES)`.
     */
    const closedSql = args.includeClosed
      ? 'true'
      : `sa.status NOT IN ('offer_declined', 'withdrawn')`;

    const scope = ctx.scope('sa', n);
    if (!scope) return empty(cols);

    const rows = await ctx.db.rows(
      `SELECT ${ANNEXURE_SELECT} ${ANNEXURE_FROM}` +
      `  WHERE ${who.sql}` +
      `    AND sa.proposed_joining_on >= $${fromParam}::date` +
      `    AND ${toSql} AND ${closedSql} AND ${scope.sql}` +
      `  ORDER BY sa.proposed_joining_on ASC LIMIT ${ROW_CAP}`,
      [...params, ...scope.params],
    );
    return { columns: cols, rows };
  },
});

// ---------------------------------------------------------------------------
// onboarding_annexure_history
// ---------------------------------------------------------------------------

/*
 * "Who approved it, and when?" - the separation-of-duty question, which is the one ADR-0020 says
 * the whole four-action design exists to answer: *"HR prepares, the finance head approves the
 * money, the delivery head approves the hire."* Without this tool the assistant could say an
 * annexure was approved and not by whom, which is the half that matters when somebody asks.
 *
 * `ctc_at_decision_minor` IS ON EVERY ROW THIS QUERY TOUCHES and is not selected. Migration 0032
 * added it so the trail can say WHAT finance approved after a rejection rewrites the components;
 * that is exactly a compensation figure, so it stays in the database where the `/onboarding`
 * timeline reads it, and the registry would drop it here even if this SELECT list asked.
 */
defineTool({
  name: 'onboarding_annexure_history',
  domain: 'onboarding',
  subjectDefault: 'scope',
  description:
    'THE APPROVAL TRAIL of an annexure: every step it has taken, who took it, when, and any ' +
    'reason they gave for sending it back. Use for "who approved X\'s annexure", "when did ' +
    'finance approve it", "why was it rejected", "what has happened to X\'s offer". Name the ' +
    'joiner the annexure belongs to. RETURNS NO FIGURES - who and when, never what was ' +
    'approved in money terms.',
  examples: [
    'who approved the annexure for ALIYAS?',
    'when did finance approve John\'s annexure?',
    'why was Meera\'s annexure rejected?',
    'what has happened to EMP006\'s offer?',
    'show me the approval history for John',
    'who withdrew the offer for Meera?',
  ],
  action: 'onboarding.annexure.read',
  resource: 'salary_annexure',
  args: z.object({ ...zWho }),
  parameters: {
    type: 'object',
    properties: { ...SCHEMA_WHO },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['employee_number', 'full_name', 'event_type', 'from_status', 'to_status',
      'actor_name', 'decided_at', 'reason'] as const;

    const who = whoClauseAnyone(args, 'e', 1);
    const scope = ctx.scope('sa', 1 + who.params.length);
    if (!scope) return empty(cols);

    /*
     * SCOPED ON THE ANNEXURE, NOT ON THE EVENT. `salary_annexure_event` carries its own
     * `subject_employee_id`, and filtering on that would be a second, parallel answer to
     * "whose row is this" - the shape DEC-060 warns about, where two permission paths over the
     * same data drift apart. The annexure owns the access decision; an event is reachable
     * because its annexure is.
     *
     * `sa.employee_id AS employee_id` and not the event's subject, for the same reason: the mask
     * asks who a row is about, and the answer is the joiner.
     */
    const rows = await ctx.db.rows(
      'SELECT sa.employee_id, e.employee_number, e.full_name, ' +
      '       ev.event_type, ev.from_status, ev.to_status, ' +
      '       ac.full_name AS actor_name, ' +
      `       ${localDateTime('ev.created_at')} AS decided_at, ` +
      '       ev.reason ' +
      '  FROM salary_annexure_event ev ' +
      '  JOIN salary_annexure sa ON sa.id = ev.annexure_id ' +
      '  JOIN employee e         ON e.id = sa.employee_id ' +
      '  LEFT JOIN employee ac   ON ac.id = ev.actor_employee_id ' +
      ' WHERE ' + who.sql + ' AND ' + scope.sql +
      // Oldest first: a trail reads forwards.
      ' ORDER BY ev.created_at ASC LIMIT ' + ROW_CAP,
      [...who.params, ...scope.params],
    );
    return { columns: cols, rows };
  },
});
