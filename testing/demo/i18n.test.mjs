/**
 * Bilingual support: English and Arabic, and right-to-left layout.
 *
 * WHAT THIS CAN AND CANNOT CHECK, stated up front because the gap matters.
 *
 * There is no browser in this repo's toolchain - Playwright is named in the stack description and
 * is not installed - so nothing here executes JavaScript. That rules out asserting the rendered
 * Arabic nav, because the shell fetches `/auth/me` and renders its navigation client-side; a
 * `curl` of an authenticated page returns the loading state in either language. **A real browser
 * pass on the Arabic UI is therefore still outstanding** and is called out in the handover rather
 * than quietly skipped.
 *
 * What IS checked here, and each of these caught something real:
 *
 *   L1-L4  `lang` and `dir` on the server-rendered HTML, per locale, plus a bogus cookie value.
 *          The first implementation exported `isLocale` from a `'use client'` module and called
 *          it from the root layout - which compiled, and then 500'd every page with "Attempted
 *          to call isLocale() from the server". `next build` passing is not evidence that a
 *          server/client boundary is right, and only an HTTP check finds it.
 *   L5     the skip link is translated in the SSR output, which proves the provider receives the
 *          server-resolved locale rather than defaulting.
 *   D1-D3  the dictionary itself: every English key present in Arabic, no extra keys, and no
 *          Arabic value left identical to its English source. The type system already forbids
 *          the first two - `ar` is annotated with a type derived from `en` - so these are
 *          defence in depth for the case where somebody widens the type to `Record<string,
 *          string>` to make an error go away.
 *   D4     every Arabic value actually contains Arabic script. A key copied across untranslated
 *          is invisible to the type system and to the build.
 *   R1     the translated screens use LOGICAL CSS properties, not left/right ones. `ml-2` and
 *          `text-right` do not flip with `dir`, so in Arabic a margin lands on the wrong side of
 *          its label and a numeric column aligns away from its own edge. This is the check that
 *          keeps RTL working as those files change.
 *   T1     the translated screens hold no hardcoded English in the props that render text.
 *
 * Run: npm run i18n:test   (needs the web server on :3100)
 */

import { globSync, readFileSync } from 'node:fs';
import { sep } from 'node:path';

const WEB = 'http://localhost:3100';
const DICT = 'apps/web/lib/i18n/dictionary.ts';

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  OK   ${name}${detail ? `  — ${detail}` : ''}`); return; }
  fail++; failures.push(`${name}${detail ? `  — ${detail}` : ''}`);
  console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`);
};

const get = async (path, cookie) => {
  const res = await fetch(WEB + path, { headers: cookie ? { cookie } : {} });
  return { status: res.status, html: await res.text() };
};

const htmlTag = (html) => (html.match(/<html[^>]*>/) ?? [''])[0];

// ================================================================ 1. the document element
console.log('\n1. lang and dir, server-rendered\n');

const enPage = await get('/login');
check('L1  English: lang="en" dir="ltr"',
  /lang="en"/.test(htmlTag(enPage.html)) && /dir="ltr"/.test(htmlTag(enPage.html)),
  htmlTag(enPage.html).slice(0, 70));

const arPage = await get('/login', 'hrm_locale=ar');
check('L2  Arabic: lang="ar" dir="rtl"',
  /lang="ar"/.test(htmlTag(arPage.html)) && /dir="rtl"/.test(htmlTag(arPage.html)),
  htmlTag(arPage.html).slice(0, 70));

const bogus = await get('/login', 'hrm_locale=zz');
check('L3  an unknown locale falls back to English rather than crashing',
  bogus.status === 200 && /lang="en"/.test(htmlTag(bogus.html)),
  `status=${bogus.status} ${htmlTag(bogus.html).slice(0, 40)}`);

// The 500 this catches was invisible to `next build`; see the header.
check('L4  no page errors while resolving the locale',
  !/__next_error__/.test(enPage.html) && !/__next_error__/.test(arPage.html),
  'a server/client boundary mistake renders <html id="__next_error__">');

check('L5  the skip link is translated in the SSR output',
  /Skip to content/.test(enPage.html) && /الانتقال إلى المحتوى/.test(arPage.html),
  'proves the provider gets the server-resolved locale, not a default');

// ================================================================ 2. the dictionary
console.log('\n2. The translation resources\n');

const src = readFileSync(DICT, 'utf8');
const slice = (start, end) => src.slice(src.indexOf(start), src.indexOf(end));
const parse = (block) => new Map(
  [...block.matchAll(/^\s*'([^']+)':\s*'((?:[^'\\]|\\.)*)',?\s*$/gm)]
    .map((m) => [m[1], m[2].replace(/\\'/g, "'")]),
);

const enDict = parse(slice('const en = {', '} as const;'));
const arDict = parse(slice('const ar: Dictionary = {', '\n};'));

check('D0  both dictionaries parsed', enDict.size > 100 && arDict.size > 100,
  `en=${enDict.size} ar=${arDict.size} keys`);

const missing = [...enDict.keys()].filter((k) => !arDict.has(k));
check('D1  every English key has an Arabic value', missing.length === 0,
  missing.length ? `MISSING: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ` (+${missing.length - 8})` : ''}` : `${enDict.size} keys`);

const extra = [...arDict.keys()].filter((k) => !enDict.has(k));
check('D2  Arabic has no key English does not', extra.length === 0,
  extra.length ? `EXTRA: ${extra.slice(0, 8).join(', ')}` : 'none');

/*
 * A value copied across untranslated is the failure the type system cannot see: `ar` still has
 * every key, still type-checks, still builds, and shows English on the Arabic screen. Both of the
 * checks below exist for that one mistake, from opposite directions.
 */
const identical = [...enDict.entries()].filter(([k, v]) => arDict.get(k) === v);
check('D3  no Arabic value is byte-identical to its English source', identical.length === 0,
  identical.length ? `UNTRANSLATED: ${identical.slice(0, 6).map(([k]) => k).join(', ')}` : 'none');

const ARABIC = /[؀-ۿ]/;
const noArabic = [...arDict.entries()]
  // A value that is only a placeholder and punctuation has no letters to translate.
  .filter(([, v]) => !ARABIC.test(v) && /[A-Za-z]{3}/.test(v.replace(/\{\w+\}/g, '')));
check('D4  every Arabic value containing words contains Arabic script', noArabic.length === 0,
  noArabic.length ? `NO ARABIC: ${noArabic.slice(0, 6).map(([k]) => k).join(', ')}` : `${arDict.size} values`);

// ================================================================ 3. RTL-safe styling
console.log('\n3. Right-to-left safety in the translated screens\n');

/*
 * EVERY screen, not a list that has to be maintained.
 *
 * This was eight hand-written paths, which is exactly the list that goes stale: a new screen is
 * added, nobody remembers to append it, and the RTL and hardcoded-string checks silently stop
 * covering the newest code. Globbing means a file is covered the moment it exists.
 */
const TRANSLATED = globSync('apps/web/{app,components}/**/*.tsx')
  .filter((f) => !f.includes('node_modules') && !f.includes('.next'))
  .map((f) => f.split(sep).join('/'));

/*
 * Comments are stripped before scanning.
 *
 * These files EXPLAIN why `ml-`/`text-right` were replaced, so that nobody reinstates them - and
 * the first version of this check read those explanations as violations. Exactly the trap
 * `nav-shell.test.mjs` documents: a file may discuss a banned pattern as long as it does not use
 * one.
 */
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

// Physical direction utilities inside a className. `mt-`/`mb-` are vertical and unaffected.
/*
 * `left-1/2` paired with `-translate-x-1/2` is the CENTERING idiom, not a direction choice: it
 * puts the element's own midpoint at the viewport's midpoint, which is the same place in both
 * writing directions. Tailwind has no logical equivalent, and rewriting it as `start-1/2` would
 * actually move the toast in Arabic. So that pair is exempt; a bare `left-`/`right-` is not.
 */
const CENTERING = /left-1\/2[^"`]*-translate-x-1\/2|-translate-x-1\/2[^"`]*left-1\/2/;
const PHYSICAL = /\b(?:ml|mr|pl|pr)-[0-9[]|\btext-(?:left|right)\b|\b(?:left|right)-[0-9[]/;

const offenders = [];
for (const f of TRANSLATED) {
  const code = stripComments(readFileSync(f, 'utf8'));
  for (const m of code.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    const cls = m[1] ?? m[2] ?? '';
    if (PHYSICAL.test(cls) && !CENTERING.test(cls)) {
      offenders.push(`${f.split('/').pop()}: ${cls.slice(0, 60)}`);
    }
  }
}
check('R1  no physical left/right utilities in the translated screens', offenders.length === 0,
  offenders.length ? offenders.slice(0, 5).join(' | ') : `${TRANSLATED.length} files clean`);

// ================================================================ 4. no hardcoded English
console.log('\n4. Strings come from the dictionary\n');

/*
 * Scans the PROPS THAT RENDER TEXT - title, hint, label, placeholder - for a quoted literal
 * rather than a `t(...)` call. Deliberately narrow: a general "find English in JSX" scan produces
 * mostly false positives on class names, ids and aria roles, and a check nobody trusts gets
 * deleted the first time it cries wolf.
 */
const TEXT_PROP = /\s(?:title|hint|label|placeholder|emptyHint)="([^"]{4,})"/g;
const hardcoded = [];
for (const f of ['apps/web/app/(app)/attendance/page.tsx',
  'apps/web/app/(app)/work/page.tsx',
  'apps/web/app/(app)/team/page.tsx',
  'apps/web/app/(app)/masters/work-management/page.tsx',
  'apps/web/components/period-picker.tsx']) {
  const code = stripComments(readFileSync(f, 'utf8'));
  for (const m of code.matchAll(TEXT_PROP)) {
    hardcoded.push(`${f.split('/').pop()}: ${m[1].slice(0, 44)}`);
  }
}
check('T1  the translated screens pass no hardcoded text props', hardcoded.length === 0,
  hardcoded.length ? hardcoded.slice(0, 5).join(' | ') : '5 files clean');

// ================================================================ 5. nothing English is left
console.log('\n5. No untranslated user-facing string survives\n');

/*
 * WHAT IS DELIBERATELY EXEMPT, and why each one.
 *
 * The requirement says to preserve technical identifiers and API values where translating them
 * would be wrong. These are those, enumerated rather than pattern-matched, so adding a new
 * English string cannot hide behind a loose rule:
 *
 *   * the BRAND WORDMARK - 'ART', 'ART HRM'. A wordmark is a logo rendered in type, not a label;
 *     transliterating it in the sidebar would be like translating a company's logo file. The
 *     accessible NAME of the app is translated (`app.name`), which is the part a screen reader
 *     reads out.
 *   * FORM PLACEHOLDERS showing the shape of an identifier or a value - 'ENG', 'SE', 'EMP006',
 *     'meera.nair@panasatech.com', '0.00', '1 to 20'. A department code and an email address have
 *     the same shape in every language; translating the example makes it less useful, not more.
 *     'Engineering', 'Senior Engineer', 'Promoted to Senior Engineer' and
 *     'Delivery reorganisation' are the same thing - sample content in a placeholder attribute.
 *   * 'ADR-0005' - a document reference. A reader who cannot then find the document is worse off.
 *   * the DEMO PEOPLE - 'Vishnu Ravi', 'Priya Menon', 'Deepa Suresh'. These are seed DATA rendered
 *     from a constant, not UI copy. Translating a person's name would be wrong in any product.
 */
const EXEMPT = new Set([
  'ART', 'ART HRM',
  'ENG', 'SE', 'Engineering', 'Senior Engineer', 'Delivery reorganisation', '1 to 20',
  'EMP006', 'Meera Nair', 'meera.nair@panasatech.com', 'Promoted to Senior Engineer',
  '0.00', 'ADR-0005',
  'Vishnu Ravi', 'Priya Menon', 'Deepa Suresh',
]);

const PROPS = /\s(?:title|hint|label|placeholder|emptyHint|sub|aria-label)="([^"]{2,})"/g;
const JSXTEXT = />\s*([A-Z][^<>{}\n]{3,})\s*</g;
const OBJTEXT = /(?:msg|message|title|hint|label|error|toast):\s*'([^']{4,})'/g;

const stragglers = [];
for (const f of TRANSLATED) {
  const code = stripComments(readFileSync(f, 'utf8'));
  for (const rx of [PROPS, JSXTEXT, OBJTEXT]) {
    rx.lastIndex = 0;
    for (const m of code.matchAll(rx)) {
      const v = m[1].trim();
      // Lowercase single words are API values ('attendance', 'employment'), not prose.
      if (!v || v.startsWith('{') || /^[a-z-]+$/.test(v) || EXEMPT.has(v)) continue;
      stragglers.push(`${f.split('/').pop()}: ${v.slice(0, 46)}`);
    }
  }
}
check('E1  every user-facing string comes from the dictionary', stragglers.length === 0,
  stragglers.length
    ? `${stragglers.length} left: ${stragglers.slice(0, 4).join(' | ')}`
    : `${TRANSLATED.length} files, ${EXEMPT.size} documented exemptions`);

// A locale is only useful if the SCREENS use it. Counting t() calls per file catches a screen
// that was skipped entirely, which the straggler scan above cannot see (a file with no strings
// and a file that was never converted look identical to it).
// `logo.tsx` renders the WORDMARK - "ART HRM" set as type, which is a logo rather than a label.
// It has no translatable string by design, so it is the one file allowed to contain none. Its
// accessible name comes from `app.name`, which IS translated.
const WORDMARK = 'apps/web/components/logo.tsx';
const unconverted = TRANSLATED.filter((f) => f !== WORDMARK).filter((f) => {
  const code = stripComments(readFileSync(f, 'utf8'));
  const hasText = />\s*[A-Z][^<>{}\n]{3,}\s*</.test(code)
    || /\s(?:title|hint|label|placeholder)="[^"]{4,}"/.test(code);
  return hasText && !code.includes("t('");
});
check('E2  no screen with visible text was skipped entirely', unconverted.length === 0,
  unconverted.length ? unconverted.join(', ') : `${TRANSLATED.length} files checked`);

// ---------------------------------------------------------------- result
console.log(`\n${'='.repeat(37)}\n  ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log('  I18N OK\n');
