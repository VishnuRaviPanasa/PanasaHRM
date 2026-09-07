#!/usr/bin/env node
/**
 * PreToolUse guard for edits to docs/adr/*.md
 *
 * WHAT IT PREVENTS
 *   Editing an ADR whose status is Accepted (Must-Know Rule 7).
 *
 * WHY IT EXISTS
 *   Accepted ADRs are the top of the authority order in this repo. If they can be quietly
 *   rewritten, every decision below them becomes unreliable and the audit trail of *why* the
 *   system is shaped this way is lost. Superseding leaves the history intact; editing destroys
 *   it. The permission `ask` list already prompts on ADR edits, but a prompt is a judgement call
 *   made at 11pm - this is the mechanical rail behind it.
 *
 * WHAT IT DELIBERATELY ALLOWS
 *   - Creating a new ADR
 *   - Editing a Proposed ADR (that is the point of Proposed)
 *   - Editing a Superseded ADR's header to point at its successor
 *
 * HOW TO REMOVE IT SAFELY
 *   Delete the matching PreToolUse entry in .claude/settings.json. You lose mechanical
 *   enforcement of ADR immutability; the `ask` prompt on docs/adr/* remains.
 *
 * CONTRACT
 *   stdin: PreToolUse JSON. exit 0 always; deny via stdout JSON.
 */

import { existsSync, readFileSync } from 'node:fs';

const read = (s) => new Promise((r) => {
  let d = '';
  s.setEncoding('utf8');
  s.on('data', (c) => (d += c));
  s.on('end', () => r(d));
});

const deny = (reason) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
};

try {
  const input = JSON.parse((await read(process.stdin)) || '{}');
  const ti = input?.tool_input ?? {};
  const path = (ti.file_path ?? ti.path ?? '').replace(/\\/g, '/');

  if (!/\/docs\/adr\/.*\.md$/.test(path) && !/^docs\/adr\/.*\.md$/.test(path)) process.exit(0);
  if (/0000-template\.md$/.test(path)) process.exit(0);
  if (!existsSync(path)) process.exit(0); // creating a new ADR is fine

  const body = readFileSync(path, 'utf8');

  // Read the Status section only, so the word "Accepted" elsewhere in prose cannot trip this.
  const m = body.match(/^##\s+Status\s*$([\s\S]*?)(?=^##\s|\Z)/mi);
  const statusBlock = (m?.[1] ?? '').trim();
  if (!statusBlock) process.exit(0);

  const superseded = /superseded/i.test(statusBlock);
  // The template ships every option on one line; only treat it as Accepted when the other
  // options are gone, i.e. a real decision has been recorded.
  const isTemplateLine = /proposed/i.test(statusBlock) && /accepted/i.test(statusBlock);
  const accepted = /\baccepted\b/i.test(statusBlock) && !isTemplateLine && !superseded;

  if (accepted) {
    deny(
      `BLOCKED: ${path} has status Accepted and is immutable (Must-Know Rule 7).\n\n` +
      `Accepted ADRs sit at the top of this repo's authority order. Rewriting one silently\n` +
      `invalidates every decision that was made downstream of it.\n\n` +
      `Instead, supersede it:\n` +
      `  1. Create docs/adr/NNNN-<new-title>.md from 0000-template.md\n` +
      `  2. In the new ADR, state what changed and why the earlier decision no longer holds\n` +
      `  3. Set this file's Status to: Superseded by ADR-NNNN  (that edit is allowed)\n\n` +
      `If you believe the ADR is simply wrong rather than outdated, stop and ask the human.`
    );
  }

  process.exit(0);
} catch (err) {
  process.stderr.write(`guard-adr: internal error, allowing edit -> ${err?.message}\n`);
  process.exit(0);
}
