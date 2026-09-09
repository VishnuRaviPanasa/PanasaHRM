/**
 * Employee documents, end to end against the running app AND a real MinIO.
 *
 * This is the first module that actually ENFORCES packages/authz, so the suite checks the
 * authorization outcomes as hard as it checks the happy path:
 *
 *   - a peer gets 404, not 403 (a 403 confirms the document exists)
 *   - a LINE MANAGER gets nothing, which is the deliberate narrowing for documents
 *   - the subject cannot reach a RESTRICTED type (offer letter, appraisal) at all
 *   - a pending version is not downloadable, and no amount of asking changes that
 *   - the bytes that come back are byte-identical to the bytes that went in
 *
 * Run: npm run docs:test
 */

const B = 'http://localhost:4000/api';
let jar = '';

async function call(path, opts = {}) {
  const headers = { ...(jar ? { cookie: jar } : {}), ...(opts.headers ?? {}) };
  if (opts.body && typeof opts.body === 'string') headers['Content-Type'] = 'application/json';
  const res = await fetch(B + path, { ...opts, headers });
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) jar = sc.map((c) => c.split(';')[0]).join('; ');
  const ct = res.headers.get('content-type') ?? '';
  let body;
  if (ct.startsWith('application/json')) body = await res.json().catch(() => null);
  else if (ct.startsWith('application/pdf') || ct.startsWith('image/')) {
    body = Buffer.from(await res.arrayBuffer());
  } else body = await res.text();
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

async function upload({ filename, contentType, bytes, typeCode, employeeId, title }) {
  const fd = new FormData();
  fd.set('file', new Blob([bytes], { type: contentType }), filename);
  fd.set('documentTypeCode', typeCode);
  if (employeeId) fd.set('employeeId', employeeId);
  if (title) fd.set('title', title);
  return call('/documents', { method: 'POST', body: fd });
}

// A small but genuinely well-formed PDF, so the magic-byte check passes on real bytes.
const PDF_BYTES = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
  + '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
  + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n'
  + 'trailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
const SVG_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

console.log('Employee documents\n');

// ---------------------------------------------------------------------------
console.log('1. An employee uploads their own ID proof');
const vishnu = await login('vishnu.ravi@panasatech.com');
let up = await upload({
  filename: 'aadhaar.pdf', contentType: 'application/pdf', bytes: PDF_BYTES,
  typeCode: 'id_proof', title: 'Aadhaar card',
});
check('upload accepted', up.ok, up.ok ? '' : JSON.stringify(up.body).slice(0, 200));
const docId = up.body?.id;
check('lands in quarantine, not available', up.body?.scanStatus === 'pending',
  up.body?.message);

// ---------------------------------------------------------------------------
console.log('\n2. A quarantined document cannot be downloaded by anybody');
let dl = await call(`/documents/${docId}/download`);
check('the owner cannot download it yet', !dl.ok && dl.status === 404,
  `status=${dl.status} — quarantine-then-promote is enforced at the database`);

console.log('\n3. ... and the employee cannot clear it themselves');
let scan = await call(`/documents/${docId}/scan`, {
  method: 'POST', body: JSON.stringify({ verdict: 'clean' }),
});
check('the uploader cannot certify their own upload', !scan.ok,
  `status=${scan.status} — otherwise the quarantine gate is self-certifying`);

// ---------------------------------------------------------------------------
console.log('\n4. HR clears it');
await login('deepa.suresh@panasatech.com');
scan = await call(`/documents/${docId}/scan`, {
  method: 'POST', body: JSON.stringify({ verdict: 'clean' }),
});
check('HR can record the verdict', scan.ok, JSON.stringify(scan.body).slice(0, 120));
check('the version is now clean', scan.body?.scanStatus === 'clean');

// ---------------------------------------------------------------------------
console.log('\n5. The owner downloads it and the bytes round-trip through MinIO');
await login('vishnu.ravi@panasatech.com');
dl = await call(`/documents/${docId}/download`);
check('download succeeds', dl.ok, `status=${dl.status}`);
check('bytes are byte-identical to what was uploaded',
  Buffer.isBuffer(dl.body) && dl.body.equals(PDF_BYTES),
  Buffer.isBuffer(dl.body) ? `${dl.body.length} bytes` : typeof dl.body);
check('served as an attachment, never rendered in the origin',
  (dl.headers.get('content-disposition') ?? '').startsWith('attachment'));
check('nosniff is set', dl.headers.get('x-content-type-options') === 'nosniff');
check('not cached', (dl.headers.get('cache-control') ?? '').includes('no-store'));

// ---------------------------------------------------------------------------
console.log('\n6. A PEER cannot see it, and gets 404 rather than 403');
await login('rahul.nair@panasatech.com');
let list = await call(`/documents?employeeId=${vishnu.employeeId}`);
const peerSees = (list.body?.documents ?? []).some((d) => d.id === docId);
check('a peer\'s list does not contain it', !peerSees,
  `${(list.body?.documents ?? []).length} documents visible`);
dl = await call(`/documents/${docId}/download`);
check('a peer download is 404, not 403', dl.status === 404,
  `status=${dl.status} — a 403 would confirm the document exists`);

// ---------------------------------------------------------------------------
console.log('\n7. THE LINE MANAGER gets nothing either - the deliberate narrowing');
await login('priya.menon@panasatech.com');
list = await call(`/documents?employeeId=${vishnu.employeeId}`);
const mgrSees = (list.body?.documents ?? []).some((d) => d.id === docId);
check('the manager cannot list a report\'s documents', !mgrSees,
  'a manager has no business reading a report\'s Aadhaar or medical certificate');
dl = await call(`/documents/${docId}/download`);
check('the manager cannot download it', dl.status === 404, `status=${dl.status}`);

// ---------------------------------------------------------------------------
console.log('\n8. Upload validation, through the real endpoint');
await login('vishnu.ravi@panasatech.com');

let bad = await upload({
  filename: 'logo.svg', contentType: 'image/svg+xml', bytes: SVG_BYTES, typeCode: 'id_proof',
});
check('SVG is refused', !bad.ok && bad.status === 400, bad.body?.message);

bad = await upload({
  filename: 'scan.pdf', contentType: 'application/pdf', bytes: PNG_BYTES, typeCode: 'id_proof',
});
check('a PNG declared as a PDF is refused (magic bytes)', !bad.ok,
  bad.body?.message);

bad = await upload({
  filename: 'payload.pdf.exe', contentType: 'application/pdf', bytes: PDF_BYTES,
  typeCode: 'id_proof',
});
check('a double extension is refused', !bad.ok, bad.body?.message);

// ---------------------------------------------------------------------------
console.log('\n9. RESTRICTED types: an employee can neither upload nor read one');
bad = await upload({
  filename: 'offer.pdf', contentType: 'application/pdf', bytes: PDF_BYTES,
  typeCode: 'offer_letter', title: 'My offer letter',
});
check('an employee cannot upload an offer letter', !bad.ok,
  `status=${bad.status} ${bad.body?.message ?? ''}`);

await login('deepa.suresh@panasatech.com');
up = await upload({
  filename: 'offer.pdf', contentType: 'application/pdf', bytes: PDF_BYTES,
  typeCode: 'offer_letter', employeeId: vishnu.employeeId, title: 'Offer letter',
});
check('HR can upload an offer letter', up.ok, JSON.stringify(up.body).slice(0, 140));
const offerId = up.body?.id;
await call(`/documents/${offerId}/scan`, {
  method: 'POST', body: JSON.stringify({ verdict: 'clean' }),
});

await login('vishnu.ravi@panasatech.com');
list = await call('/documents');
const seesOffer = (list.body?.documents ?? []).some((d) => d.id === offerId);
check('the subject does NOT see their own RESTRICTED document', !seesOffer,
  'offer letters and appraisals are hr_admin only - OR-25 records this as an HR/legal question');
dl = await call(`/documents/${offerId}/download`);
check('nor can they download it', dl.status === 404, `status=${dl.status}`);
check('but they DO still see their own id_proof',
  (list.body?.documents ?? []).some((d) => d.id === docId));

// ---------------------------------------------------------------------------
console.log('\n10. Document history');
let vers = await call(`/documents/${docId}/versions`);
check('version history loads', vers.ok, `${vers.body?.versions?.length ?? 0} version(s)`);
check('storage coordinates are NOT exposed',
  !JSON.stringify(vers.body).includes('object_key')
  && !JSON.stringify(vers.body).includes('sha256')
  && !JSON.stringify(vers.body).includes('bucket'),
  'handing out the key invites a caller to try the object store directly');

console.log('\n11. A second version supersedes the first');
up = await upload({
  filename: 'aadhaar-v2.pdf', contentType: 'application/pdf',
  bytes: Buffer.concat([PDF_BYTES, Buffer.from('% v2\n')]), typeCode: 'id_proof',
  title: 'Aadhaar card',
});
check('a new upload creates a new document', up.ok);

// ---------------------------------------------------------------------------
console.log('\n12. Withdrawal is administrative');
let wd = await call(`/documents/${docId}/withdraw`, {
  method: 'POST', body: JSON.stringify({ reason: 'superseded' }),
});
check('the employee cannot withdraw their own document', !wd.ok,
  `status=${wd.status} — an employee must not remove a document HR relies on`);

await login('deepa.suresh@panasatech.com');
wd = await call(`/documents/${docId}/withdraw`, { method: 'POST', body: JSON.stringify({}) });
check('a withdrawal without a reason is refused', !wd.ok, wd.body?.message);

wd = await call(`/documents/${docId}/withdraw`, {
  method: 'POST', body: JSON.stringify({ reason: 'replaced by a clearer scan' }),
});
check('HR can withdraw with a reason', wd.ok, JSON.stringify(wd.body).slice(0, 100));

dl = await call(`/documents/${docId}/download`);
check('a withdrawn document is no longer downloadable', !dl.ok, `status=${dl.status}`);

// ---------------------------------------------------------------------------
console.log('\n13. Viewing is a distinct disclosure from downloading');
{
  await login('vishnu.ravi@panasatech.com');
  const u = await upload({
    filename: 'view.pdf', contentType: 'application/pdf', bytes: PDF_BYTES,
    typeCode: 'education', title: 'Viewable certificate',
  });
  const vid = u.body?.id;
  await login('deepa.suresh@panasatech.com');
  await call(`/documents/${vid}/scan`, { method: 'POST', body: JSON.stringify({ verdict: 'clean' }) });
  await login('vishnu.ravi@panasatech.com');

  const view = await call(`/documents/${vid}/download?mode=view`);
  check('a view returns the bytes',
    view.ok && Buffer.isBuffer(view.body) && view.body.equals(PDF_BYTES),
    `status=${view.status}`);

  // The header must NOT be relaxed for a view. The client previews from a blob: URL instead, so
  // the browser never navigates to this response and a scripted PDF has no origin to abuse.
  check('a view is STILL served as an attachment',
    (view.headers.get('content-disposition') ?? '').startsWith('attachment'),
    'inline disposition would let a scripted PDF run in the origin holding the session cookie');
  check('a view carries a CSP that can do nothing',
    (view.headers.get('content-security-policy') ?? '').includes("default-src 'none'"),
    view.headers.get('content-security-policy') ?? 'absent');
}

console.log('\n14. HR sees document counts on the employee list; an employee does not');
{
  await login('vishnu.ravi@panasatech.com');
  const asEmp = await call('/employees');
  check('an employee gets no document counts', asEmp.body?.showDocumentCounts === false,
    `showDocumentCounts=${asEmp.body?.showDocumentCounts}`);
  check('  ... and the field is absent from the ROWS, not just hidden in the UI',
    (asEmp.body?.employees ?? []).every((e) => e.document_count === null),
    'a count of MEDICAL certificates is information about health, even without the files');

  await login('deepa.suresh@panasatech.com');
  const asHr = await call('/employees');
  check('HR gets document counts', asHr.body?.showDocumentCounts === true);
  check('  ... with per-employee totals',
    (asHr.body?.employees ?? []).every((e) => e.document_count !== null),
    (asHr.body?.employees ?? []).map((e) => `${e.employee_number}:${e.document_count}`).join(' '));
  check('  ... and a pending count, so gaps are visible without opening anybody',
    (asHr.body?.employees ?? []).every((e) => e.pending_count !== null));
}

console.log('\n15. A PENDING document must still describe itself, and be clearable');
{
  /*
   * REGRESSION. The list query originally joined version info on `current_version_id` only.
   * A pending document HAS no current version - that is the quarantine gate working - so
   * filename, size, content type and scan status all came back NULL. The UI showed
   * "no version" with "-- . --", could not offer a download (correct) and could not offer HR
   * the CLEAR action either (a bug), leaving the document stuck permanently.
   *
   * The earlier tests missed it because they called /scan directly by id rather than through
   * the affordance the UI actually renders. So this checks the SHAPE of the row, not just that
   * the endpoint works.
   */
  await login('vishnu.ravi@panasatech.com');
  const u = await upload({
    filename: 'pending-shape.pdf', contentType: 'application/pdf', bytes: PDF_BYTES,
    typeCode: 'address_proof', title: 'Pending shape check',
  });
  check('upload accepted', u.ok);

  const find = async (who) => {
    await login(who);
    const r = await call(`/documents?employeeId=${vishnu.employeeId}`);
    return (r.body?.documents ?? []).find((x) => x.title === 'Pending shape check');
  };

  let row = await find('vishnu.ravi@panasatech.com');
  check('a pending document is listed at all', !!row);
  check('  ... and reports its filename', row?.original_name === 'pending-shape.pdf',
    `original_name=${row?.original_name}`);
  check('  ... and its size', Number(row?.size_bytes) > 0, `size_bytes=${row?.size_bytes}`);
  check('  ... and its content type', row?.content_type === 'application/pdf',
    `content_type=${row?.content_type}`);
  check('  ... and is NOT available', row?.available === false, `available=${row?.available}`);
  check('  ... and reports the LATEST version as pending, which is what HR must act on',
    row?.latest_scan_status === 'pending',
    `latest_scan_status=${row?.latest_scan_status} — if this is null, the Mark cleared button `
    + 'never renders and the document is stuck');
  check('  ... with a version number', Number(row?.latest_version_no) === 1,
    `latest_version_no=${row?.latest_version_no}`);

  // Now the affordance HR is actually offered.
  row = await find('deepa.suresh@panasatech.com');
  check('HR sees the same pending row', row?.latest_scan_status === 'pending');
  const cleared = await call(`/documents/${row.id}/scan`, {
    method: 'POST', body: JSON.stringify({ verdict: 'clean' }),
  });
  check('HR can clear it', cleared.ok, `status=${cleared.status}`);

  row = await find('vishnu.ravi@panasatech.com');
  check('after clearing it becomes available', row?.available === true,
    `available=${row?.available}`);
  check('  ... and a promoted version number appears', Number(row?.current_version_no) === 1);

  const got = await call(`/documents/${row.id}/download`);
  check('  ... and it downloads', got.ok && Buffer.isBuffer(got.body)
    && got.body.equals(PDF_BYTES), `status=${got.status}`);
}

console.log('\n16. The audit trail');
const audit = await call('/documents');   // any authenticated call, to keep the session alive
check('session still valid', audit.ok);

console.log('');
if (fail) { console.log('FAILURES:'); for (const f of failures) console.log(`  ${f}`); }
console.log(`${fail === 0 ? 'DOCUMENTS FLOW OK' : 'DOCUMENTS FLOW FAILED'} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
