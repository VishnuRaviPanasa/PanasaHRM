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
import { existsSync, readFileSync } from 'node:fs';

const read = (s) => new Promise((r) => {
  let d = '';
  s.setEncoding('utf8');
  s.on('data', (c) => (d += c));
  s.on('end', () => r(d));
});

const git = (args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
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

const DESTRUCTIVE_SQL =
  /\b(DROP\s+(TABLE|COLUMN|SCHEMA|TYPE|INDEX|CONSTRAINT)|TRUNCATE|DELETE\s+FROM(?![\s\S]{0,80}WHERE)|ALTER\s+TABLE[\s\S]{0,200}?\bDROP\b)/i;

try {
  const input = JSON.parse((await read(process.stdin)) || '{}');
  const cmd = input?.tool_input?.command ?? '';
  if (!isGitCommit(cmd)) process.exit(0);

  const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
    .split('\n').map((s) => s.trim()).filter(Boolean);
  if (staged.length === 0) process.exit(0);

  // ---- 1. forbidden paths -------------------------------------------------
  for (const path of staged) {
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
  const migrations = staged.filter((p) => /^infrastructure\/db\/migrations\/.*\.sql$/.test(p));
  for (const m of migrations) {
    if (!existsSync(m)) continue;
    const sql = readFileSync(m, 'utf8');
    if (DESTRUCTIVE_SQL.test(sql) && !/--\s*IRREVERSIBLE:/i.test(sql)) {
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

  // ---- 4. authz guard -----------------------------------------------------
  // Skipped until packages/authz exists, so it cannot fire spuriously in Phase 1.
  if (existsSync('packages/authz')) {
    const touchesAuthz = staged.some((p) => p.startsWith('packages/authz/'));
    const addsRoute = added.some((l) => /@(Get|Post|Patch|Put|Delete)\s*\(/.test(l));
    const matrixStaged = staged.some((p) => /authz-matrix\.ya?ml$/.test(p));
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
