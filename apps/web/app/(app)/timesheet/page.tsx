'use client';

import { useState } from 'react';
import { addDaysIso, api, ApiError, fmtDate, fmtDateShort, hm, decimalHours, useData, weekdayOf } from '@/lib/api';
import { Async, Badge, Bar, Button, Card, CardHead, Empty, Toast } from '@/components/ui';
import { withBasePath } from '@/lib/base-path';
import { useT } from '@/lib/i18n';

interface Timesheet {
  periodStart: string; periodEnd: string;
  period: {
    id: string; period_start: string; period_end: string; status: string;
    submitted_at: string | null; decided_at: string | null;
    return_note: string | null; decided_by_name: string | null;
  } | null;
  byDay: { work_date: string; minutes: number }[];
  byProject: { code: string; name: string; minutes: number }[];
  totalMinutes: number;
}

export default function TimesheetPage() {
  const t = useT();
  /*
   * NO DATE LITERAL. This opened on `useState('2026-09-07')` - one fixed week, forever.
   *
   * `GET /timesheet` already defaults its own `periodStart` from `fn_business_date()` when
   * the parameter is absent, so the literal was overriding a correct server default with a
   * stale one. The state starts empty, the first request sends no `start`, and the
   * response's own `periodStart` becomes the anchor the week arrows move from. An
   * explicitly chosen week is preserved.
   */
  const [start, setStart] = useState('');
  /*
   * The parameter is OMITTED when nothing is chosen, not sent empty.
   *
   * `?start=` is not the same as absent: the handler resolves `start ?? weekStart(today)`, and
   * `??` does not fall back on an empty string - so an empty value would have been used as the
   * period start and matched no week at all.
   */
  const state = useData<Timesheet>(`/timesheet${start ? `?start=${start}` : ''}`, [start]);
  // The week actually being shown: what was chosen, or what the server resolved. Every arrow,
  // label and submit reads THIS, so none of them can act on an empty string.
  const week = start || state.data?.periodStart || '';
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; tone: 'good' | 'bad' } | null>(null);

  async function submit() {
    setBusy(true);
    try {
      const res = await api.post<{ totalMinutes: number }>('/timesheet/submit', { start: week });
      setToast({ msg: `{t('ts.submitted')} — ${hm(res.totalMinutes)}`, tone: 'good' });
      await state.reload();
    } catch (err) {
      setToast({ msg: err instanceof ApiError ? err.message : t('ts.couldNotSubmit'), tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }

  const maxDay = Math.max(1, ...(state.data?.byDay.map((d) => d.minutes) ?? [1]));
  const maxProject = Math.max(1, ...(state.data?.byProject.map((p) => p.minutes) ?? [1]));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[21px] font-semibold text-ink-900">{t('ts.title')}</h1>
          <p className="mt-0.5 text-[13.5px] text-ink-500">
            {t('ts.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="secondary" size="sm" onClick={() => week && setStart(addDaysIso(week, -7))} disabled={!week} aria-label={t('ts.previousWeek')}>←</Button>
          <span className="num min-w-[11rem] text-center text-[13.5px] font-medium text-ink-800">
            {week ? `${fmtDateShort(week)} – ${fmtDateShort(addDaysIso(week, 6))}` : '—'}
          </span>
          <Button variant="secondary" size="sm" onClick={() => week && setStart(addDaysIso(week, 7))} disabled={!week} aria-label={t('ts.nextWeek')}>→</Button>
        </div>
      </div>

      <Async state={state} rows={5}>
        {(d) => {
          const status = d.period?.status ?? 'draft';
          const locked = status === 'submitted' || status === 'approved';
          const empty = d.totalMinutes === 0;

          return (
            <div className="space-y-5">
              <Card>
                <div className="flex flex-wrap items-center justify-between gap-4 p-4 sm:p-5">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="num text-[26px] font-semibold text-ink-900">{hm(d.totalMinutes)}</span>
                      <Badge status={status} />
                    </div>
                    <p className="mt-0.5 text-[13px] text-ink-500">
                      {fmtDate(d.periodStart)} → {fmtDate(d.periodEnd)}
                      <span className="num"> · {decimalHours(d.totalMinutes)} decimal hours</span>
                    </p>
                    {d.period?.decided_by_name && (
                      <p className="mt-1 text-[12.5px] text-ink-500">
                        {status} by {d.period.decided_by_name}
                        {d.period.return_note ? ` — “${d.period.return_note}”` : ''}
                      </p>
                    )}
                  </div>

                  {status === 'approved' ? (
                    <div className="rounded-lg bg-emerald-50 px-3.5 py-2 text-[13px] text-emerald-800 ring-1 ring-inset ring-emerald-200">
                      {t('ts.approvedLocked')}
                    </div>
                  ) : status === 'submitted' ? (
                    <div className="rounded-lg bg-amber-50 px-3.5 py-2 text-[13px] text-amber-900 ring-1 ring-inset ring-amber-200">
                      {t('ts.underReview')}
                    </div>
                  ) : (
                    <Button onClick={submit} busy={busy} disabled={empty}>
                      {t('ts.submitForApproval')}
                    </Button>
                  )}
                </div>
              </Card>

              {empty ? (
                <Card>
                  <Empty
                    title={t('ts.nothingLogged')}
                    hint={t('ts.nothingLoggedHint')}
                    action={<Button variant="secondary" onClick={() => (window.location.href = withBasePath('/work'))}>{t('ts.goToMyWork')}</Button>}
                  />
                </Card>
              ) : (
                <div className="grid gap-5 lg:grid-cols-2">
                  <Card>
                    <CardHead title={t('ts.byDay')} hint={t('ts.byDayHint')} />
                    <ul className="space-y-3 p-4 sm:p-5">
                      {d.byDay.map((day) => (
                        <li key={day.work_date}>
                          <div className="flex items-baseline justify-between text-[13px]">
                            <span className="num text-ink-700">
                              {weekdayOf(day.work_date)} {fmtDateShort(day.work_date)}
                            </span>
                            <span className="num font-medium text-ink-900">{hm(day.minutes)}</span>
                          </div>
                          <div className="mt-1"><Bar value={day.minutes} max={maxDay} /></div>
                        </li>
                      ))}
                    </ul>
                  </Card>

                  <Card>
                    <CardHead title={t('ts.byProject')} hint={t('ts.byProjectHint')} />
                    <ul className="space-y-3 p-4 sm:p-5">
                      {d.byProject.map((p) => (
                        <li key={p.code}>
                          <div className="flex items-baseline justify-between gap-2 text-[13px]">
                            <span className="min-w-0 truncate text-ink-700">
                              {p.name} <span className="num text-ink-400">{p.code}</span>
                            </span>
                            <span className="num font-medium text-ink-900">{hm(p.minutes)}</span>
                          </div>
                          <div className="mt-1"><Bar value={p.minutes} max={maxProject} tone="good" /></div>
                        </li>
                      ))}
                    </ul>
                  </Card>
                </div>
              )}

              {locked && (
                <p className="text-[12.5px] text-ink-500">
                  The lock is enforced by the database, not only by this screen — an attempt to edit a
                  submitted week is refused even from raw SQL.
                </p>
              )}
            </div>
          );
        }}
      </Async>

      {toast && <Toast message={toast.msg} tone={toast.tone} onDone={() => setToast(null)} />}
    </div>
  );
}
