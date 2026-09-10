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

import { execFileSync, spawn } from 'node:child_process';
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
 * Wait until an expression is true, or give up.
 *
 * `goto` already polls rather than sleeps, and for good reason; everything AFTER a navigation was
 * still using a fixed `sleep`, which is fine against a warm server and wrong against a cold one.
 * Restarting the stack and re-running produced four false failures in a row - the HR work-log
 * form was still a skeleton at +2500ms, so none of its fields existed yet. The checks were right
 * and the wait was too short, which is the worst kind of red: it sends you hunting a defect that
 * is not there.
 */
async function waitFor(expr, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await evalJs(`Boolean(${expr})`)) === true) return true;
    if (Date.now() >= deadline) return false;
    await sleep(200);
  }
}

/**
 * Click something, and keep clicking until the page shows it worked.
 *
 * A `click()` on a button React has not hydrated yet is a NO-OP - the element is in the DOM,
 * `querySelector` finds it, the call returns cleanly, and nothing happens. That is what made
 * B10-B12b fail while the form worked perfectly when driven by hand: `goto` returned as soon as
 * the card's title text appeared, the click landed a few hundred milliseconds before the handler
 * was attached, and then twelve seconds of polling watched a form that had never been asked to
 * open. A fixed sleep would paper over it; retrying the click asserts the outcome instead.
 *
 * `clickExpr` must be idempotent - clicking twice on a toggle would close what the first click
 * opened - so it is written as "click if the target is not already showing".
 */
async function clickUntil(clickExpr, readyExpr, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await evalJs(`Boolean(${readyExpr})`)) === true) return true;
    await evalJs(clickExpr);
    await sleep(400);
    if ((await evalJs(`Boolean(${readyExpr})`)) === true) return true;
    if (Date.now() >= deadline) return false;
  }
}

/**
 * Sign in through the real form, as B03 does inline.
 *
 * Factored rather than copied, because a second hand-written login is the kind of thing that
 * drifts. Takes a password so the account-provisioning block can sign in as somebody whose
 * password was just chosen through the activation page rather than seeded.
 */
async function signIn(email, password = PASSWORD) {
  await goto(`${WEB}/login`, 'document.querySelector("#email")');
  await evalJs(`(() => {
    const set = (sel, v) => {
      const el = document.querySelector(sel);
      const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
      d.set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('#email', ${JSON.stringify(email)});
    set('#password', ${JSON.stringify(password)});
    document.querySelector('form').requestSubmit();
    return true;
  })()`);
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    if ((await evalJs('location.pathname')) !== '/login') return true;
  }
  return false;
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

/*
 * B02a-c: THE LOGIN LANGUAGE SWITCHER IS READABLE, AND EXISTS ON A PHONE.
 *
 * Reported from the screen: "in login screen, language dropdown visibility is low". Two separate
 * defects behind one symptom.
 *
 * It sat in the dark pitch panel - `bg-ink-900`, #17171a - while styling its own text
 * `text-ink-600`, #4c4c47. **Measured at 2.07:1**, against the 4.5:1 WCAG asks for 12.5px text.
 * The globe beside it was `ink-400` and passed at 4.8:1, which is exactly why it presented as a
 * visible globe next to an unreadable word rather than as a missing control.
 *
 * And that panel is `hidden ... lg:flex`, so below 1024px the switcher DID NOT EXIST - somebody
 * who reads Arabic had no way to choose it before signing in, on a phone or a narrow window. That
 * is the more serious of the two and it is invisible to any desktop-only check, so B02c sets a
 * phone viewport rather than trusting the class list.
 *
 * The ratio is computed here rather than asserted as a class name, because the contrast depends
 * on what is actually painted behind the control - which is the thing that changed.
 */
const CONTRAST = `(() => {
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = (p) => 0.2126 * lin(p[0]) + 0.7152 * lin(p[1]) + 0.0722 * lin(p[2]);
  const rgb = (v) => v.replace(/[^0-9.,]/g, '').split(',').filter((x) => x !== '').map(Number);
  const el = document.querySelector('select');
  if (!el) return { present: false };
  const cs = getComputedStyle(el);
  let node = el, bg = null;
  while (node) {
    const c = rgb(getComputedStyle(node).backgroundColor);
    if (c.length >= 3 && (c[3] === undefined || c[3] > 0.5)) { bg = c; break; }
    node = node.parentElement;
  }
  if (!bg) bg = [255, 255, 255];
  const pair = [lum(rgb(cs.color)) + 0.05, lum(bg) + 0.05].sort((a, b) => b - a);
  const r = el.getBoundingClientRect();
  return {
    present: true,
    visible: r.width > 4 && r.height > 4,
    ratio: Math.round((pair[0] / pair[1]) * 100) / 100,
    options: el.options.length,
  };
})()`;

const sw = await evalJs(CONTRAST);
check('B02a the login page offers a language switcher', sw?.present === true && sw?.visible === true
  && Number(sw?.options) >= 2, `${sw?.options} languages`);
check('B02b its text is readable against whatever is painted behind it',
  Number(sw?.ratio) >= 4.5, `${sw?.ratio}:1 (WCAG wants 4.5:1 at this size; was 2.07:1)`);

// A phone. The switcher used to live in a `hidden lg:flex` panel, so this is the check that
// would have caught its total absence - the desktop one could not.
await send('Emulation.setDeviceMetricsOverride', {
  width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
});
await goto(`${WEB}/login`, 'document.querySelector("#email")');
const swPhone = await evalJs(CONTRAST);
check('B02c and it is still there at a phone width, not hidden with the desktop panel',
  swPhone?.present === true && swPhone?.visible === true && Number(swPhone?.ratio) >= 4.5,
  swPhone?.present
    ? `visible=${swPhone?.visible} ${swPhone?.ratio}:1 at 390px`
    : 'NOT IN THE DOM at 390px');
await shot('01b-login-phone');
await send('Emulation.clearDeviceMetricsOverride');
await goto(`${WEB}/login`, 'document.querySelector("#email")');

/*
 * B02d: THE CORNER FLIPS IN ARABIC.
 *
 * The switcher is pinned with `end-4`, not `right-4`, so the corner that means "the page's own
 * controls" follows the reading direction - top right in English, top LEFT in Arabic. A hardcoded
 * `right-4` would look correct in every English screenshot and be in the wrong corner for half the
 * intended users, which is precisely the kind of thing nobody notices without checking.
 */
const cornerOf = `(() => {
  const el = document.querySelector('select');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { centre: Math.round(r.left + r.width / 2), top: Math.round(r.top),
           width: window.innerWidth };
})()`;
const cornerEn = await evalJs(cornerOf);
await evalJs(`(() => { document.cookie = 'hrm_locale=ar; path=/; max-age=600'; return true; })()`);
await goto(`${WEB}/login`, 'document.querySelector("#email")');
const cornerAr = await evalJs(cornerOf);
check('B02d the switcher sits in the corner, and the corner follows the reading direction',
  !!cornerEn && !!cornerAr
  && cornerEn.centre > cornerEn.width / 2 && cornerAr.centre < cornerAr.width / 2
  && cornerEn.top < 80 && cornerAr.top < 80,
  `en x=${cornerEn?.centre}/${cornerEn?.width} ar x=${cornerAr?.centre}/${cornerAr?.width}, top ${cornerEn?.top}px`);
await evalJs(`(() => { document.cookie = 'hrm_locale=en; path=/; max-age=600'; return true; })()`);
await goto(`${WEB}/login`, 'document.querySelector("#email")');

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
/*
 * WAIT FOR THE NAVIGATION, not for the click to return. `link.click()` on a Next `<Link>` starts a
 * CLIENT-SIDE transition, so `location.href` read on the next line is still the directory - and
 * the `goto` below then dutifully re-navigated to `/employees` and stayed there. Every check after
 * it measured the directory while claiming to measure a profile, which is how B10-B12b reported
 * "the form never finished loading" for a form that was never on the page.
 *
 * B09c is now the navigation itself rather than the href the link happened to carry.
 */
const arrived = await waitFor('location.pathname.startsWith("/employees/")');
check('B09c an employee profile opens from the directory', !profileOpened?.err && arrived,
  arrived ? await evalJs('location.pathname') : (profileOpened?.err ?? 'never left the directory'));

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

/*
 * B26: ACCOUNT PROVISIONING, THROUGH BOTH REAL SCREENS.
 *
 * `accounts:test` proves the API end to end - 36 checks - and cannot prove the hand-over, which
 * is the part with two people and two screens in it: HR reads a code off the profile, and the
 * employee types it into a page they reach without a session. So this drives exactly that, as a
 * person would, and the code is CARRIED FROM ONE SCREEN TO THE OTHER by reading it out of the
 * DOM. If the panel ever stopped rendering the code, or the activation form stopped accepting the
 * shape it renders, this is the only check that would notice.
 *
 * EMP006 Meera Nair is the fixture - a permanent demo employee with no login, which is the state
 * the feature exists for. The block resets the account afterwards so the suite is re-runnable;
 * the employee itself cannot be deleted (append-only `employment_event`) and is not meant to be.
 */
console.log('\n3b. Account provisioning, HR screen to employee screen');

const resetFixture = () => {
  try {
    execFileSync('docker', ['exec', '-i', '-e', 'PGPASSWORD=hrm_dev_only', 'hrm-postgres',
      'psql', '-U', 'hrm', '-d', 'hrm', '-tAc', `DO $$
       DECLARE v_e UUID; v_u UUID;
       BEGIN
         SELECT id INTO v_e FROM employee WHERE employee_number = 'EMP006';
         IF v_e IS NULL THEN RETURN; END IF;
         SELECT id INTO v_u FROM app_user WHERE employee_id = v_e;
         IF v_u IS NULL THEN RETURN; END IF;
         DELETE FROM user_activation WHERE user_id = v_u;
         ALTER TABLE user_role DISABLE TRIGGER tg_user_role_immutable_history;
         DELETE FROM user_role WHERE user_id = v_u;
         ALTER TABLE user_role ENABLE ALWAYS TRIGGER tg_user_role_immutable_history;
         DELETE FROM session WHERE user_id = v_u;
         DELETE FROM app_user WHERE id = v_u;
       END $$;`], { encoding: 'utf8', stdio: 'pipe' });
    return true;
  } catch { return false; }
};

if (!resetFixture()) {
  note('B26 skipped - no docker, so the EMP006 fixture cannot be reset between runs');
} else {
  await signIn('deepa.suresh@panasatech.com');
  // Wait for the ROW, not for the page to have text. The shell renders before the directory
  // resolves, so `innerText.length > 200` is true while the table is still empty - which failed
  // this block on a cold server exactly as it failed B10 (see waitFor's comment).
  await goto(`${WEB}/employees`, 'document.body.innerText.length > 200');
  await waitFor('[...document.querySelectorAll("a")].some((a) => /Meera Nair/.test(a.textContent))');

  const opened = await evalJs(`(() => {
    const a = [...document.querySelectorAll('a')].find((x) => /Meera Nair/.test(x.textContent));
    if (!a) return { err: 'EMP006 Meera Nair is not in the directory' };
    a.click();
    return { ok: true };
  })()`);
  await sleep(1800);
  check('B26  HR opens the profile of an employee who has no login', !opened?.err,
    opened?.err ?? await evalJs('location.pathname'));

  // The panel does not fetch on render - a privileged read is not made just because somebody
  // opened a profile - so it has to be asked for.
  await evalJs(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find((x) => /^check login$/i.test(x.textContent.trim()));
    if (b) b.click();
    return true;
  })()`);
  const panel = await waitFor('document.querySelector("#acct-create")');
  check('B26a the Login panel loads on request and offers to create one', panel,
    panel ? 'create control present' : 'the panel never rendered');

  await evalJs(`document.querySelector('#acct-create').click()`);
  const shown = await waitFor(`document.body.innerText.match(/[23-9A-Z]{5}-[23-9A-Z]{5}-[23-9A-Z]{5}-[23-9A-Z]{5}/)`);
  const shownCode = await evalJs(`(() => {
    const m = document.body.innerText
      .match(/[23456789ABCDEFGHJKMNPQRSTVWXYZ]{5}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{5}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{5}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{5}/);
    return m ? m[0] : '';
  })()`);
  check('B26b creating the login shows a one-time code on screen', shown && !!shownCode,
    shownCode ? `${shownCode} (read off the page)` : 'no code rendered');

  check('B26c and the screen says plainly that it cannot be read again',
    (await evalJs('/cannot be read again|Shown once/i.test(document.body.innerText)')) === true);
  await shot('14-account-code');

  /*
   * The hand-over. A DIFFERENT session now - the employee has no session at all - so the code has
   * to work with nothing carried over from HR's browser state but the string itself.
   */
  await goto(`${WEB}/activate`, 'document.querySelector("#act-code")');
  const typed = await evalJs(`(() => {
    const set = (sel, v) => {
      const el = document.querySelector(sel);
      const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
      d.set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    // Typed LOWERCASE and with the dashes stripped, which is how somebody retyping it off a note
    // would get it. The field re-groups and upper-cases as they type.
    set('#act-code', ${JSON.stringify(String(shownCode).toLowerCase().replace(/-/g, ''))});
    set('#act-pw', 'a-passphrase-nobody-else-knows');
    set('#act-pw2', 'a-passphrase-nobody-else-knows');
    return { code: document.querySelector('#act-code').value };
  })()`);
  check('B26d the code is accepted lowercase and un-grouped, and re-formatted as typed',
    typed?.code === shownCode, `field shows ${typed?.code}`);

  await evalJs(`document.querySelector('#act-code').closest('form').requestSubmit()`);
  const activated = await waitFor('/login is ready|\\u062c\\u0627\\u0647\\u0632/i.test(document.body.innerText)', 15000);
  check('B26e the employee sets their own password through the real form', activated,
    activated ? await evalJs('document.querySelector("h1")?.textContent') : 'no confirmation shown');
  await shot('15-activated');

  // And it works: sign in as somebody who could not sign in ninety seconds ago.
  const inAsNew = await signIn('meera.nair@panasatech.com', 'a-passphrase-nobody-else-knows');
  check('B26f and can then sign in - the account is genuinely usable', inAsNew === true,
    inAsNew ? await evalJs('location.pathname') : 'sign-in failed');

  resetFixture();
  await signIn('deepa.suresh@panasatech.com');
}

/*
 * B27: THE ACTIVATION PAGE EXPLAINS ITSELF WHEN THE CODE IS WRONG.
 *
 * Reported from the screen as "unable to set password". The page had let arbitrary typing through
 * a filter that SILENTLY DELETED every character outside the code alphabet, so a few words became
 * `KANNA-NPANA-SATEC-HCM` - the exact shape of a real code - and then showed a disabled button
 * with no message. Three separate failures: input reshaped into something plausible, no
 * explanation of what was wrong, and no way out for somebody who has no code at all.
 *
 * B27a-d are that scenario, typed as it was typed. The important one is B27b: a control that
 * refuses in silence is the defect, so the button is now enabled and the form does the talking.
 */
console.log('\n3c. The activation page when the code is wrong');

await goto(`${WEB}/activate`, 'document.querySelector("#act-code")');
const junk = await evalJs(`(() => {
  const set = (sel, v) => {
    const el = document.querySelector(sel);
    const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
    d.set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  // What was actually typed on the screenshot: words, not a code.
  set('#act-code', 'kannan panasa tech hcm');
  set('#act-pw', 'a-passphrase-nobody-else-knows');
  set('#act-pw2', 'a-passphrase-nobody-else-knows');
  return { shows: document.querySelector('#act-code').value };
})()`);
await sleep(400);

/*
 * SOME explanation must appear - not one particular wording. The first version of this check
 * demanded the look-alike message and failed, because "kannan panasa tech hcm" happens to contain
 * only characters that ARE in the code alphabet: no O, I, L or U. Nothing was dropped, so the
 * page's honest complaint is the LENGTH, and it made it. The requirement is that typing words
 * cannot pass in silence, which is what this now asserts.
 */
const explained = await evalJs(`(() => {
  const m = document.body.innerText.match(/An activation code is [^<]{5,80}|never contain[^<]{5,80}/);
  return { found: !!m, text: m ? m[0].trim() : '' };
})()`);
check('B27a typing words no longer passes as a code shape without comment',
  explained?.found === true && String(explained?.text).length > 10,
  `field shows "${junk?.shows}" -> "${String(explained?.text).slice(0, 56)}"`);

const btn = await evalJs(`(() => {
  const b = document.querySelector('#act-submit');
  return { disabled: b?.disabled ?? null, text: b?.textContent?.trim() ?? '' };
})()`);
check('B27b the submit button is NOT a dead grey control - it can be pressed and answers',
  btn?.disabled === false, `disabled=${btn?.disabled}`);

await evalJs(`document.querySelector('#act-submit').click()`);
await sleep(700);
check('B27c pressing it explains the problem rather than doing nothing',
  (await evalJs('!!document.querySelector("#act-error") || /look-alike|never contain/i.test(document.body.innerText)')) === true,
  'a message, not silence');

// A code of the right alphabet but the wrong length says how far off it is.
await evalJs(`(() => {
  const el = document.querySelector('#act-code');
  const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
  d.set.call(el, 'ABCDE-FGHJK');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(400);
check('B27d an incomplete code says how many characters it has, not just "invalid"',
  (await evalJs('/you have 10|20 characters/i.test(document.body.innerText)')) === true,
  await evalJs(`(() => {
    const m = document.body.innerText.match(/An activation code is[^\\n]*/);
    return m ? m[0].slice(0, 62) : 'no count shown';
  })()`));

check('B27e and somebody who has no code at all is told what to do',
  (await evalJs('/No code\\?/.test(document.body.innerText)')) === true
  && (await evalJs('[...document.querySelectorAll("a")].some((a) => /sign in/i.test(a.textContent))')) === true,
  'points at HR, and back to sign in');
await shot('16-activate-wrong-code');

/*
 * B28: EVERY CARD BODY LINES UP WITH ITS OWN HEADING.
 *
 * Reported twice, from two different screens: the payslip document actions sat ~23px left of the
 * heading above them (B15a), and then the whole "Change assignment" form ran flush to the card
 * border while every card around it was inset. Same omission, different call sites - `Card`
 * carries no padding and `CardHead` supplies its own `px-4 sm:px-5`, so a body placed after a
 * head has to bring the same inset and several did not.
 *
 * MEASURED, NOT PATTERN-MATCHED. A source scan for "unpadded child of <Card>" produced over sixty
 * candidates across the app, nearly all of them a conditional wrapper whose inner content IS
 * padded, or a table that must span the full width - unusable as a signal. The browser knows both
 * left edges exactly, so the check is the subtraction, and it names every offender rather than
 * failing on the first.
 *
 * The tolerance is 2px for sub-pixel layout. A full-bleed body is legitimate - a table, a `<dl>`
 * with its own dividers, an `Empty` spanning the card - so only bodies that carry their own
 * horizontal padding are compared, which is exactly the set that is meant to align.
 */
const MEASURE_CARDS = `(() => {
  const out = [];
  for (const card of document.querySelectorAll('div.rounded-xl.border')) {
    const head = card.firstElementChild;
    if (!head || !head.className.includes('border-b')) continue;
    const title = head.querySelector('h2');
    if (!title) continue;
    const body = head.nextElementSibling;
    if (!body) continue;
    const bs = getComputedStyle(body);
    const padded = parseFloat(bs.paddingLeft) > 0 || parseFloat(bs.paddingRight) > 0;
    if (!padded) continue;
    const inner = body.firstElementChild ?? body;
    const t = title.getBoundingClientRect();
    const i = inner.getBoundingClientRect();
    if (i.width < 4 || i.height < 4) continue;
    out.push({ title: title.textContent.trim().slice(0, 26), off: Math.round(i.left - t.left) });
  }
  return out;
})()`;

console.log('\n3d. Card bodies line up with their headings');

await signIn('deepa.suresh@panasatech.com');
await goto(`${WEB}/employees`, 'document.body.innerText.length > 200');
await waitFor('[...document.querySelectorAll("a")].some((a) => /Meera Nair/.test(a.textContent))');
await evalJs(`(() => {
  [...document.querySelectorAll('a')].find((x) => /Meera Nair/.test(x.textContent))?.click();
  return true;
})()`);
await waitFor('/Assignment history/i.test(document.body.innerText)');

// Open the form that was reported, so it is measured rather than assumed.
await evalJs(`(() => {
  const b = [...document.querySelectorAll('button')]
    .find((x) => /change assignment|^change$/i.test(x.textContent.trim()));
  if (b) b.click();
  return true;
})()`);
const asgOpen = await waitFor('!!document.querySelector("#ca-effective") || /is currently/i.test(document.body.innerText)');
check('B28  the Change assignment form opens on the profile', asgOpen,
  asgOpen ? 'open' : 'the form never appeared');

const profileCards = await evalJs(MEASURE_CARDS);
const profileBad = (Array.isArray(profileCards) ? profileCards : []).filter((c) => Math.abs(c.off) > 2);
check('B28a every padded card body on the profile starts where its heading does',
  Array.isArray(profileCards) && profileCards.length > 0 && profileBad.length === 0,
  profileBad.length
    ? `OFF: ${profileBad.map((c) => `${c.title} ${c.off}px`).join(', ')}`
    : `${profileCards.length} cards, max offset 0px`);

// The payslip form, which is the other place it was reported.
await evalJs(`(() => {
  const b = [...document.querySelectorAll('button')]
    .find((x) => /add payslip/i.test(x.textContent.trim()));
  if (b) b.click();
  return true;
})()`);
const payOpen = await waitFor('/Pay period/i.test(document.body.innerText)');
check('B28b the Add payslip form opens', payOpen, payOpen ? 'open' : 'not offered on this profile');

if (payOpen) {
  const payCards = await evalJs(MEASURE_CARDS);
  const payBad = (Array.isArray(payCards) ? payCards : []).filter((c) => Math.abs(c.off) > 2);
  check('B28c and every card inside it lines up too',
    Array.isArray(payCards) && payCards.length > 0 && payBad.length === 0,
    payBad.length
      ? `OFF: ${payBad.map((c) => `${c.title} ${c.off}px`).join(', ')}`
      : `${payCards.length} cards, max offset 0px`);
  await shot('17-card-alignment');
}

/*
 * B29: THE ONBOARDING SCREEN, SEEN BY THE THREE PEOPLE WHO SHARE IT.
 *
 * `onboarding:test` proves the chain 24 ways through the API, including that HR cannot approve
 * what HR typed. What it cannot show is the screen: whether the queue renders, and whether the
 * sidebar offers it to the right people. That last part matters more than it looks - onboarding is
 * the first screen in this product shared by three roles who otherwise see nothing of each other's
 * work, and it needed a nav gate of its own because `hr` was too wide (it includes the read-only
 * auditor) and `hr_manage` too narrow (it excludes both approvers).
 *
 * The negative is the interesting one: an ordinary employee must not be offered it at all.
 */
console.log('\n3e. Onboarding, as the three roles who share it');

await signIn('deepa.suresh@panasatech.com');
await goto(`${WEB}/onboarding`, 'document.body.innerText.length > 200');
const hrSees = await waitFor('/Annexures|Onboarding/i.test(document.body.innerText)');
check('B29  HR opens the onboarding screen', hrSees,
  hrSees ? await evalJs('document.querySelector("h1")?.textContent') : 'never rendered');

check('B29a the queue is on screen with its status filter',
  (await evalJs('!!document.querySelector("#onb-filter")')) === true);

/*
 * B29g: THERE IS SOMEBODY TO PREPARE AN ANNEXURE FOR.
 *
 * Reported from the screen: "no employee listed". The form was correct and the roster was not -
 * every seeded person had already started, so the only people the form may offer (pre-boarding)
 * was an empty set, and the screen read as broken. A future joining date is the whole of what
 * makes somebody pre-boarding, and nothing said so, so an employee created with today's date was
 * active before HR got back to this screen.
 */
await clickUntil(`(() => {
  if (document.querySelector('#onb-emp')) return true;
  [...document.querySelectorAll('button')]
    .find((b) => /prepare annexure/i.test(b.textContent.trim()))?.click();
  return true;
})()`, 'document.querySelector("#onb-emp")');
const joiners = await evalJs(`(() => {
  const sel = document.querySelector('#onb-emp');
  if (!sel) return { err: 'the prepare form never opened' };
  return { options: [...sel.options].filter((o) => o.value).map((o) => o.textContent.trim()) };
})()`);
check('B29g the prepare form offers a joiner who has not started',
  Array.isArray(joiners?.options) && joiners.options.length > 0,
  joiners?.err ?? joiners?.options?.join(' | '));

check('B29b and the sidebar offers it',
  (await evalJs('[...document.querySelectorAll("nav a")].some((a) => /onboarding/i.test(a.textContent))')) === true);

// The finance head - a role that until now could not even be given a login.
const asFinance = await signIn('arun.thomas@panasatech.com');
await goto(`${WEB}/onboarding`, 'document.body.innerText.length > 200');
check('B29c the finance head can sign in at all, and reaches the same queue', asFinance
  && (await waitFor('!!document.querySelector("#onb-filter")')),
  `path=${await evalJs('location.pathname')}`);

check('B29d but is NOT offered the screens that administer people',
  (await evalJs('![...document.querySelectorAll("nav a")].some((a) => /^settings$/i.test(a.textContent.trim()))')) === true,
  'least privilege: they approve a package, they do not run HR');
await shot('18-onboarding-finance');

// The delivery head.
await signIn('nisha.varghese@panasatech.com');
await goto(`${WEB}/onboarding`, 'document.body.innerText.length > 200');
check('B29e the delivery head reaches it too',
  (await waitFor('!!document.querySelector("#onb-filter")')) === true);

// And an ordinary employee must not be offered it.
await signIn('vishnu.ravi@panasatech.com');
await goto(`${WEB}/`, 'document.querySelectorAll("nav a").length > 3');
check('B29f an ordinary employee is not offered onboarding at all',
  (await evalJs('![...document.querySelectorAll("nav a")].some((a) => /onboarding/i.test(a.textContent))')) === true,
  'the nav gate is three roles wide, and they are not one of them');

await signIn('deepa.suresh@panasatech.com');
await goto(`${WEB}/`, 'document.querySelectorAll("nav a").length > 3');

/*
 * B30: ROLES ARE A SET ON SCREEN, NOT A SLOT.
 *
 * `accounts:test` proves the endpoints, including that HR cannot grant themselves a role. What it
 * cannot show is that the panel presents roles as something you ADD to rather than something you
 * replace - which is the whole question that prompted this ("how can we assign multiple roles?").
 * A dropdown that swaps one role for another would pass every API check and still be the wrong
 * product.
 */
console.log('\n3f. Roles on an account');

await signIn('deepa.suresh@panasatech.com');
await goto(`${WEB}/employees`, 'document.querySelector("table")');
await waitFor('[...document.querySelectorAll("a")].some((a) => /Priya Menon/.test(a.textContent))');
await evalJs(`(() => {
  [...document.querySelectorAll('a')].find((a) => /Priya Menon/.test(a.textContent))?.click();
  return true;
})()`);
await waitFor('location.pathname.startsWith("/employees/")');
await goto(await evalJs('location.href'), 'document.body.innerText.includes("Login")');

const panelOpen = await clickUntil(`(() => {
  if (document.querySelector('#acct-add-role')) return true;
  [...document.querySelectorAll('button')]
    .find((b) => /^check login$/i.test(b.textContent.trim()))?.click();
  return true;
})()`, 'document.querySelector("#acct-add-role")');
check('B30  the Login panel shows the roles an account holds', panelOpen,
  panelOpen ? 'role editor present' : 'never rendered');

const roleState = await evalJs(`(() => {
  const sel = document.querySelector('#acct-add-role');
  const chips = [...document.querySelectorAll('li span')]
    .map((x) => x.textContent.trim()).filter((x) => /^(employee|manager|hr admin|finance|delivery head|hr ops|auditor)/.test(x));
  return {
    held: chips,
    offered: sel ? [...sel.options].filter((o) => o.value).map((o) => o.value) : [],
  };
})()`);
check('B30a it lists MORE THAN ONE role held, as chips',
  Array.isArray(roleState?.held) && roleState.held.length >= 2,
  (roleState?.held ?? []).join(' + '));

check('B30b and offers to ADD another rather than replace what is there',
  Array.isArray(roleState?.offered) && roleState.offered.length >= 3
  && !roleState.offered.includes('manager'),
  `offers ${(roleState?.offered ?? []).join(', ')} - already-held roles are not re-offered`);

check('B30c the base `employee` role has no remove control, the others do',
  (await evalJs(`(() => {
    const items = [...document.querySelectorAll('li')];
    const emp = items.find((li) => /^employee/.test(li.textContent.trim()));
    const mgr = items.find((li) => /^manager/.test(li.textContent.trim()));
    return !!emp && !!mgr && !emp.querySelector('button') && !!mgr.querySelector('button');
  })()`)) === true,
  'every account is also an employee');
await shot('19-account-roles');

/*
 * B31: BOTH APPROVALS, THROUGH THE REAL SCREENS, AS THE TWO DIFFERENT PEOPLE.
 *
 * `onboarding:test` proves the chain 24 ways through the API. What it cannot show is the thing
 * that was actually asked - "HR sent an annexure for approval, how does the finance head approve,
 * and check the delivery head too" - because that question is about which BUTTON each person is
 * offered on a shared screen, and when. The negative halves matter as much as the positive ones:
 * while an annexure sits with finance the delivery head must be offered NOTHING, and once it moves
 * the finance head must lose their control. A screen showing both buttons to both people would
 * pass every API test, because the API would still refuse - and the product would still be wrong.
 *
 * EVERY ASSERTION READS `#onb-status`, NOT THE PAGE TEXT. The first version of this block tested
 * `/With delivery/.test(document.body.innerText)` and three checks passed while nothing had
 * happened: "With delivery" is one of the options in the status-filter dropdown, so that string is
 * on the page permanently. The annexure was still sitting in finance_review the whole time.
 *
 * It also OWNS its subject rather than opening whatever row is first: any live annexure for the
 * joiner is withdrawn at the start, so exactly one exists and it is this block's.
 */
console.log('\n3g. The two approvals, on screen');

const statusNow = async () => evalJs('document.querySelector("#onb-status")?.dataset.status ?? null');
const buttonsNow = `[...document.querySelectorAll('button')].map((b) => b.textContent.trim())
  .filter((x) => /approve|send back|issue|withdraw|accepted|declined/i.test(x)).join(' | ')`;

/** Open the only annexure that is not in a terminal state. */
const openLive = async () => {
  await waitFor('document.querySelectorAll("tbody tr").length > 0');
  await clickUntil(`(() => {
    if (document.querySelector('#onb-status')) return true;
    const live = [...document.querySelectorAll('tbody tr')]
      .find((r) => !/Accepted|Declined|Withdrawn/.test(r.innerText));
    live?.querySelector('button')?.click();
    return true;
  })()`, 'document.querySelector("#onb-status")');
  return statusNow();
};

await signIn('deepa.suresh@panasatech.com');
await goto(`${WEB}/onboarding`, 'document.body.innerText.length > 200');

// Clear anything in flight, so this block's subject is unambiguous and it can run again.
for (let i = 0; i < 4; i++) {
  const live = await evalJs(`[...document.querySelectorAll('tbody tr')]
    .filter((r) => !/Accepted|Declined|Withdrawn/.test(r.innerText)).length`);
  if (Number(live) === 0) break;
  await openLive();
  const done = await evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /^withdraw$/i.test(x.textContent.trim()));
    if (!b) return false;
    window.prompt = () => 'cleared by the browser verification';
    b.click();
    return true;
  })()`);
  if (!done) break;
  await sleep(1200);
  await goto(`${WEB}/onboarding`, 'document.body.innerText.length > 200');
  await waitFor('document.querySelectorAll("tbody tr").length >= 0');
}

await clickUntil(`(() => {
  if (document.querySelector('#onb-emp')) return true;
  [...document.querySelectorAll('button')]
    .find((b) => /prepare annexure/i.test(b.textContent.trim()))?.click();
  return true;
})()`, 'document.querySelector("#onb-emp")');

const prepared = await evalJs(`(() => {
  const set = (sel, v) => {
    const el = document.querySelector(sel);
    const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
    d.set.call(el, v);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  };
  const emp = document.querySelector('#onb-emp');
  const opt = [...emp.options].find((o) => o.value);
  if (!opt) return { err: 'no pre-boarding joiner to prepare for' };
  set('#onb-emp', opt.value);
  set('#onb-ctc', '1000000');
  set('#onb-join', '2027-03-01');
  const nums = [...document.querySelectorAll('input.num')].filter((i) => i.id !== 'onb-ctc');
  const setEl = (el, v) => {
    const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
    d.set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  if (nums[0]) setEl(nums[0], '600000');
  if (nums[1]) setEl(nums[1], '400000');
  return { joiner: opt.textContent.trim() };
})()`);
await sleep(500);
check('B31  HR fills the prepare form for a joiner', !prepared?.err, prepared?.err ?? prepared?.joiner);

check('B31a the running total confirms the components agree with the CTC',
  (await evalJs('document.querySelector("#onb-create") && !document.querySelector("#onb-create").disabled')) === true,
  await evalJs(`(() => { const m = document.body.innerText.match(/Components total[^\n]*/); return m ? m[0] : ''; })()`));

const created = await clickUntil(`(() => {
  document.querySelector('#onb-create')?.click();
  return true;
})()`, '!document.querySelector("#onb-create")');
check('B31b the draft is created', created);

let st = await openLive();
check('B31c it opens as a draft', st === 'draft', `status=${st}`);

const sent = await clickUntil(`(() => {
  document.querySelector('#onb-submit')?.click();
  return true;
})()`, 'document.querySelector("#onb-status")?.dataset.status === "finance_review"');
check('B31d HR sends it to finance', sent, `status=${await statusNow()}`);

// THE DELIVERY HEAD, while it is still with finance: nothing to do.
await signIn('nisha.varghese@panasatech.com');
await goto(`${WEB}/onboarding`, 'document.body.innerText.length > 200');
st = await openLive();
check('B31e the delivery head is offered NOTHING while it sits with finance',
  st === 'finance_review' && (await evalJs(buttonsNow)) === '',
  `status=${st}, buttons=[${await evalJs(buttonsNow)}]`);

// THE FINANCE HEAD approves.
await signIn('arun.thomas@panasatech.com');
await goto(`${WEB}/onboarding`, 'document.body.innerText.length > 200');
await openLive();
const financeButtons = await evalJs(buttonsNow);
check('B31f the finance head IS offered the approval, and a way to send it back',
  /Approve \(finance\)/.test(String(financeButtons)) && /Send back/.test(String(financeButtons)),
  financeButtons);

const financeDone = await clickUntil(`(() => {
  document.querySelector('#onb-fin-approve')?.click();
  return true;
})()`, 'document.querySelector("#onb-status")?.dataset.status === "delivery_review"');
check('B31g finance approves, and it moves to the delivery head', financeDone,
  `status=${await statusNow()}`);

check('B31h and the finance head now has nothing left to do on it',
  !/Approve \(finance\)/.test(String(await evalJs(buttonsNow))),
  'their control disappears once the step is no longer theirs');

// THE DELIVERY HEAD, now that it is their turn.
await signIn('nisha.varghese@panasatech.com');
await goto(`${WEB}/onboarding`, 'document.body.innerText.length > 200');
await openLive();
const deliveryButtons = await evalJs(buttonsNow);
check('B31i the delivery head is NOW offered the approval',
  /Approve \(delivery\)/.test(String(deliveryButtons)), deliveryButtons);

const deliveryDone = await clickUntil(`(() => {
  document.querySelector('#onb-del-approve')?.click();
  return true;
})()`, 'document.querySelector("#onb-status")?.dataset.status === "delivery_approved"');
check('B31j the delivery head approves', deliveryDone, `status=${await statusNow()}`);

// HR issues, and the trail names both approvers.
await signIn('deepa.suresh@panasatech.com');
await goto(`${WEB}/onboarding`, 'document.body.innerText.length > 200');
await openLive();
const trail = await evalJs('document.body.innerText.replace(/\\s+/g, " ")');
check('B31k the trail names WHO approved at each step',
  /Finance approved . Arun Thomas/.test(String(trail))
  && /Delivery approved . Nisha Varghese/.test(String(trail)),
  'separation of duty is visible on the record, not only enforced');

check('B31l money is grouped the Indian way, not mangled',
  /10,00,000\.00/.test(String(trail)),
  'a second copy of formatPaise had rendered 1,00000.00 on the approval screen');
await shot('20-approvals');

const issued = await clickUntil(`(() => {
  document.querySelector('#onb-issue')?.click();
  return true;
})()`, 'document.querySelector("#onb-status")?.dataset.status === "offer_issued"');
check('B31m HR issues the offer letter', issued, `status=${await statusNow()}`);

const accepted = await clickUntil(`(() => {
  document.querySelector('#onb-accept')?.click();
  return true;
})()`, 'document.querySelector("#onb-status")?.dataset.status === "offer_accepted"');
check('B31n and records that it was accepted, which frees the joiner for a fresh offer',
  accepted, `status=${await statusNow()}`);

/*
 * ================================================================ THE PHONE LAYOUT
 *
 * Both checks below cover defects that every other suite in this repo was blind to, and that the
 * 2026-09-10 login/dashboard redesign found by taking screenshots at 390px.
 *
 * B32a THE HEADER SHOWED THE BRAND MARK TWICE below 640px. The shell rendered two lockups - a
 *      compact one for phones and a full one for desktop - and switched between them by passing
 *      `hidden sm:inline-flex` as ArtLogo's className. That lands TWO competing `display`
 *      utilities of equal specificity on one element, and which one wins is decided by their
 *      order in the generated stylesheet rather than in the class attribute. Tailwind emits
 *      `inline-flex` after `hidden`, so on a phone both rendered. Invisible at every desktop
 *      width, present since the sidebar shell was written, and not caught by anything.
 *
 * B32b THE DASHBOARD SCROLLED SIDEWAYS on a phone - 7px in English and 17px in Arabic, measured.
 *      Small enough to look like nothing and enough to make the whole page rock horizontally
 *      under a thumb. Asserted as `scrollWidth === clientWidth` on the document, in BOTH writing
 *      directions, because the Arabic figure was the worse of the two and an English-only check
 *      would have reported the page clean.
 */
console.log('\n3b. The phone layout');

await send('Emulation.setDeviceMetricsOverride', {
  width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
});

const noOverflow = `(() => {
  const de = document.documentElement;
  return { scrollW: de.scrollWidth, clientW: de.clientWidth, over: de.scrollWidth - de.clientWidth };
})()`;

for (const [loc, label] of [['en', 'English'], ['ar', 'Arabic']]) {
  await evalJs(`(() => { document.cookie = 'hrm_locale=${loc}; path=/; max-age=600'; return true; })()`);
  await goto(`${WEB}/`, NAV_READY);
  const o = await evalJs(noOverflow);
  check(`B32b the dashboard does not scroll sideways at 390px (${label})`,
    Number(o?.over) <= 0, `scrollWidth ${o?.scrollW} vs clientWidth ${o?.clientW}`);

  if (loc === 'en') {
    const marks = await evalJs(`(() => {
      const imgs = [...document.querySelectorAll('header img')]
        .filter((i) => /art-mark/.test(i.getAttribute('src') || ''))
        .filter((i) => { const r = i.getBoundingClientRect(); return r.width > 4 && r.height > 4; });
      return imgs.length;
    })()`);
    check('B32a exactly one brand mark is visible in the header at 390px',
      Number(marks) === 1,
      `${marks} visible - two means the compact and full lockups are both rendering`);
  }
}
await evalJs(`(() => { document.cookie = 'hrm_locale=en; path=/; max-age=600'; return true; })()`);
await send('Emulation.clearDeviceMetricsOverride');
await shot('21-dashboard-phone');

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
