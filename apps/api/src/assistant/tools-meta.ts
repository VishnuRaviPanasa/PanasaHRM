/**
 * Domain: meta. ADR-0020.
 *
 * WHAT THE ASSISTANT CAN DO, asked of the assistant itself. No employee data is read here at all.
 *
 * THE ACTION IS A REUSE, and the reasoning has to be stated because §1 is strict about it. Every
 * tool declares the action of the screen it mirrors, and the "screen" here is
 * `GET /assistant/capabilities`, which is gated by `@Authenticated()` and nothing more - there is
 * no action to reuse, and §1 forbids inventing one. `org.unit.read` is the narrowest EXISTING
 * action that every one of the six roles holds (verified in `policies.ts`: all six, `ALLOW_ALL`),
 * and it is the closest in kind - "facts about the company rather than about a person". The
 * precedent is `leave_holidays`, which reuses `leave.balance.read` for the same reason: the
 * calendar has no action of its own.
 *
 * Being denied this action means holding no role at all, in which case the assistant has nothing
 * to offer anyway - so the gate is honest rather than decorative.
 *
 * IT READS THE CATALOGUE THROUGH `permittedTools`, so what it lists is what `assertCan` says this
 * actor may call - the same computation `/assistant/capabilities` publishes. It cannot advertise
 * a tool the asker would then be refused, and it needs no maintenance when the catalogue changes.
 */

import { z } from 'zod';
import { allTools, defineTool, permittedTools, type ToolResult } from './catalog';

// ---------------------------------------------------------------------------
// meta_capabilities
// ---------------------------------------------------------------------------

/*
 * "What can I ask you?" - and until now nothing answered it.
 *
 * ITS DESCRIPTION HAD TO BE NARROWED IMMEDIATELY (DEC-162). The first version invited "what do
 * you know about" and "can you tell me about my leave", and the model then chose it for "what is
 * my phone number?" - a question `me_contact_details` had been answering correctly. A tool that
 * describes itself as the answer to open-ended questions competes with every tool that holds an
 * actual answer, and it wins whenever the router declines to narrow (DEC-158). The description
 * now says what it is NOT for, in as many words.
 *
 * `/assistant/capabilities` has existed as an endpoint since ADR-0020 and no question reached it,
 * so the only way to discover the catalogue was to guess at it. That is the worst possible
 * failure mode for a tool-calling assistant: a question outside the catalogue is refused with
 * "that is outside what this assistant can answer", which tells the asker what is NOT there and
 * never what is.
 */
defineTool({
  name: 'meta_capabilities',
  domain: 'meta',
  subjectDefault: 'scope',
  description:
    'A LIST OF WHAT THIS ASSISTANT CAN DO, for the person asking. Use ONLY when the question is ' +
    'about the assistant itself - "what can you do", "what can I ask you", "help", "what are ' +
    'your capabilities". NEVER use it to answer a question about somebody records: a question ' +
    'that names any actual subject - leave, attendance, a phone number, a colleague, hours, ' +
    'tasks - belongs to the tool for that subject, even when it is phrased as "what do you ' +
    'know about X". Reads no employee records at all.',
  examples: [
    'what can you help me with?',
    'what can I ask you?',
    'what are your capabilities?',
    'help',
  ],
  action: 'org.unit.read',
  resource: 'department',
  args: z.object({
    topic: z.string().trim().min(2).max(40).optional(),
  }),
  parameters: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description:
          'Narrow to one subject, e.g. leave, attendance, work, people. Omit for everything.',
      },
    },
    additionalProperties: false,
  },
  async run(ctx, args): Promise<ToolResult> {
    const cols = ['subject'] as const;

    // The actor's OWN catalogue, so nothing is advertised that they would then be refused.
    const mine = await permittedTools(ctx.authz, ctx.auth);
    const wanted = args.topic?.toLowerCase();

    /*
     * MINE FIRST, WITHOUT THE TOPIC FILTER - because an empty result after filtering means
     * something completely different from an empty result before it, and this tool used to
     * report both with the same sentence.
     *
     * FOUND BY AN EMPLOYEE ASKING "any onboarding pending?" (DEC-169). The model chose this tool
     * with `topic: 'onboarding'`; no domain of theirs matched; rows came back empty; and
     * `buildAnswerPayload` says next to `Total rows found: 0` - correctly, for a data lookup -
     * *"Nothing is on file for that. Answer as an absence ... in the words of the question."* So
     * the answer was **"There is no onboarding pending."**
     *
     * That is a statement about the ORGANISATION'S DATA, made because of the asker's
     * PERMISSIONS, and an employee holds no grant on `salary_annexure` at all. It is DEC-150's
     * shape - a fact the system does not hold, presented as one it does - and it is the same
     * mistake DEC-142(b) fixed for a NAMED person ("Priya Menon is outside what your account can
     * see"), reappearing in the one path where the question names nobody.
     */
    const mineDomains = new Map<string, number>();
    for (const t of mine) {
      if (t.domain === 'meta') continue;                 // do not describe this tool to itself
      mineDomains.set(t.domain, (mineDomains.get(t.domain) ?? 0) + 1);
    }

    const byDomain = new Map<string, number>();
    for (const [domain, count] of mineDomains) {
      if (wanted && !domain.includes(wanted)) continue;
      byDomain.set(domain, count);
    }

    const SUBJECT: Record<string, string> = {
      me: 'Your own record',
      leave: 'Leave',
      attendance: 'Attendance',
      work: 'Work and timesheets',
      people: 'People and the org chart',
      documents: 'Documents',
      // Added with the onboarding domain (DEC-168). Without an entry the fallback prints the
      // raw domain key, so an hr_admin asking "what can I ask you?" was offered "onboarding"
      // in lower case beside six sentence-cased subjects.
      onboarding: 'Onboarding approvals',
      cross: 'Combined questions',
    };

    /*
     * SUBJECTS ONLY - no example questions (DEC-163).
     *
     * Listing four examples per subject produced a wall of twenty questions, which reads as a
     * manual rather than an answer and goes stale the moment a tool is reworded. The subject
     * names are what a reader needs: they say where to point a question, and the assistant can
     * take any wording once it is pointed the right way.
     */
    const subjectsOf = (domains: Iterable<string>) => [...domains]
      .sort((a, b) => a.localeCompare(b))
      .map((domain) => ({ subject: SUBJECT[domain] ?? domain }));

    /*
     * THE TOPIC MISSED, AND WHY IT MISSED IS THE ANSWER.
     *
     * Three outcomes, and the old code collapsed all of them into "you hold no permissions":
     *
     *   a) the asker holds nothing at all           - the original note, still right
     *   b) the topic exists here but not for them   - a PERMISSIONS answer
     *   c) the topic is not something this assistant covers at all - a CAPABILITY answer
     *
     * (b) AND (c) ARE REFUSALS, NOT ANSWERS (DEC-170). The first attempt returned the subjects
     * they DO hold with the reason in the `note`, reasoning that non-empty rows stop
     * `buildAnswerPayload` from instructing an absence. The rows did change, the instruction did
     * go, and the reply was still **"I have nothing for onboarding pending."** - because a model
     * was still being asked to write a sentence for a question whose answer is "you cannot ask
     * that", and it answered the question as asked. The note underneath was right and nobody
     * reads the subscript when the headline contradicts it.
     *
     * `notPermitted` therefore carries the whole reply, deterministically, with no model call -
     * the shape DEC-142(b) already uses for a named person out of reach. THE REDIRECT MOVES INTO
     * THE MESSAGE rather than being dropped: a bare "you cannot see that" is accurate and
     * useless, and the subjects are the one thing that makes it actionable (DEC-163: subjects,
     * not a manual).
     *
     * (b) IS NOT AN ENUMERATION ORACLE, by the same reasoning DEC-142(b) records. It names a
     * SUBJECT AREA of this product, never a person, a record or a count - "you cannot see
     * onboarding approvals" says nothing whatever about whether any onboarding is pending, which
     * is precisely the confusion being fixed. The domain list is already published per role by
     * `/assistant/capabilities`.
     */
    if (wanted && byDomain.size === 0 && mineDomains.size > 0) {
      const existsHere = allTools().some(
        (t) => t.domain !== 'meta' && t.domain.includes(wanted));
      // Lower-cased because the map's values are list headings ("Onboarding approvals") and
      // these read mid-sentence. "Onboarding approvals is not..." does not agree in number.
      const label = (SUBJECT[wanted] ?? wanted).toLowerCase();
      const subjects = subjectsOf(mineDomains.keys()).map((r) => r.subject.toLowerCase());
      // The serial comma is load-bearing here, not a style choice: several subjects contain
      // "and" ("people and the org chart"), so "x, y or z" runs the last two together.
      const instead = subjects.length > 1
        ? `${subjects.slice(0, -1).join(', ')}, or ${subjects[subjects.length - 1]}`
        : subjects[0];

      /*
       * TWO SHORT SENTENCES - DEC-141: the panel shows prose, so a longer refusal is most of the
       * screen. The first states the limit, the second is the only useful thing left to say.
       *
       * No "...so this is not an answer about whether any exist" hedge any more. That phrasing
       * existed to CORRECT a contradicting headline while this text was a subscript; now it IS
       * the reply, so there is nothing to correct and the qualifier only reads as hedging.
       */
      return {
        columns: cols,
        rows: [],
        notPermitted: existsHere
          ? `Your account cannot see ${label}. You can ask about ${instead}.`
          : `The assistant does not cover ${label}. You can ask about ${instead}.`,
      };
    }

    const rows = subjectsOf(byDomain.keys());

    /*
     * NO NOTE WHEN THERE IS SOMETHING TO SHOW (DEC-161).
     *
     * A count of lookups and a caveat about wording is chrome about the answer rather than the
     * answer, and the subjects with their examples already say everything a reader needs. The
     * empty case keeps its note because without one the reply would be nothing at all.
     */
    return {
      columns: cols,
      rows,
      note: rows.length === 0
        ? 'Your account holds no permissions the assistant can act on.'
        : undefined,
    };
  },
});
