#!/usr/bin/env node
/**
 * Assistant FLOW suite.  npm run assistant:test
 *
 * WHY THIS EXISTS
 *   `package.json` named this file from the moment the chatbot merged (commit 415804c) and it
 *   was never written - `npm run assistant:test` failed with MODULE_NOT_FOUND. Written 2026-09-10.
 *
 * WHAT IT COVERS, AND WHAT IT DELIBERATELY DOES NOT
 *   `testing/assistant/redteam.test.mjs` already drives every (tool x role) cell through
 *   `POST /assistant/run` - 2,065 authorization checks. This suite does NOT repeat that. It
 *   covers the PRODUCT contract around it: that the routes require a session, that the catalogue
 *   is role-shaped, that a tool actually returns rows, that an unavailable tool refuses rather
 *   than leaking or crashing, that every turn is transcribed, and that the assistant introduces
 *   no authorization action of its own.
 *
 * NO API KEY REQUIRED, BY DESIGN
 *   Everything here goes through `/capabilities` and `/run`, neither of which involves a model.
 *   That is the property ADR-0020 relies on: the model was never a control, so the controls can
 *   be tested without it. `/ask` is exercised only for its refusal contract when the assistant
 *   is switched off - which is the state a fresh clone is in, and the state this suite asserts
 *   is graceful rather than broken.
 *
 * Needs the API on :4000 and the web proxy on :3100, like every other demo suite.
 */

import { execFileSync } from 'node:child_process';

const B = 'http://localhost:3100/api';
const jars = {};

async function call(who, path, opts = {}) {
  const res = await fetch(B + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(jars[who] ? { cookie: jars[who] } : {}) },
  });
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) jars[who] = sc.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { ok: res.ok, status: res.status, body, text };
}

const login = (who, email) =>
  call(who, '/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: process.env.HRM_DEMO_PASSWORD ?? 'panasa2026' }),
  });

const psql = (sql) =>
  execFileSync('psql', [
    '-h', process.env.PGHOST ?? '127.0.0.1',
    '-p', String(process.env.PGPORT ?? 55432),
    '-U', process.env.PGUSER ?? 'hrm',
    '-d', process.env.PGDATABASE ?? 'hrm',
    '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', sql,
  ], {
    encoding: 'utf8',
    env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD ?? 'hrm_dev_only' },
  }).split('\r').join('').trim();

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `  — ${detail}` : ''}`);
};

const flat = (cap) => Object.values(cap.domains ?? {}).flat();

// ---------------------------------------------------------------------------

console.log('\n1. Every assistant route requires a session');
for (const [path, opts] of [
  ['/assistant/capabilities', {}],
  ['/assistant/run', { method: 'POST', body: JSON.stringify({ tool: 'leave_balance' }) }],
  ['/assistant/ask', { method: 'POST', body: JSON.stringify({ question: 'hello' }) }],
]) {
  const r = await call('anon', path, opts);
  check(`anonymous ${path} is refused`, r.status === 401, `http=${r.status}`);
}

await login('emp', 'vishnu.ravi@panasatech.com');
await login('hr', 'deepa.suresh@panasatech.com');

console.log('\n2. The catalogue answers "what can you see?" honestly');
const capEmp = (await call('emp', '/assistant/capabilities')).body;
const capHr = (await call('hr', '/assistant/capabilities')).body;

check('capabilities reports the total tool count', Number(capHr.total) > 0, `total=${capHr.total}`);
check('every listed tool names the action it REUSES',
  flat(capHr).every((t) => typeof t.action === 'string' && t.action.includes('.')),
  `${flat(capHr).length} tools`);

// Asserted as a relation, not a hardcoded 38/41, so adding a tool does not fail this suite.
check('an employee is offered strictly fewer tools than HR',
  Number(capEmp.available) < Number(capHr.available),
  `employee ${capEmp.available} < hr_admin ${capHr.available} of ${capHr.total}`);

const empNames = new Set(flat(capEmp).map((t) => t.name));
const hrOnly = flat(capHr).map((t) => t.name).filter((n) => !empNames.has(n));
check('the withheld tools are the org-wide ones', hrOnly.length > 0, hrOnly.join(', '));

console.log('\n3. ADR-0020: the assistant introduces NO authorization action of its own');
// The load-bearing claim. If a tool ever needs a new action, it can out-reach the screens beside
// it and the whole "cannot exceed the UI" argument collapses.
const matrix = execFileSync('node', ['-e',
  "process.stdout.write(require('node:fs').readFileSync('packages/authz/authz-matrix.yaml','utf8'))",
], { encoding: 'utf8' });
const actions = [...new Set(flat(capHr).map((t) => t.action))];
const unknown = actions.filter((a) => !matrix.includes(a));
check(`all ${actions.length} tool actions pre-exist in the authz matrix`, unknown.length === 0,
  unknown.length ? `NEW: ${unknown.join(', ')}` : 'no assistant-only action');
check('the matrix defines no assistant.* action', !/^\s*-?\s*assistant\./m.test(matrix));

console.log('\n4. A permitted tool actually returns the asker\'s own rows');
const before = Number(psql('SELECT count(*) FROM assistant_message'));   // baseline for section 7
const run = await call('emp', '/assistant/run', {
  method: 'POST', body: JSON.stringify({ tool: 'leave_balance', args: {} }),
});
check('run succeeds', run.ok, `http=${run.status}`);
check('no refusal', !run.body?.refusal, run.body?.refusal?.code ?? '');
check('columns and rows come back',
  Array.isArray(run.body?.columns) && Array.isArray(run.body?.rows),
  `${run.body?.columns?.length ?? 0} cols, rowCount=${run.body?.rowCount}`);
check('the asker has a leave balance', Number(run.body?.rowCount) > 0);

console.log('\n5. An unavailable tool refuses - it does not leak and does not crash');
const denied = await call('emp', '/assistant/run', {
  method: 'POST', body: JSON.stringify({ tool: hrOnly[0], args: {} }),
});
check(`employee calling ${hrOnly[0]} by name is refused`,
  denied.body?.refusal?.code === 'not_permitted', denied.body?.refusal?.code ?? `http=${denied.status}`);
check('the refusal carries no rows', (denied.body?.rows?.length ?? 0) === 0);
check('it is a refusal, not a 500', denied.status < 500, `http=${denied.status}`);

const nosuch = await call('emp', '/assistant/run', {
  method: 'POST', body: JSON.stringify({ tool: 'definitely_not_a_tool' }),
});
check('an unknown tool name is a 400', nosuch.status === 400, `http=${nosuch.status}`);

console.log('\n6. With no API key the assistant REFUSES, it does not error');
// This is the state of a fresh clone, and of this machine. A 500 here would mean nobody can run
// the product without buying a key first.
check('capabilities reports it is switched off', capEmp.enabled === false,
  String(capEmp.disabledReason ?? ''));
const ask = await call('emp', '/assistant/ask', {
  method: 'POST', body: JSON.stringify({ question: 'How many leave days do I have left?' }),
});
check('ask does not error', ask.status < 400, `http=${ask.status}`);
check('ask streams a disabled refusal',
  /event:\s*refusal/.test(ask.text) && /"code"\s*:\s*"disabled"/.test(ask.text),
  (ask.text ?? '').split('\n')[1]?.slice(0, 60));
check('and no answer text is fabricated', !/event:\s*token/.test(ask.text));

console.log('\n7. Every turn is transcribed - REFUSALS INCLUDED (migration 0035)');
// Runs last so it can see all four calls above. The first draft of this section asserted that the
// newest row was `leave_balance` and it FAILED: the refusal had also been recorded. That is the
// property actually worth asserting - a refused question is the one an auditor most wants to find.
const after = Number(psql('SELECT count(*) FROM assistant_message'));
check('three turns were recorded', after - before === 3,
  `${before} -> ${after} (+${after - before})`);

const rows = psql(
  "SELECT coalesce(tool_name,'-') || '|' || coalesce(refusal_code,'-') || '|' ||" +
  " coalesce(row_count::text,'-') FROM assistant_message" +
  ' ORDER BY asked_at DESC, seq DESC LIMIT 3',
).split('\n').map((r) => r.trim());
const [askRow, deniedRow, runRow] = rows;

check('the permitted run recorded its tool, and no refusal code',
  runRow === 'leave_balance|-|2', runRow);
check('...and the row_count it recorded matches what the API returned',
  runRow === `leave_balance|-|${run.body?.rowCount}`, `transcript=${runRow} api=${run.body?.rowCount}`);
check('the REFUSAL was recorded, with its code',
  deniedRow === `${hrOnly[0]}|not_permitted|-`, deniedRow);
check('the disabled /ask was recorded too', askRow === '-|disabled|-', askRow);

// Documented, deliberate gap: an unknown tool name is rejected by validation before a turn
// begins, so it leaves no transcript - hence +3 above, not +4. It also reached no data. If that
// ever needs auditing it is a new requirement, not a regression.

console.log(`\n${fail === 0 ? 'ASSISTANT FLOW OK' : `${fail} FAILED`} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
