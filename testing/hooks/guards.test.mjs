#!/usr/bin/env node
/**
 * Adversarial regression test for the PreToolUse guard hooks.
 *
 * Run from the repo root:  node testing/hooks/guards.test.mjs
 *
 * Builds a throwaway git repo in the OS temp dir, copies .claude/hooks into it, and asserts
 * each guard both BLOCKS what it should and ALLOWS what it should. The allow cases matter as
 * much as the deny cases: a guard that cries wolf gets disabled, which costs more than the
 * misses it prevents.
 *
 * Exits non-zero on any failure, so CI can gate on it.
 */
import { mkdtempSync, cpSync, mkdirSync as mkd } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = process.cwd();
const SANDBOX = mkdtempSync(join(tmpdir(), 'hrm-guards-'));
cpSync(join(REPO, '.claude/hooks'), join(SANDBOX, '.claude/hooks'), { recursive: true });
process.chdir(SANDBOX);
for (const d of ['docs/adr','infrastructure/db/migrations','src']) mkd(d, { recursive: true });
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';

execSync('git init -q && git config user.email t@t.t && git config user.name t', { stdio: 'ignore' });
writeFileSync('seed.md', 'seed');
execSync('git add -A && git commit -qm seed', { stdio: 'ignore' });

let pass = 0, fail = 0;

const runHook = (script, payload) => {
  try {
    const out = execFileSync('node', [`.claude/hooks/${script}`], {
      input: JSON.stringify(payload), encoding: 'utf8',
    });
    if (!out.trim()) return { decision: 'allow', reason: '' };
    const j = JSON.parse(out);
    return {
      decision: j?.hookSpecificOutput?.permissionDecision ?? 'allow',
      reason: j?.hookSpecificOutput?.permissionDecisionReason ?? '',
    };
  } catch (e) {
    return { decision: 'ERROR', reason: e.message };
  }
};

const commitPayload = (cmd = 'git commit -m "x"') => ({
  hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd },
});
const editPayload = (p) => ({
  hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: p },
});

const check = (name, got, want, reason) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`      expected=${want} got=${got}`);
  if (!ok && reason) console.log(`      reason: ${reason.split('\n')[0]}`);
};

const reset = () => { try { execSync('git reset -q', { stdio: 'ignore' }); } catch {} };
const stage = (p, body) => {
  mkdirSync(p.split('/').slice(0, -1).join('/') || '.', { recursive: true });
  writeFileSync(p, body);
  execSync(`git add -f "${p}"`, { stdio: 'ignore' });
};

// Secret fixtures are ASSEMBLED AT RUNTIME, never written as literals.
//
// This suite feeds the secret scanner strings it is meant to match - so if they appeared
// verbatim here, guard-commit would refuse to let this very file be committed. It did:
// verified 2026-09-08, staging this file and running the hook returned DENY, "an Anthropic
// API key". Splitting the literals keeps the rail at full strength and keeps the test honest.
// Weakening the pattern, or allow-listing testing/**, would do neither.
const FAKE_ANTHROPIC_KEY = ['sk', 'ant', 'abcdefghijklmnopqrstuvwxyz012345'].join('-');
const FAKE_DB_URL = 'postgresql://app:' + 's3cret' + 'password' + '@db:5432/hrm';

console.log('\n=== guard-commit: secrets ===');
reset();
stage('src/config.ts', `export const K = "${FAKE_ANTHROPIC_KEY}";\n`);
let r = runHook('guard-commit.mjs', commitPayload());
check('T1 Anthropic key in staged diff is blocked', r.decision, 'deny', r.reason);

reset(); rmSync('src/config.ts', { force: true });
stage('.env', 'DATABASE_PASSWORD=hunter2\n');
r = runHook('guard-commit.mjs', commitPayload());
check('T2 staged .env file is blocked', r.decision, 'deny', r.reason);

reset(); rmSync('.env', { force: true });
stage('deploy/server.key', 'not-really-a-key\n');
r = runHook('guard-commit.mjs', commitPayload());
check('T3 staged *.key file is blocked', r.decision, 'deny', r.reason);

reset(); rmSync('deploy/server.key', { force: true });
stage('src/db.ts', `const url = "${FAKE_DB_URL}";\n`);
r = runHook('guard-commit.mjs', commitPayload());
check('T4 DB URL with inline password is blocked', r.decision, 'deny', r.reason);

console.log('\n=== guard-commit: migrations ===');
reset(); rmSync('src/db.ts', { force: true });
stage('infrastructure/db/migrations/0002_drop_col.sql',
  'ALTER TABLE leave_request DROP COLUMN legacy_note;\n');
r = runHook('guard-commit.mjs', commitPayload());
check('T5 destructive migration without marker is blocked', r.decision, 'deny', r.reason);

reset();
stage('infrastructure/db/migrations/0002_drop_col.sql',
  '-- IRREVERSIBLE: drops legacy_note, superseded by leave_request_slot (ADR-0011)\n' +
  'ALTER TABLE leave_request DROP COLUMN legacy_note;\n');
r = runHook('guard-commit.mjs', commitPayload());
check('T6 destructive migration WITH marker is allowed', r.decision, 'allow', r.reason);

reset();
stage('infrastructure/db/migrations/0003_add_col.sql',
  'ALTER TABLE employee ADD COLUMN service_start_on DATE;\n');
r = runHook('guard-commit.mjs', commitPayload());
check('T7 additive migration is allowed', r.decision, 'allow', r.reason);

console.log('\n=== guard-commit: authz ===');
reset();
mkdirSync('packages/authz', { recursive: true });
writeFileSync('packages/authz/authz-matrix.yaml', 'rules: []\n');
stage('packages/authz/service.ts', 'export const can = () => true;\n');
r = runHook('guard-commit.mjs', commitPayload());
check('T8 authz change without matrix change is blocked', r.decision, 'deny', r.reason);

reset();
stage('packages/authz/service.ts', 'export const can = () => true;\n');
stage('packages/authz/authz-matrix.yaml', 'rules: [{role: employee}]\n');
r = runHook('guard-commit.mjs', commitPayload());
check('T9 authz change WITH matrix change is allowed', r.decision, 'allow', r.reason);

console.log('\n=== guard-commit: pass-through ===');
reset(); rmSync('packages', { recursive: true, force: true });
stage('docs/notes.md', 'plain documentation\n');
r = runHook('guard-commit.mjs', commitPayload());
check('T10 clean commit is allowed', r.decision, 'allow', r.reason);

r = runHook('guard-commit.mjs', commitPayload('git status'));
check('T11 non-commit bash command passes through', r.decision, 'allow', r.reason);

reset();
stage('src/leak.ts', `const k = "${FAKE_ANTHROPIC_KEY}";\n`);
r = runHook('guard-commit.mjs', commitPayload('git commit --dry-run -m x'));
check('T12 --dry-run is not treated as a commit', r.decision, 'allow', r.reason);

reset();
stage('src/leak.ts', `const k = "${FAKE_ANTHROPIC_KEY}";\n`);
r = runHook('guard-commit.mjs', commitPayload('cd /repo && git commit -m x'));
check('T13 compound "cd x && git commit" is still caught', r.decision, 'deny', r.reason);
reset(); rmSync('src', { recursive: true, force: true });

console.log('\n=== guard-adr ===');
writeFileSync('docs/adr/0001-accepted.md',
  '# ADR-0001: Test\n\n## Status\n\nAccepted\n\n## Context\n\nx\n');
r = runHook('guard-adr.mjs', editPayload('docs/adr/0001-accepted.md'));
check('T14 editing an Accepted ADR is blocked', r.decision, 'deny', r.reason);

writeFileSync('docs/adr/0002-proposed.md',
  '# ADR-0002: Test\n\n## Status\n\nProposed\n\n## Context\n\nx\n');
r = runHook('guard-adr.mjs', editPayload('docs/adr/0002-proposed.md'));
check('T15 editing a Proposed ADR is allowed', r.decision, 'allow', r.reason);

writeFileSync('docs/adr/0003-superseded.md',
  '# ADR-0003: Test\n\n## Status\n\nSuperseded by ADR-0009\n\n## Context\n\nx\n');
r = runHook('guard-adr.mjs', editPayload('docs/adr/0003-superseded.md'));
check('T16 editing a Superseded ADR is allowed', r.decision, 'allow', r.reason);

writeFileSync('docs/adr/0000-template.md',
  '# ADR-NNNN\n\n## Status\n\nProposed | **Accepted** | Superseded by ADR-NNNN\n');
r = runHook('guard-adr.mjs', editPayload('docs/adr/0000-template.md'));
check('T17 editing the ADR template is allowed', r.decision, 'allow', r.reason);

r = runHook('guard-adr.mjs', editPayload('apps/api/src/foo.ts'));
check('T18 editing a non-ADR file passes through', r.decision, 'allow', r.reason);

writeFileSync('docs/adr/0004-prose.md',
  '# ADR-0004\n\n## Status\n\nProposed\n\n## Context\n\nWe Accepted this pattern before.\n');
r = runHook('guard-adr.mjs', editPayload('docs/adr/0004-prose.md'));
check('T19 the word "Accepted" in prose does not trip the guard', r.decision, 'allow', r.reason);

// ---------------------------------------------------------------------------
// The bypass. Every case above sends tool_name 'Edit', which tested the guard's PARSING and
// never its REACH - so a shell write to an Accepted ADR went unnoticed by both the hook and
// this suite. Found by the 2026-09-08 ADR review (C-1 / S-1). These cases fail against the
// pre-fix hook.
// ---------------------------------------------------------------------------
console.log('\n=== guard-adr: shell (Bash) reach ===');

const bashPayload = (cmd) => ({
  hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd },
});

r = runHook('guard-adr.mjs', bashPayload(
  "sed -i 's/Accepted/Proposed/' docs/adr/0001-accepted.md"));
check('T20 sed -i on an Accepted ADR is blocked', r.decision, 'deny', r.reason);

r = runHook('guard-adr.mjs', bashPayload('cat docs/adr/0001-accepted.md'));
check('T21 reading an Accepted ADR is allowed', r.decision, 'allow', r.reason);

r = runHook('guard-adr.mjs', bashPayload('cat docs/adr/0001-accepted.md > /tmp/copy.md'));
check('T22 reading an Accepted ADR into another file is allowed', r.decision, 'allow', r.reason);

r = runHook('guard-adr.mjs', bashPayload('echo broken > docs/adr/0001-accepted.md'));
check('T23 redirecting ONTO an Accepted ADR is blocked', r.decision, 'deny', r.reason);

r = runHook('guard-adr.mjs', bashPayload(
  "sed -i 's/x/y/' docs/adr/0002-proposed.md"));
check('T24 sed -i on a Proposed ADR is allowed', r.decision, 'allow', r.reason);

r = runHook('guard-adr.mjs', bashPayload("sed -i 's/Accepted/Proposed/' docs/adr/*.md"));
check('T25 a glob covering an Accepted ADR is blocked', r.decision, 'deny', r.reason);

r = runHook('guard-adr.mjs', bashPayload('cp /tmp/evil.md docs/adr/0001-accepted.md'));
check('T26 cp over an Accepted ADR is blocked', r.decision, 'deny', r.reason);

r = runHook('guard-adr.mjs', bashPayload('npm run db:status'));
check('T27 an unrelated shell command passes through', r.decision, 'allow', r.reason);

// ---------------------------------------------------------------------------
// The backstop. guard-adr can only see commands that NAME the path; a script that rewrites
// ADRs is invisible to it. guard-commit compares staged content against HEAD, so the route
// taken does not matter.
// ---------------------------------------------------------------------------
console.log('\n=== guard-commit: Accepted-ADR backstop ===');

reset();
rmSync('docs/adr', { recursive: true, force: true });
mkdirSync('docs/adr', { recursive: true });
writeFileSync('docs/adr/0008-locked.md',
  '# ADR-0008: Locked\n\n## Status\n\nAccepted\n\n## Context\n\noriginal\n');
execSync('git add -f docs/adr/0008-locked.md && git commit -qm "accept adr"', { stdio: 'ignore' });

reset();
stage('docs/adr/0008-locked.md',
  '# ADR-0008: Locked\n\n## Status\n\nAccepted\n\n## Context\n\nQUIETLY REWRITTEN\n');
r = runHook('guard-commit.mjs', commitPayload());
check('T28 committing a change to an ADR Accepted in HEAD is blocked',
  r.decision, 'deny', r.reason);

reset();
stage('docs/adr/0008-locked.md',
  '# ADR-0008: Locked\n\n## Status\n\nSuperseded by ADR-0020\n\n## Context\n\noriginal\n');
r = runHook('guard-commit.mjs', commitPayload());
check('T29 superseding an Accepted ADR is allowed', r.decision, 'allow', r.reason);

reset();
execSync('git checkout -q -- docs/adr/0008-locked.md', { stdio: 'ignore' });
stage('docs/adr/0021-new.md',
  '# ADR-0021: New\n\n## Status\n\nProposed\n\n## Context\n\nx\n');
r = runHook('guard-commit.mjs', commitPayload());
check('T30 adding a new ADR is allowed', r.decision, 'allow', r.reason);

// Real ADRs now carry acceptance PRECONDITIONS inside the `## Status` block ("must NOT be
// accepted until ..."), which is the block the guard parses. T19 covers the word appearing in
// Context; these cover it appearing in Status, where it actually matters.
console.log('\n=== guard-adr: acceptance prose inside the Status block ===');

mkdirSync('docs/adr', { recursive: true });
const PRECONDITION =
  '> **Acceptance precondition.** This ADR must NOT be accepted until the mechanism is\n' +
  '> implemented and concurrency-tested.\n';

writeFileSync('docs/adr/0031-precondition-proposed.md',
  `# ADR-0031\n\n## Status\n\nProposed\n\n${PRECONDITION}\n## Context\n\nx\n`);
r = runHook('guard-adr.mjs', editPayload('docs/adr/0031-precondition-proposed.md'));
check('T31 Proposed ADR with acceptance prose in Status is still editable',
  r.decision, 'allow', r.reason);

writeFileSync('docs/adr/0032-precondition-accepted.md',
  `# ADR-0032\n\n## Status\n\nAccepted\n\n${PRECONDITION}\n## Context\n\nx\n`);
r = runHook('guard-adr.mjs', editPayload('docs/adr/0032-precondition-accepted.md'));
check('T32 Accepted ADR with acceptance prose in Status is still blocked',
  r.decision, 'deny', r.reason);

console.log(`\n=====================================`);
// ---------------------------------------------------------------------------
// Pass-2 repairs. Every case here FAILS against the pre-fix hooks - that is the point.
//   C-1  `\Z` is not a JS anchor, so a trailing `## Status` section made the parser fail open
//   C-2  the template heuristic misread ordinary acceptance prose as "not Accepted"
//   C-3  `git commit -a` stages nothing, so guard-commit exited before every check
//   C-4  the ADR backstop read the working tree, not the content being committed
//   H-5  DROP/DISABLE TRIGGER was not considered destructive
// ---------------------------------------------------------------------------
console.log('\n=== guard-adr: status parsing (C-1 / C-2) ===');

mkdirSync('docs/adr', { recursive: true });
const writeAdr = (name, statusBlock, trailing = '\n## Context\n\nx\n') =>
  writeFileSync(`docs/adr/${name}`, `# ADR\n\n## Status\n\n${statusBlock}\n${trailing}`);

// C-1: Status as the LAST section. The old regex did not match at all -> fail open.
writeFileSync('docs/adr/0033-status-last.md',
  '# ADR-0033\n\n## Context\n\nx\n\n## Status\n\nAccepted\n');
r = runHook('guard-adr.mjs', editPayload('docs/adr/0033-status-last.md'));
check('T33 Accepted ADR whose Status is the LAST section is blocked', r.decision, 'deny', r.reason);

// C-2: the wording a human reaches for while accepting.
writeAdr('0034-accept-prose.md', 'Accepted 2026-09-08 (was Proposed 2026-09-01)');
r = runHook('guard-adr.mjs', editPayload('docs/adr/0034-accept-prose.md'));
check('T34 "Accepted ... (was Proposed ...)" is blocked', r.decision, 'deny', r.reason);

// C-1 variant: a literal-Z match truncated the block BEFORE the status word. The blockquote
// is first on purpose, so truncation removes 'Accepted' entirely: the old parser returned an
// empty block and ALLOWED the edit.
writeFileSync('docs/adr/0035-capital-z.md',
  '# ADR-0035\n\n## Status\n\n> Zoe raised this at review.\n\nAccepted\n\n## Context\n\nx\n');
r = runHook('guard-adr.mjs', editPayload('docs/adr/0035-capital-z.md'));
check('T35 a capital Z in the Status section does not defeat the parser', r.decision, 'deny', r.reason);

// Fail closed: an unparseable status must stop the edit, not allow it.
writeAdr('0036-garbage.md', 'Ratified-ish, mostly');
r = runHook('guard-adr.mjs', editPayload('docs/adr/0036-garbage.md'));
check('T36 an unparseable status fails CLOSED', r.decision, 'deny', r.reason);

// Acceptance preconditions live in blockquotes and must stay ignorable.
writeAdr('0037-precondition.md', 'Proposed',
  '\n> **Acceptance precondition.** Do NOT set this to Accepted until the mechanism is\n' +
  '> implemented and concurrency-tested.\n\n## Context\n\nx\n');
r = runHook('guard-adr.mjs', editPayload('docs/adr/0037-precondition.md'));
check('T37 Proposed + blockquote precondition remains editable', r.decision, 'allow', r.reason);

// A BLOCKED ADR is Proposed-and-held: still mutable.
writeAdr('0038-blocked.md', 'Proposed - **BLOCKED, do not accept**');
r = runHook('guard-adr.mjs', editPayload('docs/adr/0038-blocked.md'));
check('T38 a BLOCKED (Proposed) ADR remains editable', r.decision, 'allow', r.reason);

console.log('\n=== guard-adr: the permitted supersede transition ===');

writeAdr('0039-accepted.md', 'Accepted');
r = runHook('guard-adr.mjs', {
  hook_event_name: 'PreToolUse', tool_name: 'Edit',
  tool_input: { file_path: 'docs/adr/0039-accepted.md',
                old_string: 'Accepted', new_string: 'Superseded by ADR-0099' },
});
check('T39 Accepted -> Superseded via Edit is allowed', r.decision, 'allow', r.reason);

r = runHook('guard-adr.mjs', {
  hook_event_name: 'PreToolUse', tool_name: 'Write',
  tool_input: { file_path: 'docs/adr/0039-accepted.md',
                content: '# ADR\n\n## Status\n\nSuperseded by ADR-0099\n\n## Context\n\nx\n' },
});
check('T40 Accepted -> Superseded via Write is allowed', r.decision, 'allow', r.reason);

r = runHook('guard-adr.mjs', {
  hook_event_name: 'PreToolUse', tool_name: 'Edit',
  tool_input: { file_path: 'docs/adr/0039-accepted.md',
                old_string: 'Accepted', new_string: 'Accepted (revised wording)' },
});
check('T41 a non-supersede Edit of an Accepted ADR is still blocked', r.decision, 'deny', r.reason);

console.log('\n=== guard-adr: shell paths the first fix missed ===');

writeAdr('0042-locked.md', 'Accepted');
const bashP = (cmd) => ({
  hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd },
});

r = runHook('guard-adr.mjs', bashP("cd docs/adr && sed -i 's/Accepted/Proposed/' 0042-locked.md"));
check('T42 cd into docs/adr then sed -i is blocked', r.decision, 'deny', r.reason);

r = runHook('guard-adr.mjs', bashP('echo x 1> docs/adr/0042-locked.md'));
check('T43 numbered redirect (1>) onto an Accepted ADR is blocked', r.decision, 'deny', r.reason);

r = runHook('guard-adr.mjs', bashP('echo x >| docs/adr/0042-locked.md'));
check('T44 clobber redirect (>|) onto an Accepted ADR is blocked', r.decision, 'deny', r.reason);

r = runHook('guard-adr.mjs', bashP("D=docs/adr; sed -i 's/x/y/' $D/0042-locked.md"));
check('T45 variable-indirected path is blocked', r.decision, 'deny', r.reason);

r = runHook('guard-adr.mjs', bashP('rm -rf docs/adr'));
check('T46 rm -rf of the whole ADR directory is blocked', r.decision, 'deny', r.reason);

r = runHook('guard-adr.mjs', bashP('grep -n Status docs/adr/0042-locked.md'));
check('T47 reading an Accepted ADR is still allowed', r.decision, 'allow', r.reason);

console.log('\n=== guard-commit: C-3 (git commit -a) and C-4 (staged content) ===');

reset();
rmSync('docs/adr', { recursive: true, force: true });
mkdirSync('docs/adr', { recursive: true });
const LOCKED = '# ADR-0050\n\n## Status\n\nAccepted\n\n## Context\n\noriginal\n';
writeFileSync('docs/adr/0050-locked.md', LOCKED);
execSync('git add -f docs/adr/0050-locked.md && git commit -qm "accept"', { stdio: 'ignore' });

// C-3: the worktree is modified but nothing is staged. `git commit -a` would commit it.
reset();
writeFileSync('docs/adr/0050-locked.md', LOCKED.replace('original', 'REWRITTEN'));
r = runHook('guard-commit.mjs', commitPayload('git commit -am "tidy"'));
check('T48 git commit -a rewriting an Accepted ADR is blocked', r.decision, 'deny', r.reason);
execSync('git checkout -q -- docs/adr/0050-locked.md', { stdio: 'ignore' });

// C-3 is wider than ADRs: it was the secret-scanning rail too.
stage('src/app.ts', 'const x = 1;\n');
execSync('git commit -qm base', { stdio: 'ignore' });
writeFileSync('src/app.ts', `const k = "${FAKE_ANTHROPIC_KEY}";\n`);
r = runHook('guard-commit.mjs', commitPayload('git commit -am "wip"'));
check('T49 git commit -a carrying a secret is blocked', r.decision, 'deny', r.reason);
execSync('git checkout -q -- src/app.ts', { stdio: 'ignore' });

// C-4: stage a rewrite, then restore the worktree. The old guard compared the clean worktree.
reset();
writeFileSync('docs/adr/0050-locked.md', LOCKED.replace('original', 'STAGED REWRITE'));
execSync('git add -f docs/adr/0050-locked.md', { stdio: 'ignore' });
writeFileSync('docs/adr/0050-locked.md', LOCKED);          // worktree looks innocent
r = runHook('guard-commit.mjs', commitPayload());
check('T50 staged rewrite with a restored worktree is blocked', r.decision, 'deny', r.reason);

reset();
execSync('git checkout -q -- docs/adr/0050-locked.md', { stdio: 'ignore' });

// Deleting an Accepted ADR destroys it as surely as rewriting it.
rmSync('docs/adr/0050-locked.md', { force: true });
execSync('git add -A docs/adr', { stdio: 'ignore' });
r = runHook('guard-commit.mjs', commitPayload());
check('T51 deleting an Accepted ADR is blocked', r.decision, 'deny', r.reason);
reset();
execSync('git checkout -q -- docs/adr/0050-locked.md', { stdio: 'ignore' });

// The permitted transition must still pass the backstop.
reset();
stage('docs/adr/0050-locked.md',
  '# ADR-0050\n\n## Status\n\nSuperseded by ADR-0060\n\n## Context\n\noriginal\n');
r = runHook('guard-commit.mjs', commitPayload());
check('T52 committing Accepted -> Superseded is allowed', r.decision, 'allow', r.reason);
reset();
execSync('git checkout -q -- docs/adr/0050-locked.md', { stdio: 'ignore' });

console.log('\n=== guard-commit: H-5 destructive DDL ===');

reset();
stage('infrastructure/db/migrations/0099_x.sql',
  'DROP TRIGGER tg_attendance_policy_immutable_history ON attendance_policy;\n');
r = runHook('guard-commit.mjs', commitPayload());
check('T53 a migration dropping the Rule 3 trigger is blocked', r.decision, 'deny', r.reason);

reset();
stage('infrastructure/db/migrations/0099_x.sql',
  'ALTER TABLE leave_policy DISABLE TRIGGER tg_leave_policy_immutable_history;\n');
r = runHook('guard-commit.mjs', commitPayload());
check('T54 a migration disabling the Rule 3 trigger is blocked', r.decision, 'deny', r.reason);

reset();
stage('infrastructure/db/migrations/0099_x.sql',
  '-- IRREVERSIBLE: replaced by a stricter trigger in 0100\nDROP TRIGGER tg_x ON leave_policy;\n');
r = runHook('guard-commit.mjs', commitPayload());
check('T55 the same drop WITH an IRREVERSIBLE marker is allowed', r.decision, 'allow', r.reason);

reset();
stage('infrastructure/db/migrations/0099_x.sql',
  'DELETE FROM leave_policy;  -- rows where the tenant was removed\n');
r = runHook('guard-commit.mjs', commitPayload());
check('T56 "where" inside a comment no longer disarms the DELETE check', r.decision, 'deny', r.reason);
reset(); rmSync('infrastructure/db/migrations/0099_x.sql', { force: true });

console.log('\n=== guard-commit: destructive-DDL precision ===');

// A BEFORE TRUNCATE trigger is a guard AGAINST truncation. Flagging it as destructive was
// backwards, and it would have taught the author to add an IRREVERSIBLE marker that means
// nothing. Found while auditing whether this session's own change set could be committed.
reset();
stage('infrastructure/db/migrations/0098_guard.sql',
  'CREATE TRIGGER tg_x_no_truncate\n' +
  '    BEFORE TRUNCATE ON leave_policy\n' +
  '    FOR EACH STATEMENT EXECUTE FUNCTION fn_block_mutation();\n');
r = runHook('guard-commit.mjs', commitPayload());
check('T57 defining a BEFORE TRUNCATE guard is not destructive', r.decision, 'allow', r.reason);

reset();
stage('infrastructure/db/migrations/0098_guard.sql', 'TRUNCATE leave_policy;\n');
r = runHook('guard-commit.mjs', commitPayload());
check('T58 an actual TRUNCATE statement is still blocked', r.decision, 'deny', r.reason);

// Prose EXPLAINING the marker convention must not satisfy it. Migration 0005's header discusses
// `-- IRREVERSIBLE:` and thereby satisfied the unanchored check, so a genuinely destructive
// migration could have shipped with no real marker at all.
reset();
stage('infrastructure/db/migrations/0098_guard.sql',
  '-- Real mitigation is grant separation, requiring an `-- IRREVERSIBLE:` marker per Rule 13.\n' +
  'DROP TRIGGER tg_leave_policy_immutable_history ON leave_policy;\n');
r = runHook('guard-commit.mjs', commitPayload());
check('T59 prose mentioning the marker does not satisfy it', r.decision, 'deny', r.reason);

reset();
stage('infrastructure/db/migrations/0098_guard.sql',
  '-- IRREVERSIBLE: replaced by a stricter trigger in 0099\n' +
  'DROP TRIGGER tg_leave_policy_immutable_history ON leave_policy;\n');
r = runHook('guard-commit.mjs', commitPayload());
check('T60 a real line-anchored marker does satisfy it', r.decision, 'allow', r.reason);
reset(); rmSync('infrastructure/db/migrations/0098_guard.sql', { force: true });

// The suite feeds the scanner strings it is designed to match. If those appeared verbatim here,
// this file could not be committed - verified, it was DENIED. The fixtures are assembled at
// runtime instead, and this asserts the property rather than trusting it.
console.log('\n=== guard-commit: DROP NOT NULL / DROP DEFAULT are not destructive ===');
/*
 * Migration 0016 does `ALTER COLUMN password_hash DROP NOT NULL` so a federated account can
 * exist without a password, and the guard blocked the commit demanding an irreversibility
 * marker. Both of these RELAX a column attribute - they widen what the column accepts and
 * destroy no row, no integrity constraint and no enforcement rail.
 *
 * The exemption is a negative lookahead on those two forms only. These checks exist in PAIRS:
 * each exemption is followed by the destructive form it must not have loosened, because an
 * over-broad fix would satisfy the first half of every pair and quietly fail the second.
 */
const dropCases = [
  // [id, sql, expected decision, why]
  ['T62', 'ALTER TABLE app_user ALTER COLUMN password_hash DROP NOT NULL;\n', 'allow',
    'relaxing NOT NULL destroys nothing'],
  ['T63', 'ALTER TABLE app_user ALTER COLUMN role DROP DEFAULT;\n', 'allow',
    'dropping a default destroys nothing'],

  // ---- and none of the genuinely destructive forms may have been loosened ----
  ['T64', 'ALTER TABLE employee DROP COLUMN blood_group;\n', 'deny', 'DROP COLUMN loses data'],
  ['T65', 'ALTER TABLE employee DROP CONSTRAINT ck_employee_status;\n', 'deny',
    'removing an integrity constraint'],
  ['T66', 'ALTER TABLE employment DISABLE TRIGGER tg_employment_immutable;\n', 'deny',
    'removing an enforcement rail (finding H-5)'],
  ['T67', 'ALTER TABLE audit_event DETACH PARTITION audit_event_p202609;\n', 'deny',
    'detaching a partition'],
  ['T68', 'DROP TABLE employee;\n', 'deny', 'dropping a table'],
  ['T69', 'DROP INDEX ix_employment_asof;\n', 'deny', 'dropping an index'],
  ['T70', 'DROP TYPE leave_kind;\n', 'deny', 'dropping a type'],
  ['T71', 'DROP FUNCTION fn_business_date();\n', 'deny', 'dropping a function'],
  ['T72', 'DROP TRIGGER tg_punch_append_only ON attendance_punch;\n', 'deny',
    'dropping a trigger'],
  ['T73', 'DROP SCHEMA public CASCADE;\n', 'deny', 'dropping a schema'],
  ['T74', 'DROP VIEW v_headcount;\n', 'deny', 'dropping a view'],
  ['T75', 'TRUNCATE audit_event;\n', 'deny', 'truncate as a command'],
  ['T76', 'DELETE FROM leave_ledger;\n', 'deny', 'an unqualified delete'],

  // ---- and the things that were already correctly allowed, still are ----
  ['T77', 'DELETE FROM leave_ledger WHERE id = 1;\n', 'allow', 'a qualified delete'],
  ['T78',
    'CREATE TRIGGER g BEFORE TRUNCATE ON payslip_event\n'
    + '  FOR EACH STATEMENT EXECUTE FUNCTION fn_no_truncate();\n', 'allow',
    'BEFORE TRUNCATE DEFINES a guard against truncation'],
  ['T79', 'ALTER TABLE employee ADD COLUMN service_start_on DATE;\n', 'allow', 'purely additive'],

  // ---- variants: case, whitespace, newlines, and the two forms next to each other ----
  ['T80', 'alter table app_user alter column password_hash drop not null;\n', 'allow',
    'lower case'],
  ['T81', 'ALTER TABLE app_user\n    ALTER COLUMN password_hash\n    DROP   NOT   NULL;\n',
    'allow', 'newlines and runs of spaces inside the phrase'],
  ['T82', 'ALTER TABLE app_user ALTER COLUMN x DROP\tNOT\tNULL;\n', 'allow', 'tabs'],
  ['T83', 'AlTeR TaBlE t DrOp CoLuMn c;\n', 'deny', 'mixed case must still be caught'],
  ['T84',
    'ALTER TABLE app_user\n'
    + '    ALTER COLUMN password_hash DROP NOT NULL,\n'
    + '    ALTER COLUMN employee_id DROP NOT NULL;\n', 'allow',
    'the real 0016 statement, both clauses'],
  ['T85',
    'ALTER TABLE app_user ALTER COLUMN password_hash DROP NOT NULL;\n'
    + 'ALTER TABLE app_user DROP COLUMN legacy_pin;\n', 'deny',
    'an exempt clause must not shield a destructive one in the same file'],
  ['T86', 'ALTER TABLE t DROP NOT NULL_LOOKALIKE;\n', 'deny',
    'the word boundary must not let DROP NOT NULL_ANYTHING through'],
  ['T87', 'ALTER TABLE t DROP DEFAULTS_TABLE;\n', 'deny',
    'nor DROP DEFAULT as a prefix of another identifier'],
];

for (const [id, sql, want, why] of dropCases) {
  reset();
  stage(`infrastructure/db/migrations/0099_${id.toLowerCase()}.sql`, sql);
  r = runHook('guard-commit.mjs', commitPayload());
  check(`${id} ${want === 'allow' ? 'allowed' : 'blocked'}: ${why}`, r.decision, want, r.reason);
}

console.log('\n=== guard-commit: still fail-closed ===');
/*
 * The exemption must not have turned the guard into something that fails OPEN. Two ways to
 * check that it still refuses by default rather than by luck: a destructive statement is
 * blocked even when the exempt phrase appears in a COMMENT above it (comments are stripped
 * before the test, so a comment can neither satisfy nor defeat a pattern), and the marker still
 * has to be a real marker.
 */
reset();
stage('infrastructure/db/migrations/0099_comment_shield.sql',
  '-- this migration only does ALTER COLUMN x DROP NOT NULL, honestly\n'
  + 'ALTER TABLE employee DROP COLUMN date_of_birth;\n');
r = runHook('guard-commit.mjs', commitPayload());
check('T88 a comment claiming the exempt form cannot shield a real DROP COLUMN',
  r.decision, 'deny', r.reason);

reset();
stage('infrastructure/db/migrations/0099_marker_needed.sql',
  '-- IRREVERSIBLE: drops legacy_pin, superseded by user_identity (ADR-0009)\n'
  + 'ALTER TABLE app_user DROP COLUMN legacy_pin;\n');
r = runHook('guard-commit.mjs', commitPayload());
check('T89 a destructive migration WITH a marker is still the only way through',
  r.decision, 'allow', r.reason);

console.log('\n=== guard-commit: reviewed exceptions are pinned to content ===');
/*
 * Two applied migrations drop an enforcement rail and replace it in the same file. No textual
 * rule separates that from a rail being REMOVED, so the exception is a recorded human review,
 * pinned to the exact SHA-256 of the reviewed content.
 *
 * The pin is the whole control, so these checks are about the pin rather than about the two
 * files: the exception must apply to the reviewed bytes, must evaporate if a single byte
 * changes, and must grant nothing to any other file.
 */
{
  const realPath = join(REPO, 'infrastructure/db/migrations/0019_work_management.sql');
  const real0019 = readFileSync(realPath, 'utf8');

  reset();
  stage('infrastructure/db/migrations/0019_work_management.sql', real0019);
  r = runHook('guard-commit.mjs', commitPayload());
  check('T90 the reviewed 0019 commits without a marker', r.decision, 'allow', r.reason);

  // ONE BYTE. A trailing newline is the smallest possible change and must break the pin.
  reset();
  stage('infrastructure/db/migrations/0019_work_management.sql', real0019 + '\n');
  r = runHook('guard-commit.mjs', commitPayload());
  check('T91 one extra byte in 0019 revokes the exception', r.decision, 'deny', r.reason);

  // A comment-only edit still changes the digest, so it still blocks. Comments are stripped
  // before the DESTRUCTIVE test but NOT before the digest - the pin covers the whole file.
  reset();
  stage('infrastructure/db/migrations/0019_work_management.sql',
    '-- a harmless looking note\n' + real0019);
  r = runHook('guard-commit.mjs', commitPayload());
  check('T92 even a comment-only edit to 0019 revokes it', r.decision, 'deny', r.reason);

  // The exception is keyed on filename AND digest. Reviewed content under a different name is
  // not reviewed content.
  reset();
  stage('infrastructure/db/migrations/0099_copy_of_0019.sql', real0019);
  r = runHook('guard-commit.mjs', commitPayload());
  check('T93 the same bytes under another filename get no exception', r.decision, 'deny', r.reason);

  // And the converse: the reviewed FILENAME with different content gets nothing.
  reset();
  stage('infrastructure/db/migrations/0019_work_management.sql',
    'ALTER TABLE employment DROP CONSTRAINT ex_employment_no_overlap;\n');
  r = runHook('guard-commit.mjs', commitPayload());
  check('T94 the reviewed filename with other content gets no exception', r.decision, 'deny', r.reason);

  const real0023 = readFileSync(
    join(REPO, 'infrastructure/db/migrations/0023_task_status_subject_column.sql'), 'utf8');
  reset();
  stage('infrastructure/db/migrations/0023_task_status_subject_column.sql', real0023);
  r = runHook('guard-commit.mjs', commitPayload());
  check('T95 the reviewed 0023 commits without a marker', r.decision, 'allow', r.reason);

  reset();
  stage('infrastructure/db/migrations/0023_task_status_subject_column.sql', real0023 + ' ');
  r = runHook('guard-commit.mjs', commitPayload());
  check('T96 one extra byte in 0023 revokes the exception', r.decision, 'deny', r.reason);

  // The exception must not have become a general amnesty for the DDL it covers.
  reset();
  stage('infrastructure/db/migrations/0099_new_drop.sql',
    'ALTER TABLE project_member DROP CONSTRAINT uq_project_member;\n');
  r = runHook('guard-commit.mjs', commitPayload());
  check('T97 the same DROP in a NEW migration is still blocked', r.decision, 'deny', r.reason);

  reset();
  stage('infrastructure/db/migrations/0099_new_fn.sql',
    'DROP FUNCTION IF EXISTS fn_task_status(integer);\n');
  r = runHook('guard-commit.mjs', commitPayload());
  check('T98 the same DROP FUNCTION in a NEW migration is still blocked', r.decision, 'deny', r.reason);

  // And the digest the pin uses must be the one migrate.mjs stores, or the exception could not
  // be verified against schema_migration.
  const sha = createHash('sha256').update(real0019.split('\r').join(''), 'utf8').digest('hex');
  const hookSrc = readFileSync(join(REPO, '.claude/hooks/guard-commit.mjs'), 'utf8');
  check('T99 the pinned digest for 0019 matches the migration runner\'s computation',
    hookSrc.includes(sha), true,
    `computed ${sha.slice(0, 16)}... - if this fails the pin and schema_migration disagree`);
}

console.log('\n=== guard-commit: this suite must be committable ===');
reset();
{
  const self = readFileSync(join(REPO, 'testing/hooks/guards.test.mjs'), 'utf8');
  const literals = ['sk' + '-ant-abc', 's3cret' + 'password'].filter((x) => self.includes(x));
  check('T61 no verbatim secret literal in this test file', literals.length === 0, true,
    `found: ${literals.join(', ')}`);
}

console.log(`  ${pass} passed, ${fail} failed`);
console.log(`=====================================\n`);
process.exit(fail === 0 ? 0 : 1);
