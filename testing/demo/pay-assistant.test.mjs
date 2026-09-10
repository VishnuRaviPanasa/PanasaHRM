#!/usr/bin/env node
/**
 * PAY IN THE ASSISTANT. ADR-0021.
 *
 *   node testing/demo/pay-assistant.test.mjs
 *   HRM_API_BASE=http://localhost:4001/api node ...        (against a spare API)
 *
 * NO MODEL IS DRIVEN HERE, and for these tools that is not merely convenient - it is the thing
 * under test. ADR-0021 permitted the assistant to report pay on one condition: *"NO PAY FIGURE
 * IS SENT TO A MODEL PROVIDER."* So a pay tool composes its own sentence and the controller
 * returns before `buildAnswerPayload` is called. Section 2 asserts that as the ABSENCE of
 * `modelPayload`, which is a property of the code rather than a claim in a comment.
 *
 * WHAT THIS SUITE OWNS, AND WHAT IT LEAVES TO THE RED TEAM. The red team reads the catalogue
 * from `/assistant/capabilities`, so it already covers these tools for scope leaks, payload
 * leaks and the (tool x role) matrix - and since ADR-0021 it asserts the no-payload rule for
 * every pay tool at every role. What it does not know is what the SENTENCES say, and a
 * hand-written sentence is the new failure surface: a wrong figure, a wrong owner, or Indian
 * digit grouping that renders a lakh as `1,00000.00`.
 *
 * THAT LAST ONE IS NOT HYPOTHETICAL. `apps/web/components/payslips.tsx` shipped exactly that
 * bug - `(\d{2})+` where the grouping needs `(\d{2})*` - on the screen where somebody approves
 * an annexure. `formatPaise` now exists twice (once in the web, once in `payroll.ts`, because
 * ADR-0021 requires the sentence to be built in the API and the API cannot import from the
 * frontend workspace), so section 4 pins the two implementations to each other over the same
 * inputs. Two copies that agree are a duplication; two that silently disagree are the bug.
 */

const B = process.env.HRM_API_BASE ?? 'http://localhost:4000/api';
const PASSWORD = process.env.HRM_DEMO_PASSWORD ?? 'panasa2026';

const ACCOUNTS = {
  employee: 'vishnu.ravi@panasatech.com',
  manager: 'priya.menon@panasatech.com',
  hr_admin: 'deepa.suresh@panasatech.com',
  auditor: 'rahul.nair@panasatech.com',
};

const PAY_TOOLS = ['pay_my_payslip', 'pay_employee_payslip', 'pay_payslip_document',
  'onboarding_annexure_amounts'];

let jar = '';

async function call(path, init = {}) {
  const res = await fetch(`${B}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(jar ? { cookie: jar } : {}), ...init.headers },
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) jar = set.map((c) => c.split(';')[0]).join('; ');
  let body = null;
  try { body = await res.json(); } catch { /* empty or SSE */ }
  return { status: res.status, ok: res.ok, body };
}

const login = async (email) => {
  jar = '';
  const r = await call('/auth/login', { method: 'POST', body: JSON.stringify({ email, password: PASSWORD }) });
  if (!r.ok) throw new Error(`login ${email} -> ${r.status}`);
  return r.body.actor;
};

const run = (tool, args = {}) =>
  call('/assistant/run', { method: 'POST', body: JSON.stringify({ tool, args }) });

/** Every tool offered to the current session, across all routing domains. */
const offeredTools = async () => {
  const caps = await call('/assistant/capabilities');
  return Object.values(caps.body?.domains ?? {}).flat();
};

let pass = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; return true; }
  failures.push(`${name}${detail ? `  -- ${detail}` : ''}`);
  return false;
};

console.log(`PAY IN THE ASSISTANT  (no model in the loop)   ${B}\n`);

// ---------------------------------------------------------------------------
// 1. Who is offered what
// ---------------------------------------------------------------------------
console.log('1. The catalogue offers pay tools exactly where the policy already did');
{
  /*
   * `payroll.payslip.read` admits the SUBJECT always plus hr_admin and finance for everyone, and
   * DENIES hr_ops, auditor and delivery_head. `onboarding.annexure.read` is the opposite shape:
   * the four approval-chain roles, never the subject.
   *
   * So an `auditor` may read the annexure amounts but not a colleague's payslip - and the
   * asymmetry is the most easily broken thing here, because "auditor" reads as broadly
   * privileged and `policies.ts` contradicts that intuition.
   *
   * ROLES ARE ADDITIVE, WHICH CAUGHT ME OUT WRITING THIS. `demo.sql` grants `employee` to every
   * account - *"Roles are ADDITIVE: a manager is also an employee"* - so the auditor DOES hold
   * `payroll.payslip.read` for themselves, and being offered `pay_my_payslip` is correct rather
   * than a leak. The `auditor: deny` cell is about OTHER people's pay, so that is what P4b
   * asserts. A test that read the cell as "no payslip tool at all" would have been asserting
   * something the policy never said.
   */
  await login(ACCOUNTS.employee);
  let offered = (await offeredTools()).map((t) => t.name);
  check('P1 an employee is offered their own payslip tool',
    offered.includes('pay_my_payslip'),
    'the subject is always admitted by payroll.payslip.read - "a wage slip is something the '
    + 'person paid is entitled to see"');
  check('P2 an employee is NOT offered the annexure amounts',
    !offered.includes('onboarding_annexure_amounts'),
    'onboarding.annexure.read denies the subject and their line manager');

  await login(ACCOUNTS.auditor);
  offered = (await offeredTools()).map((t) => t.name);
  check('P3 an auditor is offered the annexure amounts', offered.includes('onboarding_annexure_amounts'),
    'the auditor holds onboarding.annexure.read');
  check('P4a an auditor is offered their OWN payslip, via the employee role they also hold',
    offered.includes('pay_my_payslip'),
    'roles are additive (demo.sql: "a manager is also an employee"), and every employee may '
    + 'read their own wage slip - the auditor CELL being deny is about OTHER people');

  /*
   * THE CELL THAT MATTERS. `auditor: deny` on `payroll.payslip.read` is about somebody else's
   * pay, and this is the assertion that proves it - reading the audit trail is not reading pay.
   */
  const other = await run('pay_employee_payslip', { employeeNumber: 'EMP001' });
  check('P4b an auditor cannot reach anybody else\'s payslip',
    other.body?.refusal?.code === 'not_permitted' || (other.body?.rowCount ?? 0) === 0,
    `got ${other.body?.refusal?.code ?? (other.body?.rowCount + ' rows')}`);

  await login(ACCOUNTS.hr_admin);
  const hrTools = await offeredTools();
  offered = hrTools.map((t) => t.name);
  check('P5 hr_admin is offered every pay tool',
    PAY_TOOLS.every((n) => offered.includes(n)),
    `offered ${offered.filter((x) => PAY_TOOLS.includes(x)).join(',')}`);

  /*
   * THE CATALOGUE DECLARES WHICH TOOLS CARRY MONEY, and it must be exactly the four - so a fifth
   * tool that starts returning a figure without declaring it fails here rather than quietly
   * bypassing the no-payload rule that keys off the flag.
   */
  const declared = hrTools.filter((t) => t.money).map((t) => t.name).sort();
  check('P5b the money flag is declared on exactly the pay tools',
    JSON.stringify(declared) === JSON.stringify([...PAY_TOOLS].sort()),
    `declared ${declared.join(',')}`);
}

// ---------------------------------------------------------------------------
// 2. ADR-0021 section 2 - no figure reaches a provider
// ---------------------------------------------------------------------------
console.log('2. No pay tool builds an answer payload, at any role, in any outcome');
{
  for (const [label, email] of Object.entries(ACCOUNTS)) {
    await login(email);
    for (const tool of PAY_TOOLS) {
      const r = await run(tool);
      if (r.body?.refusal) continue;             // a refusal sends nothing anywhere

      check(`P6 [${label}] ${tool} builds no payload`, r.body?.modelPayload === null,
        'ADR-0021 s2: a pay figure must never be transmitted to the provider, and a built '
        + 'payload is exactly how it would be');

      /*
       * AND IT MUST STILL HAVE ANSWERED. "No payload" is trivially satisfiable by returning
       * nothing at all, so the sentence is asserted beside it - including for the empty cases,
       * which is why `empty()` in `tools-pay.ts` carries one.
       */
      check(`P7 [${label}] ${tool} answers with its own sentence`,
        typeof r.body?.sentence === 'string' && r.body.sentence.length > 0,
        'no payload AND no sentence is a turn with no answer');
    }
  }
}

// ---------------------------------------------------------------------------
// 3. The sentences are true
// ---------------------------------------------------------------------------
console.log('3. A pay sentence states the right owner and the right figure');
{
  const actor = await login(ACCOUNTS.employee);
  const r = await run('pay_my_payslip');
  const rows = r.body?.rows ?? [];

  if (check('P8 the employee has payslips to describe', rows.length > 0,
    'nothing to assert against - seed payslips before trusting this section')) {
    const s = r.body.sentence;

    check('P9 a self sentence says "Your", never the name', /\bYour\b/.test(s),
      `sentence was "${s}"`);

    /*
     * THE FIGURE IN THE SENTENCE MUST BE THE FIGURE IN THE ROW. Recomputed here from
     * `net_minor` by the same text-slicing rule, so a sentence built from the wrong column, or
     * divided by 100 in a float somewhere, fails rather than merely looking plausible.
     */
    const group = (paise) => {
      const d = String(paise).replace(/\D/g, '').padStart(3, '0');
      return `${d.slice(0, -2).replace(/\B(?=(\d{2})*(\d{3})$)/g, ',')}.${d.slice(-2)}`;
    };
    const expected = group(rows[0].net_minor);
    check('P10 the sentence carries the net from the row', s.includes(expected),
      `expected ${expected} from net_minor=${rows[0].net_minor}; sentence was "${s}"`);

    check('P11 no raw paise integer appears in the sentence',
      !new RegExp(`\\b${String(rows[0].net_minor)}\\b`).test(s),
      'an unformatted minor-unit value means the figure was never rendered');

    // Every row the tool returned should be accounted for, so a multi-payslip answer cannot
    // quietly describe only the first.
    if (rows.length > 1) {
      check('P12 a multi-row answer is a bullet per payslip',
        (s.match(/^- /gm) ?? []).length === rows.length,
        `${(s.match(/^- /gm) ?? []).length} bullets for ${rows.length} rows`);
    }
  }

  // The annexure amounts, which is the question that prompted ADR-0021.
  await login(ACCOUNTS.hr_admin);
  const a = await run('onboarding_annexure_amounts');
  if (check('P13 there is an annexure to describe', (a.body?.rows ?? []).length > 0)) {
    const s = a.body.sentence;
    check('P14 the annexure sentence names the CTC and the joiner',
      /CTC/i.test(s) && /₹/.test(s) && new RegExp(a.body.rows[0].employee_number).test(s),
      `sentence was "${s}"`);
    /*
     * THE STAGE, NOT ONE PHRASING OF IT. This pinned the literal "annexure is at", which broke
     * the moment a second candidate existed and the sentence became one bullet each ("at draft")
     * rather than prose ("The annexure is at draft."). The property that matters is that a
     * figure never appears without the stage beside it - a CTC on an unapproved annexure is a
     * plan, not a commitment - so the check names the STATUS VOCABULARY instead of the sentence
     * around it.
     */
    check('P15 the stage appears beside the figure',
      /(draft|finance review|delivery review|delivery approved|offer issued|offer accepted|offer declined|withdrawn)/i.test(s),
      `no annexure status in "${s}" - a figure without its stage reads as a commitment`);
  }
}

// ---------------------------------------------------------------------------
// 4. The two money formatters agree
// ---------------------------------------------------------------------------
console.log('4. The API and web paise formatters agree, digit for digit');
{
  const { formatPaise } = await import('../../apps/api/dist/payroll.js');

  /** The web copy, `apps/web/components/payslips.tsx`, transcribed. */
  const web = (paise) => {
    if (paise === null || paise === undefined || paise === '') return '—';
    const s = String(paise);
    const neg = s.startsWith('-');
    const digits = (neg ? s.slice(1) : s).replace(/\D/g, '').padStart(3, '0');
    const whole = digits.slice(0, -2);
    const frac = digits.slice(-2);
    const grouped = whole.replace(/\B(?=(\d{2})*(\d{3})$)/g, ',');
    return `${neg ? '-' : ''}${grouped}.${frac}`;
  };

  /*
   * The boundaries that matter for INDIAN grouping, which is where a naive implementation
   * breaks: the first comma falls after three digits and every one after it after two.
   * `10000000` (a crore) and `100000` (a lakh) are the two that caught the web bug.
   */
  const CASES = ['0', '1', '99', '100', '999', '1000', '99999', '100000', '123456',
    '1000000', '10000000', '1234567890', '9007199254740993', '-500000', null, ''];

  for (const c of CASES) {
    check(`P16 formatPaise(${JSON.stringify(c)}) matches the web copy`,
      formatPaise(c) === web(c),
      `api=${formatPaise(c)} web=${web(c)}`);
  }

  // Spot-check the grouping itself, so both being wrong the same way still fails.
  const EXPECT = {
    '100000': '1,000.00',
    '10000000': '1,00,000.00',
    '1000000000': '1,00,00,000.00',
    '12345678': '1,23,456.78',
  };
  for (const [paise, want] of Object.entries(EXPECT)) {
    check(`P17 ${paise} paise renders as ${want}`, formatPaise(paise) === want,
      `got ${formatPaise(paise)}`);
  }

  /*
   * NO FLOAT, EVER (Rule 4). 2^53 + 1 is the smallest integer a double cannot represent, and
   * a naive `Number(paise)/100` returns 90071992547409.94 for it. The text path must carry
   * every digit through.
   */
  const big = '9007199254740993';
  const rendered = formatPaise(big);
  check('P18a a value beyond 2^53 keeps every digit',
    rendered.replace(/[^0-9]/g, '') === big,
    `${rendered} dropped or changed a digit from ${big}`);
  check('P18b and groups them the Indian way', rendered === '9,00,71,99,25,47,409.93',
    `got ${rendered}`);
  /*
   * THE PROOF THAT IT IS NOT DOING ARITHMETIC. `Number(big)/100` is 90071992547409.92 - a
   * paisa short, because 2^53 + 1 is the smallest integer a double cannot hold. If this ever
   * matches, somebody has reintroduced a float and Rule 4 is broken where it is least visible.
   */
  check('P18c a float path would have given a different answer',
    (Number(big) / 100).toFixed(2) !== '90071992547409.93',
    'the float and text paths agree, which means this case no longer tests anything');
}

console.log('');
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log(`\nPAY ASSISTANT FAILED (${pass} passed, ${failures.length} failed)`);
  process.exitCode = 1;
} else {
  console.log(`PAY ASSISTANT OK (${pass} passed, 0 failed)`);
}
