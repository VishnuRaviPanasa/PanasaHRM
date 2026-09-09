#!/usr/bin/env node
/**
 * PreToolUse guard for `git commit`.
 *
 * WHAT IT PREVENTS
 *   1. Committing secrets (private keys, tokens, .env files, *.pem, *.key).
 *   2. A destructive migration with no `-- IRREVERSIBLE:` marker (Must-Know Rule 13).
 *   3. An authorization change with no matching authz-matrix.yaml change (Must-Know Rule 1).
 *
 * WHY IT EXISTS
 *   There is no second human reviewer on this project. These three classes are the ones where a
 *   silent mistake is both easy to make and expensive to undo, and all three are cheaply
 *   detectable from the staged diff. See plan section 24.3.
 *
 * WHY IT IS NOT SLOWER
 *   Deliberately does NOT run tests or a typecheck. A slow commit gate is what drives people to
 *   `--no-verify`, which this repo denies outright - so a slow gate would leave the developer
 *   genuinely stuck. Budget: under 10s. It only reads the staged diff.
 *
 * HOW TO REMOVE IT SAFELY
 *   Delete the PreToolUse entry in .claude/settings.json that references this file. You lose
 *   pre-commit detection of the three classes above; CI still catches secrets, but only after
 *   they are already in git history, which for a secret is too late.
 *
 * CONTRACT
 *   stdin : PreToolUse hook JSON
 *   stdout: {"hookSpecificOutput":{...,"permissionDecision":"deny","permissionDecisionReason":...}}
 *   exit 0 always. An internal error warns on stderr and allows - a bug here must not brick the
 *   repo, and exit 1 is non-blocking by design.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parseAdrStatus, STATUS, isImmutableStatus } from './lib/adr-status.mjs';

const read = (s) => new Promise((r) => {
  let d = '';
  s.setEncoding('utf8');
  s.on('data', (c) => (d += c));
  s.on('end', () => r(d));
});

const git = (args) => {
  try {
    // stderr is suppressed: `git show HEAD:<path>` is expected to fail for a newly added file,
    // and a guard that prints "fatal:" on a legitimate commit trains people to ignore it.
    return execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
};

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

const isGitCommit = (cmd) =>
  /(^|[;&|]\s*|\s)git(\s+-[^\s]+(\s+[^\s]+)?)*\s+commit\b/.test(cmd) &&
  !/--dry-run\b/.test(cmd);

// Narrow, high-signal patterns. Broad entropy checks produce false positives, and a guard that
// cries wolf gets disabled - which costs more than the misses it prevents.
const SECRET_PATTERNS = [
  [/-----BEGIN\s+(RSA|EC|OPENSSH|PGP|DSA)?\s*PRIVATE KEY-----/, 'a private key block'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'a GitHub token'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/, 'an Anthropic API key'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, 'a Slack token'],
  [/\b(?:postgres|postgresql|mysql|mongodb)(?:\+srv)?:\/\/[^\s:@/]+:[^\s@/]{6,}@/, 'a database URL with an inline password'],
  [/["']?(?:api[_-]?key|secret[_-]?key|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*["'][A-Za-z0-9/+_-]{20,}["']/i, 'a hardcoded secret assignment'],
];

const FORBIDDEN_PATHS = [
  [/(^|\/)\.env($|\.)/, '.env file'],
  [/\.pem$/, 'PEM file'],
  [/\.key$/, 'key file'],
  [/(^|\/)secrets\//, 'file under secrets/'],
  [/\.p12$|\.pfx$/, 'keystore file'],
];

// Destructive DDL. Two corrections after the 2026-09-08 review:
//  * Removing an enforcement rail is itself destructive. DROP TRIGGER, DROP FUNCTION and
//    ALTER TABLE ... DISABLE TRIGGER were absent, so a migration deleting the Rule 3 trigger
//    passed the guard that exists to catch exactly that (finding H-5).
//  * The DELETE FROM lookahead is case-insensitive, so the word 'where' in a nearby COMMENT
//    disarmed it. Comments are stripped before the test now.
const DESTRUCTIVE_SQL =
//  * `TRUNCATE` is matched only as a COMMAND. `BEFORE TRUNCATE ON x` DEFINES A GUARD against
//    truncation, so flagging it as destructive was backwards - and a marker demanded for a
//    protective trigger is a marker that stops meaning anything.
//
// And one correction after 2026-09-09:
//  * `DROP NOT NULL` and `DROP DEFAULT` are NOT destructive, and the bare `DROP` inside the
//    ALTER TABLE branch was sweeping them up. Both RELAX a column attribute - they widen what
//    the column accepts and destroy no row, no integrity constraint and no enforcement rail.
//    Migration 0016 does `ALTER COLUMN password_hash DROP NOT NULL` so a federated account can
//    exist without a password, and this guard demanded an irreversibility marker for it.
//
//    That was worth fixing rather than working around, because the only two ways past it were
//    to bypass the hook or to write `-- IRREVERSIBLE: ...` describing a loss that does not
//    occur. A marker used once to describe nothing is a marker nobody trusts the next time,
//    which is precisely the failure this guard exists to prevent.
//
//    The exemption is a negative lookahead on those two forms ONLY - deliberately not a
//    loosening of `DROP` in general. Everything genuinely destructive still matches:
//    DROP COLUMN, DROP CONSTRAINT, DISABLE TRIGGER and DETACH PARTITION inside ALTER TABLE,
//    and the standalone DROP TABLE / SCHEMA / TYPE / INDEX / CONSTRAINT / TRIGGER / FUNCTION /
//    PROCEDURE / DATABASE / VIEW forms, which never reach the lookahead at all.
//    Pinned by testing/hooks/guards.test.mjs.
  /\b(DROP\s+(TABLE|COLUMN|SCHEMA|TYPE|INDEX|CONSTRAINT|TRIGGER|FUNCTION|PROCEDURE|DATABASE|VIEW)|DELETE\s+FROM(?![\s\S]{0,80}\bWHERE\b)|ALTER\s+TABLE[\s\S]{0,200}?\b(DROP(?!\s+(?:NOT\s+NULL|DEFAULT)\b)|DISABLE\s+TRIGGER|DETACH\s+PARTITION)\b)|(?:^|;)\s*TRUNCATE\b/im;

/** SQL with comments removed, so a comment can neither satisfy nor defeat a pattern. */
const stripSqlComments = (sql) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

/**
 * The digest a reviewed exception is pinned to.
 *
 * Deliberately the SAME computation as `scripts/migrate.mjs` - SHA-256 of the body with CR
 * stripped, so a checkout with different line endings produces the same digest. That means an
 * exception here can be verified against the `checksum` column in `schema_migration` rather than
 * taken on trust, and the two can never disagree about what the reviewed content was.
 */
const sha256Sql = (sql) =>
  createHash('sha256').update(sql.split('\r').join(''), 'utf8').digest('hex');

try {
  const input = JSON.parse((await read(process.stdin)) || '{}');
  const cmd = input?.tool_input?.command ?? '';
  if (!isGitCommit(cmd)) process.exit(0);

  const lines_ = (out) => out.split('\n').map((s) => s.trim()).filter(Boolean);

  const staged        = lines_(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']));
  const stagedDeleted = lines_(git(['diff', '--cached', '--name-only', '--diff-filter=D']));

  // FINDING C-3: `git commit -a` (and `git commit -m x <pathspec>`) stages nothing in the index,
  // so `staged` was empty and this hook exited before EVERY check - secrets, forbidden paths,
  // destructive migrations, authz, and the ADR backstop. The bypass was one flag wide.
  // When the commit takes its content from the working tree, the working tree is what must be
  // scanned. Over-scanning an uncommitted change is a false deny; under-scanning is a leak.
  const commitsWorktree =
    /(^|\s)-[A-Za-z]*a[A-Za-z]*(\s|$)/.test(cmd) || /--all\b/.test(cmd) || staged.length === 0;

  const worktree        = commitsWorktree ? lines_(git(['diff', '--name-only', '--diff-filter=ACMR'])) : [];
  const worktreeDeleted = commitsWorktree ? lines_(git(['diff', '--name-only', '--diff-filter=D'])) : [];

  const filesToCommit   = [...new Set([...staged, ...worktree])];
  const deletedToCommit = [...new Set([...stagedDeleted, ...worktreeDeleted])];

  if (filesToCommit.length === 0 && deletedToCommit.length === 0) process.exit(0);

  /** The bytes that will actually land in the commit: staged blob, else working tree. */
  const contentToCommit = (path) => {
    if (staged.includes(path)) {
      const blob = git(['show', `:${path}`]);
      if (blob) return blob;
    }
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  };

  // ---- 1. forbidden paths -------------------------------------------------
  for (const path of [...filesToCommit, ...deletedToCommit]) {
    for (const [re, label] of FORBIDDEN_PATHS) {
      if (re.test(path)) {
        deny(
          `BLOCKED: staged ${label} -> ${path}\n\n` +
          `Secrets must never enter git history; removing them afterwards means rotating them.\n\n` +
          `Fix:  git restore --staged "${path}"\n` +
          `      (and confirm it is matched by .gitignore)`
        );
      }
    }
  }

  // ---- 2. secret content in the staged diff -------------------------------
  const diff = git(['diff', '--cached', '--unified=0']);
  const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  for (const line of added) {
    for (const [re, label] of SECRET_PATTERNS) {
      if (re.test(line)) {
        deny(
          `BLOCKED: the staged diff appears to contain ${label}.\n\n` +
          `Matched line (truncated): ${line.slice(0, 120)}\n\n` +
          `If this is a false positive, move the value to an env var or a fixture file and stage\n` +
          `again. Do not weaken this pattern to get past it - see Forbidden Actions in CLAUDE.md.`
        );
      }
    }
  }

  // ---- 3. migration guard -------------------------------------------------
  const migrations = filesToCommit.filter((p) => /^infrastructure\/db\/migrations\/.*\.sql$/.test(p));
  for (const m of migrations) {
    if (!existsSync(m) && !staged.includes(m)) continue;
    const rawSql = contentToCommit(m);

    /*
     * A reviewed exception, PINNED TO THE EXACT CONTENT.
     *
     * Two applied migrations drop an enforcement rail and replace it in the same file. No
     * textual rule can tell that apart from a rail being removed: "same table gets an ADD
     * CONSTRAINT" would wave through `DROP CONSTRAINT ex_employment_no_overlap; ADD CONSTRAINT
     * ck_trivial CHECK (true)`, and "same NAME re-added" does not cover 0019's uq_project_member,
     * which is deliberately replaced by a DIFFERENT constraint. Judging "the replacement is at
     * least as strong" is a human act, so it is recorded as one here rather than approximated in
     * a regex.
     *
     * The pin is what makes this safe. The exception applies only to a file whose SHA-256 is
     * exactly the reviewed content - the same digest `scripts/migrate.mjs` stores in
     * `schema_migration`, so it is independently verifiable against the database. Change one
     * byte of either migration and the exception evaporates and the guard blocks again. It
     * grants nothing to any other file, and it does not touch DESTRUCTIVE_SQL, so every other
     * DROP CONSTRAINT, DROP FUNCTION and DISABLE TRIGGER in the repository is still caught.
     *
     * These entries must never be added to make a NEW migration commit. A new migration that
     * needs one should carry an `-- IRREVERSIBLE:` marker instead, which is reviewable in the
     * diff where the change actually is.
     */
    const REVIEWED_DESTRUCTIVE = [
      {
        file: '0019_work_management.sql',
        sha256: 'a13a038c8e299b40a5c05552ef48fb0e3fd675c694689b08af7510e11bc9d808',
        reviewedOn: '2026-09-09',
        reason:
          'Drops uq_project_member, ck_task_status and ck_timesheet_status, each replaced in '
          + 'the same migration. uq_project_member is superseded by ex_project_member_no_overlap, '
          + 'an EXCLUDE that forbids overlapping membership PERIODS rather than only duplicate '
          + 'rows - strictly stronger. The two CHECKs are re-added under the same names, widened '
          + 'to admit the new statuses. No row is lost and no rail is left removed.',
      },
      {
        file: '0023_task_status_subject_column.sql',
        sha256: 'ea81a96d019126e93f189701f50f43c2c3e6304cf20ff953c67b3d7dc3ea2507',
        reviewedOn: '2026-09-09',
        reason:
          'Drops and immediately recreates fn_task_status(integer). CREATE OR REPLACE cannot '
          + 'rename an OUT parameter, and the column had to be renamed to the one packages/authz '
          + 'renders. A function holds no data and the previous definition is recoverable from '
          + '0022.',
      },
    ];

    const reviewed = REVIEWED_DESTRUCTIVE.find(
      (e) => m.endsWith(`/${e.file}`) && e.sha256 === sha256Sql(rawSql),
    );
    if (reviewed) continue;
    // Patterns are tested against comment-stripped SQL so a comment cannot satisfy or defeat
    // one; the IRREVERSIBLE marker is looked for in the RAW text, because the marker IS a
    // comment - and anchored to the START OF A LINE, because otherwise a header paragraph
    // merely EXPLAINING the convention satisfies it (0005 did exactly that).
    const sql = stripSqlComments(rawSql);
    if (DESTRUCTIVE_SQL.test(sql) && !/^[ \t]*--[ \t]*IRREVERSIBLE:/im.test(rawSql)) {
      deny(
        `BLOCKED: ${m} contains destructive DDL with no irreversibility marker.\n\n` +
        `Must-Know Rule 13: a destructive migration needs an explicit marker AND a fresh\n` +
        `verified backup. Production migrations are forward-only and expand/contract - a rename\n` +
        `is three deploys, never one.\n\n` +
        `If it is genuinely intended, add a line stating what is lost and why:\n` +
        `  -- IRREVERSIBLE: drops leave_request.legacy_note; superseded by leave_request_slot (ADR-00NN)`
      );
    }
  }

  // ---- 3b. Accepted-ADR backstop ------------------------------------------
  // guard-adr.mjs stops a direct edit to an Accepted ADR, but it only sees commands that name
  // the file. Anything indirect - a script, a generated patch, an editor outside the harness -
  // reaches the index unobserved. This is the independent second layer.
  //
  // FINDING C-4: this previously read the WORKING TREE (readFileSync) while the file list came
  // from `git diff --cached`. Staging a rewrite and then restoring the worktree copy defeated
  // it completely. It now reads the bytes that will actually be committed.
  //
  // FINDING C-1/C-2: status parsing was a private copy that shared guard-adr.mjs's two fail-open
  // defects. Both now use lib/adr-status.mjs. Do not reintroduce a local copy.
  //
  // The one permitted transition is Accepted -> "Superseded by ADR-NNNN" (Must-Know Rule 7).
  const isAdr = (p) => /^docs\/adr\/\d{4}-.*\.md$/.test(p) && !/0000-template\.md$/.test(p);

  // Deleting an Accepted ADR destroys it just as effectively as rewriting it.
  for (const p of deletedToCommit.filter(isAdr)) {
    const head = git(['show', `HEAD:${p}`]);
    if (!head) continue;
    if (!isImmutableStatus(parseAdrStatus(head).status)) continue;
    deny(
      `BLOCKED: this commit DELETES ${p}, which is Accepted in HEAD (Must-Know Rule 7).\n\n` +
      `An Accepted ADR is retired by superseding it, never by removing it. Deleting the file\n` +
      `destroys the record of why every decision downstream of it was made.\n\n` +
      `Fix:  git restore --staged --worktree "${p}"`
    );
  }

  for (const p of filesToCommit.filter(isAdr)) {
    const head = git(['show', `HEAD:${p}`]);
    if (!head) continue;                               // newly added ADR - allowed
    const headStatus = parseAdrStatus(head).status;
    if (!isImmutableStatus(headStatus)) continue;      // was not Accepted in HEAD

    const next = contentToCommit(p);
    if (next === head) continue;                       // listed but unchanged

    const nextStatus = parseAdrStatus(next).status;
    if (headStatus === STATUS.ACCEPTED && nextStatus === STATUS.SUPERSEDED) continue;

    deny(
      `BLOCKED: ${p} is Accepted in HEAD and this commit modifies it (Must-Know Rule 7).\n\n` +
      (headStatus === STATUS.UNKNOWN
        ? `(HEAD's status could not be parsed, so it is treated as Accepted - this check fails\n` +
          ` CLOSED by design.)\n\n`
        : '') +
      `This compares the content that will actually be committed - staged blob, or the working\n` +
      `tree for a "git commit -a" - so it fires regardless of which tool made the change.\n\n` +
      `The only permitted change to an Accepted ADR is retiring it:\n` +
      `  Status: Superseded by ADR-NNNN\n\n` +
      `To record a different decision, add a NEW ADR and supersede this one.\n` +
      `Fix:  git restore --staged --worktree "${p}"`
    );
  }


  // ---- 4. authz guard -----------------------------------------------------
  // Skipped until packages/authz exists, so it cannot fire spuriously in Phase 1.
  if (existsSync('packages/authz')) {
    const touchesAuthz = filesToCommit.some((p) => p.startsWith('packages/authz/'));
    const addsRoute = added.some((l) => /@(Get|Post|Patch|Put|Delete)\s*\(/.test(l));
    const matrixStaged = filesToCommit.some((p) => /authz-matrix\.ya?ml$/.test(p));
    if ((touchesAuthz || addsRoute) && !matrixStaged) {
      deny(
        `BLOCKED: this change touches authorization or adds a route, but no authz-matrix change\n` +
        `is staged.\n\n` +
        `Every route needs a (role x action x resource) entry with both an allow AND a deny test.\n` +
        `OWASP A01 (Broken Access Control) is the top risk category for HR software, and an\n` +
        `unregistered route is how endpoints get missed.\n\n` +
        `Fix: add the entry to packages/authz/authz-matrix.yaml and stage it.`
      );
    }
  }

  process.exit(0);
} catch (err) {
  process.stderr.write(`guard-commit: internal error, allowing commit -> ${err?.message}\n`);
  process.exit(0);
}
