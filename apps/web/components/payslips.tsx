'use client';

import { useEffect, useState } from 'react';
import { api, ApiError, fmtDate, fmtDateShort, useBusinessDate, useData } from '@/lib/api';
import { useT } from '@/lib/i18n';
import {
  Async, Badge, Button, Card, CardBody, CardHead, Empty, ErrorBox, Field, Skeleton, Stat, Toast,
  inputCls,
} from '@/components/ui';

/**
 * Payslips - the employee's own, and HR's management of somebody else's.
 *
 * MONEY IS FORMATTED FROM STRINGS, NEVER PARSED INTO A NUMBER FIRST.
 *
 * The API sends integer paise as text (Rule 4). `(Number(paise)/100).toFixed(2)` is the obvious
 * formatter and it reintroduces exactly the float the API went to trouble to avoid - it happens to
 * be exact for values under ~90 trillion paise, but "happens to be exact" is not a property to
 * build a salary register on. `formatPaise` splits the digits as text instead, so the rupee figure
 * on screen is the integer from the database with a decimal point inserted.
 *
 * AND THE TOTALS ARE NOT COMPUTED HERE. Gross, total deductions and net all arrive derived from
 * `fn_payslip_totals`. Re-deriving them in the browser would give the reader a second opinion
 * that could disagree with the one the database enforced at issue time - and the disagreement
 * would look like a UI bug rather than the data problem it would actually be.
 */

/** Integer paise as text -> a rupee string, with no float in between. */
export function formatPaise(paise: string | number | null | undefined): string {
  if (paise === null || paise === undefined || paise === '') return '—';
  const s = String(paise);
  const neg = s.startsWith('-');
  const digits = (neg ? s.slice(1) : s).replace(/\D/g, '').padStart(3, '0');
  const whole = digits.slice(0, -2);
  const frac = digits.slice(-2);
  // Indian digit grouping: the last three, then pairs. 1234567 -> 12,34,567
  const grouped = whole.replace(/\B(?=(\d{2})*(\d{3})$)/g, ',');
  return `${neg ? '-' : ''}${grouped}.${frac}`;
}

export interface PayslipRow {
  id: string; employee_number: string; full_name: string;
  period_start: string; period_end: string; pay_date: string | null;
  status: string; currency_code: string;
  net_minor: string; gross_minor: string; deductions_minor: string;
  declared_net_minor: string | null; line_count: number;
  has_document: boolean; reconciles: boolean;
  issued_at: string | null; voided_at: string | null; void_reason: string | null;
}

interface PayslipDetailData {
  payslip: Partial<PayslipRow> & { note?: string; source?: string };
  lines: {
    component_code: string; name: string; kind: string; is_statutory: boolean;
    amount_minor: string; note: string | null;
  }[];
  totals: { gross_minor: string; deductions_minor: string; net_minor: string; line_count: number };
  reconciles: boolean;
}

const period = (r: { period_start: string; period_end: string }) =>
  `${fmtDateShort(r.period_start)} – ${fmtDateShort(r.period_end)}`;

// ---------------------------------------------------------------------------

/** The salary breakdown for one payslip, plus the document. */
export function PayslipDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT();
  const state = useData<PayslipDetailData>(`/payslips/${id}`, [id]);
  const [preview, setPreview] = useState<{ url: string; revoke: () => void } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => () => preview?.revoke(), [preview]);

  /*
   * The preview is built from a `blob:` URL the browser never navigates to (DEC-050). The API
   * always sends `Content-Disposition: attachment`, so opening the response directly would
   * download rather than render - and relaxing that header is what would let a scripted PDF run
   * in the origin holding the session cookie.
   */
  async function view() {
    setBusy(true); setErr(null);
    try {
      const b = await api.blob(`/payslips/${id}/document?mode=view`);
      setPreview((old) => { old?.revoke(); return b; });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'That document could not be opened.');
    } finally { setBusy(false); }
  }

  async function download() {
    setBusy(true); setErr(null);
    try { await api.download(`/payslips/${id}/document`, 'payslip.pdf'); }
    catch (e) {
      setErr(e instanceof ApiError ? e.message : 'That document could not be downloaded.');
    } finally { setBusy(false); }
  }

  return (
    <Async state={state} rows={5}>
      {(d) => (
        <div className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-[17px] font-semibold text-ink-900">
                {d.payslip.period_start ? period(d.payslip as PayslipRow) : t('pay.payslip')}
              </h2>
              <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[13px] text-ink-500">
                <Badge status={d.payslip.status === 'issued' ? 'approved'
                  : d.payslip.status === 'void' ? 'rejected' : 'draft'}>
                  {d.payslip.status}
                </Badge>
                {d.payslip.pay_date && <span>paid {fmtDate(d.payslip.pay_date)}</span>}
                {d.payslip.full_name && <span>· {d.payslip.full_name}</span>}
              </p>
            </div>
            <Button variant="secondary" size="sm" onClick={onClose}>{t('common.close')}</Button>
          </div>

          {d.payslip.status === 'void' && (
            <Card className="border-rose-200 bg-rose-50/50 px-4 py-3.5 sm:px-5">
              <p className="text-[13px] text-rose-800">
                <span className="font-medium">{t('pay.voided')}</span>{' '}
                {d.payslip.void_reason}
                {' '}The record is kept — a pay record is never deleted — but its document is no
                longer available.
              </p>
            </Card>
          )}

          <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Stat label={t('pay.gross')} value={`₹${formatPaise(d.totals.gross_minor)}`} />
            <Stat label={t('payslips.deductions')} value={`₹${formatPaise(d.totals.deductions_minor)}`} />
            <Stat label={t('payslips.netPay')} value={`₹${formatPaise(d.totals.net_minor)}`} tone="brand" />
          </section>

          {/*
            * THE RECONCILIATION, said out loud.
            *
            * An issued payslip cannot fail this - the database refuses to issue one whose lines
            * do not total to the figure declared from the PDF. So a warning here on an ISSUED
            * payslip would mean something has gone wrong that a constraint was meant to prevent,
            * and it is worth showing rather than hiding.
            */}
          {!d.reconciles && (
            <Card className={`px-4 py-3.5 sm:px-5 ${d.payslip.status === 'issued'
              ? 'border-rose-300 bg-rose-50' : 'border-amber-200 bg-amber-50/60'}`}>
              <p className="text-[13px] text-ink-800">
                <span className="font-medium">
                  {d.payslip.status === 'issued'
                    ? 'These figures no longer agree with the PDF.'
                    : 'Not yet reconciled.'}
                </span>{' '}
                The lines total{' '}
                <span className="num font-medium">₹{formatPaise(d.totals.net_minor)}</span>
                {' '}and the PDF declares{' '}
                <span className="num font-medium">
                  ₹{formatPaise(d.payslip.declared_net_minor)}
                </span>.
                {d.payslip.status === 'draft'
                  && ' This payslip cannot be issued until they match exactly.'}
              </p>
            </Card>
          )}

          <Card>
            <CardHead title={t('pay.breakdown')} hint={`${d.totals.line_count} line items`} />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[26rem] text-start text-[13.5px]">
                <tbody className="divide-y divide-ink-100">
                  {(['earning', 'deduction'] as const).map((kind) => {
                    const rows = d.lines.filter((l) => l.kind === kind);
                    if (rows.length === 0) return null;
                    return [
                      <tr key={`${kind}-head`}>
                        {/* A group heading spanning the row, so scope is `colgroup` rather than
                            `col` - it labels the section below it, not one column. `text-start`
                            rather than `text-left` so it follows the writing direction. */}
                        <th
                          colSpan={2}
                          scope="colgroup"
                          className="px-3 pt-3 pb-1 text-start text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-400"
                        >
                          {kind === 'earning' ? t('payslips.earnings') : t('payslips.deductions')}
                        </th>
                      </tr>,
                      ...rows.map((l) => (
                        <tr key={l.component_code}>
                          <td className="px-3 py-2 text-ink-800">
                            {l.name}
                            {l.is_statutory && (
                              <span className="ms-2 text-[11px] text-ink-400">statutory</span>
                            )}
                            {l.note && (
                              <div className="text-[12px] text-ink-400">{l.note}</div>
                            )}
                          </td>
                          <td className={`num px-3 py-2 text-end ${
                            kind === 'deduction' ? 'text-rose-700' : 'text-ink-800'}`}>
                            {kind === 'deduction' ? '−' : ''}₹{formatPaise(l.amount_minor)}
                          </td>
                        </tr>
                      )),
                    ];
                  })}
                  <tr className="bg-ink-50">
                    <td className="px-3 py-2.5 font-semibold text-ink-900">{t('payslips.netPay')}</td>
                    <td className="num px-3 py-2.5 text-end font-semibold text-ink-900">
                      ₹{formatPaise(d.totals.net_minor)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>

          <Card>
            <CardHead
              title={t('pay.document')}
              hint={d.payslip.has_document
                ? 'The PDF issued for this period, stored in the document store.'
                : 'No document is available for this payslip.'}
            />
            {/*
              * ONE PADDED BODY, so everything below the header shares the header's edge.
              *
              * The View and Download buttons, the error box and the PDF preview each sat directly
              * inside <Card> with no padding of their own, while `CardHead` insets its text by
              * `px-4 sm:px-5`. So the buttons started ~23px to the LEFT of the heading above them
              * and pressed against the bottom of the card. `p-4 sm:p-5` is what every other card
              * body in this app uses; `Empty` brings its own padding, so it stays outside.
              */}
            {d.payslip.has_document ? (
              <div className="p-4 sm:p-5">
                {err && <div className="mb-3"><ErrorBox message={err} /></div>}
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={view} disabled={busy}>{t('docs.view')}</Button>
                  <Button variant="secondary" size="sm" onClick={download} disabled={busy}>
                    {t('docs.download')}
                  </Button>
                </div>

                {preview && (
                  <div className="mt-3 overflow-hidden rounded-lg border border-ink-200">
                    {/*
                      * `sandbox` with NO allow tokens: an opaque origin with scripts refused. A
                      * PDF is a program format, and this one arrived from a file upload.
                      */}
                    <iframe
                      src={preview.url}
                      title={t('pay.payslip')}
                      sandbox=""
                      className="h-[28rem] w-full bg-ink-50"
                    />
                  </div>
                )}
              </div>
            ) : (
              <>
                {err && <div className="px-4 pt-4 sm:px-5"><ErrorBox message={err} /></div>}
                <Empty
                  title={t('pay.noDocument')}
                  hint={d.payslip.status === 'void'
                    ? 'Voiding a payslip withdraws its document.'
                    : 'HR attaches the PDF before the payslip is issued.'}
                />
              </>
            )}
          </Card>
        </div>
      )}
    </Async>
  );
}

// ---------------------------------------------------------------------------

/** The list. Shared by My Payslips and by HR's view of one employee. */
export function PayslipList({ employeeId, onOpen, emptyHint }: {
  employeeId?: string; onOpen: (id: string) => void; emptyHint?: string;
}) {
  const t = useT();
  const q = employeeId ? `?employeeId=${employeeId}` : '';
  const state = useData<{ rows: PayslipRow[] }>(`/payslips${q}`, [q]);

  return (
    <Async
      state={state}
      rows={4}
      isEmpty={(d) => d.rows.length === 0}
      empty={(
        <Card>
          <Empty title={t('payslips.empty')} hint={emptyHint ?? 'Payslips appear here once HR issues them.'} />
        </Card>
      )}
    >
      {(d) => (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-start text-[13.5px]">
              <thead>
                <tr className="border-b border-ink-200">
                  {[t('period.label'), t('payslips.paid'), t('common.status'), t('payslips.netPay'), t('common.actions')].map((h, i) => (
                    <th scope="col"
                      key={h}
                      className={`px-3 py-2 text-[12px] font-medium uppercase tracking-wide text-ink-400 ${i > 0 ? 'text-end' : ''}`}
                    >
                      {/* Named for assistive tech, hidden visually - a column of buttons needs no
                          visible label but must not be anonymous. */}
                      <span className={h === t('common.actions') ? 'sr-only' : undefined}>{h}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {d.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-ink-800">{period(r)}</div>
                      {!employeeId && r.full_name && (
                        <div className="num text-[12px] text-ink-400">{r.employee_number}</div>
                      )}
                    </td>
                    <td className="num px-3 py-2.5 text-end text-ink-600">
                      {r.pay_date ? fmtDateShort(r.pay_date) : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-end">
                      <Badge status={r.status === 'issued' ? 'approved'
                        : r.status === 'void' ? 'rejected' : 'draft'}>
                        {r.status}
                      </Badge>
                      {!r.reconciles && r.status !== 'void' && (
                        <span className="ms-1.5 text-[11px] font-medium text-amber-700">
                          {t('payslips.unreconciled')}
                        </span>
                      )}
                    </td>
                    <td className="num px-3 py-2.5 text-end font-medium text-ink-900">
                      ₹{formatPaise(r.net_minor)}
                    </td>
                    <td className="px-3 py-2.5 text-end">
                      <Button variant="secondary" size="sm" onClick={() => onOpen(r.id)}>
                        {t('common.open')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </Async>
  );
}

// ---------------------------------------------------------------------------

interface Component {
  code: string; name: string; kind: string; is_statutory: boolean;
}

/**
 * HR's add-payslip form.
 *
 * IT DOES NOT CALCULATE ANYTHING, and the copy says so where HR can see it. Every figure is typed
 * in from a payroll result finalised elsewhere; the running totals below are a display check
 * against the declared net, not a computation of it. ADR-0012 is BLOCKED on build-versus-buy and
 * owns the engine, so a form that quietly derived PF or TDS would be pre-empting a decision that
 * is explicitly a human's.
 *
 * The running total IS computed here, and only here - as a hint while typing, before anything is
 * saved. The authoritative total comes back from the database on every read.
 */
export function AddPayslip({ employeeId, employeeName, onDone, onCancel }: {
  employeeId: string; employeeName: string; onDone: () => void; onCancel: () => void;
}) {
  const t = useT();
  const comps = useData<{ components: Component[] }>('/payslips/components');
  /*
   * The pay period defaults from the SERVER's business date.
   *
   * It was `new Date().toISOString().slice(0, 10)`, so before 05:30 IST the period ended
   * a day early. That is not cosmetic on this form: 0024 stores the period as a generated
   * half-open range with an EXCLUDE constraint, and the payslip only issues when the net
   * derived from the lines matches the net declared on the PDF - a period a day short is a
   * month's payroll attributed to the wrong window.
   */
  const today = useBusinessDate();
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');

  useEffect(() => {
    if (!today) return;
    setPeriodStart((v) => v || `${today.slice(0, 7)}-01`);
    setPeriodEnd((v) => v || today);
  }, [today]);
  const [payDate, setPayDate] = useState('');
  const [declaredNet, setDeclaredNet] = useState('');
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  /*
   * A display check in the same integer paise the API uses - the digits are parsed as text and
   * summed with BigInt, so the running total on screen agrees exactly with what the database will
   * derive. Formatting through a float here would let the hint and the truth disagree in the last
   * paise, which is the one place a payroll figure must not wobble.
   */
  const toPaise = (v: string): bigint => {
    const m = /^(-?)(\d{1,12})(?:\.(\d{1,2}))?$/.exec(v.trim().replace(/[, ]/g, ''));
    if (!m) return 0n;
    const p = BigInt(m[2]) * 100n + BigInt(`${m[3] ?? ''}00`.slice(0, 2));
    return m[1] === '-' ? -p : p;
  };

  const list = comps.data?.components ?? [];
  const gross = list.filter((c) => c.kind === 'earning')
    .reduce((a, c) => a + toPaise(amounts[c.code] ?? ''), 0n);
  const deductions = list.filter((c) => c.kind === 'deduction')
    .reduce((a, c) => a + toPaise(amounts[c.code] ?? ''), 0n);
  const net = gross - deductions;
  const declared = toPaise(declaredNet);
  const matches = declaredNet.trim() !== '' && declared === net;

  async function save(issue: boolean) {
    setBusy(true); setErr(null);
    try {
      const lines = list
        .filter((c) => (amounts[c.code] ?? '').trim() !== '')
        .map((c) => ({ componentCode: c.code, amount: amounts[c.code] }));
      if (lines.length === 0) throw new ApiError(400, 'Enter at least one earning or deduction.');

      const created = await api.post<{ id: string }>('/payslips', {
        employeeId, periodStart, periodEnd, payDate: payDate || undefined,
        declaredNet: declaredNet || undefined, lines,
      });

      if (file) {
        const fd = new FormData();
        fd.append('file', file);
        await api.upload(`/payslips/${created.id}/document`, fd);
      }

      if (issue) await api.post(`/payslips/${created.id}/issue`);

      setToast(issue ? 'Payslip issued.' : 'Payslip saved as a draft.');
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'That payslip could not be saved.');
    } finally { setBusy(false); }
  }

  if (comps.loading) return <Skeleton rows={6} />;
  if (comps.error) return <ErrorBox message={comps.error} onRetry={comps.reload} />;

  return (
    <div className="space-y-4">
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold text-ink-900">{t('pay.addPayslip')}</h2>
          <p className="mt-0.5 text-[13px] text-ink-500">
            For {employeeName}. Enter the finalised payroll figures and attach the issued PDF —
            nothing here is calculated.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={onCancel}>{t('common.cancel')}</Button>
      </div>

      {err && <ErrorBox message={err} />}

      <Card>
        <CardHead title={t('pay.payPeriod')} />
        <CardBody>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('leave.from')} htmlFor="ps-from">
            <input id="ps-from" type="date" value={periodStart} max={periodEnd}
              onChange={(e) => setPeriodStart(e.target.value)} className={inputCls} />
          </Field>
          <Field label={t('leave.to')} htmlFor="ps-to">
            <input id="ps-to" type="date" value={periodEnd} min={periodStart}
              onChange={(e) => setPeriodEnd(e.target.value)} className={inputCls} />
          </Field>
          <Field label={t('pay.payDate')} hint="optional" htmlFor="ps-paid">
            <input id="ps-paid" type="date" value={payDate}
              onChange={(e) => setPayDate(e.target.value)} className={inputCls} />
          </Field>
        </div>
      </CardBody>
    </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {(['earning', 'deduction'] as const).map((kind) => (
          <Card key={kind}>
            <CardHead
              title={kind === 'earning' ? t('payslips.earnings') : t('payslips.deductions')}
              hint={kind === 'earning' ? 'Rupees. Leave blank to omit a component.'
                : 'Enter as positive amounts — they are subtracted.'}
            />
            <CardBody>
            <div className="space-y-2.5">
              {list.filter((c) => c.kind === kind).map((c) => (
                <div key={c.code} className="flex items-center gap-3">
                  <label htmlFor={`amt-${c.code}`} className="flex-1 text-[13.5px] text-ink-700">
                    {c.name}
                    {c.is_statutory && (
                      <span className="ms-1.5 text-[11px] text-ink-400">statutory</span>
                    )}
                  </label>
                  <input
                    id={`amt-${c.code}`}
                    inputMode="decimal"
                    placeholder="0.00"
                    value={amounts[c.code] ?? ''}
                    onChange={(e) => setAmounts((a) => ({ ...a, [c.code]: e.target.value }))}
                    className={`${inputCls} num w-32 text-end`}
                  />
                </div>
              ))}
            </div>
          </CardBody>
    </Card>
        ))}
      </div>

      <Card>
        <CardHead
          title={t('pay.checkAgainstPdf')}
          hint={t('pay.reconcileHint')}
        />
        <CardBody>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label={t('pay.gross')} value={`₹${formatPaise(gross.toString())}`} />
          <Stat label={t('payslips.deductions')} value={`₹${formatPaise(deductions.toString())}`} />
          <Stat label={t('payslips.netPay')} value={`₹${formatPaise(net.toString())}`} tone="brand" />
        </div>
        <div className="mt-3 max-w-xs">
          <Field
            label={t('pay.netAsPrinted')}
            hint={t('pay.typedSeparately')}
            htmlFor="ps-declared"
          >
            <input id="ps-declared" inputMode="decimal" placeholder="0.00" value={declaredNet}
              onChange={(e) => setDeclaredNet(e.target.value)}
              className={`${inputCls} num text-end`} />
          </Field>
        </div>
        {declaredNet.trim() !== '' && (
          <p className={`mt-2 text-[13px] font-medium ${matches ? 'text-emerald-700' : 'text-amber-700'}`}>
            {matches
              ? '✓ The figures agree — this payslip can be issued.'
              : `These do not match: the lines total ₹${formatPaise(net.toString())} and you entered ₹${formatPaise(declared.toString())}.`}
          </p>
        )}
      </CardBody>
    </Card>

      <Card>
        <CardHead title={t('pay.thePdf')} hint={t('pay.pdfHint')} />
        <CardBody>
        <input
          type="file"
          accept="application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-[13.5px] text-ink-600 file:me-3 file:rounded-lg file:border-0 file:bg-ink-100 file:px-3 file:py-1.5 file:text-[13px] file:font-medium file:text-ink-700 hover:file:bg-ink-200"
        />
        {file && (
          <p className="mt-2 text-[12.5px] text-ink-500">
            {file.name} · {(file.size / 1024).toFixed(0)} KB
          </p>
        )}
      </CardBody>
    </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => save(true)} disabled={busy || !matches || !file}>
          {t('pay.saveAndIssue')}
        </Button>
        <Button variant="secondary" onClick={() => save(false)} disabled={busy}>
          {t('pay.saveAsDraft')}
        </Button>
        {(!matches || !file) && (
          <span className="text-[12.5px] text-ink-500">
            {!file ? 'Attach the PDF' : 'Figures must match'} before issuing.
          </span>
        )}
      </div>
    </div>
  );
}
