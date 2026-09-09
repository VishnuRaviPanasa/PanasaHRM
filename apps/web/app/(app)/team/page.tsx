'use client';

import { useState } from 'react';
import { addDaysIso, fmtDate, fmtDateShort, hm, decimalHours, useData, weekdayOf } from '@/lib/api';
import { Async, Badge, Bar, Button, Card, CardHead, Empty, Stat } from '@/components/ui';

interface Effort {
  periodStart: string; periodEnd: string;
  rows: { full_name: string; employee_number: string; project_code: string; project_name: string; minutes: number }[];
  attendanceVsEffort: {
    full_name: string; business_date: string; attendance_status: string;
    attendance_minutes: number; logged_minutes: number; variance_flag: string;
  }[];
}

export default function TeamPage() {
  const [start, setStart] = useState('2026-08-31');
  const state = useData<Effort>(`/team/effort?start=${start}`, [start]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[21px] font-semibold text-ink-900">Team effort</h1>
          <p className="mt-0.5 text-[13.5px] text-ink-500">
            Where your team's time went, by project. This is work-log effort — not attendance.
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

      <Async
        state={state}
        rows={5}
        isEmpty={(d) => d.rows.length === 0}
        empty={
          <Card>
            <Empty
              title="No effort logged by your team this week"
              hint="Try an earlier week, or check that your reports have recorded their work."
            />
          </Card>
        }
      >
        {(d) => {
          const byPerson = new Map<string, { number: string; total: number; projects: typeof d.rows }>();
          for (const r of d.rows) {
            const cur = byPerson.get(r.full_name) ?? { number: r.employee_number, total: 0, projects: [] };
            cur.total += Number(r.minutes);
            cur.projects.push(r);
            byPerson.set(r.full_name, cur);
          }
          const people = [...byPerson.entries()].sort((a, b) => b[1].total - a[1].total);

          const byProject = new Map<string, { name: string; minutes: number }>();
          for (const r of d.rows) {
            const cur = byProject.get(r.project_code) ?? { name: r.project_name, minutes: 0 };
            cur.minutes += Number(r.minutes);
            byProject.set(r.project_code, cur);
          }
          const projects = [...byProject.entries()].sort((a, b) => b[1].minutes - a[1].minutes);

          const total = d.rows.reduce((s, r) => s + Number(r.minutes), 0);
          const maxPerson = Math.max(1, ...people.map(([, v]) => v.total));
          const maxProject = Math.max(1, ...projects.map(([, v]) => v.minutes));

          return (
            <div className="space-y-5">
              <section aria-label="Week summary" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Total effort" value={hm(total)} sub={`${decimalHours(total)} decimal hours`} />
                <Stat label="People reporting" value={people.length} />
                <Stat label="Projects touched" value={projects.length} />
                <Stat
                  label="Variance flags"
                  value={d.attendanceVsEffort.length}
                  tone={d.attendanceVsEffort.length ? 'warn' : 'good'}
                  sub="flagged, not corrected"
                />
              </section>

              <div className="grid gap-5 lg:grid-cols-2">
                <Card>
                  <CardHead title="By person" hint="Each person's week, split across the projects they touched." />
                  <ul className="divide-y divide-ink-100">
                    {people.map(([name, v]) => (
                      <li key={name} className="px-4 py-3.5 sm:px-5">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="text-[13.5px] font-medium text-ink-900">
                            {name} <span className="num text-[12px] font-normal text-ink-400">{v.number}</span>
                          </span>
                          <span className="num text-[13.5px] font-semibold text-ink-900">{hm(v.total)}</span>
                        </div>
                        <div className="mt-1.5"><Bar value={v.total} max={maxPerson} /></div>
                        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                          {v.projects.sort((a, b) => Number(b.minutes) - Number(a.minutes)).map((p) => (
                            <li key={p.project_code} className="num text-[12.5px] text-ink-500">
                              <span className="font-medium text-ink-700">{p.project_code}</span> {hm(p.minutes)}
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                </Card>

                <Card>
                  <CardHead title="By project" hint="Effort only. No cost, no rates — those are a separate, permissioned concern." />
                  <ul className="space-y-3.5 p-4 sm:p-5">
                    {projects.map(([code, v]) => (
                      <li key={code}>
                        <div className="flex items-baseline justify-between gap-2 text-[13.5px]">
                          <span className="min-w-0 truncate text-ink-800">
                            {v.name} <span className="num text-ink-400">{code}</span>
                          </span>
                          <span className="num font-semibold text-ink-900">{hm(v.minutes)}</span>
                        </div>
                        <div className="mt-1"><Bar value={v.minutes} max={maxProject} tone="good" /></div>
                      </li>
                    ))}
                  </ul>
                </Card>
              </div>

              {/* The architectural punchline, made visible. */}
              <Card>
                <CardHead
                  title="Attendance vs work effort"
                  hint="The two are separate domains. This report flags where they disagree — it never changes either side."
                />
                {d.attendanceVsEffort.length === 0 ? (
                  <Empty
                    title="No discrepancies this week"
                    hint="Everyone who was present logged effort, and nobody logged effort on a non-working day."
                  />
                ) : (
                  <ul className="divide-y divide-ink-100">
                    {d.attendanceVsEffort.map((v, i) => (
                      <li key={i} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
                        <div className="min-w-0">
                          <div className="text-[13.5px] font-medium text-ink-900">{v.full_name}</div>
                          <div className="num mt-0.5 text-[12.5px] text-ink-500">
                            {weekdayOf(v.business_date)} {fmtDate(v.business_date)}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-3 text-[13px]">
                          <span className="flex items-center gap-1.5">
                            <span className="text-ink-500">attendance</span>
                            <Badge status={v.attendance_status} />
                            <span className="num text-ink-700">{hm(v.attendance_minutes)}</span>
                          </span>
                          <span className="flex items-center gap-1.5">
                            <span className="text-ink-500">logged</span>
                            <span className="num font-medium text-ink-900">{hm(v.logged_minutes)}</span>
                          </span>
                          <Badge status="pending">{v.variance_flag}</Badge>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="border-t border-ink-100 px-4 py-3 text-[12.5px] text-ink-500 sm:px-5">
                  Payroll consumes the attendance side only. Project costing consumes the effort side
                  only. Neither is derived from the other, so a timesheet dispute can never become a
                  payroll dispute.
                </p>
              </Card>
            </div>
          );
        }}
      </Async>
    </div>
  );
}
