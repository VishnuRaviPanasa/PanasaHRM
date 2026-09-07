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
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';

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

console.log('\n=== guard-commit: secrets ===');
reset();
stage('src/config.ts', 'export const K = "sk-ant-abcdefghijklmnopqrstuvwxyz012345";\n');
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
stage('src/db.ts', 'const url = "postgresql://app:s3cretpassword@db:5432/hrm";\n');
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
stage('src/leak.ts', 'const k = "sk-ant-abcdefghijklmnopqrstuvwxyz012345";\n');
r = runHook('guard-commit.mjs', commitPayload('git commit --dry-run -m x'));
check('T12 --dry-run is not treated as a commit', r.decision, 'allow', r.reason);

reset();
stage('src/leak.ts', 'const k = "sk-ant-abcdefghijklmnopqrstuvwxyz012345";\n');
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

console.log(`\n=====================================`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log(`=====================================\n`);
process.exit(fail === 0 ? 0 : 1);
