/**
 * The tool catalogue contract. ADR-0020.
 *
 * A TOOL IS NOT AN ENDPOINT. It has no route, and it adds no permission: every tool declares an
 * action that already exists, and that action is the one the equivalent SCREEN uses. This is the
 * principle `reports.ts` established and the reason the assistant cannot out-reach the product
 * around it:
 *
 *   "each report REUSES the resource action it reports on ... A report can therefore never
 *    reveal more than the equivalent detail screen, and it inherits the policy that is already
 *    tested by 385 matrix assertions rather than needing its own."
 *
 * Two permission sets over the same data drift apart, and the day they do the assistant shows
 * what the screen refuses - which is the worst direction for the mistake to go, because the
 * assistant is on every page and takes free text.
 *
 * AUTHORIZATION IS RESOLVED TWICE, and neither is the model's business:
 *
 *   1. Before the model sees the catalogue, `assertCan` filters it. An actor is never OFFERED a
 *      tool they cannot call, so the commonest failure is a refusal rather than a denial.
 *   2. On execution, `assertCan` runs AGAIN. The model's choice is untrusted input - it is
 *      derived from text a user typed - and a filtered list is a UX affordance, not a control.
 *
 * Rows are then filtered by `scope()` composed INTO the SQL, never applied to a result set.
 * ADR-0005: filtering afterwards "still leaks via counts, pagination totals and timing".
 */

import type { Action, AuthContext, ResourceType } from '@panasa/authz';
import { AuthzDeniedError } from '@panasa/authz';
import { z } from 'zod';
import type { Db } from '../db';
import type { Authz } from '../authz';

/**
 * The nine routing domains. MIRRORS `ck_assistant_message_domain`, which is a closed set.
 *
 * The constraint arrived in the migration originally numbered 0029 and now numbered 0035
 * (DEC-167 - it was renamed to resolve a merge collision and the database row was relabelled to
 * match); `onboarding` was added by migration 0036 and `pay` by 0037 (ADR-0021).
 *
 * THE TWO LISTS MUST MOVE TOGETHER, and the failure mode if they do not is the worst available:
 * the transcript INSERT happens at the END of a turn, so a domain the router can reach but the
 * constraint rejects answers the user first and fails the audit row afterwards.
 */
export const DOMAINS = ['me', 'leave', 'attendance', 'work', 'people', 'documents', 'cross',
  'onboarding', 'pay'] as const;
export type Domain = (typeof DOMAINS)[number] | 'meta';

/**
 * ADR-0017 amendment (d): minimum group size for any aggregate that crosses an individual
 * boundary. "Below that the query returns suppressed rather than a number. Without a threshold,
 * 'de-identified' is a label rather than a property."
 */
export const K_ANONYMITY = 5;

export interface ToolResult {
  /** Ordered column keys, so rendering is deterministic and does not depend on key order. */
  readonly columns: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
  /** Shown above the table. Used for k-suppression and for stating an applied default. */
  readonly note?: string;
  /**
   * THIS RESULT IS ABOUT PERMISSIONS, NOT ABOUT DATA. The controller refuses the turn with this
   * exact text - `not_permitted`, no model call - instead of asking a model to write a sentence
   * about an empty table.
   *
   * IT EXISTS BECAUSE A NOTE WAS NOT ENOUGH (DEC-170). An employee asked "is any onboarding
   * pending?", which they hold no grant to ask, and the reply was **"I have nothing for
   * onboarding pending."** above a correct note explaining they cannot see onboarding. Two
   * problems, and the second is the real one:
   *
   *   1. The note is rendered as secondary text, and the sentence above it is what people read.
   *   2. A MODEL WAS BEING ASKED TO WRITE THE SENTENCE AT ALL. Whether an answer is about data
   *      or about permissions is not a judgement to delegate - it is known, exactly, before any
   *      prompt is built. DEC-142(b) already established the right shape for the sibling case:
   *      a named person out of reach becomes a deterministic refusal, which is why "Priya Menon
   *      is outside what your account can see" has always read correctly.
   *
   * So this is the same device, moved to where a TOOL can reach it: the tool knows the topic was
   * refused, and says so, rather than encoding it in rows a model then paraphrases. Every tool
   * remains a SELECT and nothing here grants a tool the power to refuse an action - the
   * authorization decision has already happened in `gateTool`; this only decides how the outcome
   * is worded.
   */
  readonly notPermitted?: string;
  /**
   * THE ANSWER, WRITTEN BY OUR OWN CODE. When set, the controller sends this as the reply and
   * **never builds an answer payload or calls the provider for this turn**.
   *
   * ADR-0021 SECTION 2 IS THE WHOLE REASON IT EXISTS. The assistant may now report pay, on one
   * condition: *"NO PAY FIGURE IS SENT TO A MODEL PROVIDER."* DEC-140 composes answers FROM the
   * masked row values, which are transmitted to `gpt-4o-mini` outside India - ADR-0020 section 3
   * names `question_text` as *"the only column in this database transmitted outside India"*, and
   * a salary must not become the second. So a tool carrying money writes its own sentence and
   * the figure goes from PostgreSQL to the authenticated caller's browser and nowhere else.
   *
   * THE ABSENCE OF `modelPayload` IS THE CHECKABLE FORM OF THAT PROMISE, which is why the
   * controller skips the payload rather than building one and discarding it: the red team
   * asserts a money tool produced no payload at all, so the guarantee is a property of the code
   * rather than a claim in a comment.
   *
   * THE COST IS REAL AND WAS ACCEPTED: these sentences are hand-written and read flatter than
   * model prose, and they need maintaining as columns change. For a compensation figure,
   * deterministic and plain beats fluent and paraphrased - a model cannot round, soften or
   * invent what it never receives.
   *
   * A tool sets EITHER this or nothing. It is not a fallback for a failed model call; that is
   * `deterministicSentence`, which reports a degraded mode and says so.
   */
  readonly sentence?: string;
}

export interface ToolCtx {
  readonly db: Db;
  readonly authz: Authz;
  readonly auth: AuthContext;
  readonly employeeId: string;
  /** Always the SERVER's date. A client computing "today" is wrong for 5.5h a day (DEC-091). */
  readonly businessDate: string;
  /**
   * The row filter for THIS tool's action and resource, already rendered.
   * `null` means the policy admits this actor to no rows - the caller returns empty rather
   * than an unfiltered set, exactly as `reports.ts` does with `predicate.kind === 'none'`.
   */
  readonly scope: (alias: string, firstParam: number) => { sql: string; params: unknown[] } | null;
}

export interface ToolSpec<A extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly name: string;
  readonly domain: Domain;
  /** Written for the MODEL. Selection quality is the product here. */
  readonly description: string;
  /** Real phrasings. The single biggest lever on whether the right tool gets picked. */
  readonly examples: readonly string[];
  readonly action: Action;
  readonly resource: ResourceType;
  /**
   * A tool that can only ever be about the ASKER, and takes no argument naming anybody.
   *
   * It buys one thing (DEC-143): the answer is masked with `inList: false`, so the fields the
   * registry marks `neverInList` - personal phone, date of birth, home address - come back.
   * DEC-137 set `inList: true` for every tool because an assistant answer is collection-shaped
   * and "search for one person, read their address" must not become a one-sentence operation.
   * That reasoning is about SEARCH, and a tool with no person argument cannot search: its WHERE
   * clause pins the subject to the caller, and the controller additionally drops any row that is
   * not theirs. So the exfiltration path DEC-137 closed stays closed, and an employee stops being
   * told "nothing matched" when they ask for their own phone number.
   *
   * The bar for setting this is exact: NO argument that names a person, and SQL that filters on
   * `ctx.employeeId` in addition to - never instead of - `scope()`.
   */
  /**
   * THIS TOOL CARRIES A COMPENSATION FIGURE. ADR-0021 section 2.
   *
   * It is a property of the TOOL and deliberately not of its routing domain, which was the first
   * design and was wrong twice over. `onboarding_annexure_amounts` had to move from `pay` to
   * `cross` to be reachable (see its own comment), and a guarantee that moved with a ROUTING
   * LABEL was a guarantee resting on the wrong thing entirely - the question "may this figure
   * reach a provider?" has nothing to do with which blurb the router matched.
   *
   * Two things key off it, and between them they make ADR-0021 section 2 structural:
   *
   *   1. The controller REFUSES a money tool that produced no `sentence`, rather than falling
   *      through to the answer path. So the only way for a money tool to answer is to write its
   *      own sentence; forgetting to is a loud refusal, not a silent transmission.
   *   2. `/assistant/capabilities` publishes it, and the red team asserts that every tool
   *      declaring it produced NO `modelPayload`, at every role.
   */
  readonly money?: true;
  readonly selfOnly?: boolean;
  /**
   * What a question that names NOBODY means for this tool.
   *
   *   'asker'  (default) - it is about the caller. "What is my leave balance?"
   *   'scope'            - it covers everyone the caller may see. "Who is off next week?"
   *
   * THIS IS THE BUG DEC-144 FIXES, and it was invisible for the narrowest role. `whoClause`
   * used to add NO filter when no person was named, leaving `scope()` to decide - which for an
   * employee is themselves, so "my leave balance" worked, and for an hr_admin is the whole
   * organisation, so the same question returned ten rows and the model reported the FIRST one as
   * "your balance". Deepa was told she had 8 days of casual leave. Vishnu has 8; she has 12.
   *
   * Not an authorization failure - every row was one she may read - which is exactly why nothing
   * caught it. It is a wrong answer about the asker themselves, and the default is now 'asker'
   * so that forgetting to think about this fails towards too little rather than too much.
   */
  readonly subjectDefault?: 'asker' | 'scope';
  /**
   * The rows describe people OTHER than the subject, by design - a reporting line, an
   * approval chain. The question is still about the asker; the answer is the people around
   * them.
   *
   * It exists so the DEC-144 check can tell the two cases apart. "Nobody else's rows may
   * appear" is the right assertion for a balance or an attendance day, and wrong for
   * "who do I report to", where a colleague appearing is the whole point. Without the
   * distinction the suite would have to be weakened for every tool to accommodate one.
   */
  readonly relatedPeople?: boolean;
  readonly args: A;
  /** JSON Schema handed to the model. Hand-written: zod-to-json-schema is a dependency. */
  readonly parameters: Record<string, unknown>;
  readonly run: (ctx: ToolCtx, args: z.infer<A>) => Promise<ToolResult>;
}

/** Every tool, keyed by name. Populated by the domain modules. */
const REGISTRY = new Map<string, ToolSpec>();

export function defineTool<A extends z.ZodTypeAny>(spec: ToolSpec<A>): void {
  if (REGISTRY.has(spec.name)) {
    throw new Error(`duplicate assistant tool: ${spec.name}`);
  }
  REGISTRY.set(spec.name, spec as unknown as ToolSpec);
}

export const allTools = (): readonly ToolSpec[] => [...REGISTRY.values()];
export const toolByName = (name: string): ToolSpec | undefined => REGISTRY.get(name);

/**
 * Which tools may this actor use at all?
 *
 * The subject on the ref is THE CALLER, and that is not a shortcut - it is DEC-061, learned when
 * an employee's own attendance report returned 404. The two questions are different:
 *
 *   assertCan  MAY YOU READ THIS RESOURCE TYPE AT ALL - asked about the one subject every caller
 *              is certainly entitled to, themselves
 *   scope      WHOSE ROWS - where an employee narrows to self, a manager to their subtree and HR
 *              to the organisation
 *
 * Asking with the caller as subject widens nothing: a role that cannot read its OWN leave is
 * refused outright, and `finance` and `auditor`, which hold no leave grant, are refused here.
 */
export async function permittedTools(
  authz: Authz,
  auth: AuthContext,
  tools: readonly ToolSpec[] = allTools(),
): Promise<ToolSpec[]> {
  const out: ToolSpec[] = [];
  for (const t of tools) {
    const decision = await authz.can(auth, t.action, {
      type: t.resource,
      subjectEmployeeId: auth.employeeId ?? undefined,
      // Documents discriminate on classification, and an ABSENT dataClass is treated as
      // RESTRICTED - so a document tool would read as denied without this.
      ...(t.resource === 'employee_document' ? { dataClass: 'PERSONAL' as const } : {}),
    });
    if (decision.allowed) out.push(t);
  }
  return out;
}

/**
 * Authorise one tool and hand back its row filter.
 *
 * Returns the RENDERED predicate rather than rows, so the caller cannot accidentally
 * fetch-then-filter: there is nothing to filter, only a predicate to put in a WHERE clause.
 * Copied deliberately from `reports.ts` `gate()` rather than reinvented.
 *
 * Throws `AuthzDeniedError` when the actor may not use the tool at all.
 */
export async function gateTool(
  authz: Authz,
  auth: AuthContext,
  tool: ToolSpec,
  opts: { asOf?: string } = {},
): Promise<ToolCtx['scope']> {
  const ref = {
    type: tool.resource,
    subjectEmployeeId: auth.employeeId ?? undefined,
    ...(opts.asOf ? { asOf: opts.asOf } : {}),
    ...(tool.resource === 'employee_document' ? { dataClass: 'PERSONAL' as const } : {}),
  };

  await authz.assertCan(auth, tool.action, ref, { notFoundOnDeny: false });

  const predicate = authz.scope(auth, tool.action, ref);
  if (predicate.kind === 'none') return () => null;
  return (alias, firstParam) => predicate.render(alias, firstParam);
}

export const isDenied = (e: unknown): e is AuthzDeniedError => e instanceof AuthzDeniedError;

// ---------------------------------------------------------------------------
// Shared argument pieces
// ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A date the model supplied. Rejected rather than coerced - a silently wrong date is worse. */
export const zDate = z.string().regex(ISO_DATE, 'expected YYYY-MM-DD');

/**
 * How the model names a person. Both are resolved INSIDE the tool's own scoped query, as an
 * extra AND - never by a separate lookup that could see further than the tool does. A name that
 * resolves to nobody the caller may see returns no rows; since DEC-142 the controller then says
 * so, rather than reporting a permissions outcome as an absence.
 *
 * OMITTING BOTH means the ASKER (DEC-144), not "everyone in scope" - see `subjectDefault`.
 */
export const zWho = {
  employeeNumber: z.string().trim().min(1).max(32).optional(),
  nameQuery: z.string().trim().min(2).max(80).optional(),
};

export const zPeriod = {
  from: zDate.optional(),
  to: zDate.optional(),
};

/** Shared JSON Schema fragments, so 50 tools describe the same argument the same way. */
export const SCHEMA_WHO = {
  employeeNumber: {
    type: 'string',
    description:
      'Employee number, e.g. EMP006. Use when the question names one. Omit for the asker themselves.',
  },
  nameQuery: {
    type: 'string',
    description:
      'Part of a person\'s name, when the question names somebody but not their number. ' +
      'Matched only against people the asker is already allowed to see.',
  },
} as const;

export const SCHEMA_PERIOD = {
  from: { type: 'string', description: 'Start date, YYYY-MM-DD. Defaults to the period start.' },
  to: { type: 'string', description: 'End date, YYYY-MM-DD. Defaults to today.' },
} as const;

/*
 * TIMESTAMPS, RENDERED IN THE COMPANY TIMEZONE - and read from configuration, not written in.
 *
 * A `timestamptz` reaches JavaScript as a Date and leaves as a UTC ISO string, so a punch at
 * 09:47 IST was handed to the model as 04:17 and reported as the arrival time (DEC-154). The
 * attendance SCREEN was right the whole time, because it formats with
 * `timeZone: 'Asia/Kolkata'` - the assistant renders no times of its own, so it has to do the
 * conversion in SQL where the value is still a timestamp.
 *
 * The zone comes from `org_setting company.timezone` with the same COALESCE fallback
 * `fn_business_date()` and migration 0012 use. CLAUDE.md rule 11: the timezone is
 * configuration, so a literal here would be a policy hardcoded in twelve SELECT lists.
 *
 * INTERPOLATION IS SAFE HERE and nowhere near user input: `expr` is a column reference this
 * repository wrote, exactly like the alias passed to `scope()`. No caller-supplied value ever
 * reaches it - those travel as parameters, which is what `security-guidelines.md` requires.
 */
const COMPANY_TZ = "COALESCE((SELECT s.value #>> '{}' FROM public.org_setting s " +
  "WHERE s.key = 'company.timezone'), 'Asia/Kolkata')";

/** Clock time, e.g. `09:47`. For a value whose DATE is already a column beside it. */
export const localTime = (expr: string): string =>
  `to_char(${expr} AT TIME ZONE ${COMPANY_TZ}, 'HH24:MI')`;

/** Date and clock time, e.g. `2026-09-03 09:47`. For a value that stands alone. */
export const localDateTime = (expr: string): string =>
  `to_char(${expr} AT TIME ZONE ${COMPANY_TZ}, 'YYYY-MM-DD HH24:MI')`;
/**
 * Compose the person filter into a scoped query.
 *
 * It is an AND on top of the scope predicate, never a substitute for it - the trap DEC-120
 * recorded, where naming an employee out of scope returned their data because the filter had
 * replaced the predicate rather than narrowed it.
 */
export function whoClause(
  args: { employeeNumber?: string | undefined; nameQuery?: string | undefined },
  alias: string,
  nextParam: number,
  selfEmployeeId: string,
): { sql: string; params: unknown[] } {
  const named = whoClauseAnyone(args, alias, nextParam);
  if (named.params.length > 0) return named;

  // Nobody named, so the question is about the asker. Still an AND on top of `scope()` at the
  // call site, never a substitute for it.
  return { sql: `${alias}.id = $${nextParam}`, params: [selfEmployeeId] };
}

/**
 * The person filter for a tool that is about EVERYBODY the caller may see when no one is named -
 * an absence calendar, a team view. `scope()` alone decides the set, which is the behaviour
 * `whoClause` had for every tool before DEC-144 and the reason "my leave balance" answered with
 * somebody else's.
 *
 * Reach for this only when a no-argument call genuinely means "everyone I can see". If you are
 * unsure, it is `whoClause`.
 */
export function whoClauseAnyone(
  args: { employeeNumber?: string | undefined; nameQuery?: string | undefined },
  alias: string,
  nextParam: number,
): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  let n = nextParam;

  if (args.employeeNumber) {
    parts.push(`upper(${alias}.employee_number) = upper($${n++})`);
    params.push(args.employeeNumber);
  }
  if (args.nameQuery) {
    parts.push(`${alias}.full_name ILIKE '%' || $${n++} || '%'`);
    params.push(args.nameQuery);
  }
  return { sql: parts.length ? parts.join(' AND ') : 'true', params };
}

/**
 * ADR-0017(d). Applied to any aggregate that crosses an individual boundary.
 *
 * Suppression replaces the FIGURES and says so. Returning zero, empty or null would each state
 * a fact about the data, which is the thing being withheld.
 */
export function suppressBelowK(
  rows: readonly Record<string, unknown>[],
  distinctPeople: number,
  columns: readonly string[],
): ToolResult {
  if (distinctPeople >= K_ANONYMITY) return { columns, rows };
  return {
    columns,
    rows: [],
    note:
      `suppressed: this covers ${distinctPeople} ${distinctPeople === 1 ? 'person' : 'people'}, ` +
      `below the minimum group size of ${K_ANONYMITY}. An aggregate over a group that small is ` +
      `not de-identified, so the figures are withheld rather than rounded.`,
  };
}
