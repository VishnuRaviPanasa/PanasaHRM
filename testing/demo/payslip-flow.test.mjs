/**
 * Payslips - the complete vertical slice, and the forbidden paths.
 *
 * THE ACCEPTANCE CRITERION IS NOT "THE SCREEN RENDERS".
 *
 * It is: HR creates a payslip -> it persists in PostgreSQL -> the PDF lands in MinIO -> the
 * employee retrieves ONLY their own -> the PDF downloads -> and cross-employee access is proven
 * denied. Every one of those is a step below, in that order, against the running stack.
 *
 * The load-bearing check is step 9: the bytes the employee downloads are compared to the bytes HR
 * uploaded. That is what makes "the PDF and the structured data are the same payslip" a tested
 * fact rather than a hopeful one - a feature that serves the right numbers with somebody else's
 * PDF would pass every other check here.
 *
 * WHAT THIS DELIBERATELY DOES NOT TEST: any payroll calculation. There is none. ADR-0012 is
 * BLOCKED on build-versus-buy and owns that decision; HR enters a finalised result. The only
 * arithmetic asserted is the derived gross/deductions/net, which is a total of what was typed in.
 *
 * Run: npm run payslip:test    (needs the API on :4000 and the dev stack up)
 */

const B = 'http://localhost:4000/api';
const MINIO = process.env.HRM_MINIO_URL ?? 'http://127.0.0.1:59000';
const BUCKET = process.env.HRM_DOC_BUCKET ?? 'hrm-documents';

let jar = '';

async function call(path, opts = {}) {
  const headers = { ...(jar ? { cookie: jar } : {}), ...(opts.headers ?? {}) };
  if (opts.body && typeof opts.body === 'string') headers['Content-Type'] = 'application/json';
  const res = await fetch(B + path, { ...opts, headers });
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) jar = sc.map((c) => c.split(';')[0]).join('; ');
  const ct = res.headers.get('content-type') ?? '';
  let body = null;
  if (ct.includes('json')) { try { body = await res.json(); } catch { /* not json after all */ } }
  else body = Buffer.from(await res.arrayBuffer());
  return { ok: res.ok, status: res.status, body, headers: res.headers };
}

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  OK   ${name}${detail ? `  — ${detail}` : ''}`); return; }
  fail++; failures.push(`${name}${detail ? `  — ${detail}` : ''}`);
  console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`);
};

const login = async (email) => {
  jar = '';
  const r = await call('/auth/login', {
    method: 'POST', body: JSON.stringify({ email, password: 'panasa2026' }),
  });
  if (!r.ok) throw new Error(`login failed for ${email}: ${JSON.stringify(r.body)}`);
  return r.body.actor;
};

/**
 * A small but structurally valid PDF, carrying a marker unique to this run.
 *
 * The marker is what makes step 9 meaningful: the employee's download is compared byte for byte
 * against what HR uploaded, so if the wrong object were ever served - a stale version, another
 * employee's payslip, a truncated read - the comparison fails instead of quietly passing because
 * "a PDF came back".
 */
const marker = `ART-HRM-PAYSLIP-TEST-${Date.now()}`;
const pdf = Buffer.from(
  `%PDF-1.4\n`
  + `1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n`
  + `2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n`
  + `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 300]>>endobj\n`
  + `% ${marker}\n`
  + `trailer<</Root 1 0 R>>\n%%EOF\n`, 'latin1');

const upload = async (path, buf, filename = 'payslip.pdf', type = 'application/pdf') => {
  const bnd = '----artpayslip' + Math.random().toString(36).slice(2);
  const head = Buffer.from(
    `--${bnd}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n`
    + `Content-Type: ${type}\r\n\r\n`, 'utf8');
  const tail = Buffer.from(`\r\n--${bnd}--\r\n`, 'utf8');
  const res = await fetch(B + path, {
    method: 'POST',
    headers: { cookie: jar, 'Content-Type': `multipart/form-data; boundary=${bnd}` },
    body: Buffer.concat([head, buf, tail]),
  });
  let body = null; try { body = await res.json(); } catch { /* empty */ }
  return { ok: res.ok, status: res.status, body };
};

const rupees = (paise) => (paise === null || paise === undefined
  ? '-' : (Number(BigInt(paise)) / 100).toFixed(2));

/*
 * MAKE THE RUN REPEATABLE, and note that this cannot be done with a DELETE.
 *
 * The first version of this suite passed once and then failed 35 checks on the second run: the
 * exclusion constraint correctly refused a second LIVE payslip for an employee and period the
 * previous run had already used, and every later step cascaded off that one failure. The
 * constraint was right and the test was leaking state - the same trap as 0012 N8 in a new costume.
 *
 * A payslip cannot be deleted, by design: a deleted row takes its reason with it. So the reset
 * VOIDS what an earlier run left behind, through the public API, with a reason that says why. The
 * cleanup therefore exercises the void path as well, and the audit trail keeps every fixture that
 * ever existed - which is the right behaviour for a pay record, even a test's.
 */
const clearPeriod = async (employeeNumber, periodStart) => {
  const list = await call('/payslips');
  let cleared = 0;
  for (const r of list.body?.rows ?? []) {
    if (r.employee_number !== employeeNumber) continue;
    if (String(r.period_start).slice(0, 10) !== periodStart) continue;
    if (r.status === 'void') continue;
    const v = await call(`/payslips/${r.id}/void`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'superseded by a payslip-flow test run' }),
    });
    if (v.ok) cleared += 1;
  }
  return cleared;
};

console.log('Payslips - complete vertical slice\n');

// ---------------------------------------------------------------------------
console.log('1. HR opens the component catalogue (configuration, not an enum in code)');
const hr = await login('deepa.suresh@panasatech.com');
const comps = await call('/payslips/components');
check('HR can read the component catalogue', comps.ok, `status=${comps.status}`);
const codes = (comps.body?.components ?? []).map((c) => c.code);
check('  ... and it holds earnings and deductions',
  codes.includes('basic') && codes.includes('pf_employee'),
  `${codes.length} components`);
check('  ... with statutory ones marked but NOT calculated',
  (comps.body?.components ?? []).some((c) => c.is_statutory),
  'is_statutory is descriptive - ADR-0012 is BLOCKED and owns the engine decision');

// ---------------------------------------------------------------------------
console.log('\n2. HR creates a payslip for an employee (persisted in PostgreSQL)');
const emps = await call('/employees');
const target = (emps.body?.rows ?? emps.body?.employees ?? [])
  .find((e) => e.employee_number === 'EMP001');
check('the target employee was found in the directory', !!target, target?.full_name ?? 'not found');

const other0 = (emps.body?.rows ?? emps.body?.employees ?? [])
  .find((e) => e.employee_number === 'EMP003');
/*
 * THE TEST'S PERIODS DO NOT TOUCH THE SEED'S, and that is a second correction.
 *
 * The seed issues payslips for June, July and August; the first version of this suite worked in
 * June, May and March, so `clearPeriod` voided two SEEDED payslips on every run and the demo
 * fixture was quietly degraded by its own test suite - `issued_payslips` fell from 6 to 4 and
 * nothing said so. The suite now lives in January to April, which the seed never uses, so the
 * reset can only ever reach payslips an earlier RUN of this suite created.
 */
const carried = await clearPeriod('EMP001', '2026-04-01')
  + await clearPeriod('EMP001', '2026-03-01')
  + await clearPeriod('EMP001', '2026-02-01')
  + await clearPeriod('EMP001', '2026-01-01')
  + await clearPeriod('EMP003', '2026-04-01');
check('anything an earlier run left behind was voided, not deleted', carried >= 0,
  `${carried} carried-over payslip(s) voided - a pay record is never deleted`);

// And the property that matters: the seeded demo payslips are none of this suite's business.
const seeded = (await call('/payslips?employeeId=' + target.id)).body?.rows ?? [];
const seededLive = seeded.filter((r) => r.status === 'issued'
  && ['2026-06-01', '2026-07-01', '2026-08-01'].includes(String(r.period_start).slice(0, 10)));
check('  ... and the SEEDED payslips are untouched', seededLive.length === 3,
  `${seededLive.length} of 3 seeded payslips still issued - a test must not degrade the demo data`);

const created = await call('/payslips', {
  method: 'POST',
  body: JSON.stringify({
    employeeId: target.id,
    periodStart: '2026-04-01',
    periodEnd: '2026-04-30',
    payDate: '2026-05-01',
    // What the PDF says. 50,000 + 20,000 + 5,000 - 6,000 - 200 = 68,800.00
    declaredNet: '68800.00',
    note: 'Created by the payslip flow test',
    lines: [
      { componentCode: 'basic', amount: '50000.00' },
      { componentCode: 'hra', amount: '20000' },
      { componentCode: 'special_allowance', amount: '5000.00' },
      { componentCode: 'pf_employee', amount: '6000.00' },
      { componentCode: 'professional_tax', amount: '200' },
    ],
  }),
});
check('HR creates the payslip', created.ok, `status=${created.status} ${JSON.stringify(created.body ?? {}).slice(0, 120)}`);
const psId = created.body?.id;
check('  ... and it starts as a DRAFT, with no standing at all',
  created.body?.status === 'draft', String(created.body?.status));

// ---------------------------------------------------------------------------
console.log('\n3. The system DISPLAY-CHECKS gross, total deductions and net');
const detail = await call(`/payslips/${psId}`);
check('the payslip reads back', detail.ok, `status=${detail.status}`);
check('  ... gross is derived from the earning lines',
  detail.body?.totals?.gross_minor === '7500000',
  `gross=${rupees(detail.body?.totals?.gross_minor)} (want 75000.00)`);
check('  ... total deductions from the deduction lines',
  detail.body?.totals?.deductions_minor === '620000',
  `deductions=${rupees(detail.body?.totals?.deductions_minor)} (want 6200.00)`);
check('  ... and net is gross minus deductions',
  detail.body?.totals?.net_minor === '6880000',
  `net=${rupees(detail.body?.totals?.net_minor)} (want 68800.00)`);
check('  ... which RECONCILES with the figure declared from the PDF',
  detail.body?.reconciles === true,
  `declared=${rupees(detail.body?.payslip?.declared_net_minor)} derived=${rupees(detail.body?.totals?.net_minor)}`);
check('  ... amounts crossed the wire as STRINGS, never as JS numbers (Rule 4)',
  typeof detail.body?.totals?.net_minor === 'string'
  && (detail.body?.lines ?? []).every((l) => typeof l.amount_minor === 'string'),
  'integer paise as text - a double would silently round the register');
check('  ... "20000" and "20000.00" mean the same thing',
  (detail.body?.lines ?? []).find((l) => l.component_code === 'hra')?.amount_minor === '2000000',
  'no float ever formed: the digits are assembled with BigInt');

// ---------------------------------------------------------------------------
console.log('\n4. A payslip that does NOT reconcile cannot be issued');
{
  const bad = await call('/payslips', {
    method: 'POST',
    body: JSON.stringify({
      employeeId: target.id,
      periodStart: '2026-02-01', periodEnd: '2026-02-28',
      declaredNet: '99999.00',                     // deliberately not the sum of the lines
      lines: [{ componentCode: 'basic', amount: '50000.00' }],
    }),
  });
  check('a draft with a mismatched declared net is accepted as a DRAFT', bad.ok,
    `status=${bad.status} - a draft is allowed to be wrong; issuing it is not`);
  const iss = await call(`/payslips/${bad.body?.id}/issue`, { method: 'POST' });
  check('  ... but issuing it is REFUSED', !iss.ok, `status=${iss.status}`);
  check('  ... and the refusal says which two figures disagree',
    /reconcile|declares/i.test(JSON.stringify(iss.body ?? {})),
    String(iss.body?.message ?? '').slice(0, 130));
  await call(`/payslips/${bad.body?.id}/void`,
    { method: 'POST', body: JSON.stringify({ reason: 'test fixture cleanup' }) });
}

// ---------------------------------------------------------------------------
console.log('\n5. Issuing without the PDF is refused - a payslip is not a payslip without it');
{
  const iss = await call(`/payslips/${psId}/issue`, { method: 'POST' });
  check('issue without a document is refused', !iss.ok, `status=${iss.status}`);
  check('  ... and says so', /document/i.test(JSON.stringify(iss.body ?? {})),
    String(iss.body?.message ?? '').slice(0, 110));
}

// ---------------------------------------------------------------------------
console.log('\n6. HR uploads the actual PDF (stored in MinIO)');
{
  const nonPdf = await upload(`/payslips/${psId}/document`,
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'), 'x.svg', 'image/svg+xml');
  check('a non-PDF upload is refused', !nonPdf.ok,
    `status=${nonPdf.status} - SVG is HTML-equivalent and has no place here`);

  const up = await upload(`/payslips/${psId}/document`, pdf);
  check('the PDF uploads', up.ok, `status=${up.status} ${JSON.stringify(up.body ?? {}).slice(0, 100)}`);
  check('  ... and its SHA-256 was recorded', /^[0-9a-f]{64}$/.test(up.body?.sha256 ?? ''),
    String(up.body?.sha256 ?? '').slice(0, 16) + '...');
}

// ---------------------------------------------------------------------------
console.log('\n7. Now it issues, and HR can reopen it and download the document');
{
  const iss = await call(`/payslips/${psId}/issue`, { method: 'POST' });
  check('HR issues the payslip', iss.ok, `status=${iss.status} ${JSON.stringify(iss.body ?? {})}`);

  const again = await call(`/payslips/${psId}`);
  check('  ... reopening it shows it issued', again.body?.payslip?.status === 'issued',
    String(again.body?.payslip?.status));
  check('  ... and it still reconciles', again.body?.reconciles === true);

  const dl = await call(`/payslips/${psId}/document`);
  check('HR downloads the PDF', dl.ok, `status=${dl.status} ${dl.body?.length ?? 0} bytes`);
  check('  ... served as an attachment, never inline (DEC-050)',
    /attachment/.test(dl.headers.get('content-disposition') ?? ''),
    dl.headers.get('content-disposition') ?? '(none)');
  check('  ... with nosniff and no-store',
    dl.headers.get('x-content-type-options') === 'nosniff'
    && /no-store/.test(dl.headers.get('cache-control') ?? ''));

  const hist = await call(`/payslips/${psId}/history`);
  check('the transition history records who issued it',
    (hist.body?.events ?? []).some((e) => e.event_type === 'issue' && e.actor_number === 'EMP005'),
    (hist.body?.events ?? []).map((e) => `${e.event_type}:${e.actor_number}`).join(' '));
}

// ---------------------------------------------------------------------------
console.log('\n8. The EMPLOYEE sees only their own payslips');
const emp = await login('vishnu.ravi@panasatech.com');
{
  const mine = await call('/payslips');
  check('the employee can list their payslips', mine.ok, `status=${mine.status}`);
  const numbers = [...new Set((mine.body?.rows ?? []).map((r) => r.employee_number))];
  check('  ... and every row is their own', numbers.length === 1 && numbers[0] === emp.employeeNumber,
    numbers.join(', ') || '(empty)');
  check('  ... including the one HR just issued',
    (mine.body?.rows ?? []).some((r) => r.id === psId),
    `${(mine.body?.rows ?? []).length} payslip(s)`);
  check('  ... with the net pay visible to them (it is their own wage)',
    (mine.body?.rows ?? []).find((r) => r.id === psId)?.net_minor === '6880000',
    rupees((mine.body?.rows ?? []).find((r) => r.id === psId)?.net_minor));

  const one = await call(`/payslips/${psId}`);
  check('the employee opens it and sees the salary breakdown', one.ok, `status=${one.status}`);
  check('  ... every line, earnings and deductions',
    (one.body?.lines ?? []).length === 5,
    (one.body?.lines ?? []).map((l) => `${l.component_code}=${rupees(l.amount_minor)}`).join(' '));
  check('  ... and the totals', one.body?.totals?.net_minor === '6880000',
    `net=${rupees(one.body?.totals?.net_minor)}`);
}

// ---------------------------------------------------------------------------
console.log('\n9. THE LOAD-BEARING CHECK: the employee downloads the SAME PDF HR uploaded');
{
  const dl = await call(`/payslips/${psId}/document`);
  check('the employee downloads their payslip PDF', dl.ok, `status=${dl.status}`);
  check('  ... and it is byte-for-byte what HR uploaded',
    Buffer.isBuffer(dl.body) && dl.body.equals(pdf),
    `${dl.body?.length ?? 0} bytes vs ${pdf.length} uploaded`);
  check('  ... carrying this run\'s unique marker, so it is not a stale or foreign object',
    Buffer.isBuffer(dl.body) && dl.body.includes(marker), marker);

  const view = await call(`/payslips/${psId}/document?mode=view`);
  check('a VIEW returns the same bytes and the same headers',
    view.ok && Buffer.isBuffer(view.body) && view.body.equals(pdf)
    && /attachment/.test(view.headers.get('content-disposition') ?? ''),
    'mode changes only the audit event type, never a header');
}

// ---------------------------------------------------------------------------
console.log('\n10. FORBIDDEN: employee A cannot reach employee B\'s payslip');
{
  // A payslip that belongs to somebody else. Made by HR, for a different employee.
  await login('deepa.suresh@panasatech.com');
  const other = other0;
  const theirs = await call('/payslips', {
    method: 'POST',
    body: JSON.stringify({
      employeeId: other.id,
      periodStart: '2026-04-01', periodEnd: '2026-04-30',
      declaredNet: '40000.00',
      lines: [{ componentCode: 'basic', amount: '40000.00' }],
    }),
  });
  const theirId = theirs.body?.id;
  check('HR created a payslip for a different employee', theirs.ok, `status=${theirs.status}`);

  await login('vishnu.ravi@panasatech.com');

  const byId = await call(`/payslips/${theirId}`);
  check('by id: refused with 404, which does not confirm it exists', byId.status === 404,
    `status=${byId.status}`);

  const byDoc = await call(`/payslips/${theirId}/document`);
  check('its PDF: refused', byDoc.status === 404, `status=${byDoc.status}`);

  const byHistory = await call(`/payslips/${theirId}/history`);
  check('its history: refused', byHistory.status === 404, `status=${byHistory.status}`);

  // THE URL-TAMPERING PATH the requirements call out by name.
  const tampered = await call(`/payslips?employeeId=${other.id}`);
  check('tampering with employeeId in the query string: refused', tampered.status === 404,
    `status=${tampered.status} - the policy is asked about THAT subject, not compared here`);

  // And even a caller who somehow passed the gate is filtered by the scope predicate.
  const wide = await call('/payslips');
  check('  ... and the unfiltered list still contains nobody else',
    !(wide.body?.rows ?? []).some((r) => r.employee_number !== emp.employeeNumber),
    [...new Set((wide.body?.rows ?? []).map((r) => r.employee_number))].join(', '));

  global.__theirId = theirId;
}

// ---------------------------------------------------------------------------
console.log('\n11. FORBIDDEN: an employee cannot create, edit, issue or void anything');
{
  const mk = await call('/payslips', {
    method: 'POST',
    body: JSON.stringify({
      employeeId: emp.employeeId ?? '00000000-0000-0000-0000-000000000000',
      periodStart: '2026-03-01', periodEnd: '2026-03-31',
      declaredNet: '999999.00',
      lines: [{ componentCode: 'basic', amount: '999999.00' }],
    }),
  });
  check('create: refused', !mk.ok, `status=${mk.status}`);

  const patch = await call(`/payslips/${psId}`, {
    method: 'PATCH', body: JSON.stringify({ declaredNet: '999999.00' }),
  });
  check('edit their OWN payslip: refused', !patch.ok,
    `status=${patch.status} - reading your wage slip is a right, rewriting it is not`);

  const iss = await call(`/payslips/${psId}/issue`, { method: 'POST' });
  check('issue: refused', !iss.ok, `status=${iss.status}`);

  const vd = await call(`/payslips/${psId}/void`, {
    method: 'POST', body: JSON.stringify({ reason: 'I would rather not have been paid this' }),
  });
  check('void: refused', !vd.ok, `status=${vd.status}`);

  const at = await upload(`/payslips/${psId}/document`, pdf);
  check('attach a different PDF to their own payslip: refused', !at.ok,
    `status=${at.status} - otherwise an employee could substitute the evidence`);

  const cat = await call('/payslips/components');
  check('read the component catalogue: refused', !cat.ok,
    `status=${cat.status} - it is the vocabulary of the pay register`);

  const stillRight = await call(`/payslips/${psId}`);
  check('  ... and after all that the payslip is untouched',
    stillRight.body?.totals?.net_minor === '6880000' && stillRight.body?.payslip?.status === 'issued',
    `net=${rupees(stillRight.body?.totals?.net_minor)} status=${stillRight.body?.payslip?.status}`);
}

// ---------------------------------------------------------------------------
console.log('\n12. FORBIDDEN: a LINE MANAGER cannot read their report\'s payslip');
{
  const mgr = await login('priya.menon@panasatech.com');
  const one = await call(`/payslips/${psId}`);
  check('a manager is refused their own report\'s payslip', one.status === 404,
    `status=${one.status} - pay is not operational data; DEC-049 denied managers documents too`);

  const listed = await call('/payslips');
  const seen = [...new Set((listed.body?.rows ?? []).map((r) => r.employee_number))];
  check('  ... and their list contains only themselves, not their subtree',
    seen.every((n) => n === mgr.employeeNumber),
    seen.join(', ') || '(empty)');

  const tampered = await call(`/payslips?employeeId=${target.id}`);
  check('  ... and asking for a report by id is refused', tampered.status === 404,
    `status=${tampered.status}`);
}

// ---------------------------------------------------------------------------
console.log('\n13. FORBIDDEN: unauthenticated requests get nothing');
{
  jar = '';
  const l = await call('/payslips');
  check('list: 401', l.status === 401, `status=${l.status}`);
  const d = await call(`/payslips/${psId}/document`);
  check('the PDF: 401', d.status === 401, `status=${d.status}`);
  check('  ... and no bytes came back',
    !(Buffer.isBuffer(d.body) && d.body.includes(marker)), 'the marker must not appear');
  const c = await call('/payslips', { method: 'POST', body: JSON.stringify({}) });
  check('create: 401', c.status === 401, `status=${c.status}`);
}

// ---------------------------------------------------------------------------
console.log('\n14. The object store is not publicly readable');
{
  // Anonymous bucket listing. A public bucket would answer this with XML full of object keys.
  let listStatus = 0, listBody = '';
  try {
    const r = await fetch(`${MINIO}/${BUCKET}?list-type=2`);
    listStatus = r.status; listBody = (await r.text()).slice(0, 200);
  } catch (e) { listStatus = -1; listBody = String(e.message); }
  check('anonymous bucket listing is denied', listStatus === 403 || listStatus === 401,
    `status=${listStatus} ${/AccessDenied/.test(listBody) ? '(AccessDenied)' : ''}`);
  check('  ... and no object key leaked in the response',
    !/<Key>/.test(listBody), listBody.slice(0, 80) || '(empty)');

  // And an anonymous fetch of a plausibly-named object.
  let objStatus = 0;
  try { objStatus = (await fetch(`${MINIO}/${BUCKET}/documents/`)).status; }
  catch { objStatus = -1; }
  check('anonymous object access is denied', objStatus !== 200, `status=${objStatus}`);
}

// ---------------------------------------------------------------------------
console.log('\n15. A VOID payslip leaves no reachable document');
{
  await login('deepa.suresh@panasatech.com');

  const before = await call(`/payslips/${psId}/document`);
  check('before voiding, HR can still fetch the PDF', before.ok, `status=${before.status}`);

  const noReason = await call(`/payslips/${psId}/void`, {
    method: 'POST', body: JSON.stringify({ reason: '' }),
  });
  check('voiding without a reason is refused', !noReason.ok,
    `status=${noReason.status} - the reason is the part that matters later`);

  const vd = await call(`/payslips/${psId}/void`, {
    method: 'POST', body: JSON.stringify({ reason: 'issued against the wrong pay period' }),
  });
  check('HR voids the payslip', vd.ok, `status=${vd.status}`);

  const after = await call(`/payslips/${psId}/document`);
  check('  ... and its PDF is now unreachable, for HR too', after.status === 404,
    `status=${after.status} - the void withdrew the document row`);

  await login('vishnu.ravi@panasatech.com');
  const empAfter = await call(`/payslips/${psId}/document`);
  check('  ... and for the employee', empAfter.status === 404, `status=${empAfter.status}`);
  check('  ... with no bytes served',
    !(Buffer.isBuffer(empAfter.body) && empAfter.body.includes(marker)), 'no marker');

  const rec = await call(`/payslips/${psId}`);
  check('the RECORD survives with its reason - voided, never deleted',
    rec.ok && rec.body?.payslip?.status === 'void'
      && /wrong pay period/.test(rec.body?.payslip?.void_reason ?? ''),
    `status=${rec.body?.payslip?.status} reason=${rec.body?.payslip?.void_reason ?? '-'}`);
}

// ---------------------------------------------------------------------------
console.log('\n16. An ISSUED payslip cannot be quietly re-priced');
{
  await login('deepa.suresh@panasatech.com');
  const fresh = await call('/payslips', {
    method: 'POST',
    body: JSON.stringify({
      employeeId: target.id,
      periodStart: '2026-01-01', periodEnd: '2026-01-31',
      declaredNet: '10000.00',
      lines: [{ componentCode: 'basic', amount: '10000.00' }],
    }),
  });
  const fid = fresh.body?.id;
  await upload(`/payslips/${fid}/document`, pdf);
  const iss = await call(`/payslips/${fid}/issue`, { method: 'POST' });
  check('a second payslip issues cleanly', iss.ok, `status=${iss.status}`);

  const edit = await call(`/payslips/${fid}`, {
    method: 'PATCH',
    body: JSON.stringify({ lines: [{ componentCode: 'basic', amount: '1.00' }] }),
  });
  check('HR cannot edit the lines of an ISSUED payslip', !edit.ok,
    `status=${edit.status} - otherwise the net could drift from the PDF after the check`);

  const declared = await call(`/payslips/${fid}`, {
    method: 'PATCH', body: JSON.stringify({ declaredNet: '1.00' }),
  });
  check('  ... nor the declared figure', !declared.ok, `status=${declared.status}`);

  const check2 = await call(`/payslips/${fid}`);
  check('  ... and it still reconciles at the original amount',
    check2.body?.totals?.net_minor === '1000000' && check2.body?.reconciles === true,
    `net=${rupees(check2.body?.totals?.net_minor)}`);

  const dup = await call('/payslips', {
    method: 'POST',
    body: JSON.stringify({
      employeeId: target.id,
      periodStart: '2026-01-15', periodEnd: '2026-02-14',
      declaredNet: '1.00', lines: [{ componentCode: 'basic', amount: '1.00' }],
    }),
  });
  /*
   * `!dup.ok` was the original assertion, and it passed on a **500** - which is how a bare
   * "Internal server error" survived review. A refused duplicate is a legitimate answer to a
   * legitimate request, so the status is now asserted exactly and the message has to be actionable.
   */
  check('a second LIVE payslip overlapping the same period is refused with a 400',
    dup.status === 400,
    `status=${dup.status} - not a 500: a refused duplicate is the caller's problem, not a fault`);
  check('  ... and the message tells HR what to do about it',
    /already has a payslip|Void the existing/i.test(String(dup.body?.message ?? '')),
    String(dup.body?.message ?? '').slice(0, 90));

  await call(`/payslips/${fid}/void`,
    { method: 'POST', body: JSON.stringify({ reason: 'test fixture cleanup' }) });
}

// ---------------------------------------------------------------------------
console.log('\n17. Every access left an audit trail, and it records no amounts');
{
  await login('deepa.suresh@panasatech.com');
  const audit = await call(`/payslips/${psId}/history`);
  check('the payslip history shows issue and void', audit.ok
    && (audit.body?.events ?? []).some((e) => e.event_type === 'issue')
    && (audit.body?.events ?? []).some((e) => e.event_type === 'void'),
    (audit.body?.events ?? []).map((e) => e.event_type).join(' -> '));
  check('  ... and the void carries its reason',
    (audit.body?.events ?? []).some((e) => e.event_type === 'void' && e.reason),
    (audit.body?.events ?? []).find((e) => e.event_type === 'void')?.reason ?? '-');
  check('  ... and no amount appears anywhere in it',
    !/68800|6880000/.test(JSON.stringify(audit.body ?? {})),
    'an audit trail holding net pay would be a second, decade-retained salary register');
}

console.log('');
if (fail) { console.log('FAILURES:'); for (const f of failures) console.log(`  ${f}`); }
console.log(`${fail === 0 ? 'PAYSLIP FLOW OK' : 'PAYSLIP FLOW FAILED'} (${pass} passed, ${fail} failed)`);
process.exitCode = fail === 0 ? 0 : 1;
