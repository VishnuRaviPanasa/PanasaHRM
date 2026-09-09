'use client';

import { useState } from 'react';
import { fmtDate, hm, useData, weekdayOf } from '@/lib/api';
import { Async, Badge, Button, Card, CardHead, Empty, Stat } from '@/components/ui';
import { PunchCard } from '@/components/punch-card';
import { PeriodLabel, PeriodPicker, periodQuery, type Period } from '@/components/period-picker';
import { localeTag, useI18n, useT } from '@/lib/i18n';

interface Attendance {
  month: string;
  from: string;
  to: string;
  preset: string;
  days: {
    business_date: string; status: string; worked_minutes: number;
    first_in_at: string | null; last_out_at: string | null; note: string | null;
  }[];
  summary: {
    present: string; late: string; wfh: string; absent: string;
    leave: string; week_off: string; total_minutes: number;
  };
}

const timeOf = (iso: string | null) => {
  if (!iso) return null;
  // Render in the business timezone, not the browser's.
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata',
  });
};

/**
 * The calendar month containing a date, shifted by `by` months.
 *
 * Used only by the month arrows, and only on a date the SERVER has already resolved and sent
 * back - never on a locally computed "today". The previous version of this page opened on
 * `useState('2026-09')`, a hardcoded literal: the screen would have shown September 2026 in
 * October, and every month after that, with no error to notice.
 */
const monthRange = (anchor: string, by: number): { from: string; to: string } => {
  const [y, m] = anchor.split('-').map(Number);
  const t = y * 12 + (m - 1) + by;
  const yy = Math.floor(t / 12);
  const mm = (t % 12) + 1;
  const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const p = (n: number) => String(n).padStart(2, '0');
  return { from: `${yy}-${p(mm)}-01`, to: `${yy}-${p(mm)}-${p(last)}` };
};

// The month name follows the locale; see the note in period-picker on why UTC is used.
const MONTH_LABEL = (iso: string, tag: string) => {
  const [y, m] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1))
    .toLocaleDateString(tag, { month: 'long', year: 'numeric', timeZone: 'UTC' });
};

export default function AttendancePage() {
  const t = useT();
  const { locale } = useI18n();
  // No date literal. `month` is the default because it is the most useful first view; the server
  // decides which month that is.
  const [period, setPeriod] = useState<Period>({ preset: 'month', from: '', to: '' });
  const q = periodQuery(period);
  const state = useData<Attendance>(`/attendance?${q}`, [q]);

  const anchor = state.data?.from;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[21px] font-semibold text-ink-900">{t('attendance.title')}</h1>
        <p className="mt-0.5 text-[13.5px] text-ink-500">
          {t('attendance.subtitle')}
        </p>
      </div>

      <PunchCard onChanged={() => void state.reload()} />

      {/*
        * The period selector is the PRIMARY filter, so it sits above the data it governs rather
        * than tucked beside the heading where the month arrows used to be.
        *
        * The month arrows are kept because stepping back through history a month at a time is
        * genuinely the most common thing anybody does here - but they now set an explicit range
        * rather than owning a second, competing piece of state. One source of truth for "which
        * period", which is what stopped the old `month` string and a range from disagreeing.
        */}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3.5">
          <PeriodPicker value={period} onChange={setPeriod} busy={state.loading}
                        resolved={{ from: state.data?.from, to: state.data?.to }} />
          {/*
            * HIDDEN while a custom range is being chosen.
            *
            * Two controls that both answer "which period" were on screen at once, and they
            * disagreed: the arrows said December 2025 while the date inputs beside them said
            * 01-06-2026 to 09-09-2026. Whichever one the reader believed, the other was lying.
            * A month stepper is also meaningless next to an arbitrary range - "the month before
            * 1 Jun 2026 to 9 Sep 2026" is not a question with an answer.
            *
            * The arrows now produce `monthOf` rather than `custom`, so stepping through history
            * no longer opens the date inputs either.
            */}
          {period.preset !== 'custom' && (
            <div className="flex items-center gap-1.5">
              <Button
                variant="secondary" size="sm" disabled={!anchor || state.loading}
                onClick={() => anchor && setPeriod({ preset: 'monthOf', ...monthRange(anchor, -1) })}
                aria-label={t('period.previousMonth')}
              >
                ←
              </Button>
              <span className="min-w-[8.5rem] text-center text-[13px] font-medium text-ink-700">
                {anchor ? MONTH_LABEL(anchor, localeTag(locale)) : '—'}
              </span>
              <Button
                variant="secondary" size="sm" disabled={!anchor || state.loading}
                onClick={() => anchor && setPeriod({ preset: 'monthOf', ...monthRange(anchor, 1) })}
                aria-label={t('period.nextMonth')}
              >
                →
              </Button>
            </div>
          )}
        </div>
        <div className="border-t border-ink-100 px-4 py-2">
          <PeriodLabel from={state.data?.from} to={state.data?.to} />
        </div>
      </Card>

      <Async state={state} rows={6}>
        {(d) => (
          <div className="space-y-5">
            <section
              aria-label={t('attendance.summary')}
              className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
            >
              <Stat label={t('attendance.present')} value={d.summary.present} tone="good" />
              <Stat label={t('attendance.late')} value={d.summary.late} tone="warn" />
              <Stat label={t('attendance.wfh')} value={d.summary.wfh} tone="brand" />
              <Stat label={t('attendance.absent')} value={d.summary.absent} tone={Number(d.summary.absent) > 0 ? 'bad' : 'plain'} />
              <Stat label={t('attendance.onLeave')} value={d.summary.leave} />
              <Stat label={t('common.hours')} value={hm(d.summary.total_minutes)} sub={t('attendance.recorded')} />
            </section>

            <Card>
              <CardHead
                title={t('attendance.dailyRecord')}
                hint={t('attendance.dailyHint')}
              />
              {d.days.length === 0 ? (
                <Empty
                  title={t('attendance.empty')}
                  hint={t('attendance.emptyHint')}
                />
              ) : (
                <>
                  <div className="hidden overflow-x-auto sm:block">
                    <table className="w-full text-start text-[13.5px]">
                      <thead className="border-b border-ink-100 text-[12px] uppercase tracking-wide text-ink-400">
                        <tr>
                          <th scope="col" className="px-5 py-2.5 font-medium">{t('common.date')}</th>
                          <th scope="col" className="px-3 py-2.5 font-medium">{t('common.status')}</th>
                          <th scope="col" className="px-3 py-2.5 font-medium">{t('attendance.in')}</th>
                          <th scope="col" className="px-3 py-2.5 font-medium">{t('attendance.out')}</th>
                          <th scope="col" className="px-3 py-2.5 font-medium">{t('attendance.worked')}</th>
                          <th scope="col" className="px-5 py-2.5 font-medium">{t('attendance.note')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-ink-100">
                        {d.days.map((day) => (
                          <tr key={day.business_date} className={day.status === 'week_off' ? 'bg-ink-50/60' : ''}>
                            <td className="num px-5 py-2.5 text-ink-800">
                              {weekdayOf(day.business_date)} {fmtDate(day.business_date)}
                            </td>
                            <td className="px-3 py-2.5"><Badge status={day.status} /></td>
                            <td className="num px-3 py-2.5 text-ink-600">{timeOf(day.first_in_at) ?? '—'}</td>
                            <td className="num px-3 py-2.5 text-ink-600">{timeOf(day.last_out_at) ?? '—'}</td>
                            <td className="num px-3 py-2.5 text-ink-800">{day.worked_minutes ? hm(day.worked_minutes) : '—'}</td>
                            <td className="px-5 py-2.5 text-[13px] text-ink-500">{day.note ?? ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <ul className="divide-y divide-ink-100 sm:hidden">
                    {d.days.map((day) => (
                      <li key={day.business_date} className="flex items-center justify-between gap-3 px-4 py-2.5">
                        <div>
                          <div className="num text-[13.5px] text-ink-800">
                            {weekdayOf(day.business_date)} {fmtDate(day.business_date)}
                          </div>
                          <div className="num text-[12.5px] text-ink-500">
                            {timeOf(day.first_in_at) ? `${timeOf(day.first_in_at)}–${timeOf(day.last_out_at) ?? '—'}` : '—'}
                            {day.worked_minutes ? ` · ${hm(day.worked_minutes)}` : ''}
                          </div>
                        </div>
                        <Badge status={day.status} />
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Card>
          </div>
        )}
      </Async>
    </div>
  );
}
