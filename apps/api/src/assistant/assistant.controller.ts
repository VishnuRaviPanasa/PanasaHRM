/**
 * The assistant endpoint. ADR-0020.
 *
 * ONE ROUTE, and it defines no authorization action of its own. It multiplexes over a fixed
 * catalogue whose every tool reuses the action of the screen it mirrors - recorded in
 * `authz-matrix.yaml` under the divergence `assistant-route-multiplexes-existing-actions`,
 * which is the "corresponding entry" CLAUDE.md requires for a new route.
 *
 * THE TURN, and where each control sits:
 *
 *   1. filter    `assertCan` per tool. The model is never OFFERED a tool this actor cannot call.
 *   2. route     model call 1 - pick a domain from seven descriptions.
 *   3. select    model call 2 - pick a tool from that domain, with arguments.
 *   4. validate  Zod. The model's arguments are text a user influenced; they are parsed, not read.
 *   5. authorise `assertCan` AGAIN, then `scope()` composed INTO the SQL. Step 1 was an
 *                affordance; this is the control. A filtered list is UX, not security.
 *   6. mask      `maskList` - as a list, except for a `selfOnly` tool. See maskRows below.
 *   7. answer    model call 3 - the question and the MASKED ROWS, with no tools attached,
 *                streamed back a fragment at a time as the provider writes it.
 *   8. record    a transcript row and an audit row, neither carrying a result.
 *
 * STEP 7 CHANGED TWICE ON 2026-09-09, and it is the one place this module gave something up.
 * DEC-140: it used to send the column names and the row count only, so the model wrote an
 * introduction to a table rather than an answer to a question; it now sends the rows. DEC-141:
 * the panel then stopped rendering the table at all, and the answer became a stream.
 *
 * WHAT THAT SECOND STEP COST. DEC-140's third bound was that the table reached the browser BEFORE
 * the model call and was never derived from its output, so a wrong sentence sat beside right
 * numbers. The `rows` event still goes first and the API still sends it - the ordering below is
 * unchanged and stays load-bearing for any client that draws it - but the shipped panel no longer
 * does, so for a real user that check is gone and only the prose remains. The two bounds that
 * survive intact are the ones in `answer.ts`: the model sees exactly the masked array the asker
 * is entitled to, and the answer call carries no tools.
 *
 * A MIS-SELECTED TOOL IS A QUALITY DEFECT, NOT A SECURITY DEFECT (DEC-135). Steps 5 and 6 do
 * not care why a tool was chosen, so the worst outcome of an adversarial question is a wrong
 * answer. That separation is what makes a large catalogue safe, and it is why the accuracy suite
 * and the red-team suite are different things with different gates.
 */

import {
  BadRequestException, Body, Controller, Get, Module, Post, Req, Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AuthContext } from '@panasa/authz';
import { Authenticated, currentActor } from '../auth';
import { authContext, Authz } from '../authz';
import { Db } from '../db';
import { Llm, LlmUnavailable, type ToolSchema } from './llm';
import {
  DOMAINS, allTools, gateTool, isDenied, permittedTools, toolByName, whoClauseAnyone,
  type Domain, type ToolResult, type ToolSpec,
} from './catalog';
import { ANSWER_SYSTEM_PROMPT, buildAnswerPayload, deterministicSentence } from './answer';

// The catalogue is populated by importing the domain modules for their side effect.
import './tools-me';
import './tools-leave';
import './tools-attendance';
import './tools-people';
import './tools-work';
import './tools-meta';

/** Mirrors ck_assistant_message_refusal in migration 0029. Changing one needs the other. */
type RefusalCode =
  | 'no_tool' | 'not_permitted' | 'forbidden_purpose' | 'too_many_rows'
  | 'invalid_args' | 'timeout' | 'provider_error' | 'disabled';

const MAX_QUESTION = 2000;
const MAX_ROWS_RENDERED = 200;

const DOMAIN_BLURB: Record<Domain, string> = {
  me: 'The asker\'s own record: profile, manager, department, job history, lifecycle milestones, documents on file.',
  leave: 'Leave balances and entitlement, leave requests and their approval, who is off, the holiday calendar.',
  attendance: 'Presence: clock-ins, days present or late or absent, working from home, attendance gaps.',
  work: 'Projects, tasks, effort in minutes, timesheets.',
  people: 'The employee directory, departments, designations, reporting lines, headcount, joiners and leavers.',
  documents: 'Documents on file for an employee - metadata only, never content.',
  cross: 'Questions spanning two areas at once, such as attendance against logged effort, or a full picture of one person over a period.',
  meta: 'What the assistant itself can do, or a question that needs clarifying before it can be answered.',
};

/*
 * PURPOSES THAT ARE REFUSED OUTRIGHT, before any model call.
 *
 * ADR-0014 placed these beyond later decisions and ADR-0020 inherited that limit rather than the
 * power to lift it: no AI input to hiring, promotion, compensation, performance rating,
 * discipline or termination; no productivity or sentiment scoring. ADR-0017 adds that work-log
 * analysis attributed to named individuals is forbidden.
 *
 * BE HONEST ABOUT WHAT THIS IS. A phrase list is a RULE, and this repo prefers a constraint. The
 * constraint is that the catalogue contains no tool that ranks, scores or orders people, no
 * payslip tool, and no narrative work-log content for anyone but its author - so a determined
 * paraphrase that gets past these patterns still has nothing to call. This list exists to give a
 * CLEAR ANSWER ("no, and here is why") rather than a confusing one ("I could not find a tool"),
 * and to make the refusal auditable as `forbidden_purpose` rather than `no_tool`.
 */
const FORBIDDEN_PURPOSE = [
  /\b(rank|ranking|leaderboard|league table|top performer|worst performer)\b/i,
  /\b(most|least)\s+(productive|efficient|hardworking|hard.working)\b/i,
  /\b(productivity|performance)\s+(score|scoring|rating|rank|index)\b/i,
  /\bwho\s+(is|are|was|were)\s+(the\s+)?(under|over)[- ]?perform/i,
  /\b(underperform|under.performing|slacking|slacker)\b/i,
  /\b(should|shall|can)\s+(i|we)\s+(fire|sack|terminate|dismiss|promote|demote)\b/i,
  /\b(fire|sack|terminate|dismiss)\s+(him|her|them|EMP\d+)\b/i,
  /*
   * PAY, IN TWO PARTS - because the first version blocked on the TOPIC, and that was wrong
   * (DEC-142). `salary` alone caught "when is my salary credited?", a question about a
   * payment DATE, and answered it with the full compensation refusal - which reads as an
   * accusation and, worse, files a process question as `forbidden_purpose` so it never reaches
   * the `no_tool` backlog that is meant to tell us what people actually want to ask.
   *
   * The line is AMOUNT-OR-RECORD versus SCHEDULE-OR-PROCESS. `payslip`, `ctc` and `bonus` name a
   * figure whatever the sentence around them says, so they stay a flat block. `salary` and `pay`
   * are topics, and become a compensation request only when the question wants a figure, a
   * structure, or somebody else's.
   *
   * NOTHING IS LOOSENED BY THIS. There is no payslip tool and no payroll-calendar tool, so a
   * pay question that gets through meets an empty catalogue and an honest refusal. ADR-0020
   * s6 is the control - "the catalogue contains no payslip entity" - and this list was never
   * more than a way of giving a clear no instead of a confusing one.
   */
  /\b(payslip|pay slip|ctc|compensation|bonus|increment|appraisal rating)\b/i,
  /\b(salary|salaries|pay)\b[^?.!]{0,40}\b(amount|figure|structure|break[- ]?up|breakdown|net|gross|slip|hike|raise|revision)\b/i,
  /\b(amount|figure|structure|break[- ]?up|breakdown|net|gross|hike|raise|revision)\b[^?.!]{0,40}\b(salary|salaries)\b/i,
  // The lookahead is what lets a DATE question through: "what date is salary credited" asks
  // when, "what is my salary" asks how much, and the words right after the verb are the only
  // difference between them.
  /\b(what|how much|show|tell|list|give|reveal|display)\b(?![^?.!]{0,25}\b(date|day|time|credit|credited|paid)\b)[^?.!]{0,40}\b(salary|salaries)\b/i,
  /\b(salary|salaries|pay)\b[^?.!]{0,30}\b(of|for)\b[^?.!]{0,25}(EMP\d+|everyone|everybody|the team|all staff|all employees|my colleague)/i,
  /\b(everyone|everybody|all)\s*['’]?s?\s+(salary|salaries|pay)\b/i,
  // "how much does X earn", "what does X earn", "what is X paid", "what does X take home".
  // The verb is the signal, not the noun: a question about pay rarely uses the word "salary".
  /\b(how much|what)\b[\w' .]{0,40}\b(earn|earns|earning|make|makes|making|paid|take home|takes home)\b/i,
  /\b(earn|earns|earning|paid|pay|salary)\b[\w' .]{0,20}\bEMP\d+\b/i,
  /\b(sentiment|morale|attitude|engagement score)\s+(of|for|analysis)\b/i,
  /\bwho\s+(earns|makes)\s+(the\s+)?most\b/i,
];

const forbiddenPurpose = (q: string): boolean => FORBIDDEN_PURPOSE.some((re) => re.test(q));

interface Turn {
  conversationId: string;
  messageId: string | null;
  routeDomain: Domain | null;
  toolName: string | null;
  toolArgs: Record<string, unknown> | null;
  refusalCode: RefusalCode | null;
  rowCount: number | null;
  model: string | null;
  promptTokens: number;
  completionTokens: number;
}

@Controller('assistant')
export class AssistantController {
  constructor(
    private readonly db: Db,
    private readonly authz: Authz,
    private readonly llm: Llm,
  ) {}

  /**
   * What can this actor ask about?
   *
   * The honest answer to "what can you see?", which is also why that whole category of probing
   * has no payoff. It is computed from `assertCan`, not from a role check - the same reasoning
   * as `GET /reports`, whose comment is explicit that gating a tab on `hasRole` would be an
   * authorization decision inlined outside `packages/authz`.
   */
  @Get('capabilities')
  @Authenticated()
  async capabilities(@Req() req: Request) {
    const auth = authContext(req);
    const tools = await permittedTools(this.authz, auth);
    const byDomain: Record<string, {
      name: string; description: string; examples: string[]; action: string; resource: string;
      subjectDefault: 'asker' | 'scope';
      relatedPeople: boolean;
    }[]> = {};
    for (const t of tools) {
      (byDomain[t.domain] ??= []).push({
        name: t.name,
        description: t.description,
        examples: [...t.examples],
        // The action and resource this tool REUSES. Published deliberately: it is the actor's
        // own permission shape, which `/reports` already discloses the same way, and it lets the
        // red-team derive each tool's expected row scope from the system rather than from a
        // hardcoded table that would rot the first time a tool changed action.
        action: t.action,
        resource: t.resource,
        subjectDefault: t.subjectDefault ?? 'asker',
        relatedPeople: t.relatedPeople === true,
      });
    }
    return {
      enabled: this.llm.enabled,
      disabledReason: this.llm.disabledReason,
      total: allTools().length,
      available: tools.length,
      domains: byDomain,
    };
  }

  /**
   * Run one named tool, with no model in the loop.
   *
   * THIS IS NOT A BACK DOOR, and the reason is the property the whole design rests on: the model
   * was never a control. Steps 5 to 8 of a turn - re-authorise, compose `scope()`, run, mask -
   * do not care why a tool was chosen, so invoking one directly is exactly as safe as asking a
   * question that selects it. Anything reachable here is reachable through `/ask`.
   *
   * IT EXISTS BECAUSE A SECURITY GATE MUST NOT BE FLAKY. ADR-0020 makes a 100% authorization
   * red-team score the release condition, and a suite that drives a language model cannot give a
   * trustworthy 100%: a passing run would prove the model picked safe tools that day, not that
   * unsafe ones are unreachable. Routing the red-team through this endpoint makes every
   * (tool x role) cell deterministic, and separates the two questions ADR-0020 keeps apart -
   * whether authorization holds, and whether selection is any good.
   *
   * It also means the security suite needs no API key and burns no credits, so it runs on every
   * change rather than when somebody remembers.
   */
  @Post('run')
  @Authenticated()
  async run(@Req() req: Request, @Body() body: { tool?: unknown; args?: unknown }) {
    const actor = currentActor(req);
    const auth = authContext(req);
    const started = Date.now();

    const name = typeof body?.tool === 'string' ? body.tool : '';
    const tool = toolByName(name);
    if (!tool) {
      throw new BadRequestException(`No such tool: ${name || '(none given)'}`);
    }

    const turn: Turn = {
      conversationId: '', messageId: null, routeDomain: null,
      toolName: tool.name, toolArgs: (body?.args as Record<string, unknown>) ?? {},
      refusalCode: null, rowCount: null, model: null, promptTokens: 0, completionTokens: 0,
    };

    const refuse = async (code: RefusalCode, message: string) => {
      turn.refusalCode = code;
      await this.record(actor, auth, `[direct] ${tool.name}`, turn, Date.now() - started)
        .catch((e) => console.error(`[assistant] TRANSCRIPT WRITE FAILED: ${(e as Error)?.message}`));
      return { refusal: { code, message }, columns: [], rows: [], rowCount: 0 };
    };

    // The offer filter, applied here too. A tool the actor could not be offered must not be
    // callable by name - otherwise the filtered catalogue would be the only thing stopping it,
    // and a filtered list is UX rather than a control.
    const permitted = await permittedTools(this.authz, auth, [tool]);
    if (permitted.length === 0) {
      return refuse('not_permitted', 'You do not have access to the records needed for that.');
    }

    const parsed = tool.args.safeParse(body?.args ?? {});
    if (!parsed.success) {
      return refuse('invalid_args', parsed.error.issues.map((i) => i.message).join('; '));
    }

    let scope;
    try {
      scope = await gateTool(this.authz, auth, tool);
    } catch (e) {
      if (isDenied(e)) {
        return refuse('not_permitted', 'You do not have access to the records needed for that.');
      }
      throw e;
    }

    const businessDate = await this.businessDate();
    const result = await tool.run(
      { db: this.db, authz: this.authz, auth, employeeId: actor.employeeId, businessDate, scope },
      parsed.data,
    );

    const masked = this.maskRows(auth, actor.employeeId, tool, result.rows as Record<string, unknown>[]);

    if (masked.length > MAX_ROWS_RENDERED) {
      turn.rowCount = masked.length;
      return refuse('too_many_rows', `${masked.length} rows, more than will be returned at once.`);
    }

    // The same out-of-reach check /ask makes, so this endpoint stays the identical path and the
    // red-team can prove the refusal without driving a model to choose the tool for it.
    if (masked.length === 0) {
      const outOfReach = await this.namedSubjectOutOfReach(
        auth, actor.employeeId, tool, parsed.data as { employeeNumber?: string; nameQuery?: string },
      );
      if (outOfReach) {
        return refuse('not_permitted', `${outOfReach} is outside what your account can see.`);
      }
    }

    const present = new Set<string>();
    for (const row of masked) for (const k of Object.keys(row)) present.add(k);

    turn.rowCount = masked.length;
    await this.record(actor, auth, `[direct] ${tool.name}`, turn, Date.now() - started)
      .catch((e) => console.error(`[assistant] TRANSCRIPT WRITE FAILED: ${(e as Error)?.message}`));

    const columns = result.columns.filter((c) => present.has(c));

    /*
     * The EXACT text a real turn would send to the provider for this result.
     *
     * Published here because DEC-140 made "what leaves the country" a property that can rot
     * silently, and a property nothing checks is a promise. Built by the same function `/ask`
     * calls, from the same masked rows, so the red-team can assert model-free that the payload
     * carries no employee outside the caller's reach and no banned column - the same invariants
     * section 1 and section 4 of that suite already prove about `rows`.
     *
     * It discloses nothing: it is a serialisation of `rows`, three lines above, to the same
     * authenticated caller who just received them.
     */
    const modelPayload = buildAnswerPayload({
      question: `[direct] ${tool.name}`,
      toolName: tool.name,
      columns,
      rows: masked,
      note: result.note ?? null,
      businessDate,
    });

    const coverage = this.coverageNote(tool, actor.employeeId, masked);

    return {
      refusal: null,
      tool: tool.name,
      columns,
      rows: masked,
      rowCount: masked.length,
      note: [result.note, coverage].filter(Boolean).join(' ') || null,
      modelPayload: {
        answerFromRows: this.llm.answerFromRows,
        system: ANSWER_SYSTEM_PROMPT,
        user: modelPayload.user,
        rowsSent: modelPayload.rowsSent,
        rowsOmitted: modelPayload.rowsOmitted,
      },
    };
  }

  /**
   * One turn, streamed.
   *
   * SSE rather than a single response because a turn makes three model calls and the wait is
   * otherwise unexplained. This is the first streaming path in the codebase.
   */
  @Post('ask')
  @Authenticated()
  async ask(@Req() req: Request, @Res() res: Response, @Body() body: { question?: unknown; conversationId?: unknown }) {
    const actor = currentActor(req);
    const auth = authContext(req);

    const question = typeof body?.question === 'string' ? body.question.trim() : '';
    if (question.length < 1 || question.length > MAX_QUESTION) {
      throw new BadRequestException(`A question must be between 1 and ${MAX_QUESTION} characters.`);
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');   // nginx must not buffer an event stream
    res.flushHeaders?.();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const started = Date.now();
    const turn: Turn = {
      conversationId: '',
      messageId: null,
      routeDomain: null,
      toolName: null,
      toolArgs: null,
      refusalCode: null,
      rowCount: null,
      model: null,
      promptTokens: 0,
      completionTokens: 0,
    };

    const finish = async (refusal: { code: RefusalCode; message: string } | null) => {
      if (refusal) {
        turn.refusalCode = refusal.code;
        send('refusal', { code: refusal.code, message: refusal.message });
      }
      try {
        await this.record(actor, auth, question, turn, Date.now() - started);
      } catch (e) {
        // An audit or transcript failure must not become a user-visible failure - the same rule
        // `authz.ts` applies to its audit sink. It is logged loudly instead.
        console.error(`[assistant] TRANSCRIPT WRITE FAILED: ${(e as Error)?.message}`);
      }
      send('done', { latencyMs: Date.now() - started });
      res.end();
    };

    try {
      /*
       * ---- 0. purposes that are refused before anything else -------------
       *
       * BEFORE the enabled check, deliberately. "The assistant is switched off" implies it might
       * work later; these limits never lift, and ADR-0014 put them beyond any later decision. A
       * permanent no should read as one.
       *
       * Being first also means this refusal costs no model call and can be proven without an API
       * key, so the red-team asserts it on every run rather than only when a key is configured.
       */
      if (forbiddenPurpose(question)) {
        return await finish({
          code: 'forbidden_purpose',
          message:
            'No. This assistant has no access to pay, and will not rank, score or compare ' +
            'people or feed a decision about hiring, promotion, discipline or termination. ' +
            'That is a fixed limit, not a permissions problem.',
        });
      }

      // ---- 1. is the feature on at all -----------------------------------
      if (!this.llm.enabled) {
        return await finish({
          code: 'disabled',
          message: 'The assistant is switched off for this deployment.',
        });
      }

      // ---- 2. which tools may this actor use -----------------------------
      send('status', { stage: 'thinking' });
      const permitted = await permittedTools(this.authz, auth);
      if (permitted.length === 0) {
        return await finish({
          code: 'not_permitted',
          message: 'Your account holds no records the assistant can read.',
        });
      }

      const businessDate = await this.businessDate();

      // ---- 3. route ------------------------------------------------------
      const domain = await this.route(question, permitted);
      turn.routeDomain = domain;
      send('status', { stage: 'routing', domain });

      // ---- 4. select -----------------------------------------------------
      // A null domain means the router declined to narrow - use everything this actor may call.
      const candidates = domain === null
        ? permitted
        : permitted.filter((t) => t.domain === domain || t.domain === 'cross');
      const pool = candidates.length > 0 ? candidates : permitted;

      const selection = await this.llm.chat({
        messages: [
          { role: 'system', content: this.selectSystemPrompt(businessDate) },
          { role: 'user', content: question },
        ],
        tools: pool.map(toSchema),
        requireTool: false,
        maxTokens: 300,
      });
      turn.model = selection.model;
      turn.promptTokens += selection.promptTokens;
      turn.completionTokens += selection.completionTokens;

      if (!selection.toolName) {
        return await finish({
          code: 'no_tool',
          message:
            'That is outside what this assistant can answer. It covers leave, attendance and ' +
            'your own employment record. Ask "what can you help me with?" for the list.',
        });
      }

      // ---- 5. the selection is untrusted input ---------------------------
      const tool = toolByName(selection.toolName);
      if (!tool) {
        return await finish({
          code: 'no_tool',
          message: 'That could not be matched to anything the assistant can look up.',
        });
      }
      turn.toolName = tool.name;
      turn.toolArgs = selection.toolArgs ?? {};

      if (!permitted.some((t) => t.name === tool.name)) {
        // The model named a tool outside the filtered list. Not reachable through the API as
        // written, and refused anyway - step 1 is an affordance, this is the control.
        return await finish({
          code: 'not_permitted',
          message: 'You do not have access to the records needed to answer that.',
        });
      }

      const parsed = tool.args.safeParse(selection.toolArgs ?? {});
      if (!parsed.success) {
        return await finish({
          code: 'invalid_args',
          message:
            'The dates in that question were not clear. Try naming them, for example ' +
            '2026-08-01 to 2026-08-31.',
        });
      }

      send('tool', { name: tool.name, domain: tool.domain });

      // ---- 6. authorise again, and get the row filter --------------------
      let scope;
      try {
        scope = await gateTool(this.authz, auth, tool);
      } catch (e) {
        if (isDenied(e)) {
          return await finish({
            code: 'not_permitted',
            message: 'You do not have access to the records needed to answer that.',
          });
        }
        throw e;
      }

      // ---- 7. run --------------------------------------------------------
      const result: ToolResult = await tool.run(
        {
          db: this.db,
          authz: this.authz,
          auth,
          employeeId: actor.employeeId,
          businessDate,
          scope,
        },
        parsed.data,
      );

      /*
       * ---- 8. mask, ALWAYS AS A LIST ------------------------------------
       *
       * `inList: true` even when one row comes back. `neverInList` exists to stop bulk
       * exfiltration through a collection response, and an assistant answer is collection-shaped
       * by nature: it is machine-composed, lands in a panel and gets copied. Treating a
       * single-row answer as a detail view would make "search for one person, read their address"
       * the way around the flag. Being wrong this way costs a missing column.
       */
      const masked = this.maskRows(auth, actor.employeeId, tool, result.rows as Record<string, unknown>[]);

      if (masked.length > MAX_ROWS_RENDERED) {
        turn.rowCount = masked.length;
        return await finish({
          code: 'too_many_rows',
          message:
            `That matches ${masked.length} records - too many for one answer. Narrow it to one ` +
            'person, one leave type, or a shorter period.',
        });
      }

      // A column survives only if the mask left it on at least one row.
      const present = new Set<string>();
      for (const row of masked) for (const k of Object.keys(row)) present.add(k);
      const columns = result.columns.filter((c) => present.has(c));

      /*
       * ---- 8b. EMPTY, OR OUT OF REACH? ----------------------------------
       *
       * `whoClause` is an AND on top of the scope predicate, so naming somebody the asker may
       * not see returns NO ROWS - deliberately, and the comment there says so: "the same answer
       * as a person with no data". That is right for the query and wrong for the sentence. An
       * employee asking about a colleague was told "nothing matched that", which reads as a
       * statement about the colleague rather than about their own permissions (DEC-142).
       *
       * NOT AN ENUMERATION ORACLE, and that is the only reason naming the person back is
       * allowed. `people.employee.read` is scope ALLOW_ALL by policy - "the directory is
       * PUBLIC_INTERNAL; the FIELD MASK is what keeps personal data out of it, not the row
       * filter" - so every employee can already look Priya up in /employees. Confirming she
       * exists discloses nothing; her leave balance still does not appear.
       */
      if (masked.length === 0) {
        const outOfReach = await this.namedSubjectOutOfReach(
          auth, actor.employeeId, tool, parsed.data as { employeeNumber?: string; nameQuery?: string },
        );
        if (outOfReach) {
          return await finish({
            code: 'not_permitted',
            message: `No. ${outOfReach} is outside what your account can see.`,
          });
        }
      }

      // The tool's own note first (k-suppression, an applied default), then who the answer
      // covers. Both reach the browser, and both reach the model as a note it must convey.
      const coverage = this.coverageNote(tool, actor.employeeId, masked);
      const note = [result.note, coverage].filter(Boolean).join(' ') || null;

      turn.rowCount = masked.length;
      send('rows', {
        columns,
        rows: masked,
        note,
        rowCount: masked.length,
      });

      // ---- 9. answer, from the masked rows -------------------------------
      //
      // AFTER the table has been sent, deliberately. The rows are already on their way to the
      // browser, so this call can only add a sentence: it cannot alter, delay or suppress the
      // data, and if it fails the user still has their answer in table form.
      const sentence = await this.answer(
        question, tool, columns, masked, note ?? undefined, businessDate,
        (text) => send('token', { text }),
      );
      // Only for the paths that did NOT stream - a streamed answer has already been sent, one
      // fragment per event, and re-sending it whole would duplicate it on screen.
      if (sentence.text) send('token', { text: sentence.text });
      turn.promptTokens += sentence.promptTokens;
      turn.completionTokens += sentence.completionTokens;

      return await finish(null);
    } catch (e) {
      if (e instanceof LlmUnavailable) {
        const code: RefusalCode = e.code === 'disabled' ? 'disabled'
          : e.code === 'timeout' ? 'timeout' : 'provider_error';
        return await finish({ code, message: e.message });
      }
      // Postgres driver detail is stripped from the response AND the log line
      // (architecture-principles.md: fail closed, and never leak `detail`/`hint`/`constraint`).
      console.error(`[assistant] turn failed: ${(e as Error)?.name ?? 'unknown'}`);
      return await finish({
        code: 'provider_error',
        message: 'Something went wrong. Nothing was changed.',
      });
    }
  }

  // -------------------------------------------------------------------------

  /**
   * Say WHO an answer covers, when the question could have been about more people than the
   * asker can see.
   *
   * THE BUG THIS FIXES IS SILENCE, NOT A LEAK. An employee asked "September attendance for all
   * employees" and got one row - their own - with nothing saying why. `scope()` had done exactly
   * its job; the answer was simply not the answer to the question asked, and nothing said so.
   * That is the same family as DEC-142 (a person out of reach reported as "nothing matched") and
   * DEC-144 (the wrong subject entirely): an authorization outcome presented as a fact about the
   * data.
   *
   * IT IS A NOTE, NOT A REFUSAL. Refusing would be wrong - a manager asking the same question
   * has a legitimate partial answer, and the instruction was to make the assistant work per role
   * rather than block. So the answer stands and gains a sentence about its own coverage, which
   * the model is required to convey ("Note that must be conveyed" in the answer payload).
   *
   * DERIVED FROM THE RESULT, not from the policy. Counting the distinct people actually returned
   * is accurate by construction, needs no second query and no reading of scope internals, and
   * stays right if a policy changes underneath it.
   *
   * Only for `subjectDefault: 'scope'` tools. A self-defaulting tool was never about anybody
   * else, so this would be noise on every "what is my leave balance".
   */
  private coverageNote(
    tool: ToolSpec,
    actorEmployeeId: string,
    rows: readonly Record<string, unknown>[],
  ): string | null {
    if (tool.subjectDefault !== 'scope') return null;

    const people = new Set<string>();
    for (const row of rows) {
      if (typeof row.employee_id === 'string') people.add(row.employee_id);
    }
    // A tool with no person dimension at all - the holiday calendar, the department tree.
    if (people.size === 0) return null;

    if (people.size === 1 && people.has(actorEmployeeId)) {
      return 'This covers your own records only. Your account does not have access to ' +
        'records for other people, so a question about everybody is answered about you.';
    }
    return 'This covers the ' + people.size + ' people your account has access to, which may ' +
      'be fewer than the whole organisation.';
  }

  /**
   * Apply the field mask, as a LIST for every tool but a self-only one.
   *
   * DEC-137 made every assistant answer a list mask, on the reasoning that an answer is
   * collection-shaped whatever its size - machine-composed, dropped into a panel, copied - so
   * treating a one-row result as a detail view would make "ask for one person by name, read
   * their address" the documented way around `neverInList`. That reasoning holds wherever a
   * tool can be POINTED at somebody.
   *
   * A `selfOnly` tool cannot be (DEC-143). It takes no person argument, and its SQL filters on
   * `ctx.employeeId` on top of `scope()`. The filter below is a second, independent guarantee:
   * a row whose subject is not the caller is DROPPED rather than masked, so a mistake in a
   * tool's WHERE clause degrades to an empty answer instead of an unmasked read of somebody
   * else. Only then is `inList: false` applied, and only to the caller's own row.
   */
  private maskRows(
    auth: AuthContext,
    actorEmployeeId: string,
    tool: ToolSpec,
    rows: readonly Record<string, unknown>[],
  ): Record<string, unknown>[] {
    const subjectOf = (row: Record<string, unknown>): string | null =>
      (typeof row.employee_id === 'string' ? row.employee_id : null);

    if (!tool.selfOnly) {
      return this.authz.maskList(
        auth, tool.resource, rows as Record<string, unknown>[], subjectOf,
      ) as Record<string, unknown>[];
    }

    return rows
      .filter((row) => subjectOf(row) === actorEmployeeId)
      .map((row) => this.authz.maskRow(auth, tool.resource, row, {
        isSubject: true,
        inList: false,
      }) as Record<string, unknown>);
  }

  /**
   * Who did the question name, and may this actor read THAT PERSON for THIS tool?
   *
   * Two authorization questions, both asked through `AuthorizationService` and neither inlined:
   *
   *   1. May the caller read the directory at all, and which rows - so the name is resolved
   *      inside the same predicate every other directory read uses, not by a free lookup.
   *   2. May the caller read this tool's resource FOR THAT SUBJECT - which is exactly the
   *      question the refusal is about, and the same probe shape `permittedTools` uses
   *      (DEC-061), only with somebody else as the subject instead of the caller.
   *
   * Returns the person's name when they are real and out of reach, and `null` in every other
   * case - including an AMBIGUOUS fragment, where guessing which "Priya" was meant would be
   * worse than saying nothing. A `null` leaves the ordinary empty-result path alone, so this
   * can only ever turn a misleading answer into an accurate one; it cannot invent a refusal.
   */
  private async namedSubjectOutOfReach(
    auth: AuthContext,
    actorEmployeeId: string,
    tool: ToolSpec,
    args: { employeeNumber?: string; nameQuery?: string },
  ): Promise<string | null> {
    if (!args.employeeNumber && !args.nameQuery) return null;

    const dirRef = { type: 'employee' as const, subjectEmployeeId: auth.employeeId ?? undefined };
    const canRead = await this.authz.can(auth, 'people.employee.read', dirRef);
    if (!canRead.allowed) return null;

    const predicate = this.authz.scope(auth, 'people.employee.read', dirRef);
    if (predicate.kind === 'none') return null;

    const who = whoClauseAnyone(args, 'e', 1);
    const scope = predicate.render('e', 1 + who.params.length);

    const found = await this.db.rows<{ id: string; full_name: string }>(
      'SELECT e.id, e.full_name FROM employee e WHERE ' + who.sql +
      ' AND ' + scope.sql + ' ORDER BY e.employee_number LIMIT 2',
      [...who.params, ...scope.params],
    );

    if (found.length !== 1) return null;
    const subject = found[0]!;
    if (subject.id === actorEmployeeId) return null;

    const decision = await this.authz.can(auth, tool.action, {
      type: tool.resource,
      subjectEmployeeId: subject.id,
      ...(tool.resource === 'employee_document' ? { dataClass: 'PERSONAL' as const } : {}),
    });
    return decision.allowed ? null : subject.full_name;
  }

  private async businessDate(): Promise<string> {
    const row = await this.db.one<{ d: string }>(`SELECT fn_business_date()::text AS d`);
    return row!.d;
  }

  /**
   * Stage one: narrow ~50 tools to one domain.
   *
   * DEC-127. Flat-listing the whole catalogue measurably degrades selection on a small model,
   * and the failure is silent. When the actor's own filtered catalogue is already small the
   * router earns nothing, so it is skipped - which is most employees.
   */
  private async route(
    question: string,
    permitted: readonly ToolSpec[],
  ): Promise<Domain | null> {
    const present = [...new Set(permitted.map((t) => t.domain))];
    if (present.length <= 1) return present[0] ?? null;
    // Small enough to select over directly. NULL means "do not narrow" - returning the first
    // domain here narrowed to it, which is the opposite of what this line intends.
    if (permitted.length <= 12) return null;

    const lines = present.map((d) => `- ${d}: ${DOMAIN_BLURB[d]}`).join('\n');
    const res = await this.llm.chat({
      messages: [
        {
          role: 'system',
          content:
            'Classify the user\'s HR question into exactly one area. Reply with the area name ' +
            'alone, nothing else.\n\n' + lines,
        },
        { role: 'user', content: question },
      ],
      maxTokens: 8,
    });

    const guess = (res.content ?? '').trim().toLowerCase().replace(/[^a-z]/g, '');
    const hit = present.find((d) => d === guess);

    /*
     * An unrecognised answer must not narrow anything - the widest pool, rather than silently
     * dropping every tool outside a domain the model invented.
     *
     * THAT IS WHAT THIS COMMENT ALREADY SAID, AND THE CODE DID THE OPPOSITE (DEC-158): it
     * returned `present[0]`, which is whichever domain the FIRST registered tool belongs to -
     * `me`, because `tools-me` is imported first. So any router reply the parser could not match
     * exactly - "the people area", a translated word, a trailing sentence - quietly restricted
     * selection to the asker's own record, and "list the employees" was answered by a tool that
     * cannot list employees. Returning null is the fix, and the caller treats it as "use all".
     */
    return hit ?? null;
  }

  private selectSystemPrompt(businessDate: string): string {
    return [
      'You help employees of Panasa Technology look up their own HR records.',
      `Today is ${businessDate}. Resolve every relative date ("this month", "last week",`,
      '"next Monday") against that date and pass explicit YYYY-MM-DD values.',
      '',
      'Choose exactly one tool. If no tool fits the question, choose none - do not force one.',
      'Never invent an employee number. If the question names a person without a number, pass',
      'the name in nameQuery and let the system resolve it.',
      '',
      'You cannot change anything: there is no tool that applies for leave, approves anything,',
      'or edits a record. If asked to do something like that, choose no tool.',
      '',
      'You have no access to pay, salary or compensation, and there is no tool that ranks,',
      'scores or compares people. Choose no tool for such questions.',
    ].join('\n');
  }

  /**
   * Stage three: the answer, in words, written from the MASKED ROWS.
   *
   * The rows passed in are `maskList`'s output - the identical array `send('rows', ...)` has
   * already streamed to the browser. That equality is the security argument, not a coincidence:
   * pass a pre-mask or wider set here and the containment described in `answer.ts` is gone, so
   * this method takes the masked array and never re-queries.
   *
   * NO TOOLS ON THIS CALL. `chat` is invoked without a `tools` array, so the model at this step
   * can produce text and nothing else. It is why a value that contains an instruction can, at
   * worst, corrupt a sentence.
   *
   * A failure here is not a failed turn. The table has already been sent, and the deterministic
   * sentence takes over - which is also the pre-DEC-140 posture an operator gets by setting
   * `HRM_LLM_ANSWER_FROM_ROWS=false`.
   */
  private async answer(
    question: string,
    tool: ToolSpec,
    columns: readonly string[],
    rows: readonly Record<string, unknown>[],
    note: string | undefined,
    businessDate: string,
    onToken: (text: string) => void,
  ): Promise<{ text: string | null; promptTokens: number; completionTokens: number }> {
    if (!this.llm.answerFromRows) {
      return {
        text: deterministicSentence(rows.length, 'disabled'),
        promptTokens: 0,
        completionTokens: 0,
      };
    }

    const payload = buildAnswerPayload({
      question,
      toolName: tool.name,
      columns,
      rows,
      note: note ?? null,
      businessDate,
    });

    let streamed = false;
    try {
      const res = await this.llm.chat({
        messages: [
          { role: 'system', content: ANSWER_SYSTEM_PROMPT },
          { role: 'user', content: payload.user },
        ],
        maxTokens: 320,
        onDelta: (text) => { streamed = true; onToken(text); },
      });

      // Already on screen, fragment by fragment. Returning the text as well would print it twice.
      if (streamed) {
        return { text: null, promptTokens: res.promptTokens, completionTokens: res.completionTokens };
      }
      return {
        text: res.content?.trim() || deterministicSentence(rows.length, 'failed'),
        promptTokens: res.promptTokens,
        completionTokens: res.completionTokens,
      };
    } catch {
      // BROKE MID-SENTENCE. The user is looking at half an answer, and silence would leave them
      // reading it as a whole one. An ellipsis is the smallest honest marker; the refusal path is
      // not used because the turn did produce a partial answer and did not fail.
      if (streamed) {
        onToken(' …');
        return { text: null, promptTokens: 0, completionTokens: 0 };
      }
      return {
        text: deterministicSentence(rows.length, 'failed'),
        promptTokens: 0,
        completionTokens: 0,
      };
    }
  }

  /**
   * Transcript + audit, in one transaction.
   *
   * NO RESULT ROW IS WRITTEN. Migration 0029 has no column that could hold one and its check A7
   * enumerates the column list so that adding one fails. DEC-133 has the reasoning.
   */
  private async record(
    actor: ReturnType<typeof currentActor>,
    auth: AuthContext,
    question: string,
    turn: Turn,
    latencyMs: number,
  ): Promise<void> {
    await this.db.tx(async (q) => {
      const conv = await q(
        `INSERT INTO assistant_conversation (user_id, employee_id, locale)
         VALUES ($1, $2, 'en')
         RETURNING id`,
        [actor.userId, actor.employeeId ?? null]);
      const conversationId = conv[0].id as string;

      const msg = await q(
        `INSERT INTO assistant_message
             (conversation_id, seq, question_text, route_domain, tool_name, tool_args,
              refusal_code, row_count, model, prompt_tokens, completion_tokens, latency_ms)
         VALUES ($1, 1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
        [
          conversationId,
          question.slice(0, MAX_QUESTION),
          turn.routeDomain,
          turn.toolName,
          turn.toolArgs ? JSON.stringify(turn.toolArgs).slice(0, 2000) : null,
          turn.refusalCode,
          turn.rowCount,
          turn.model,
          turn.promptTokens,
          turn.completionTokens,
          latencyMs,
        ]);
      const messageId = msg[0].id as string;

      const tool = turn.toolName ? toolByName(turn.toolName) : undefined;

      // `reason` is the action plus a closed-set code, never a data value - the same contract
      // `authz.ts` uses for its deny rows. The question text is NOT audited: audit_event has
      // decade retention and no selective erasure, and the transcript has a 90-day window.
      await q(
        `SELECT fn_audit_assistant($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, $10)`,
        [
          'assistant.query',
          messageId,
          actor.userId,
          actor.employeeId ?? null,
          actor.employeeId ?? null,
          tool?.resource ?? null,
          actor.sessionId ?? null,
          auth.correlationId ?? null,
          turn.refusalCode
            ? `assistant.refuse:${turn.refusalCode}`
            : `assistant.query:${turn.toolName ?? 'none'}`,
          actor.roles,
        ]);
    });
  }
}

const toSchema = (t: ToolSpec): ToolSchema => ({
  name: t.name,
  // The examples go to the model. They are the single biggest lever on whether the right tool
  // gets picked, which is why they live on the spec rather than in a prompt somewhere.
  description: `${t.description}\nExample questions: ${t.examples.join(' | ')}`,
  parameters: t.parameters,
});

@Module({ controllers: [AssistantController], providers: [Llm] })
export class AssistantModule {}

export { DOMAINS };
