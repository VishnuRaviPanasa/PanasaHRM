/**
 * Real-browser verification, driven over the DevTools Protocol.
 *
 * WHY THIS EXISTS AND WHY IT ADDS NO DEPENDENCY
 *
 * Playwright is named in the stack description and is not installed, and installing a browser
 * stack to satisfy a test requirement was explicitly off the table. But Windows already ships
 * Edge, and Node 24 already has a global `WebSocket` - so a real browser can be driven with
 * nothing added to `package.json`: launch it headless with `--remote-debugging-port`, speak CDP
 * over the socket it opens, and read back the DOM *after* hydration.
 *
 * WHAT THIS CAN CHECK THAT THE HTTP SUITES CANNOT. Every other suite here reads server output.
 * The application shell fetches `/auth/me` and renders its navigation client-side, so a `curl` of
 * any authenticated page returns the loading state in both languages - which is precisely why the
 * rendered Arabic nav and the RTL layout could not be asserted before. This executes the
 * JavaScript, so it sees what a person sees: computed `direction`, real bounding boxes, the nav
 * after it resolves, a dialog after it opens.
 *
 * IT DRIVES THE REAL LOGIN FORM rather than injecting a cookie, so the sign-in path is covered
 * too, and the language switch goes through the actual `<select>` and the reload it triggers.
 *
 * Run: npm run browser:test   (needs the API on :4000 and the web server on :3100)
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WEB = 'http://127.0.0.1:3100';
const PASSWORD = process.env.HRM_DEMO_PASSWORD ?? 'panasa2026';
const SHOTS = process.env.HRM_SHOT_DIR ?? join(tmpdir(), 'hrm-browser-shots');

const EDGES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];

let pass = 0, fail = 0, skipped = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  OK   ${name}${detail ? `  — ${detail}` : ''}`); return true; }
  fail++; failures.push(`${name}${detail ? `  — ${detail}` : ''}`);
  console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`);
  return false;
};
const note = (msg) => { skipped++; console.log(`  INFO ${msg}`); };

// ---------------------------------------------------------------- CDP, hand-rolled
let ws = null, msgId = 0;
const pending = new Map();
const events = [];

const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  setTimeout(() => {
    if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} timed out`)); }
  }, 30000);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Evaluate in the page and return the JSON value. */
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', {
    expression: `(() => { try { return JSON.stringify(${expr}); } catch (e) { return JSON.stringify({__err: String(e)}); } })()`,
    awaitPromise: true, returnByValue: true,
  });
  const raw = r?.result?.value;
  try { return JSON.parse(raw); } catch { return raw; }
}

/**
 * Navigate and wait until the app has actually rendered.
 *
 * `Page.loadEventFired` is not enough: the shell's navigation appears only after `/auth/me`
 * resolves, so a check that ran at load would see the skeleton and conclude the nav was missing.
 * This polls for a real signal instead of sleeping a fixed amount.
 */
async function goto(url, readyExpr = 'document.body.innerText.length > 200') {
  await send('Page.navigate', { url });
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const ready = await evalJs(`Boolean(${readyExpr})`);
    if (ready === true) return true;
  }
  return false;
}

async function shot(name) {
  try {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (r?.data) {
      writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'));
      return true;
    }
  } catch { /* evidence is a nicety, not the assertion */ }
  return false;
}

// ---------------------------------------------------------------- launch
/*
 * PREFLIGHT. Without this the suite drives a dead port and reports thirty feature failures, which
 * is exactly what happened the first time it ran: the web server had not finished starting, every
 * navigation "succeeded" onto an error page, and B03 even passed because the pathname changed.
 * A suite that cannot tell "the server is down" from "the feature is broken" is worse than none.
 */
for (const [name, url] of [['web', `${WEB}/login`], ['api', 'http://127.0.0.1:4000/api/auth/me']]) {
  let up = false;
  try {
    const r = await fetch(url, { redirect: 'manual' });
    up = r.status > 0 && r.status < 500;
  } catch { up = false; }
  if (!up) {
    console.log(`\n  FAIL the ${name} server is not answering at ${url}.`);
    console.log('       Start both, then re-run: npm run web:build && npm run web:start,'
      + ' and npm run api:start\n');
    process.exit(1);
  }
}

const exe = EDGES.find((p) => existsSync(p));
if (!exe) {
  console.log('\n  FAIL no browser found. Checked:\n' + EDGES.map((e) => `    ${e}`).join('\n'));
  process.exit(1);
}
console.log(`\nReal-browser verification\n  browser: ${exe.split('/').pop()}`);

rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });
const profile = join(tmpdir(), `hrm-edge-${Date.now()}`);

const proc = spawn(exe, [
  '--headless=new',
  '--remote-debugging-port=9222',
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-gpu', '--hide-scrollbars', '--window-size=1600,1000',
  'about:blank',
], { stdio: 'ignore', detached: false });

const cleanup = () => {
  try { ws?.close(); } catch { /* already gone */ }
  try { proc.kill(); } catch { /* already gone */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* windows lock */ }
};
process.on('exit', cleanup);

// Wait for the debugging endpoint.
let wsUrl = null;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  try {
    const r = await fetch('http://127.0.0.1:9222/json/version');
    const j = await r.json();
    if (j.webSocketDebuggerUrl) { wsUrl = j.webSocketDebuggerUrl; break; }
  } catch { /* not up yet */ }
}
if (!wsUrl) {
  console.log('  FAIL the browser did not expose a debugging endpoint');
  process.exit(1);
}

// One page target, attached flat so every message can carry its sessionId implicitly.
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = targets.find((t) => t.type === 'page');
ws = new WebSocket(page.webSocketDebuggerUrl);
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(m.error.message));
    else resolve(m.result);
  } else if (m.method) {
    events.push(m);
  }
});
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
console.log('  connected over CDP\n');

// Collect page errors, so a screen that renders but throws is not reported as working.
const consoleErrors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(m.params?.exceptionDetails?.text
      ?? m.params?.exceptionDetails?.exception?.description ?? 'unknown');
  }
});

// ================================================================ ENGLISH
console.log('1. English — sign in and every screen');

await goto(`${WEB}/login`, 'document.querySelector("#email")');
check('B01 the login page renders', await evalJs('!!document.querySelector("#email")'));
check('B02 direction is ltr',
  (await evalJs('getComputedStyle(document.documentElement).direction')) === 'ltr');
await shot('01-login-en');

// Drive the real form.
await evalJs(`(() => {
  const set = (sel, v) => {
    const el = document.querySelector(sel);
    const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
    d.set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  set('#email', 'deepa.suresh@panasatech.com');
  set('#password', ${JSON.stringify(PASSWORD)});
  document.querySelector('form').requestSubmit();
  return true;
})()`);

let signedIn = false;
for (let i = 0; i < 60; i++) {
  await sleep(300);
  const path = await evalJs('location.pathname');
  if (path && path !== '/login') { signedIn = true; break; }
}
check('B03 signing in through the real form works', signedIn,
  `landed on ${await evalJs('location.pathname')}`);

const NAV_READY = 'document.querySelectorAll("nav a").length > 3';
await goto(`${WEB}/`, NAV_READY);
const navCount = await evalJs('document.querySelectorAll("nav a").length');
check('B04 the dashboard renders with its navigation', Number(navCount) > 5, `${navCount} links`);
await shot('02-dashboard-en');

const SCREENS = [
  ['attendance', '/attendance', 'document.body.innerText.includes("Attendance")'],
  ['employee profile', '/profile', 'document.body.innerText.includes("Profile")'],
  ['leave', '/leave', 'document.body.innerText.includes("Leave")'],
  /*
   * HR is a member of NO project, so this screen legitimately renders its empty state - there is
   * no #wk-project to wait for. And #wk-emp is gone on purpose now that HR records an employee's
   * effort from that employee's profile instead. Waiting on either selector reported a working
   * screen as broken, twice, for two different reasons; the readiness signal is the heading.
   */
  ['work log', '/work', 'document.body.innerText.includes("My work")'],
  ['timesheet', '/timesheet', 'document.body.innerText.length > 400'],
  ['approvals', '/approvals', 'document.body.innerText.length > 300'],
  ['team effort', '/team', 'document.querySelector("#tm-emp")'],
  ['reports', '/reports', 'document.body.innerText.length > 400'],
  ['payslips', '/payslips', 'document.body.innerText.length > 200'],
  ['work masters', '/masters/work-management', 'document.querySelector("#wm-q")'],
  ['employees', '/employees', 'document.body.innerText.length > 400'],
  ['documents', '/documents', 'document.body.innerText.length > 300'],
  ['organisation', '/organisation', 'document.body.innerText.length > 300'],
  ['settings', '/settings', 'document.body.innerText.length > 400'],
];

for (const [name, path, ready] of SCREENS) {
  const ok = await goto(`${WEB}${path}`, ready);
  const broken = await evalJs('document.body.innerText.includes("hit a problem") '
    + '|| document.body.innerText.includes("does not exist")');
  check(`B05 ${name} renders`, ok && broken !== true, path);
}
await shot('03-work-en');

// ---- the interactive checks the HTTP suites cannot reach
console.log('\n2. English — interaction');

await goto(`${WEB}/attendance`, 'document.querySelectorAll("[role=group] button").length >= 4');
const before = await evalJs('document.body.innerText');
await evalJs(`(() => {
  const b = [...document.querySelectorAll('[role=group] button')]
    .find((x) => /today/i.test(x.textContent));
  b?.click();
  return true;
})()`);
await sleep(2500);
const after = await evalJs('document.body.innerText');
check('B06 the attendance date-period selector changes what is shown',
  typeof before === 'string' && typeof after === 'string' && before !== after,
  'clicked Today');

await evalJs(`(() => {
  const b = [...document.querySelectorAll('[role=group] button')]
    .find((x) => /custom/i.test(x.textContent));
  b?.click();
  return true;
})()`);
await sleep(1200);
check('B07 the custom range reveals two real date inputs',
  Number(await evalJs('document.querySelectorAll("input[type=date]").length')) >= 2);
await shot('04-attendance-range-en');

/*
 * B07b-B07e: TWO CONTROLS MUST NOT BOTH CLAIM TO SET THE PERIOD.
 *
 * Reported from a screenshot: with Custom range open, the month stepper was still on screen
 * reading "December 2025" while the date inputs beside it read 01-06-2026 and 09-09-2026, and the
 * label underneath reported a third thing. Two causes - the arrows set `preset: 'custom'`, which
 * is what reveals the inputs, and the picker's draft state never re-synced when the period moved
 * from outside it. A month stepper is also meaningless beside an arbitrary range.
 *
 * These four are the regression guard: the stepper is present for a preset, absent for a custom
 * range, stepping does not open the inputs, and when the inputs ARE open they agree with the
 * period actually in force.
 */
const arrowCount = '[...document.querySelectorAll("button")]'
  + '.filter((b) => /^(←|→)$/.test(b.textContent.trim())).length';

check('B07b choosing Custom range HIDES the month stepper',
  Number(await evalJs(arrowCount)) === 0, `${await evalJs(arrowCount)} arrows`);

const agree = await evalJs(`(() => {
  const ds = [...document.querySelectorAll('input[type=date]')].map((d) => d.value);
  const lbl = [...document.querySelectorAll('p')].map((p) => p.textContent)
    .find((t) => /Showing/.test(t)) ?? '';
  return { ds, lbl: lbl.trim() };
})()`);
check('B07c the date inputs agree with the period in force - no contradiction',
  !!agree?.ds?.[0] && String(agree.lbl).includes(String(agree.ds[0]).slice(0, 4)),
  `inputs=${(agree?.ds ?? []).join(' .. ')} label="${agree?.lbl}"`);

// Back to a preset, then step a month: the inputs must stay closed.
await evalJs(`(() => {
  [...document.querySelectorAll('[role=group] button')]
    .find((b) => /this month/i.test(b.textContent))?.click();
  return true;
})()`);
await sleep(2500);
check('B07d returning to a preset brings the stepper back and closes the inputs',
  Number(await evalJs(arrowCount)) === 2
  && Number(await evalJs('document.querySelectorAll("input[type=date]").length')) === 0);

await evalJs(`(() => {
  [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '←')?.click();
  return true;
})()`);
await sleep(2500);
check('B07e stepping a month does NOT open the custom inputs',
  Number(await evalJs('document.querySelectorAll("input[type=date]").length')) === 0
  && Number(await evalJs(arrowCount)) === 2,
  `${await evalJs('document.querySelectorAll("input[type=date]").length')} date inputs`);

/*
 * Invalid range: start after end must be refused in the UI, not silently accepted.
 *
 * THIS CHECK RE-OPENS CUSTOM RANGE ITSELF rather than inheriting whatever the previous one left
 * behind. It used to rely on B07 still having the inputs open, and when B07b-B07e were inserted
 * above - the last of which steps a month, closing them - it typed into `ds[0]` that did not
 * exist, threw, and reported the validation as broken. Same discipline as the DB suites: a check
 * that borrows another's fixture fails for a reason that has nothing to do with what it tests.
 */
await evalJs(`(() => {
  [...document.querySelectorAll('[role=group] button')]
    .find((b) => /custom/i.test(b.textContent))?.click();
  return true;
})()`);
await sleep(1200);
const invalid = await evalJs(`(() => {
  const set = (el, v) => {
    const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
    d.set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const ds = document.querySelectorAll('input[type=date]');
  if (ds.length < 2) return { err: 'the custom range inputs are not open' };
  set(ds[0], '2026-09-20'); set(ds[1], '2026-09-01');
  const btn = [...document.querySelectorAll('button')].find((b) => /apply/i.test(b.textContent));
  if (!btn) return { err: 'no Apply button' };
  btn.click();
  return { ok: true };
})()`);
check('B08a the inverted range could actually be entered', !invalid?.err,
  invalid?.err ?? 'typed 2026-09-20 .. 2026-09-01 and pressed Apply');
await sleep(1000);
check('B08 an inverted range is refused with a visible message',
  (await evalJs('!!document.querySelector("[role=alert]")')) === true,
  await evalJs('(document.querySelector("[role=alert]")?.textContent ?? "").slice(0,60)'));

// HR work-log creation, with the cascade.
await goto(`${WEB}/work`, 'document.querySelector("#wk-emp")');
/*
 * B09-B12: HR RECORDS AN EMPLOYEE'S EFFORT FROM THAT EMPLOYEE'S PROFILE.
 *
 * These used to drive an Employee dropdown on `/work`. It is gone: a screen called "My work"
 * offering a list of colleagues, and retitling itself when one was chosen, made the same page
 * mean two things. The capability is unchanged - `POST /work-log` still takes `employeeId` under
 * `work.log.write_for` - only the place it is offered moved to where the employee is already the
 * subject of the page.
 *
 * The first assertion is therefore the NEGATIVE one: the picker must not have come back.
 */
check('B09a /work no longer offers an employee picker',
  (await evalJs('!document.querySelector("#wk-emp")')) === true,
  '"My work" is only ever the signed-in person');
check('B09b and it still offers the project selector for your own effort',
  (await evalJs('!!document.querySelector("#wk-project") '
    + '|| document.body.innerText.includes("not on any project")')) === true);

// Rahul's profile, reached the way a person would - through the directory.
await goto(`${WEB}/employees`, 'document.querySelector("table")');
const profileOpened = await evalJs(`(() => {
  const link = [...document.querySelectorAll('a')].find((a) => /EMP004|Rahul/.test(a.textContent));
  if (!link) return { err: 'EMP004 is not in the directory' };
  link.click();
  return { href: link.getAttribute('href') };
})()`);
await sleep(2500);
check('B09c an employee profile opens from the directory', !profileOpened?.err,
  profileOpened?.href ?? profileOpened?.err);

await goto(await evalJs('location.href'), 'document.body.innerText.includes("Work log")');

/*
 * CLICK, THEN CHECK IT LANDED - and retry if it did not.
 *
 * `goto` waits for TEXT, which arrives with the server-rendered HTML. A click dispatched between
 * that moment and React hydrating does nothing at all: the button is in the DOM, `b.click()`
 * succeeds, and no handler runs. The 2500ms sleep afterwards cannot help, because by then the
 * click has already been swallowed.
 *
 * That race was always here and surfaced when the assistant (ADR-0020) made the shell's bundle
 * marginally larger: the first run after a server restart failed these four checks and the next
 * two runs passed. A gate that passes on the second try is not a gate, and "it was flaky" is how
 * one gets ignored - so the wait is now on the OUTCOME rather than on elapsed time.
 */
let offered = null;
for (let attempt = 1; attempt <= 3; attempt++) {
  offered = await evalJs(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find((x) => /^add work log$/i.test(x.textContent.trim()));
    if (!b) return { err: 'the Add work log action is not on the profile' };
    b.click();
    return { ok: true };
  })()`);
  if (offered?.err) break;
  // The form is open once its own fields exist. Poll for that, not for a duration.
  let opened = false;
  for (let i = 0; i < 20 && !opened; i++) {
    await sleep(250);
    opened = (await evalJs('!!document.querySelector("#hr-wl-project")')) === true;
  }
  if (opened) break;
  if (attempt === 3) offered = { err: 'the form never opened after three clicks - not a race' };
}
check('B10 HR is offered "Add work log" on the employee profile', !offered?.err,
  offered?.err ?? 'opened the form');

check('B10b the form knows whose effort it is, so there is nothing to pick',
  (await evalJs('document.body.innerText.includes("Recording for")')) === true
  && (await evalJs('!document.querySelector("#hr-wl-emp")')) === true,
  'no employee dropdown; the page is already about this person');

const cascadeState = await evalJs(`(() => {
  const set = (el, v) => {
    const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
    d.set.call(el, v);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const p = document.querySelector('#hr-wl-project');
  if (!p) return { err: 'no project selector in the profile form' };
  const po = [...p.options].find((o) => o.value);
  if (!po) return { err: 'no project options for this employee' };
  set(p, po.value);
  return { project: po.textContent.trim() };
})()`);
await sleep(1500);
const cascadeAfter = await evalJs(`({
  tasks: document.querySelector('#hr-wl-task')?.options.length ?? 0,
  subTasksDisabled: document.querySelector('#hr-wl-subtask')?.disabled ?? null,
  dateValue: document.querySelector('#hr-wl-date')?.value ?? '',
})`);
check('B11 choosing a project populates its tasks', !cascadeState?.err
  && Number(cascadeAfter?.tasks) > 1,
  `project=${cascadeState?.project} tasks=${cascadeAfter?.tasks}`);
check('B12a the sub-task selector stays disabled until a task is chosen',
  cascadeAfter?.subTasksDisabled === true, `disabled=${cascadeAfter?.subTasksDisabled}`);
check('B12b the date is seeded from the server business date, not left blank',
  /^\d{4}-\d{2}-\d{2}$/.test(String(cascadeAfter?.dateValue)),
  `date="${cascadeAfter?.dateValue}"`);
await shot('05-cascade-profile-en');

/*
 * Team filters.
 *
 * COUNTED, not measured in characters. These compared `document.body.innerText.length` before and
 * after, and asserted the cleared length was byte-identical to the baseline. That is brittle for
 * a reason that has nothing to do with filtering: any incidental difference in the rendered page -
 * a total gaining a digit, a note appearing - fails it, and it failed exactly that way while
 * `period:test` T7 was proving the same behaviour correctly against the API (5 rows, 8460
 * minutes, restored). The semantic being tested is "which rows", so the check counts rows.
 */
await goto(`${WEB}/team`, 'document.querySelector("#tm-emp")');
await sleep(1200);

// Rows under "By person": one <li> per person, each carrying their total.
const teamRows = 'document.querySelectorAll("li").length';
const teamBaseline = Number(await evalJs(teamRows));

const picked = await evalJs(`(() => {
  const set = (el, v) => {
    const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
    d.set.call(el, v);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const e = document.querySelector('#tm-emp');
  const o = [...e.options].find((x) => x.value);
  if (!o) return { err: 'no person to filter by - the period has no effort' };
  set(e, o.value);
  return { name: o.textContent.trim() };
})()`);
await sleep(2500);
const filtered = Number(await evalJs(teamRows));

check('B13a there was more than one person to filter down from',
  !picked?.err && teamBaseline > 1,
  picked?.err ?? `${teamBaseline} rows, filtering to ${picked?.name}`);
check('B13b filtering by person narrows the rendered rows',
  filtered > 0 && filtered < teamBaseline,
  `${teamBaseline} -> ${filtered} rows`);
check('B13c and the filter is named on screen so the smaller number has a visible reason',
  (await evalJs('document.body.innerText.includes("filter")')) === true);

const cleared = await evalJs(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /clear/i.test(x.textContent));
  if (!b || b.disabled) return { err: 'no enabled Clear control' };
  b.click();
  return { ok: true };
})()`);
await sleep(2500);
const restored = Number(await evalJs(teamRows));
check('B14 clearing the filters restores every row',
  !cleared?.err && restored === teamBaseline,
  `${filtered} -> ${restored} rows, baseline ${teamBaseline}`);
await shot('06-team-en');

// Masters: a real dialog-ish inline form.
await goto(`${WEB}/masters/work-management`, 'document.querySelector("#wm-q")');
const opened = await evalJs(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /add project/i.test(x.textContent));
  b?.click();
  return !!b;
})()`);
await sleep(700);
check('B15 the masters screen opens its inline create form', opened === true
  && Number(await evalJs('document.querySelectorAll("form input").length')) >= 2);
await shot('07-masters-en');

/*
 * B15e-h: THE SEARCH ROW LINES UP.
 *
 * Reported from a screenshot: the Search button sat a line below the input it belongs to. The row
 * was `flex items-end` holding a `Field` and the buttons - and `Field` stacks label, control AND
 * HINT, so its bottom edge is below the hint text. `items-end` aligned the buttons to that
 * instead of to the input. The hint moved out of the row, and the buttons went from `sm` to `md`
 * so the control heights match rather than merely sharing a bottom edge.
 */
await goto(`${WEB}/masters/work-management`, 'document.querySelector("#wm-q")');
await sleep(800);
const searchRow = await evalJs(`(() => {
  const input = document.querySelector('#wm-q');
  if (!input) return { err: 'the search input is not on screen' };
  const form = input.closest('form');
  const btn = [...form.querySelectorAll('button')].find((b) => /^search$/i.test(b.textContent.trim()));
  if (!btn) return { err: 'no Search button in the form' };
  const hint = [...form.querySelectorAll('p')].find((p) => /Matches a project/i.test(p.textContent));
  const ib = input.getBoundingClientRect(), bb = btn.getBoundingClientRect();
  const hb = hint ? hint.getBoundingClientRect() : null;
  return {
    sameRow: bb.top < ib.bottom - 1,
    bottomDelta: Math.round(bb.bottom - ib.bottom),
    centreDelta: Math.round((bb.top + bb.height / 2) - (ib.top + ib.height / 2)),
    hintBelowBoth: hb ? Math.round(hb.top - Math.max(ib.bottom, bb.bottom)) : null,
    gap: Math.round(bb.left - ib.right),
  };
})()`);
if (searchRow?.err) {
  check('B15e the search row is aligned', false,
    `SKIPPED - ${searchRow.err}; a skipped layout check is a failure`);
} else {
  check('B15e the Search button shares the input row', searchRow.sameRow === true);
  check('B15f their bottom edges and centres both line up',
    Math.abs(Number(searchRow.bottomDelta)) <= 1 && Math.abs(Number(searchRow.centreDelta)) <= 2,
    `bottom ${searchRow.bottomDelta}px, centre ${searchRow.centreDelta}px`);
  check('B15g the hint sits BELOW the row, not beside the button',
    Number(searchRow.hintBelowBoth) >= 0, `${searchRow.hintBelowBoth}px below`);
  check('B15h input and button do not touch', Number(searchRow.gap) >= 6,
    `${searchRow.gap}px apart`);
}

/*
 * B15a-c: THE PAYSLIP DOCUMENT CARD'S ACTIONS LINE UP.
 *
 * Reported from a screenshot: View and Download sat ~23px to the LEFT of the heading above them
 * and pressed against the bottom of the card. `CardHead` insets its text by `px-4 sm:px-5` and
 * the button row had no padding at all, so it started at the card's border while everything above
 * it was inset.
 *
 * MEASURED, not inspected. A source-pattern scan for "unpadded child of <Card>" produced 110
 * candidates across the app, almost all of them intentional nesting or a right-hand grid column -
 * unusable. The browser knows the two left edges exactly, so the check is the subtraction.
 */
await goto(`${WEB}/payslips`, 'document.body.innerText.length > 200');
await evalJs(`(() => {
  [...document.querySelectorAll('button')].find((b) => /^open$/i.test(b.textContent.trim()))?.click();
  return true;
})()`);
await sleep(2200);
const docCard = await evalJs(`(() => {
  const h = [...document.querySelectorAll('h2')].find((x) => /payslip document/i.test(x.textContent));
  if (!h) return { err: 'the document card is not on screen' };
  const card = h.closest('div').parentElement.parentElement;
  const view = [...card.querySelectorAll('button')].find((b) => /^view$/i.test(b.textContent.trim()));
  const dl = [...card.querySelectorAll('button')].find((b) => /^download$/i.test(b.textContent.trim()));
  if (!view || !dl) return { err: 'View/Download not found inside the card' };
  const hb = h.getBoundingClientRect(), vb = view.getBoundingClientRect();
  const db = dl.getBoundingClientRect(), cb = card.getBoundingClientRect();
  return {
    deltaLeft: Math.round(vb.left - hb.left),
    bottomGap: Math.round(cb.bottom - db.bottom),
    sameRow: Math.abs(vb.top - db.top) < 2,
    gapBetween: Math.round(db.left - vb.right),
  };
})()`);
if (docCard?.err) {
  check('B15d the payslip document actions are aligned', false,
    `SKIPPED - ${docCard.err}; a skipped layout check is a failure`);
} else {
  check('B15a View aligns with the card heading above it', docCard.deltaLeft === 0,
    `${docCard.deltaLeft}px offset`);
  check('B15b the buttons are not flush to the card bottom', Number(docCard.bottomGap) >= 12,
    `${docCard.bottomGap}px gap`);
  check('B15c View and Download share a baseline and do not touch',
    docCard.sameRow === true && Number(docCard.gapBetween) >= 6,
    `sameRow=${docCard.sameRow} gap=${docCard.gapBetween}px`);
}
await shot('08-payslip-document-en');

// ================================================================ ARABIC
console.log('\n3. Arabic — switch, render, RTL, switch back');

const switched = await evalJs(`(() => {
  const sel = [...document.querySelectorAll('select')]
    .find((s) => [...s.options].some((o) => o.value === 'ar'));
  if (!sel) return { err: 'no language switcher found' };
  const d = Object.getOwnPropertyDescriptor(sel.constructor.prototype, 'value');
  d.set.call(sel, 'ar');
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
})()`);
check('B16 the language switcher is present and accepts Arabic', !switched?.err,
  switched?.err ?? 'selected ar');

// The switch reloads, so wait for the document to come back in Arabic.
let rtl = false;
for (let i = 0; i < 60; i++) {
  await sleep(300);
  if ((await evalJs('document.documentElement.getAttribute("dir")')) === 'rtl') { rtl = true; break; }
}
check('B17 the document flips to dir="rtl"', rtl,
  `dir=${await evalJs('document.documentElement.getAttribute("dir")')} lang=${await evalJs('document.documentElement.lang')}`);
check('B18 the computed direction is rtl, not just the attribute',
  (await evalJs('getComputedStyle(document.documentElement).direction')) === 'rtl');

const ARABIC_RX = '/[\\u0600-\\u06FF]/';
const AR_SCREENS = [
  ['dashboard', '/', NAV_READY],
  ['attendance', '/attendance', 'document.querySelectorAll("[role=group] button").length >= 4'],
  ['work', '/work', 'document.querySelector("#wk-project")'],
  ['team', '/team', 'document.querySelector("#tm-emp")'],
  ['masters', '/masters/work-management', 'document.querySelector("#wm-q")'],
  ['reports', '/reports', 'document.body.innerText.length > 400'],
  ['payslips', '/payslips', 'document.body.innerText.length > 200'],
  ['settings', '/settings', 'document.body.innerText.length > 400'],
];
for (const [name, path, ready] of AR_SCREENS) {
  await goto(`${WEB}${path}`, ready);
  const hasArabic = await evalJs(`${ARABIC_RX}.test(document.body.innerText)`);
  const dir = await evalJs('getComputedStyle(document.documentElement).direction');
  check(`B19 ${name} renders Arabic text, rtl`, hasArabic === true && dir === 'rtl',
    `arabic=${hasArabic} dir=${dir}`);
}
await shot('08-dashboard-ar');

// A FORM in Arabic: labels translated, and the control order follows the direction.
await goto(`${WEB}/work`, 'document.querySelector("#wk-project")');
const form = await evalJs(`(() => {
  const lab = [...document.querySelectorAll('label')].map((l) => l.textContent.trim())
    .filter(Boolean);
  const arabic = lab.filter((t) => /[\\u0600-\\u06FF]/.test(t)).length;
  return { total: lab.length, arabic };
})()`);
check('B20 a FORM has Arabic labels', Number(form?.arabic) > 0,
  `${form?.arabic} of ${form?.total} labels in Arabic`);
await shot('09-work-form-ar');

// A TABLE in Arabic: headers translated, and the first column starts on the RIGHT.
/*
 * The EMPLOYEE DIRECTORY, not attendance.
 *
 * Attendance renders its empty state when the signed-in person has no rows in the selected
 * period, which is the normal case for an HR account - so the table check found no table and
 * proved nothing. The directory always holds the five seeded employees.
 */
await goto(`${WEB}/employees`, 'document.querySelector("table")');
const table = await evalJs(`(() => {
  const th = [...document.querySelectorAll('th')];
  if (th.length < 2) return { err: 'no table on this screen right now' };
  const a = th[0].getBoundingClientRect();
  const b = th[th.length - 1].getBoundingClientRect();
  return {
    headers: th.length,
    arabic: th.filter((h) => /[\\u0600-\\u06FF]/.test(h.textContent)).length,
    firstIsRightOfLast: a.left > b.left,
  };
})()`);
if (table?.err) {
  check('B21 a TABLE renders in Arabic', false,
    `SKIPPED - ${table.err}; a skipped RTL layout check is a failure`);
} else {
  check('B21a a TABLE has Arabic headers', Number(table?.arabic) > 0,
    `${table?.arabic} of ${table?.headers}`);
  check('B21b and its first column sits to the RIGHT of its last - real RTL layout',
    table?.firstIsRightOfLast === true,
    `firstLeft > lastLeft = ${table?.firstIsRightOfLast}`);
}
await shot('10-employees-table-ar');

// A DIALOG in Arabic.
await goto(`${WEB}/masters/work-management`, 'document.querySelector("#wm-q")');
/*
 * TARGETED, because "any Arabic button" was a FALSE PASS.
 *
 * The first version clicked the first short Arabic button it found, which was تسجيل الخروج -
 * Sign out. That navigated to the login page, whose two inputs satisfied the assertion, so the
 * check reported a working Arabic dialog while actually proving the sign-out button works. It
 * also destroyed the session, which is why the sidebar check after it found no sidebar. The
 * button is now matched by the exact dictionary string for "Add project".
 */
const ADD_PROJECT_AR = 'إضافة مشروع';
const dialog = await evalJs(`(() => {
  const b = [...document.querySelectorAll('button')]
    .find((x) => x.textContent.trim() === ${JSON.stringify(ADD_PROJECT_AR)});
  if (!b) return { err: 'the Arabic "Add project" button was not found' };
  b.click();
  return { clicked: b.textContent.trim() };
})()`);
await sleep(900);
const dialogState = await evalJs(`(() => {
  const f = document.querySelector('form');
  if (!f) return { err: 'no form opened' };
  const cs = getComputedStyle(f);
  return { inputs: f.querySelectorAll('input').length, dir: cs.direction };
})()`);
check('B22 a DIALOG/inline form opens in Arabic and inherits rtl',
  !dialog?.err && !dialogState?.err && dialogState?.dir === 'rtl',
  `${dialog?.clicked ?? dialog?.err} inputs=${dialogState?.inputs} dir=${dialogState?.dir}`);
await shot('11-masters-dialog-ar');

// The sidebar must be on the RIGHT in Arabic.
await goto(`${WEB}/`, NAV_READY);
const side = await evalJs(`(() => {
  // The VISIBLE sidebar. The shell also renders a mobile drawer, and picking the first
  // <nav> in the document found that one - zero-width and positioned nowhere useful.
  const navs = [...document.querySelectorAll('nav')]
    .filter((n) => n.getBoundingClientRect().width > 80);
  const main = document.querySelector('main') ?? document.body;
  if (!navs.length) return { err: 'no nav wider than 80px is visible' };
  const nav = navs[0];
  return { navLeft: Math.round(nav.getBoundingClientRect().left),
           mainLeft: Math.round(main.getBoundingClientRect().left),
           width: window.innerWidth };
})()`);
if (side?.err) {
  check('B23 the sidebar sits on the RIGHT of the content in Arabic', false,
    `SKIPPED - ${side.err}; a skipped RTL layout check is a failure`);
} else {
  check('B23 the sidebar sits on the RIGHT of the content in Arabic',
    Number(side.navLeft) > Number(side.mainLeft),
    `nav.left=${side.navLeft} main.left=${side.mainLeft} width=${side.width}`);
}

// ---- and back to English
const back = await evalJs(`(() => {
  const sel = [...document.querySelectorAll('select')]
    .find((s) => [...s.options].some((o) => o.value === 'en'));
  if (!sel) return { err: 'no switcher' };
  const d = Object.getOwnPropertyDescriptor(sel.constructor.prototype, 'value');
  d.set.call(sel, 'en');
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
})()`);
let ltr = false;
for (let i = 0; i < 60; i++) {
  await sleep(300);
  if ((await evalJs('document.documentElement.getAttribute("dir")')) === 'ltr') { ltr = true; break; }
}
check('B24 switching back to English restores dir="ltr"', !back?.err && ltr,
  `dir=${await evalJs('document.documentElement.getAttribute("dir")')}`);
await shot('12-dashboard-en-again');

// ================================================================ no page threw
console.log('\n4. Nothing threw while all of that happened');
const realErrors = consoleErrors.filter((e) => !/favicon|ResizeObserver/i.test(e));
check('B25 no uncaught exception on any screen', realErrors.length === 0,
  realErrors.length ? realErrors.slice(0, 3).join(' | ') : `${consoleErrors.length} benign`);

console.log(`\n  screenshots: ${SHOTS}`);
console.log(`${'='.repeat(37)}\n  ${pass} passed, ${fail} failed${skipped ? `, ${skipped} noted` : ''}`);
if (fail) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f}`));
  cleanup();
  process.exit(1);
}
console.log('  BROWSER VERIFICATION OK\n');
cleanup();
process.exit(0);
