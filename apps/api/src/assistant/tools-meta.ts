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
import { defineTool, permittedTools, type ToolResult } from './catalog';

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

    const byDomain = new Map<string, number>();
    for (const t of mine) {
      if (t.domain === 'meta') continue;                 // do not describe this tool to itself
      if (wanted && !t.domain.includes(wanted)) continue;
      byDomain.set(t.domain, (byDomain.get(t.domain) ?? 0) + 1);
    }

    const SUBJECT: Record<string, string> = {
      me: 'Your own record',
      leave: 'Leave',
      attendance: 'Attendance',
      work: 'Work and timesheets',
      people: 'People and the org chart',
      documents: 'Documents',
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
    const rows = [...byDomain.keys()]
      .sort((a, b) => a.localeCompare(b))
      .map((domain) => ({ subject: SUBJECT[domain] ?? domain }));

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
