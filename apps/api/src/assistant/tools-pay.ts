/**
 * Domain: pay. ADR-0021.
 *
 * THE ACCESS QUESTION, ASKED FIRST, AS EVERY TOOL FILE HERE DOES:
 *
 *   `payroll.payslip.read`  allow: the SUBJECT always (employee, manager, hr_admin, finance
 *                           `when: isSelf`), plus hr_admin and finance `when: always`.
 *                           DENY: hr_ops, auditor, delivery_head.
 *                           denyOverrides: isBreakGlassActor, **isAncestorOfActor**.
 *                           graph: self.
 *
 * NOTHING IN THAT LINE IS NEW, and it is the reason ADR-0021 is a small decision rather than a
 * large one. *"Everybody their own, HR everyone's"* was already the policy, with a screen behind
 * it and 80 passing payslip checks; the assistant was the only place it did not hold. This file
 * adds no action, no cell and no scope - it reuses the action `/payslips` uses, exactly as
 * ADR-0020 section 1 requires of every tool.
 *
 * `isAncestorOfActor` IS THE INTERESTING PART and it is worth naming because it is easy to lose:
 * a line manager is denied the payslip of somebody who reports to them. `manager` appears in the
 * allow list only `when: isSelf`. So "what does my report earn?" is refused, by policy, and this
 * file does nothing to help it.
 *
 * ---------------------------------------------------------------------------
 * EVERY TOOL HERE WRITES ITS OWN SENTENCE. THAT IS THE POINT OF THE FILE.
 * ---------------------------------------------------------------------------
 *
 * ADR-0021 section 2: **no pay figure is sent to a model provider.** DEC-140 has the assistant
 * compose answers FROM the masked row values, which are transmitted to `gpt-4o-mini` outside
 * India - and ADR-0020 section 3 names `question_text` as *"the only column in this database
 * transmitted outside India"*. A salary must not become the second.
 *
 * So each tool returns `sentence`, and the controller sends it and **makes no provider call for
 * that turn**: no `buildAnswerPayload`, no `llm.chat`, no `modelPayload`. The absence of the
 * payload is the checkable form of the promise, which is why the controller returns early rather
 * than building one and discarding it - the red team asserts a money tool produced none.
 *
 * WHAT THAT COSTS, SAID PLAINLY: these sentences are hand-written and read flatter than model
 * prose, and they need maintaining as columns change. For a compensation figure that is the
 * better trade - a model cannot round, soften, average or invent a number it never receives.
 *
 * MONEY IS RENDERED BY `rupees()` FROM `payroll.ts`, which slices digits as text and never
 * divides (Rule 4). It is a second implementation of the web's `formatPaise` and the duplication
 * is deliberate: the sentence must be built in the API so the figure never leaves, and the API
 * cannot import from the frontend workspace. `pay:test` pins the two together, because the web
 * copy already shipped one grouping bug of exactly this kind.
 *
 * NO TOOL HERE AGGREGATES, COMPARES, RANKS OR ORDERS BY AMOUNT. ADR-0021 section 3 carries that
 * forward from ADR-0020 unweakened, and it is what keeps "who earns the most" a flat refusal for
 * every role however much pay they may legitimately read. There is no SUM, no average, no
 * `ORDER BY net_minor`, and no tool that takes two people.
 */

import { z } from 'zod';
import { defineTool, whoClause, whoClauseAnyone, zDate, zWho, SCHEMA_WHO, type ToolResult } from './catalog';
import { rupees } from '../payroll';

/*
 * A payslip is monthly, so a person accumulates twelve a year. 60 covers five years of history
 * for one person and is far below `MAX_ROWS_RENDERED`; an HR query across everybody is bounded
 * by the period arguments rather than by this.
 */
const ROW_CAP = 60;

/**
 * The empty result for THIS file carries a sentence, unlike the one every other tool module
 * defines - and that difference is the point.
 *
 * ADR-0021 section 2's guarantee is checkable only if it is UNCONDITIONAL: "no pay tool ever
 * builds an answer payload" can be asserted, whereas "no payload ever contains a figure" needs
 * somebody to inspect every payload for numbers. The controller skips the payload when a result
 * carries `sentence`, so every return path here has to have one - including the two that carry
 * no figure at all (`!scope`, and no rows), where a payload would have been harmless and the
 * guarantee would have become "usually".
 *
 * `!scope` means the policy admits this actor to NO rows. It is unreachable through `/ask`,
 * because a caller who can read no payslip is not offered a payslip tool - but `scope()` is the
 * control and this is what it renders, so the branch exists rather than being assumed away.
 */
const empty = (columns: readonly string[]): ToolResult => ({
  columns,
  rows: [],
  sentence: 'There is no pay information available to your account for that.',
});

/** `2026-08-01` .. `2026-08-31` -> `August 2026`. A period reads as a month, not two dates. */
const monthName = (isoDate: unknown): string => {
  const s = String(isoDate ?? '');
  const m = /^(\d{4})-(\d{2})/.exec(s);
  if (!m) return s;
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
};

/*
 * THE SELECT LIST AND THE TOTALS FUNCTION ARE THE PAYSLIP SCREEN'S, NOT A SECOND VERSION.
 *
 * `gross_minor`, `net_minor` and `deductions_minor` are NOT columns on `payslip` - they are
 * derived by `fn_payslip_totals`, which is where migration 0024 put the arithmetic so that a
 * script, a migration and this file cannot each derive a different net. `declared_net_minor` IS
 * a column: it is what the PDF says, kept deliberately distinct so the two can be compared.
 *
 * Everything is cast `::text` at the boundary. `bigint` reaches JavaScript as a `number` through
 * some drivers and silently loses precision above 2^53 - which is only ₹90,07,199 and change, an
 * entirely reachable annual figure.
 */
const PAYSLIP_SELECT = `
       p.employee_id,
       e.employee_number,
       e.full_name,
       p.period_start,
       p.period_end,
       p.pay_date,
       p.status,
       p.currency_code,
       t.net_minor::text        AS net_minor,
       t.gross_minor::text      AS gross_minor,
       t.deductions_minor::text AS deductions_minor,
       t.line_count,
       (p.document_id IS NOT NULL) AS has_document`;

const PAYSLIP_FROM = `
    FROM payslip p
    JOIN employee e ON e.id = p.employee_id
    CROSS JOIN LATERAL fn_payslip_totals(p.id) t`;

const PAYSLIP_COLUMNS = ['employee_number', 'full_name', 'period_start', 'period_end', 'pay_date',
  'status', 'currency_code', 'gross_minor', 'deductions_minor', 'net_minor', 'line_count',
  'has_document'] as const;

/**
 * One payslip as a sentence. Shared so that the self tool and the HR tool cannot describe the
 * same record differently.
 *
 * A VOIDED PAYSLIP SAYS SO FIRST. `status` is on every row and a voided figure is not what
 * somebody was paid; reporting the number without the word would be accurate about the record
 * and wrong about the person.
 */
const describe = (row: Record<string, unknown>, self: boolean): string => {
  const who = self ? 'Your' : `${String(row.full_name)}'s`;
  const period = monthName(row.period_start);
  const net = rupees(row.net_minor as string);
  const gross = rupees(row.gross_minor as string);
  const ded = rupees(row.deductions_minor as string);
  const status = String(row.status ?? '');

  const head = status === 'void'
    ? `${who} ${period} payslip was VOIDED`
    : `${who} ${period} payslip`;

  const figures = `net ${net}, gross ${gross}, deductions ${ded}`;
  // The pay date is absent until a payslip is issued, and saying "paid on null" is worse than
  // not mentioning it.
  const paid = row.pay_date ? `, paid on ${String(row.pay_date)}` : '';
  return `${head}: ${figures}${paid}.`;
};

// ---------------------------------------------------------------------------
// pay_my_payslip
// ---------------------------------------------------------------------------

/*
 * "What is my salary?" - the question ADR-0021 exists to let through, and the one that had been
 * answered with a flat compensation refusal since the assistant shipped.
 *
 * `selfOnly: true` AND NO PERSON ARGUMENT. The two go together and the bar for `selfOnly` in
 * `catalog.ts` is exact: no argument that names anybody, and SQL that filters on
 * `ctx.employeeId` in ADDITION to `scope()`. Both hold here. It buys the DEC-143 masking
 * behaviour (`inList: false`), which for `payslip` matters not at all today because no PAY field
 * is `neverInList` - but it also makes the controller drop any row that is not the caller's,
 * which is a second filter on the single most sensitive tool in the catalogue. Worth having
 * twice.
 */
defineTool({
  name: 'pay_my_payslip',
  domain: 'pay',
  money: true,
  selfOnly: true,
  description:
    'THE ASKER\'S OWN PAY. Their payslips with net, gross and deductions, the pay date and the ' +
    'period. Use for "what is my salary", "what is my net pay", "how much was I paid in ' +
    'August", "show my last payslip", "what were my deductions". With no dates it returns the ' +
    'most recent payslips. This tool is ONLY ever about the person asking - it takes no name ' +
    'and cannot be aimed at anybody else.',
  examples: [
    'what is my salary?',
    'what is my net pay?',
    'how much was I paid in August?',
    'show me my last payslip',
    'what were my deductions last month?',
    'what is my gross salary?',
    'my salary details',
  ],
  action: 'payroll.payslip.read',
  resource: 'payslip',
  args: z.object({ from: zDate.optional(), to: zDate.optional() }),
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Earliest period start, YYYY-MM-DD. Omit for recent.' },
      to: { type: 'string', description: 'Latest period end, YYYY-MM-DD. Omit for recent.' },
    },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = PAYSLIP_COLUMNS;
    const scope = ctx.scope('p', 2);
    if (!scope) return empty(cols);

    const params: unknown[] = [ctx.employeeId, ...scope.params];
    let n = 2 + scope.params.length;
    let period = 'true';
    if (args.from) { period += ` AND p.period_end >= $${n++}::date`; params.push(args.from); }
    if (args.to) { period += ` AND p.period_start <= $${n++}::date`; params.push(args.to); }

    // `p.employee_id = $1` IN ADDITION to `scope()`, never instead of it - the `selfOnly`
    // contract, and the trap DEC-120 recorded when a filter replaced a predicate.
    const rows = await ctx.db.rows(
      `SELECT ${PAYSLIP_SELECT} ${PAYSLIP_FROM}` +
      `  WHERE p.employee_id = $1 AND ${scope.sql} AND ${period}` +
      `  ORDER BY p.period_start DESC LIMIT ${ROW_CAP}`,
      params,
    );

    if (rows.length === 0) {
      return {
        columns: cols,
        rows: [],
        // Written here rather than left to the zero-row path, because "no payslip on file" is a
        // fact about the records and the honest thing to say (DEC-165's shape, stated by us).
        sentence: args.from || args.to
          ? 'You have no payslip on file for that period.'
          : 'You have no payslips on file yet.',
      };
    }

    /*
     * ONE SENTENCE PER PAYSLIP, NEWEST FIRST, and a lead line when there are several - the
     * DEC-151 shape (a bullet per record, prose for a single fact), written by us instead of
     * asked of a model. `**bold**` and `- ` are the only two constructs the panel parses.
     */
    const sentence = rows.length === 1
      ? describe(rows[0]!, true)
      : `Your last ${rows.length} payslips:\n`
        + rows.map((r) => `- ${describe(r, true)}`).join('\n');

    return { columns: cols, rows, sentence };
  },
});

// ---------------------------------------------------------------------------
// pay_employee_payslip
// ---------------------------------------------------------------------------

/*
 * "What did Priya earn in August?" - `hr_admin` and `finance` only.
 *
 * A SEPARATE TOOL FROM `pay_my_payslip` RATHER THAN AN ARGUMENT ON IT, and here the reason is
 * stronger than the usual selection argument. `pay_my_payslip` is `selfOnly`, which is a
 * contract that forbids a person argument entirely - adding one would remove the second filter
 * that makes the self tool safe. Two tools also means an employee is OFFERED only the self tool,
 * so the commonest failure is the model never seeing a tool it cannot use.
 *
 * `subjectDefault: 'asker'` (the default, stated for the reader): an HR admin asking "what is my
 * salary" through THIS tool must get their own, not the whole payroll register - which is
 * precisely the DEC-144 bug, and `whoClause` is what prevents it.
 */
defineTool({
  name: 'pay_employee_payslip',
  domain: 'pay',
  money: true,
  description:
    'SOMEBODY ELSE\'S PAY - for HR and finance only. A named employee\'s payslips with net, ' +
    'gross and deductions. Use when the question names a person, e.g. "what did Priya earn in ' +
    'August", "show EMP003 payslips", "what is the salary of Hisham". Name the person; with no ' +
    'name it returns the asker\'s own. Reports one person at a time and never compares, ranks ' +
    'or totals people.',
  examples: [
    'what did Priya earn in August?',
    'show me EMP003\'s payslips',
    'what is the salary of Anu Krishnan?',
    'what was Rahul\'s net pay last month?',
    'has Priya\'s September payslip been issued?',
  ],
  action: 'payroll.payslip.read',
  resource: 'payslip',
  args: z.object({ ...zWho, from: zDate.optional(), to: zDate.optional() }),
  parameters: {
    type: 'object',
    properties: {
      ...SCHEMA_WHO,
      from: { type: 'string', description: 'Earliest period start, YYYY-MM-DD.' },
      to: { type: 'string', description: 'Latest period end, YYYY-MM-DD.' },
    },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = PAYSLIP_COLUMNS;

    // `whoClause`, not `whoClauseAnyone`: naming nobody means the ASKER (DEC-144), never
    // "everybody in scope" - which for hr_admin would be the entire payroll register in answer
    // to "what is my salary".
    const who = whoClause(args, 'e', 1, ctx.employeeId);
    const scope = ctx.scope('p', 1 + who.params.length);
    if (!scope) return empty(cols);

    const params: unknown[] = [...who.params, ...scope.params];
    let n = 1 + who.params.length + scope.params.length;
    let period = 'true';
    if (args.from) { period += ` AND p.period_end >= $${n++}::date`; params.push(args.from); }
    if (args.to) { period += ` AND p.period_start <= $${n++}::date`; params.push(args.to); }

    const rows = await ctx.db.rows(
      `SELECT ${PAYSLIP_SELECT} ${PAYSLIP_FROM}` +
      `  WHERE ${who.sql} AND ${scope.sql} AND ${period}` +
      // Period, then employee NUMBER - never by amount. ADR-0021 section 3: the catalogue
      // contains no tool that orders people by pay.
      `  ORDER BY p.period_start DESC, e.employee_number LIMIT ${ROW_CAP}`,
      params,
    );

    if (rows.length === 0) {
      /*
       * A SENTENCE EVEN WITH NO ROWS, so that a pay tool NEVER reaches the answer payload.
       *
       * With zero rows a payload carries no figure, so leaving this to the model would not
       * breach ADR-0021 section 2 - but it would make the guarantee conditional, and "no pay
       * tool ever builds a payload" is checkable in a way that "no payload ever contains a
       * figure" is not. The red team asserts the former.
       *
       * IT DOES NOT PRE-EMPT DEC-142(b). The controller consults `namedSubjectOutOfReach`
       * BEFORE it looks at `sentence`, so a named person the caller cannot reach still produces
       * "X is outside what your account can see" rather than this. This only speaks for the
       * case where the person IS reachable and simply has no payslip.
       */
      return {
        columns: cols,
        rows: [],
        sentence: 'There is no payslip on file for that.',
      };
    }

    const self = rows.every((r) => r.employee_id === ctx.employeeId);
    const sentence = rows.length === 1
      ? describe(rows[0]!, self)
      : `${self ? 'Your' : `${String(rows[0]!.full_name)}'s`} last ${rows.length} payslips:\n`
        + rows.map((r) => `- ${describe(r, self)}`).join('\n');

    return { columns: cols, rows, sentence };
  },
});

// ---------------------------------------------------------------------------
// pay_payslip_document
// ---------------------------------------------------------------------------

/*
 * "Can I get my payslip PDF?" - requested alongside the figures.
 *
 * IT RETURNS A PATH, NOT BYTES AND NOT A PRESIGNED URL. `/payslips/:id/document` is the door
 * DEC-076 opened for the subject, and it does its own authorization when opened; handing back a
 * presigned URL instead would put a credential in a response body and, from there, in a log.
 * `object_key` and `bucket` are unregistered in the field registry for the same reason, so they
 * could not be returned even if this asked for them.
 *
 * WHY IT IS NOT A COLUMN ON THE OTHER TWO TOOLS: `has_document` already is one. This tool exists
 * because "send me my payslip" is a different question from "what did I earn", and a model given
 * one tool answering both picks the wrong shape - the `people_directory_lookup` /
 * `people_department_roster` precedent.
 */
defineTool({
  name: 'pay_payslip_document',
  domain: 'pay',
  money: true,
  description:
    'THE PAYSLIP PDF - where to open it, for a payslip that has one. Use for "can I download ' +
    'my payslip", "send me my August payslip", "is there a PDF for my payslip", "payslip ' +
    'document". Returns the period, whether a document exists and the link to open it. Returns ' +
    'no amounts - use pay_my_payslip for figures.',
  examples: [
    'can I download my payslip?',
    'send me my August payslip',
    'is there a PDF of my last payslip?',
    'where can I get my payslip document?',
  ],
  action: 'payroll.payslip.read',
  resource: 'payslip',
  args: z.object({ ...zWho, from: zDate.optional(), to: zDate.optional() }),
  parameters: {
    type: 'object',
    properties: {
      ...SCHEMA_WHO,
      from: { type: 'string', description: 'Earliest period start, YYYY-MM-DD.' },
      to: { type: 'string', description: 'Latest period end, YYYY-MM-DD.' },
    },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['employee_number', 'full_name', 'period_start', 'period_end', 'status',
      'has_document', 'document_link'] as const;

    const who = whoClause(args, 'e', 1, ctx.employeeId);
    const scope = ctx.scope('p', 1 + who.params.length);
    if (!scope) return empty(cols);

    const params: unknown[] = [...who.params, ...scope.params];
    let n = 1 + who.params.length + scope.params.length;
    let period = 'true';
    if (args.from) { period += ` AND p.period_end >= $${n++}::date`; params.push(args.from); }
    if (args.to) { period += ` AND p.period_start <= $${n++}::date`; params.push(args.to); }

    const rows = await ctx.db.rows(
      'SELECT p.employee_id, e.employee_number, e.full_name, p.period_start, p.period_end, ' +
      '       p.status, (p.document_id IS NOT NULL) AS has_document, ' +
      // A relative path, assembled from the payslip id. Never a storage coordinate.
      "       CASE WHEN p.document_id IS NOT NULL " +
      "            THEN '/api/payslips/' || p.id::text || '/document' END AS document_link " +
      '  FROM payslip p ' +
      '  JOIN employee e ON e.id = p.employee_id ' +
      ' WHERE ' + who.sql + ' AND ' + scope.sql + ' AND ' + period +
      ' ORDER BY p.period_start DESC LIMIT ' + ROW_CAP,
      params,
    );

    // A sentence even with no rows - see pay_employee_payslip: a pay tool must never reach the
    // answer payload, and the out-of-reach refusal still runs before this.
    if (rows.length === 0) {
      return { columns: cols, rows: [], sentence: 'There is no payslip on file for that.' };
    }

    const self = rows.every((r) => r.employee_id === ctx.employeeId);
    const subject = self ? 'Your' : `${String(rows[0]!.full_name)}'s`;
    const withDoc = rows.filter((r) => r.has_document === true);

    const sentence = withDoc.length === 0
      ? `${subject} ${monthName(rows[0]!.period_start)} payslip has no PDF attached yet.`
      : withDoc.length === 1
        ? `${subject} ${monthName(withDoc[0]!.period_start)} payslip PDF: `
          + `${String(withDoc[0]!.document_link)}`
        : `${subject} payslip PDFs:\n`
          + withDoc.map((r) => `- ${monthName(r.period_start)}: ${String(r.document_link)}`)
            .join('\n');

    return { columns: cols, rows, sentence };
  },
});

// ---------------------------------------------------------------------------
// onboarding_annexure_amounts
// ---------------------------------------------------------------------------

/*
 * "Salary of the onboarded candidate" - the question that started this, and the reason ADR-0021
 * was written rather than the pay block merely being patched again.
 *
 * DOMAIN `pay`, NOT `onboarding`, and that is a considered choice. The four process tools in
 * `tools-onboarding.ts` state in their descriptions that they return NO figures, which is what
 * lets the router send an approval-chain question there without a model having to weigh whether
 * money is wanted. Putting an amounts tool beside them would undo that. The asker's intent -
 * a figure - is what selects the domain, and `pay` is where figures live.
 *
 * ITS ACTION IS THE ANNEXURE'S, NOT THE PAYSLIP'S. `onboarding.annexure.read` admits `hr_admin`,
 * `finance`, `auditor` and `delivery_head`, and DENIES the subject and their line manager - a
 * package under review is not team information. So this tool is offered to the approval chain
 * and to nobody else, and an employee asking is refused rather than answered.
 */
defineTool({
  name: 'onboarding_annexure_amounts',
  /*
   * DOMAIN `cross`, AND THE FIRST CHOICE OF `pay` WAS A BUG THE PRODUCT OWNER FOUND: *"from hr
   * cant see onboarding guys expected salary. but can see others salary."*
   *
   * The router picks ONE domain and then
   * `candidates = permitted.filter((t) => t.domain === domain || t.domain === 'cross')`. A
   * question with the word "onboarding" in it routes to the `onboarding` domain - correctly, it
   * IS about onboarding - and a tool sitting in `pay` was therefore not a candidate at all. The
   * four process tools there each say "RETURNS NO FIGURES", so the model picked one, got rows
   * with no money in them, and answered that it had nothing. Payslips worked the whole time
   * because those questions route to `pay`.
   *
   * `cross` is the one domain that is ALWAYS in the candidate list, whatever the router chose,
   * and the blurb describes it as "questions spanning two areas at once" - which an annexure CTC
   * genuinely is: it is onboarding AND it is pay. So the fix is structural rather than a better
   * prompt, which is the preference this repo states everywhere else.
   *
   * The cost is one extra tool in every selection call. DEC-127's finding was about a catalogue
   * of fifty; one emphatically-described tool is not that, and it is offered only to the four
   * roles that hold `onboarding.annexure.read` in the first place.
   */
  domain: 'cross',
  money: true,
  subjectDefault: 'scope',
  description:
    'THE OFFERED PAY IN A NEW JOINER\'S SALARY ANNEXURE - the annual CTC and its components - ' +
    'for the onboarding approval chain only. Use for "what is the CTC in X\'s annexure", ' +
    '"salary of the onboarded candidate", "what are the salary components for the new joiner", ' +
    '"what package was offered to X". This is the compensation being OFFERED before joining, ' +
    'not pay that has been issued - use pay_employee_payslip for an employee\'s actual pay.',
  examples: [
    'salary of the onboarded candidate',
    'what is the CTC in John\'s annexure?',
    'what are the salary components for Hisham?',
    'what package was offered to EMP007?',
    'how much is the annexure for the new joiner?',
    'what is the annual CTC being offered to Meera?',
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
    const cols = ['employee_number', 'full_name', 'status', 'proposed_joining_on',
      'declared_annual_ctc_minor', 'component_code', 'label', 'kind', 'amount_minor'] as const;

    const who = whoClauseAnyone(args, 'e', 1);
    const scope = ctx.scope('sa', 1 + who.params.length);
    if (!scope) return empty(cols);

    /*
     * ONE ROW PER COMPONENT, with the annexure's declared CTC repeated on each. A join rather
     * than a JSON aggregate because the field registry masks COLUMNS: components nested inside a
     * JSON value would pass through the mask unexamined, which is precisely the hole a
     * default-deny registry exists to close.
     *
     * `::text` on both amounts - `bigint` loses precision above 2^53 through some drivers, and
     * that is only ₹90,07,199, an entirely ordinary annual CTC.
     */
    const rows = await ctx.db.rows(
      'SELECT sa.employee_id, e.employee_number, e.full_name, sa.status, ' +
      '       sa.proposed_joining_on, ' +
      '       sa.declared_annual_ctc_minor::text AS declared_annual_ctc_minor, ' +
      '       c.component_code, c.label, c.kind, c.amount_minor::text AS amount_minor ' +
      '  FROM salary_annexure sa ' +
      '  JOIN employee e ON e.id = sa.employee_id ' +
      '  LEFT JOIN salary_annexure_component c ON c.annexure_id = sa.id ' +
      ' WHERE ' + who.sql + ' AND ' + scope.sql +
      ' ORDER BY sa.updated_at DESC, c.sort_order LIMIT 200',
      [...who.params, ...scope.params],
    );

    if (rows.length === 0) {
      return {
        columns: cols,
        rows: [],
        sentence: 'There is no salary annexure on file for that.',
      };
    }

    /*
     * EVERY CANDIDATE THE QUERY RETURNED, NOT JUST THE FIRST (DEC-172).
     *
     * This described only `rows[0]`'s annexure, on the stated grounds that *"running several
     * joiners' packages together would be the comparison ADR-0021 section 3 keeps out of the
     * catalogue"*. **That reasoning was wrong.** A LIST of records is not a comparison of them:
     * HR reads exactly this list on `/onboarding`, and section 3 forbids RANKING, ordering by
     * amount and AGGREGATING - not enumerating. The rows were all there and being entitled to
     * them; only the sentence was throwing them away.
     *
     * Reported as *"if no name mention it might show all candidates salary details i believe"*,
     * which is the right expectation and was already what the SQL did - `subjectDefault: 'scope'`
     * with `whoClauseAnyone`, ordered by `updated_at` and never by an amount.
     *
     * ONE BULLET PER CANDIDATE when there are several - the DEC-151 shape, and the panel parses
     * only `**bold**` and `- `, so components go inline rather than as a second bullet level
     * that would render as literal characters.
     */
    const byPerson = new Map<string, Record<string, unknown>[]>();
    for (const r of rows) {
      const key = String(r.employee_number);
      (byPerson.get(key) ?? byPerson.set(key, []).get(key)!).push(r);
    }

    /** `Basic ₹10,00,000.00, HRA ₹5,00,000.00` - the entered lines, in their own order. */
    const components = (group: Record<string, unknown>[]): string[] => group
      .filter((r) => r.component_code)
      .map((r) => `**${String(r.label)}**${r.kind === 'deduction' ? ' (deduction)' : ''}: `
        + `${rupees(r.amount_minor as string)}`);

    const headOf = (r: Record<string, unknown>): string =>
      `${String(r.full_name)} (${String(r.employee_number)}) is offered an annual CTC of `
      + `${rupees(r.declared_annual_ctc_minor as string)}, proposed to join on `
      + `${String(r.proposed_joining_on)}. The annexure is at `
      + `${String(r.status).replace(/_/g, ' ')}.`;

    let sentence: string;
    if (byPerson.size === 1) {
      const group = [...byPerson.values()][0]!;
      const lines = components(group);
      sentence = lines.length
        ? `${headOf(group[0]!)}\n${lines.map((l) => `- ${l}`).join('\n')}`
        // Nothing is calculated here - the total is a sum of what somebody typed (ADR-0020) - so
        // a draft with no components yet says so rather than implying the CTC is unsupported.
        : `${headOf(group[0]!)} No components have been entered yet.`;
    } else {
      const bullets = [...byPerson.values()].map((group) => {
        const r = group[0]!;
        const lines = components(group);
        return `- **${String(r.full_name)}** (${String(r.employee_number)}): annual CTC `
          + `${rupees(r.declared_annual_ctc_minor as string)}, joining `
          + `${String(r.proposed_joining_on)}, at ${String(r.status).replace(/_/g, ' ')}`
          + (lines.length ? ` — ${lines.join(', ')}` : ' — no components entered yet');
      });
      sentence = `${byPerson.size} candidates have a salary annexure on file:\n`
        + bullets.join('\n');
    }

    return { columns: cols, rows, sentence };
  },
});
