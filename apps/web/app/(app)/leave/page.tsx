'use client';

import { useEffect, useState } from 'react';
import { addDaysIso, api, ApiError, fmtDate, fmtDateShort, useBusinessDate, useData, weekdayOf } from '@/lib/api';
import { Async, Badge, Bar, Button, Card, CardHead, Empty, Field, Skeleton, Toast, inputCls } from '@/components/ui';
import { useT } from '@/lib/i18n';

interface Balances {
  leaveYear: number;
  balances: { code: string; name: string; accrued: string | null; taken: string | null; pending: string | null; available: string | null }[];
}
interface Preview {
  from: string; to: string; type: string;
  workingDays: number; calendarDays: number;
  days: { on_date: string; weekday: string; is_weekend: boolean; holiday_name: string | null; counts: boolean }[];
  optionalHolidaysInRange: { holiday_on: string; name: string }[];
  balanceBefore: number; balanceAfter: number; sufficient: boolean;
}
interface Requests {
  requests: {
    id: string; type: string; from_date: string; to_date: string; working_days: string;
    status: string; reason: string | null; submitted_at: string;
    decided_at: string | null; decision_note: string | null; decided_by_name: string | null;
  }[];
}

export default function LeavePage() {
  const t = useT();
  const balances = useData<Balances>('/leave/balance');
  const history = useData<Requests>('/leave/requests');

  /*
   * NO DATE LITERALS. These were '2026-09-14' and '2026-09-16', so the apply form opened
   * on a fixed range that would have been in the past from October onward - and the live
   * preview would have priced it against a leave year that had moved on.
   *
   * Seeded from the SERVER's business date instead, five and seven days ahead: leave is
   * applied for in advance, so a default in the future is the useful one, and the live
   * preview still has something to price the moment the screen opens. `addDaysIso` is
   * UTC-anchored string arithmetic on a value the server produced, so no local timezone
   * enters the calculation at any point.
   */
  const businessDate = useBusinessDate();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  useEffect(() => {
    if (!businessDate) return;
    // Seeds only - a range the person has typed is never overwritten.
    setFrom((v) => v || addDaysIso(businessDate, 5));
    setTo((v) => v || addDaysIso(businessDate, 7));
  }, [businessDate]);
  const [type, setType] = useState('CL');
  const [reason, setReason] = useState('Family function');

  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Live preview: the range is priced as it is typed, so "the system calculates" is visible
  // rather than something the presenter has to describe.
  useEffect(() => {
    if (!from || !to || to < from) { setPreview(null); setPreviewError(to && from && to < from ? 'The end date is before the start date' : null); return; }
    let cancelled = false;
    setPreviewing(true);
    setPreviewError(null);
    api.get<Preview>(`/leave/preview?from=${from}&to=${to}&type=${type}`)
      .then((p) => { if (!cancelled) setPreview(p); })
      .catch((e) => { if (!cancelled) setPreviewError(e instanceof ApiError ? e.message : 'Could not price this range'); })
      .finally(() => { if (!cancelled) setPreviewing(false); });
    return () => { cancelled = true; };
  }, [from, to, type]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      const res = await api.post<{ workingDays: number }>('/leave/requests', { from, to, type, reason });
      setToast(`Leave applied for ${res.workingDays} working day${res.workingDays === 1 ? '' : 's'}`);
      await Promise.all([balances.reload(), history.reload()]);
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : t('ts.couldNotSubmit'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[21px] font-semibold text-ink-900">{t('leave.title')}</h1>
        <p className="mt-0.5 text-[13.5px] text-ink-500">
          {t('leave.subtitle')}
        </p>
      </div>

      {/* Balance */}
      <Async state={balances} rows={2}>
        {(b) => (
          <section aria-label={t('leave.balances')} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {b.balances.map((x) => {
              const avail = Number(x.available ?? 0);
              const pending = Number(x.pending ?? 0);
              return (
                <Card key={x.code} className="px-4 py-3.5">
                  <div className="flex items-baseline justify-between">
                    <span className="text-[12px] font-medium uppercase tracking-wide text-ink-400">{x.code}</span>
                    {pending > 0 && <Badge status="pending">{pending} held</Badge>}
                  </div>
                  <div className="num mt-1 text-2xl font-semibold text-ink-900">{avail}</div>
                  <div className="mt-0.5 text-[12.5px] text-ink-500">
                    of {Number(x.accrued ?? 0)} · {Number(x.taken ?? 0)} taken
                  </div>
                  <div className="mt-2"><Bar value={avail} max={Math.max(1, Number(x.accrued ?? 0))} /></div>
                </Card>
              );
            })}
          </section>
        )}
      </Async>

      <div className="grid gap-5 lg:grid-cols-5">
        {/* Apply */}
        <Card className="lg:col-span-3">
          <CardHead title={t('leave.apply')} hint={t('leave.applyHint')} />
          <form onSubmit={submit} className="space-y-4 p-4 sm:p-5" noValidate>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={t('leave.type')} htmlFor="lv-type">
                <select id="lv-type" className={inputCls} value={type} onChange={(e) => setType(e.target.value)}>
                  {(balances.data?.balances ?? [{ code: 'CL', name: 'Casual Leave' }]).map((b) => (
                    <option key={b.code} value={b.code}>{b.code} — {b.name}</option>
                  ))}
                </select>
              </Field>
              <Field label={t('leave.from')} htmlFor="lv-from">
                <input id="lv-from" type="date" required className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} />
              </Field>
              <Field label={t('leave.to')} htmlFor="lv-to" error={to < from ? 'Must be on or after the start date' : undefined}>
                <input id="lv-to" type="date" required className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} />
              </Field>
            </div>

            <Field label={t('leave.reason')} htmlFor="lv-reason" hint={t('leave.reasonHint')}>
              <input id="lv-reason" type="text" className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('leave.reasonPlaceholder')} />
            </Field>

            {/* The calculation, shown */}
            <div className="rounded-lg bg-ink-50 p-3.5 ring-1 ring-inset ring-ink-200" aria-live="polite">
              {previewing && <div className="skeleton h-4 w-2/3" />}
              {!previewing && previewError && <p className="text-[13px] text-rose-700">{previewError}</p>}
              {!previewing && !previewError && preview && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="num text-[19px] font-semibold text-ink-900">
                      {preview.workingDays} working day{preview.workingDays === 1 ? '' : 's'}
                    </span>
                    <span className="num text-[13px] text-ink-500">
                      from {preview.calendarDays} calendar day{preview.calendarDays === 1 ? '' : 's'}
                    </span>
                  </div>

                  <ul className="flex flex-wrap gap-1.5">
                    {preview.days.map((day) => (
                      <li
                        key={day.on_date}
                        className={`num rounded-md px-2 py-1 text-[12.5px] ring-1 ring-inset ${
                          day.counts
                            ? 'bg-white text-ink-800 ring-ink-200'
                            : 'bg-ink-100 text-ink-400 ring-ink-200 line-through'
                        }`}
                        title={day.holiday_name ?? (day.is_weekend ? 'Weekend' : 'Working day')}
                      >
                        {weekdayOf(day.on_date)} {fmtDateShort(day.on_date)}
                        {day.holiday_name && <span className="ms-1 no-underline">· {day.holiday_name}</span>}
                      </li>
                    ))}
                  </ul>

                  {preview.optionalHolidaysInRange.length > 0 && (
                    <p className="text-[12.5px] text-amber-800">
                      <strong className="font-semibold">{t('leave.note')}</strong>{' '}
                      {preview.optionalHolidaysInRange.map((h) => `${h.name} (${fmtDateShort(h.holiday_on)})`).join(', ')}
                      {' '}is an <em>optional</em> holiday. It still counts as leave unless you elect it,
                      so it is included above.
                    </p>
                  )}

                  <div className="flex items-baseline gap-2 border-t border-ink-200 pt-2.5 text-[13.5px]">
                    <span className="text-ink-500">{type} balance</span>
                    <span className="num font-medium text-ink-800">{preview.balanceBefore}</span>
                    <span aria-hidden className="text-ink-400">→</span>
                    <span className={`num font-semibold ${preview.sufficient ? 'text-ink-900' : 'text-rose-700'}`}>
                      {preview.balanceAfter}
                    </span>
                    {!preview.sufficient && <span className="text-[12.5px] text-rose-700">— not enough balance</span>}
                  </div>
                </div>
              )}
            </div>

            {formError && (
              <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-[13px] text-rose-800 ring-1 ring-inset ring-rose-200">
                {formError}
              </p>
            )}

            <div className="flex items-center gap-3">
              <Button type="submit" busy={busy} disabled={!preview?.sufficient || preview.workingDays === 0}>
                {t('leave.submit')}
              </Button>
              <span className="text-[12.5px] text-ink-500">
                {t('leave.submitHint')}
              </span>
            </div>
          </form>
        </Card>

        {/* History */}
        <Card className="lg:col-span-2">
          <CardHead title={t('leave.history')} />
          <Async
            state={history}
            rows={4}
            isEmpty={(d) => d.requests.length === 0}
            empty={<Empty title={t('leave.noRequests')} hint={t('leave.noRequestsHint')} />}
          >
            {(d) => (
              <ul className="divide-y divide-ink-100">
                {d.requests.map((r) => (
                  <li key={r.id} className="px-4 py-3 sm:px-5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[13.5px] font-medium text-ink-900">
                          {r.type} · <span className="num">{Number(r.working_days)}</span> day{Number(r.working_days) === 1 ? '' : 's'}
                        </div>
                        <div className="num mt-0.5 text-[12.5px] text-ink-500">
                          {fmtDate(r.from_date)} → {fmtDate(r.to_date)}
                        </div>
                        {r.reason && <div className="mt-1 text-[13px] text-ink-600">{r.reason}</div>}
                        {r.decided_by_name && (
                          <div className="mt-1 text-[12.5px] text-ink-500">
                            {r.status} by {r.decided_by_name}
                            {r.decision_note ? ` — “${r.decision_note}”` : ''}
                          </div>
                        )}
                      </div>
                      <Badge status={r.status} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Async>
        </Card>
      </div>

      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}
