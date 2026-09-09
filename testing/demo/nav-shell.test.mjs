/**
 * The application shell - that every door it offers actually opens.
 *
 * WHY THIS EXISTS AND WHAT IT IS NOT
 *
 * It is NOT an authorization test. Which links a role is offered is an affordance, and
 * `settings:test` already proves the API refuses a line manager who types the URL anyway
 * (DEC-053). Testing the list itself would mostly assert a constant.
 *
 * What is NOT a constant is the relationship between the list and the filesystem. A nav entry is
 * a hand-written string and the route it names is a directory; nothing in TypeScript connects
 * them, so `/timesheets` instead of `/timesheet` compiles, deploys, and gives whoever clicks it a
 * 404. Twelve entries today and six modules still to come makes that a matter of when.
 *
 * It also pins two naming rules that are otherwise only remembered:
 *   * no group may be titled with the unqualified word "Manager" - `domain-glossary.md` bans it
 *     because a line manager and a project manager resolve through DIFFERENT authorization
 *     graphs, and calls the ambiguity "a security bug waiting to happen";
 *   * the employee directory is not labelled "People" - a Person survives rehire and may hold two
 *     employments, so the two words mean different things in this domain.
 *
 * Reads the nav out of the source rather than duplicating it, so the test cannot drift into
 * agreeing with itself.
 *
 * Run: npm run nav:test   (needs the web server on :3100)
 */

import { readFileSync } from 'node:fs';

const WEB = 'http://localhost:3100';
const LAYOUT = 'apps/web/app/(app)/layout.tsx';

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  OK   ${name}${detail ? `  — ${detail}` : ''}`); return; }
  fail++; failures.push(`${name}${detail ? `  — ${detail}` : ''}`);
  console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`);
};

const src = readFileSync(LAYOUT, 'utf8');

/*
 * THE CHECKS IN SECTION 4 READ CODE, NOT PROSE - and they had to learn that the hard way.
 *
 * They first ran against the raw file and both failed, because the layout's own comments EXPLAIN
 * the rejected `top-[57px]` / `h-screen` approach in order to stop somebody reinstating it. The
 * test was reading the argument against the mistake as the mistake. Comments are stripped first,
 * so a file may discuss a banned pattern as long as it does not use one.
 */
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')            // block comments, JSX {/* ... */} bodies included
  .split(/\r?\n/)
  .filter((l) => !/^\s*(\/\/|\*)/.test(l))     // line comments and continuation lines
  .join('\n');

// The nav block only - so a href appearing elsewhere in the file (the logo's `/`, the profile
// badge) is not mistaken for a nav entry.
const navBlock = src.slice(src.indexOf('const NAV_GROUPS'), src.indexOf('export default'));
const hrefs = [...new Set([...navBlock.matchAll(/href:\s*'([^']+)'/g)].map((m) => m[1]))];
const titles = [...navBlock.matchAll(/title:\s*'([^']+)'/g)].map((m) => m[1]);
const labels = [...navBlock.matchAll(/label:\s*'([^']+)'/g)].map((m) => m[1]);

console.log('Application shell - navigation\n');

console.log('1. The nav was parsed at all');
check('nav entries found in the layout', hrefs.length >= 10, `${hrefs.length} destinations`);
check('group titles found', titles.length >= 3, titles.join(', '));

console.log('\n2. Every door the shell offers actually opens');
for (const href of hrefs) {
  const res = await fetch(WEB + href, { redirect: 'manual' });
  // 200 is the page; a redirect is the sign-in bounce and still proves the route exists. A 404
  // means the nav names a directory that is not there.
  check(`${href} resolves`, res.status !== 404, `status=${res.status}`);
}

console.log('\n3. Naming rules the glossary states, enforced rather than remembered');
const badTitle = titles.find((t) => /\bmanagers?\b/i.test(t));
check('no group is titled with the unqualified word "Manager"', !badTitle,
  badTitle
    ? `"${badTitle}" - say line manager or project manager; the two are different graphs`
    : titles.join(' · '));

check('the employee directory is not labelled "People"',
  !labels.includes('People'),
  'a Person survives rehire and may hold two employments; this screen lists employments');

check('the reporting-line group exists and is named for the line, not the role',
  titles.some((t) => /team/i.test(t)), titles.join(' · '));

console.log('\n4. The shell does not reintroduce a hand-measured header height');
check('no hardcoded header offset in the sidebar',
  !/top-\[\d+px\]|calc\(100vh-\d+px\)/.test(code),
  'the flex column sizes itself; a magic number silently breaks when the avatar or padding moves');
check('the viewport height is dvh, not vh',
  /h-dvh/.test(code) && !/\bh-screen\b/.test(code),
  '100vh includes mobile browser chrome and pushes the layout under the URL bar');

console.log('');
if (fail) { console.log('FAILURES:'); for (const f of failures) console.log(`  ${f}`); }
console.log(`${fail === 0 ? 'NAV SHELL OK' : 'NAV SHELL FAILED'} (${pass} passed, ${fail} failed)`);

/*
 * `process.exitCode`, NOT `process.exit()`.
 *
 * `process.exit(0)` here aborted with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` and
 * left the shell with **127** - after printing NAV SHELL OK. This section makes a dozen requests
 * to one host, so undici holds keep-alive sockets open, and tearing the loop down under them
 * trips libuv on Windows.
 *
 * A suite that reports success and exits non-zero is worse than no suite: it either blocks a gate
 * for a reason nobody can find, or gets deleted. Setting the code and letting Node drain its own
 * handles is both correct and quieter - the other suites get away with `process.exit` because
 * they make fewer connections, which is luck rather than a reason to copy them.
 */
process.exitCode = fail === 0 ? 0 : 1;
