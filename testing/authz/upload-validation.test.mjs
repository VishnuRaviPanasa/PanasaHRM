/**
 * Upload validation - the highest-risk surface (security-guidelines.md).
 *
 * These are the cases an attacker actually tries, not the cases a form generates. The ones that
 * matter most:
 *
 *   - a PNG renamed `.pdf` and declared `application/pdf`  (magic bytes must catch it)
 *   - `photo.pdf.exe`                                       (double extension, resolved LAST-dot)
 *   - an SVG                                                (banned outright, and alerted)
 *   - an ELF or MZ binary declared as a PDF                 (named in the alert, not "unknown")
 *   - a DOCX declaring a 400:1 expansion ratio              (decompression bomb)
 *
 * Every rejection also asserts whether it should ALERT. That distinction is the point of the
 * requirement: a polyglot attempt is an attack signal, and downgrading it to a validation
 * message loses the detection while still "handling" the file correctly.
 *
 * Run: npm run upload:test
 */

import {
  MAX_UPLOAD_BYTES, objectKeyFor, sniffContentType, validateUpload,
} from '../../packages/authz/dist/index.js';

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail ? `  — ${detail}` : ''}`);
};

// --- byte fixtures ---------------------------------------------------------
const PDF   = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1');
const JPEG  = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG   = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const ZIP   = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);
const SVG   = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const SVG2  = Buffer.from('  <svg onload="alert(1)"></svg>');
const HTML  = Buffer.from('<!DOCTYPE html><html><body>hi</body></html>');
const MZ    = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
const ELF   = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01]);
const NOISE = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const v = (o) => validateUpload({ sizeBytes: 1024, ...o });

console.log('Upload validation\n');

// ---------------------------------------------------------------------------
console.log('1. Magic-byte sniffing');
check('PDF', sniffContentType(PDF) === 'application/pdf');
check('JPEG', sniffContentType(JPEG) === 'image/jpeg');
check('PNG', sniffContentType(PNG) === 'image/png');
check('ZIP (docx/xlsx container)', sniffContentType(ZIP) === 'application/zip');
check('SVG with an XML prolog', sniffContentType(SVG) === 'image/svg+xml', sniffContentType(SVG));
check('SVG with leading whitespace', sniffContentType(SVG2) === 'image/svg+xml', sniffContentType(SVG2));
check('HTML', sniffContentType(HTML) === 'text/html');
check('Windows executable is NAMED, not "unknown"',
  sniffContentType(MZ) === 'application/x-msdownload',
  'an alert saying "an executable was uploaded as a PDF" is actionable; "unknown" is not');
check('ELF binary is NAMED', sniffContentType(ELF) === 'application/x-elf');
check('unrecognised bytes are unknown', sniffContentType(NOISE) === 'unknown');

// ---------------------------------------------------------------------------
console.log('2. Happy paths');
for (const [ct, name, head] of [
  ['application/pdf', 'offer.pdf', PDF],
  ['image/jpeg', 'scan.jpg', JPEG],
  ['image/jpeg', 'scan.JPEG', JPEG],
  ['image/png', 'card.png', PNG],
  [DOCX, 'letter.docx', ZIP],
  [XLSX, 'sheet.xlsx', ZIP],
]) {
  const r = v({ filename: name, declaredContentType: ct, head });
  check(`accepts ${name}`, r.ok, r.ok ? '' : r.rejection.code);
}
check('a content type with a charset parameter is tolerated',
  v({ filename: 'a.pdf', declaredContentType: 'application/pdf; charset=binary', head: PDF }).ok);

// ---------------------------------------------------------------------------
console.log('3. THE POLYGLOT CASES');
{
  const r = v({ filename: 'certificate.pdf', declaredContentType: 'application/pdf', head: PNG });
  check('a PNG declared and named as a PDF is refused',
    !r.ok && r.rejection.code === 'magic_byte_mismatch', r.ok ? 'ACCEPTED' : r.rejection.code);
  check('  ... and it ALERTS', !r.ok && r.rejection.alert === true);
  check('  ... and the detail carries no filename',
    !r.ok && !r.rejection.detail.includes('certificate'), !r.ok ? r.rejection.detail : '');
}
{
  const r = v({ filename: 'payload.pdf.exe', declaredContentType: 'application/pdf', head: PDF });
  check('a double extension resolves on the LAST dot, so .exe is refused',
    !r.ok && r.rejection.code === 'extension_mismatch', r.ok ? 'ACCEPTED' : r.rejection.code);
  check('  ... and it ALERTS', !r.ok && r.rejection.alert === true);
}
{
  const r = v({ filename: 'logo.svg', declaredContentType: 'image/svg+xml', head: SVG });
  check('SVG is refused outright', !r.ok && r.rejection.code === 'type_not_allowed');
  check('  ... and SVG specifically ALERTS (HTML-equivalent, no HR use case)',
    !r.ok && r.rejection.alert === true);
}
{
  const r = v({ filename: 'resume.docx', declaredContentType: DOCX, head: SVG });
  check('an SVG smuggled inside a .docx declaration is refused',
    !r.ok && r.rejection.code === 'magic_byte_mismatch', r.ok ? 'ACCEPTED' : r.rejection.code);
}
{
  const r = v({ filename: 'invoice.pdf', declaredContentType: 'application/pdf', head: MZ });
  check('a Windows executable declared as a PDF is refused',
    !r.ok && r.rejection.code === 'magic_byte_mismatch');
  check('  ... and the alert NAMES the executable',
    !r.ok && r.rejection.detail.includes('x-msdownload'), !r.ok ? r.rejection.detail : '');
}
{
  const r = v({ filename: 'doc.pdf', declaredContentType: 'application/pdf', head: ELF });
  check('an ELF binary declared as a PDF is refused and named',
    !r.ok && r.rejection.detail.includes('x-elf'));
}
{
  const r = v({ filename: 'page.pdf', declaredContentType: 'application/pdf', head: HTML });
  check('HTML declared as a PDF is refused', !r.ok && r.rejection.code === 'magic_byte_mismatch');
}
{
  const r = v({ filename: 'scan.png', declaredContentType: 'image/png', head: JPEG });
  check('a JPEG declared as a PNG is refused (both are allowed types)',
    !r.ok && r.rejection.code === 'magic_byte_mismatch',
    'the allowlist is not enough on its own - the bytes still have to agree');
}

// ---------------------------------------------------------------------------
console.log('4. Structural checks');
{
  const r = v({ filename: 'a.pdf', declaredContentType: 'application/pdf', head: PDF, sizeBytes: 0 });
  check('an empty file is refused', !r.ok && r.rejection.code === 'empty');
  check('  ... and does not alert (an ordinary mistake)', !r.ok && r.rejection.alert === false);
}
{
  const r = v({
    filename: 'a.pdf', declaredContentType: 'application/pdf', head: PDF,
    sizeBytes: MAX_UPLOAD_BYTES + 1,
  });
  check('over the size cap is refused', !r.ok && r.rejection.code === 'too_large');
  check('  ... the message states the limit in MB',
    !r.ok && /25 MB/.test(r.rejection.message), !r.ok ? r.rejection.message : '');
}
check('exactly at the cap is accepted',
  v({ filename: 'a.pdf', declaredContentType: 'application/pdf', head: PDF, sizeBytes: MAX_UPLOAD_BYTES }).ok);
{
  const r = v({ filename: 'noextension', declaredContentType: 'application/pdf', head: PDF });
  check('a file with no extension is refused', !r.ok && r.rejection.code === 'extension_missing');
}
{
  const r = v({ filename: 'a.txt', declaredContentType: 'text/plain', head: PDF });
  check('a disallowed type is refused before anything else',
    !r.ok && r.rejection.code === 'type_not_allowed');
}

// ---------------------------------------------------------------------------
console.log('5. Decompression bombs');
{
  const r = v({
    filename: 'bomb.docx', declaredContentType: DOCX, head: ZIP,
    sizeBytes: 1_000_000, uncompressedBytes: 400_000_000,   // 400:1
  });
  check('a 400:1 expansion ratio is refused',
    !r.ok && r.rejection.code === 'decompression_ratio', r.ok ? 'ACCEPTED' : r.rejection.code);
  check('  ... and it ALERTS', !r.ok && r.rejection.alert === true);
}
check('a realistic 20:1 Office document is accepted',
  v({ filename: 'ok.docx', declaredContentType: DOCX, head: ZIP,
    sizeBytes: 1_000_000, uncompressedBytes: 20_000_000 }).ok);
{
  const r = v({
    filename: 'huge.xlsx', declaredContentType: XLSX, head: ZIP,
    sizeBytes: 20_000_000, uncompressedBytes: 900_000_000,  // 45:1 but absolutely enormous
  });
  check('an absolute uncompressed cap applies even at a modest ratio',
    !r.ok && r.rejection.code === 'decompression_ratio', r.ok ? 'ACCEPTED' : r.rejection.code);
}
check('an unknown uncompressed size does not fail the upload',
  v({ filename: 'ok.docx', declaredContentType: DOCX, head: ZIP, sizeBytes: 1000 }).ok,
  'a ratio we cannot compute must not become a refusal we cannot explain');

// ---------------------------------------------------------------------------
console.log('6. Object keys carry no personal data');
{
  const doc = '11111111-2222-3333-4444-555555555555';
  const ver = '66666666-7777-8888-9999-aaaaaaaaaaaa';
  check('a key is exactly two UUIDs', objectKeyFor(doc, ver) === `${doc}/${ver}`);
  let threw = false;
  try { objectKeyFor('EMP001', ver); } catch { threw = true; }
  check('an employee number in a key is refused', threw,
    'bucket listings, backups and access logs all travel differently from the database');
  threw = false;
  try { objectKeyFor(doc, 'aadhaar-scan.pdf'); } catch { threw = true; }
  check('a filename in a key is refused', threw);
}

// ---------------------------------------------------------------------------
console.log('');
if (fail) {
  console.log('FAILURES:');
  for (const f of failures) console.log(`  FAIL  ${f}`);
}
console.log(`${fail === 0 ? 'UPLOAD VALIDATION OK' : 'UPLOAD VALIDATION FAILED'} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
