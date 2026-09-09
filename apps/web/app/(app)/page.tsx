'use client';

import Link from 'next/link';
import { fmtDate, fmtDateShort, hm, useData, type Actor } from '@/lib/api';
import { Async, Badge, Bar, Card, CardHead, Empty, Stat } from '@/components/ui';
import { PunchCard } from '@/components/punch-card';

interface Dashboard {
  actor: Actor;
  businessDate: string;
  // null for an employee: org-wide presence is HR/manager information and is not sent to them.
  org: { headcount: string; present_today: string; wfh_today: string; on_leave_today: string } | null;
  isManager: boolean;
  pending: { leave: number; timesheets: number };
  me: {
    balances: { code: string; available: string }[];
    attendanceToday: { status: string; worked_minutes: number; first_in_at: string | null } | null;
    openRequests: { id: string; type: string; from_date: string; to_date: string; working_days: string; status: string }[];
    projects: { code: string; name: string; role: string }[];
    todayMinutes: number;
    month: { present: number; late: number; wfh: number; absent: number };
    weekMinutes: number;
  };
  upcomingHolidays: { holiday_on: string; name: string; is_optional: boolean }[];
  recentActivity: { at: string; who: string; what: string }[];
}

export default function DashboardPage() {
  const state = useData<Dashboard>('/dashboard');

  return (
    <Async state={state} rows={6}>
      {(d) => {
        const isManager = d.isManager;
        const cl = d.me.balances.find((b) => b.code === 'CL');
        const sl = d.me.balances.find((b) => b.code === 'SL');
        const pendingTotal = d.pending.leave + d.pending.timesheets;

        return (
          <div className="space-y-5">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h1 className="text-[21px] font-semibold text-ink-900">
                  Welcome, {d.actor.name.split(' ')[0]}
                </h1>
                <p className="mt-0.5 text-[13.5px] text-ink-500">
                  {fmtDate(d.businessDate)} · Kochi
                </p>
              </div>
              {d.me.attendanceToday && (
                <div className="flex items-center gap-2 text-[13px] text-ink-600">
                  <span>Today</span>
                  <Badge status={d.me.attendanceToday.status} />
                  {d.me.attendanceToday.worked_minutes > 0 && (
                    <span className="num">{hm(d.me.attendanceToday.worked_minutes)}</span>
                  )}
                </div>
              )}
            </div>

            {/*
              Two different rows, because the two audiences need different things.

              A manager or HR gets org-wide presence - that is their job. An employee has no
              business reason to know how many colleagues are absent today, so they get their OWN
              month instead. The API does not send the org figures to an employee at all, so this
              is a presentation of what arrived rather than a hidden field.
            */}
            {isManager && d.org ? (
              <section aria-label="Organization today" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Employees" value={d.org.headcount} sub="active headcount" />
                <Stat label="Present today" value={d.org.present_today} tone="good" sub="including late arrivals" />
                <Stat label="Working from home" value={d.org.wfh_today} tone="brand" sub="paid, approved, present" />
                <Stat label="On leave today" value={d.org.on_leave_today} tone="warn" sub="approved leave" />
              </section>
            ) : (
              <section aria-label="My month so far" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Days present" value={d.me.month.present} tone="good" sub="this month, including WFH" />
                <Stat label="Late arrivals" value={d.me.month.late}
                      tone={d.me.month.late > 0 ? 'warn' : 'plain'} sub="beyond the grace period" />
                <Stat label="Logged this week" value={hm(d.me.weekMinutes)} tone="brand" sub="effort against projects" />
                <Stat label="Leave available" value={Number(cl?.available ?? 0)}
                      sub="casual leave days" />
              </section>
            )}

            <div className="grid gap-5 lg:grid-cols-3">
              <div className="space-y-5 lg:col-span-2">
                {/* Check in / out. The first thing anyone does each day, so it goes first. */}
                <PunchCard onChanged={() => void state.reload()} />

                {isManager && (
                  <Card>
                    <CardHead
                      title="Waiting on you"
                      hint={pendingTotal ? 'Approvals from your reports' : undefined}
                    />
                    {pendingTotal === 0 ? (
                      <Empty title="Nothing to approve" hint="Leave requests and timesheets from your reports will appear here." />
                    ) : (
                      <ul className="divide-y divide-ink-100">
                        {d.pending.leave > 0 && (
                          <li>
                            <Link href="/approvals" className="flex items-center justify-between px-4 py-3 hover:bg-ink-50 sm:px-5">
                              <span className="text-[13.5px] font-medium text-ink-800">Leave requests</span>
                              <span className="flex items-center gap-2">
                                <Badge status="pending">{d.pending.leave} pending</Badge>
                                <span aria-hidden className="text-ink-400">→</span>
                              </span>
                            </Link>
                          </li>
                        )}
                        {d.pending.timesheets > 0 && (
                          <li>
                            <Link href="/approvals" className="flex items-center justify-between px-4 py-3 hover:bg-ink-50 sm:px-5">
                              <span className="text-[13.5px] font-medium text-ink-800">Timesheets</span>
                              <span className="flex items-center gap-2">
                                <Badge status="submitted">{d.pending.timesheets} submitted</Badge>
                                <span aria-hidden className="text-ink-400">→</span>
                              </span>
                            </Link>
                          </li>
                        )}
                      </ul>
                    )}
                  </Card>
                )}

                <Card>
                  <CardHead
                    title="My leave balance"
                    hint="Derived from the leave ledger, not a stored counter"
                    action={<Link href="/leave" className="text-[13px] font-medium text-brand-700 hover:underline">Apply for leave</Link>}
                  />
                  <div className="grid gap-4 p-4 sm:grid-cols-2 sm:p-5">
                    {[cl, sl].filter(Boolean).map((b) => (
                      <div key={b!.code}>
                        <div className="flex items-baseline justify-between">
                          <span className="text-[13px] font-medium text-ink-700">
                            {b!.code === 'CL' ? 'Casual leave' : 'Sick leave'}
                          </span>
                          <span className="num text-[15px] font-semibold text-ink-900">
                            {Number(b!.available)} <span className="text-[12.5px] font-normal text-ink-500">days left</span>
                          </span>
                        </div>
                        <div className="mt-2"><Bar value={Number(b!.available)} max={12} /></div>
                      </div>
                    ))}
                  </div>
                  {d.me.openRequests.length > 0 && (
                    <div className="border-t border-ink-100 px-4 py-3 sm:px-5">
                      <p className="text-[12px] font-semibold uppercase tracking-wide text-ink-400">Awaiting approval</p>
                      <ul className="mt-2 space-y-1.5">
                        {d.me.openRequests.map((r) => (
                          <li key={r.id} className="flex items-center justify-between text-[13px]">
                            <span className="text-ink-700">
                              {r.type} · {fmtDateShort(r.from_date)} – {fmtDateShort(r.to_date)}
                              <span className="num text-ink-500"> ({Number(r.working_days)}d)</span>
                            </span>
                            <Badge status={r.status} />
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </Card>

                <Card>
                  <CardHead
                    title="Today's work"
                    hint="Effort against projects — separate from attendance"
                    action={<Link href="/work" className="text-[13px] font-medium text-brand-700 hover:underline">Log work</Link>}
                  />
                  <div className="flex items-center justify-between px-4 py-4 sm:px-5">
                    <div>
                      <div className="num text-2xl font-semibold text-ink-900">{hm(d.me.todayMinutes)}</div>
                      <div className="mt-0.5 text-[12.5px] text-ink-500">
                        {d.me.todayMinutes === 0 ? 'Nothing logged yet today' : 'logged so far today'}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-[12px] font-semibold uppercase tracking-wide text-ink-400">My projects</div>
                      <div className="mt-1 flex flex-wrap justify-end gap-1">
                        {d.me.projects.length === 0
                          ? <span className="text-[13px] text-ink-500">None assigned</span>
                          : d.me.projects.map((p) => <Badge key={p.code}>{p.code}</Badge>)}
                      </div>
                    </div>
                  </div>
                </Card>
              </div>

              <div className="space-y-5">
                <Card>
                  <CardHead title="Upcoming holidays" hint="2026 company calendar" />
                  {d.upcomingHolidays.length === 0 ? (
                    <Empty title="No holidays left this year" />
                  ) : (
                    <ul className="divide-y divide-ink-100">
                      {d.upcomingHolidays.map((h) => (
                        <li key={h.holiday_on + h.name} className="flex items-center justify-between gap-2 px-4 py-2.5 sm:px-5">
                          <div>
                            <div className="text-[13.5px] font-medium text-ink-800">{h.name}</div>
                            <div className="text-[12.5px] text-ink-500">{fmtDate(h.holiday_on)}</div>
                          </div>
                          {h.is_optional && <Badge>optional</Badge>}
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>

                <Card>
                  <CardHead title="Recent HR activity" />
                  {d.recentActivity.length === 0 ? (
                    <Empty title="No activity yet" />
                  ) : (
                    <ul className="divide-y divide-ink-100">
                      {d.recentActivity.map((a, i) => (
                        <li key={i} className="px-4 py-2.5 text-[13px] sm:px-5">
                          <span className="font-medium text-ink-800">{a.who}</span>{' '}
                          <span className="text-ink-600">{a.what}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>
            </div>
          </div>
        );
      }}
    </Async>
  );
}
