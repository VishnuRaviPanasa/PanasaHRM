'use client';

import { useState } from 'react';
import { fmtDate, hm, useData, weekdayOf } from '@/lib/api';
import { Async, Badge, Button, Card, CardHead, Empty, Stat } from '@/components/ui';
import { PunchCard } from '@/components/punch-card';

interface Attendance {
  month: string;
  days: {
    business_date: string; status: string; worked_minutes: number;
    first_in_at: string | null; last_out_at: string | null; note: string | null;
  }[];
  summary: {
    present: string; late: string; wfh: string; absent: string;
    leave: string; week_off: string; total_minutes: number;
  };
}

const MONTH_LABEL = (m: string) => {
  const [y, mm] = m.split('-').map(Number);
  return `${['January','February','March','April','May','June','July','August','September','October','November','December'][mm - 1]} ${y}`;
};

const shiftMonth = (m: string, by: number) => {
  const [y, mm] = m.split('-').map(Number);
  const total = y * 12 + (mm - 1) + by;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
};

const timeOf = (iso: string | null) => {
  if (!iso) return null;
  // Render in the business timezone, not the browser's.
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata',
  });
};

export default function AttendancePage() {
  const [month, setMonth] = useState('2026-09');
  const state = useData<Attendance>(`/attendance?month=${month}`, [month]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[21px] font-semibold text-ink-900">Attendance</h1>
          <p className="mt-0.5 text-[13.5px] text-ink-500">
            Was this person present? A separate question from what they worked on.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="secondary" size="sm" onClick={() => setMonth((m) => shiftMonth(m, -1))} aria-label="Previous month">←</Button>
          <span className="min-w-[9.5rem] text-center text-[13.5px] font-medium text-ink-800">{MONTH_LABEL(month)}</span>
          <Button variant="secondary" size="sm" onClick={() => setMonth((m) => shiftMonth(m, 1))} aria-label="Next month">→</Button>
        </div>
      </div>

      <PunchCard onChanged={() => void state.reload()} />

      <Async state={state} rows={6}>
        {(d) => (
          <div className="space-y-5">
            <section aria-label="Monthly summary" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Present" value={d.summary.present} tone="good" />
              <Stat label="Late" value={d.summary.late} tone="warn" />
              <Stat label="WFH" value={d.summary.wfh} tone="brand" />
              <Stat label="Absent" value={d.summary.absent} tone={Number(d.summary.absent) > 0 ? 'bad' : 'plain'} />
              <Stat label="On leave" value={d.summary.leave} />
              <Stat label="Hours" value={hm(d.summary.total_minutes)} sub="recorded" />
            </section>

            <Card>
              <CardHead
                title="Daily record"
                hint="Late is derived from the 15-minute grace period in the attendance policy in force on that date."
              />
              {d.days.length === 0 ? (
                <Empty
                  title="No attendance recorded for this month"
                  hint="Records appear once punches are ingested or entered for these dates."
                />
              ) : (
                <>
                  <div className="hidden overflow-x-auto sm:block">
                    <table className="w-full text-left text-[13.5px]">
                      <thead className="border-b border-ink-100 text-[12px] uppercase tracking-wide text-ink-400">
                        <tr>
                          <th scope="col" className="px-5 py-2.5 font-medium">Date</th>
                          <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
                          <th scope="col" className="px-3 py-2.5 font-medium">In</th>
                          <th scope="col" className="px-3 py-2.5 font-medium">Out</th>
                          <th scope="col" className="px-3 py-2.5 font-medium">Worked</th>
                          <th scope="col" className="px-5 py-2.5 font-medium">Note</th>
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
