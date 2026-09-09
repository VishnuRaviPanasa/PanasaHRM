'use client';

import { useMemo, useState } from 'react';
import { fmtDate, hm, decimalHours, useData, weekdayOf } from '@/lib/api';
import { Async, Badge, Bar, Button, Card, CardHead, Empty, Field, Stat, inputCls } from '@/components/ui';
import { PeriodLabel, PeriodPicker, periodQuery, type Period } from '@/components/period-picker';
import { useT } from '@/lib/i18n';

interface Effort {
  periodStart: string; periodEnd: string; from: string; to: string;
  filters: { employeeId: string | null; projectId: string | null; taskId: string | null };
  activeFilters: string[];
  totals: { minutes: number; people: number; projects: number };
  rows: {
    full_name: string; employee_number: string; employee_id: string;
    project_id: string; project_code: string; project_name: string;
    minutes: number; hr_entered: number;
  }[];
  attendanceVsEffort: {
    full_name: string; business_date: string; attendance_status: string;
    attendance_minutes: number; logged_minutes: number; variance_flag: string;
  }[];
}

export default function TeamPage() {
  const t = useT();
  /*
   * NO DATE LITERAL. This page opened on `useState('2026-08-31')` - a fixed week, forever. The
   * server resolves the period from `fn_business_date()`; the browser must not, because at 00:35
   * IST its own "today" is the previous day (DEC-091).
   */
  const [period, setPeriod] = useState<Period>({ preset: 'month', from: '', to: '' });
  const [employeeId, setEmployeeId] = useState('');
  const [projectId, setProjectId] = useState('');

  const pq = periodQuery(period);
  const filterQs = [
    employeeId && `employeeId=${employeeId}`,
    projectId && `projectId=${projectId}`,
  ].filter(Boolean).join('&');

  const state = useData<Effort>(`/team/effort?${pq}${filterQs ? `&${filterQs}` : ''}`,
    [pq, filterQs]);

  /*
   * THE FILTER OPTIONS COME FROM AN UNFILTERED REQUEST FOR THE SAME PERIOD.
   *
   * Deriving them from the filtered response would make the dropdowns collapse to whatever is
   * already selected - choose one person and they become the only person choosable, which is a
   * dead end nobody can back out of except by reloading. Deriving them from `/employees` and
   * `/projects` instead would be wrong in a subtler way: those are different scopes, so a manager
   * would be offered people whose effort this screen will never show them.
   *
   * So: one extra request, whose result is exactly "everybody and every project this actor can
   * see effort for in this period". When no filter is set the two requests agree, which is
   * wasteful and correct; the alternative was a stale or misleading option list.
   */
  const options = useData<Effort>(`/team/effort?${pq}`, [pq]);

  const people = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of options.data?.rows ?? []) m.set(r.employee_id, r.full_name);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [options.data]);

  const projectOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of options.data?.rows ?? []) m.set(r.project_id, `${r.project_code} — ${r.project_name}`);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [options.data]);

  const activeCount = (employeeId ? 1 : 0) + (projectId ? 1 : 0)
    + (period.preset === 'custom' ? 1 : 0);
  const clearAll = () => {
    setEmployeeId(''); setProjectId(''); setPeriod({ preset: 'month', from: '', to: '' });
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[21px] font-semibold text-ink-900">{t('team.title')}</h1>
        <p className="mt-0.5 text-[13.5px] text-ink-500">
          {t('team.subtitle')}
        </p>
      </div>

      <Card>
        <div className="space-y-3 px-4 py-3.5">
          <PeriodPicker value={period} onChange={setPeriod} busy={state.loading}
                        resolved={{ from: state.data?.from, to: state.data?.to }} />

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label={t('common.person')} htmlFor="tm-emp">
              <select id="tm-emp" className={inputCls} value={employeeId}
                      onChange={(e) => setEmployeeId(e.target.value)}
                      disabled={options.loading}>
                <option value="">{t('common.everyone')}</option>
                {people.map(([id, name]) => (
                  <option key={id} value={id}>{name}</option>
                ))}
              </select>
            </Field>
            <Field label={t('common.project')} htmlFor="tm-proj">
              <select id="tm-proj" className={inputCls} value={projectId}
                      onChange={(e) => setProjectId(e.target.value)}
                      disabled={options.loading}>
                <option value="">{t('team.allProjects')}</option>
                {projectOptions.map(([id, label]) => (
                  <option key={id} value={id}>{label}</option>
                ))}
              </select>
            </Field>
            <div className="flex items-end">
              <Button variant="secondary" size="sm" onClick={clearAll} disabled={activeCount === 0}>
                {t('common.clearFilters')}
              </Button>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-ink-100 px-4 py-2">
          <PeriodLabel from={state.data?.from} to={state.data?.to} />
          {/*
            * Active filters, named. A screen showing a smaller number than somebody expects, with
            * no visible reason, is how a filtered figure gets reported upward as a total.
            */}
          {employeeId && (
            <Badge>{people.find(([id]) => id === employeeId)?.[1] ?? t('common.person')}</Badge>
          )}
          {projectId && (
            <Badge>{projectOptions.find(([id]) => id === projectId)?.[1]?.split(' — ')[0] ?? t('common.project')}</Badge>
          )}
          {activeCount > 0 && (
            <span className="text-[12.5px] text-ink-500">
              {activeCount === 1
                ? t('team.filterApplied', { n: activeCount })
                : t('team.filtersApplied', { n: activeCount })}
            </span>
          )}
        </div>
      </Card>

      <Async
        state={state}
        rows={5}
        isEmpty={(d) => d.rows.length === 0}
        empty={
          <Card>
            <Empty
              title={activeCount > 0 ? t('team.noMatch') : t('team.empty')}
              hint={activeCount > 0 ? t('team.noMatchHint') : t('team.emptyHint')}
              action={activeCount > 0
                ? <Button variant="secondary" size="sm" onClick={clearAll}>{t('common.clearFilters')}</Button>
                : undefined}
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
          const peopleRows = [...byPerson.entries()].sort((a, b) => b[1].total - a[1].total);

          const byProject = new Map<string, { name: string; minutes: number }>();
          for (const r of d.rows) {
            const cur = byProject.get(r.project_code) ?? { name: r.project_name, minutes: 0 };
            cur.minutes += Number(r.minutes);
            byProject.set(r.project_code, cur);
          }
          const projectRows = [...byProject.entries()].sort((a, b) => b[1].minutes - a[1].minutes);

          /*
           * THE HEADER TOTALS COME FROM THE SERVER, not from summing what happens to be rendered.
           * The two agree today; they would stop agreeing the moment this table paginates or
           * groups differently, and then the header would be quietly wrong. The breakdown cards
           * below DO group locally, because that is presentation of these same rows rather than a
           * second answer to "how much effort was there".
           */
          const total = d.totals.minutes;
          const maxPerson = Math.max(1, ...peopleRows.map(([, v]) => v.total));
          const maxProject = Math.max(1, ...projectRows.map(([, v]) => v.minutes));
          const hrEntered = d.rows.reduce((s, r) => s + Number(r.hr_entered ?? 0), 0);

          return (
            <div className="space-y-5">
              <section aria-label={t('attendance.summary')} className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label={t('team.totalEffort')} value={hm(total)}
                      sub={t('team.decimalHours', { n: decimalHours(total) })} />
                <Stat label={t('team.peopleReporting')} value={d.totals.people} />
                <Stat label={t('team.projectsTouched')} value={d.totals.projects} />
                <Stat
                  label={t('team.varianceFlags')}
                  value={d.attendanceVsEffort.length}
                  tone={d.attendanceVsEffort.length ? 'warn' : 'good'}
                  sub={t('team.flaggedNotCorrected')}
                />
              </section>

              {/*
                * Surfaced because it changes how a figure should be read: effort HR recorded on
                * somebody's behalf is not the same claim as effort the employee entered.
                */}
              {hrEntered > 0 && (
                <p className="text-[12.5px] text-ink-500">
                  {t('team.hrEnteredNote', { n: hrEntered })}
                </p>
              )}

              <div className="grid gap-5 lg:grid-cols-2">
                <Card>
                  <CardHead title={t('team.byPerson')} hint={t('team.byPersonHint')} />
                  <ul className="divide-y divide-ink-100">
                    {peopleRows.map(([name, v]) => (
                      <li key={name} className="px-4 py-3.5 sm:px-5">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="text-[13.5px] font-medium text-ink-900">
                            {name} <span className="num text-[12px] font-normal text-ink-400">{v.number}</span>
                          </span>
                          <span className="num text-[13.5px] font-semibold text-ink-900">{hm(v.total)}</span>
                        </div>
                        <div className="mt-1.5"><Bar value={v.total} max={maxPerson} /></div>
                        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                          {v.projects.slice().sort((a, b) => Number(b.minutes) - Number(a.minutes)).map((p) => (
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
                  <CardHead title={t('team.byProject')} hint={t('team.byProjectHint')} />
                  <ul className="space-y-3.5 p-4 sm:p-5">
                    {projectRows.map(([code, v]) => (
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
                  title={t('team.variance')}
                  hint={t('team.varianceHint')}
                />
                {d.attendanceVsEffort.length === 0 ? (
                  <Empty
                    title={t('team.noVariance')}
                    hint={t('team.noVarianceHint')}
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
                            <span className="text-ink-500">{t('team.attendanceLabel')}</span>
                            <Badge status={v.attendance_status} />
                            <span className="num text-ink-700">{hm(v.attendance_minutes)}</span>
                          </span>
                          <span className="flex items-center gap-1.5">
                            <span className="text-ink-500">{t('team.loggedLabel')}</span>
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
