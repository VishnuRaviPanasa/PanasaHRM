#!/usr/bin/env node
/**
 * PreToolUse guard for edits to docs/adr/*.md
 *
 * WHAT IT PREVENTS
 *   Editing an ADR whose status is Accepted (Must-Know Rule 7), via EITHER the structured file
 *   tools (Edit/Write/NotebookEdit) OR a shell command (Bash).
 *
 * WHY IT EXISTS
 *   Accepted ADRs are the top of the authority order in this repo. If they can be quietly
 *   rewritten, every decision below them becomes unreliable and the audit trail of *why* the
 *   system is shaped this way is lost. Superseding leaves the history intact; editing destroys it.
 *
 * WHAT IT DELIBERATELY ALLOWS
 *   - Creating a new ADR
 *   - Editing a Proposed ADR (that is the point of Proposed), including one held BLOCKED
 *   - **The Accepted -> "Superseded by ADR-NNNN" transition.** The previous version denied this,
 *     while its own error message instructed the author to make it. See supersedeIntent().
 *   - Reading an Accepted ADR by any means
 *
 * STATUS PARSING lives in lib/adr-status.mjs and is shared with guard-commit.mjs. It used to be
 * duplicated, and both copies carried the same two fail-open defects (a `\Z` that is not an
 * anchor in JavaScript, and a template heuristic that misread ordinary acceptance prose). Do not
 * reintroduce a second copy.
 *
 * KNOWN LIMIT - and why the commit backstop exists
 *   A shell command that never identifies the file (`node scripts/rewrite-adrs.mjs`) cannot be
 *   caught here. guard-commit.mjs therefore carries an independent check against the content
 *   that is actually about to be committed. Neither layer is sufficient alone.
 *
 * CONTRACT
 *   stdin: PreToolUse JSON. exit 0 always; deny via stdout JSON.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseAdrStatus, STATUS, isImmutableStatus } from './lib/adr-status.mjs';

const ADR_DIR = 'docs/adr';

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

/**
 * An ADR is a NUMBERED decision record. Everything else living in docs/adr/ is not.
 *
 * This used to match any `.md` under docs/adr/, which swept in `README.md` (the index) and the
 * three `adr-review-report*.md` files. None of those has a `## Status` section, the parser
 * therefore returns UNKNOWN, and UNKNOWN fails closed - so the ADR INDEX became permanently
 * unmodifiable from inside the harness, while remaining freely editable to anyone working
 * outside it (hooks only run in Claude Code). It also denied read-only commands that merely
 * named such a path alongside an in-place-looking token.
 *
 * The `\d{4}-` prefix is the same test `adrFileNames()` already applied, so the two agree now.
 */
const isAdrPath = (p) =>
  /(^|\/)docs\/adr\/\d{4}-[^/]*\.md$/.test(p) && !/0000-template\.md$/.test(p);

/** Filenames that are actually ADRs, for basename matching. */
const adrFileNames = () => {
  try {
    return existsSync(ADR_DIR)
      ? readdirSync(ADR_DIR).filter((f) => /^\d{4}-.*\.md$/.test(f) && f !== '0000-template.md')
      : [];
  } catch { return []; }
};

const statusOfFile = (path) => {
  if (!existsSync(path)) return null;                 // creating a new ADR is fine
  try { return parseAdrStatus(readFileSync(path, 'utf8')); } catch { return null; }
};

const REASON = (path, st, how) =>
  `BLOCKED: ${path} may not be modified (Must-Know Rule 7).\n\n` +
  (st.status === STATUS.UNKNOWN
    ? `Its status could not be parsed - ${st.reason}\n` +
      `This guard fails CLOSED: an unreadable status is treated as Accepted, because reading it\n` +
      `as "not Accepted" is exactly how a total bypass happened before.\n` +
      `Fix the first line of the "## Status" section to be one of:\n` +
      `  Proposed  |  Accepted  |  Superseded by ADR-NNNN\n` +
      `(Explanatory prose belongs on a "> " blockquote line beneath it, which is ignored.)\n\n`
    : `It has status Accepted and is immutable.\n\n`) +
  (how === 'bash'
    ? `Detected via a shell command. Routing an edit through Bash does not exempt it -\n` +
      `the rail is on the change, not on the tool.\n\n`
    : '') +
  `Accepted ADRs sit at the top of this repo's authority order. Rewriting one silently\n` +
  `invalidates every decision made downstream of it.\n\n` +
  `To retire it, supersede it:\n` +
  `  1. Create docs/adr/NNNN-<new-title>.md from 0000-template.md\n` +
  `  2. State what changed and why the earlier decision no longer holds\n` +
  `  3. Set this file's Status line to: Superseded by ADR-NNNN\n` +
  `     (that edit IS allowed through Edit/Write - it is the one permitted change)\n\n` +
  `If you believe the ADR is simply wrong rather than outdated, stop and ask the human.`;

// ---------------------------------------------------------------------------
// The permitted Accepted -> Superseded transition
// ---------------------------------------------------------------------------
const SUPERSEDE_LINE = /^\s*\**\s*superseded\s+by\s+adr-\d{4}/im;

/**
 * True when this specific edit is the sanctioned retirement of an Accepted ADR.
 * Only decidable for the structured tools, where the replacement text is visible.
 */
const supersedeIntent = (tool, ti) => {
  if (tool === 'Write') {
    const next = parseAdrStatus(String(ti.content ?? ''));
    return next.status === STATUS.SUPERSEDED;
  }
  if (tool === 'Edit' || tool === 'NotebookEdit') {
    const oldStr = String(ti.old_string ?? '');
    const newStr = String(ti.new_string ?? '');
    // The replacement must itself introduce the superseded marker, and must be replacing the
    // status value rather than body prose.
    return SUPERSEDE_LINE.test(newStr) && /\baccepted\b/i.test(oldStr);
  }
  return false;
};

// ---------------------------------------------------------------------------
// Bash branch
// ---------------------------------------------------------------------------

// A redirect counts only when it TARGETS an ADR. `1>`, `>|` and `exec 3>` are all redirects;
// matching a bare `>` would block `cat <adr> > /tmp/x`, which is a read.
const REDIRECT_TO_ADR =
  /(?:^|[^0-9<>])\d*>>?\|?\s*['"]?([\w./\\*?[\]$-]*(?:docs[\\/]adr[\\/])?[\w.*?[\]$-]+\.md)/i;

// In-place / copy-shaped tools, checked against every ADR the command names.
const INPLACE_TOOL = new RegExp([
  /\bsed\b[^;|]*\s-[A-Za-z]*[iI]\b/.source,
  /\bperl\b[^;|]*\s-[A-Za-z]*i\b/.source,
  /\bawk\b[^;|]*-i\s+inplace/.source,
  /\b(tee|dd|truncate|shred|install|patch|ex|ed|vi|vim|nano)\b/.source,
  /\b(mv|cp|rm|rsync|ln)\b/.source,
  /\bgit\s+(checkout|restore|apply|stash|clean|mv|rm)\b/.source,
  /\b(python[0-9.]*|node|ruby|php|pwsh|powershell)\b[^;|]*\s-(c|e|Command)\b/.source,
  // `find ... -delete` genuinely removes files and nothing else here matches it.
  //
  // Bare `xargs` and `find -exec` were removed: neither writes anything by itself, so they
  // added no coverage - a pipeline that actually writes names the writing tool too
  // (`... | xargs sed -i`, `find -exec rm`), and both of those already match above. What they
  // DID do was deny read-only commands: `grep -c x docs/adr/README.md | xargs -I{} echo {}`
  // was refused, which teaches people to route around the guard rather than trust it.
  /\bfind\b[^;|]*\s-delete\b/.source,
].join('|'), 'i');

const globToRe = (g) =>
  new RegExp('^' + g.split('').map((c) =>
    c === '*' ? '[^/]*' : c === '?' ? '[^/]' : '\\^$.|+()[]{}'.includes(c) ? '\\' + c : c,
  ).join('') + '$');

/**
 * Every ADR a shell command could be writing to.
 *
 * Three routes, because the first version only understood the first one and `cd docs/adr &&
 * sed -i 0002-x.md` walked straight past it:
 *   1. an explicit path containing docs/adr (globs expanded against disk)
 *   2. the directory itself, e.g. `rm -rf docs/adr`
 *   3. ANY token whose basename matches a real ADR filename - which catches a cwd-relative
 *      path, a variable-indirected path (`$D/0002-x.md`), and an absolute path
 */
const adrPathsIn = (cmd) => {
  const found = new Set();
  const names = adrFileNames();

  // Route 1 + 2: tokens naming the directory.
  for (const raw of cmd.match(/[\w./\\*?[\]$-]*docs[\\/]adr(?:[\\/][^\s"';:|&)]*)?/g) ?? []) {
    const tok = raw.replace(/\\/g, '/').replace(/^['"]|['"]$/g, '');
    const tail = tok.slice(tok.indexOf('docs/adr'));
    if (tail === 'docs/adr' || tail === 'docs/adr/') {
      for (const f of names) found.add(`${ADR_DIR}/${f}`);
      continue;
    }
    const pattern = tail.slice('docs/adr/'.length);
    if (/[*?[]/.test(pattern)) {
      let re; try { re = globToRe(pattern); } catch { continue; }
      for (const f of names) if (re.test(f)) found.add(`${ADR_DIR}/${f}`);
    } else if (/\.md$/.test(pattern)) {
      found.add(`${ADR_DIR}/${pattern}`);
    }
  }

  // Route 3: basename match. ADR filenames are distinctive (NNNN-*.md), so this is precise.
  for (const raw of cmd.match(/[^\s"';:|&()<>]+\.md\b/g) ?? []) {
    const b = basename(raw.replace(/\\/g, '/').replace(/^['"]|['"]$/g, ''));
    if (names.includes(b)) found.add(`${ADR_DIR}/${b}`);
  }

  return [...found];
};

// ---------------------------------------------------------------------------

try {
  const input = JSON.parse((await read(process.stdin)) || '{}');
  const tool = input?.tool_name ?? '';
  const ti = input?.tool_input ?? {};

  if (tool === 'Bash') {
    const cmd = String(ti.command ?? '');
    if (!cmd) process.exit(0);

    const targets = new Set();
    const redirect = cmd.match(REDIRECT_TO_ADR);
    if (redirect) for (const p of adrPathsIn(redirect[0])) targets.add(p);
    if (INPLACE_TOOL.test(cmd)) for (const p of adrPathsIn(cmd)) targets.add(p);

    if (targets.size === 0) process.exit(0);           // reads are fine

    for (const p of targets) {
      if (!isAdrPath(p)) continue;
      const st = statusOfFile(p);
      if (st && isImmutableStatus(st.status)) deny(REASON(p, st, 'bash'));
    }
    process.exit(0);
  }

  // Structured file tools.
  const path = String(ti.file_path ?? ti.path ?? '').replace(/\\/g, '/');
  if (!isAdrPath(path)) process.exit(0);

  const st = statusOfFile(resolve(path) && path);
  if (!st) process.exit(0);                            // new file
  if (!isImmutableStatus(st.status)) process.exit(0);

  // The one sanctioned change to an Accepted ADR.
  if (st.status === STATUS.ACCEPTED && supersedeIntent(tool, ti)) process.exit(0);

  deny(REASON(path, st, 'edit'));
} catch (err) {
  process.stderr.write(`guard-adr: internal error, allowing edit -> ${err?.message}\n`);
  process.exit(0);
}
