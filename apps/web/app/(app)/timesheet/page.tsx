'use client';

import { useState } from 'react';
import { addDaysIso, api, ApiError, fmtDate, fmtDateShort, hm, decimalHours, useData, weekdayOf } from '@/lib/api';
import { Async, Badge, Bar, Button, Card, CardHead, Empty, Toast } from '@/components/ui';

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
  const [start, setStart] = useState('2026-09-07');
  const state = useData<Timesheet>(`/timesheet?start=${start}`, [start]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; tone: 'good' | 'bad' } | null>(null);

  async function submit() {
    setBusy(true);
    try {
      const res = await api.post<{ totalMinutes: number }>('/timesheet/submit', { start });
      setToast({ msg: `Timesheet submitted — ${hm(res.totalMinutes)}`, tone: 'good' });
      await state.reload();
    } catch (err) {
      setToast({ msg: err instanceof ApiError ? err.message : 'Could not submit', tone: 'bad' });
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
          <h1 className="text-[21px] font-semibold text-ink-900">Timesheet</h1>
          <p className="mt-0.5 text-[13.5px] text-ink-500">
            The week is the approvable, lockable unit — not the individual day.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="secondary" size="sm" onClick={() => setStart((s) => addDaysIso(s, -7))} aria-label="Previous week">←</Button>
          <span className="num min-w-[11rem] text-center text-[13.5px] font-medium text-ink-800">
            {fmtDateShort(start)} – {fmtDateShort(addDaysIso(start, 6))}
          </span>
          <Button variant="secondary" size="sm" onClick={() => setStart((s) => addDaysIso(s, 7))} aria-label="Next week">→</Button>
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
                      Approved and locked. Corrections need an adjustment.
                    </div>
                  ) : status === 'submitted' ? (
                    <div className="rounded-lg bg-amber-50 px-3.5 py-2 text-[13px] text-amber-900 ring-1 ring-inset ring-amber-200">
                      Awaiting your manager. The week is locked while it is under review.
                    </div>
                  ) : (
                    <Button onClick={submit} busy={busy} disabled={empty}>
                      Submit for approval
                    </Button>
                  )}
                </div>
              </Card>

              {empty ? (
                <Card>
                  <Empty
                    title="Nothing logged this week"
                    hint="Record effort against your projects on the My Work screen, then submit the week."
                    action={<Button variant="secondary" onClick={() => (window.location.href = '/work')}>Go to My Work</Button>}
                  />
                </Card>
              ) : (
                <div className="grid gap-5 lg:grid-cols-2">
                  <Card>
                    <CardHead title="By day" hint="Weekends and days with no entry are omitted." />
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
                    <CardHead title="By project" hint="This is the number project costing consumes — never attendance." />
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
