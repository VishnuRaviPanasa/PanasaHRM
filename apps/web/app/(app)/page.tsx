'use client';

import Link from 'next/link';
import { hasRole, hm, useData, type Actor } from '@/lib/api';
import {
  ActionTile, Async, Avatar, Badge, Card, CardHead, Empty, IconTile, KpiCard, SegmentBar,
} from '@/components/ui';
import {
  IconBriefcase, IconCalendar, IconCalendarOff, IconCalendarPlus, IconChevron, IconClock,
  IconClockAlert, IconHome, IconInbox, IconListCheck, IconPin, IconReceipt, IconSun,
  IconUserCheck, IconUsers,
} from '@/components/icons';
import { PunchCard } from '@/components/punch-card';
import { useFormat, useT } from '@/lib/i18n';

/**
 * The landing screen.
 *
 * WHAT THIS SCREEN HAS TO ANSWER, in the order it answers it:
 *   1. what do I need to DO today          -> the punch card and quick actions
 *   2. what is waiting on ME               -> approvals, or my own open requests
 *   3. where do I stand                    -> leave balance, effort, my month
 *   4. what is going on around me          -> holidays, activity, and for HR the org row
 *
 * That ordering is the whole layout. The previous version led with a four-figure org row for HR
 * and put the day's one action below it, so the first thing on the page was information rather
 * than a decision.
 *
 * EVERY NUMBER HERE COMES FROM `/dashboard`. There is no arithmetic in this file beyond turning a
 * ledger figure into a bar width, and no fallback that invents a value when the API sends none -
 * an absent figure renders an empty state, because a dashboard that guesses is worse than one
 * that admits it does not know.
 */

interface Balance {
  code: string;
  name: string;
  available: string;
  taken: string;
  pending: string;
  entitled: string;
}

interface Activity {
  at: string;
  who: string;
  /** The English sentence the endpoint still sends. Used only if `kind` is unrecognised. */
  what: string;
  kind: string | null;
  amount: string | null;
  subject: string | null;
}

interface Dashboard {
  actor: Actor;
  businessDate: string;
  // null for an employee: org-wide presence is HR/manager information and is not sent to them.
  org: { headcount: string; present_today: string; wfh_today: string; on_leave_today: string } | null;
  isManager: boolean;
  pending: { leave: number; timesheets: number };
  me: {
    balances: Balance[];
    attendanceToday: { status: string; worked_minutes: number; first_in_at: string | null } | null;
    openRequests: { id: string; type: string; from_date: string; to_date: string; working_days: string; status: string }[];
    projects: { code: string; name: string; role: string }[];
    todayMinutes: number;
    month: { present: number; late: number; wfh: number; absent: number };
    weekMinutes: number;
  };
  upcomingHolidays: { holiday_on: string; name: string; is_optional: boolean }[];
  recentActivity: Activity[];
}

export default function DashboardPage() {
  const t = useT();
  const f = useFormat();
  const state = useData<Dashboard>('/dashboard');

  return (
    <Async state={state} rows={6}>
      {(d) => {
        const isManager = d.isManager;
        /*
         * The same affordance rule the sidebar follows: `hasRole` decides what is OFFERED, and
         * every route calls `assertCan` regardless (DEC-053). This is not a second authorization
         * model - it is the identical expression the shell already uses for the "My team" group,
         * so a tile and a nav row can never disagree about whether to show approvals.
         */
        const isTeamLead = hasRole(d.actor, 'manager', 'hr_admin', 'hr_ops');
        const pendingTotal = d.pending.leave + d.pending.timesheets;
        const firstName = d.actor.name.split(' ')[0];

        /* The activity sentence, assembled where the language is known. */
        const activityText = (a: Activity): string => {
          switch (a.kind) {
            case 'leave_applied':
              return t('activity.leaveApplied', {
                days: Number(a.amount ?? 0), type: a.subject ?? '',
              });
            case 'leave_approved':
              return t('activity.leaveApproved', { name: a.subject ?? '' });
            case 'leave_rejected':
              return t('activity.leaveRejected', { name: a.subject ?? '' });
            case 'timesheet_submitted':
              return t('activity.timesheetSubmitted');
            default:
              // An unrecognised kind falls back to what the endpoint said rather than to nothing.
              return a.what;
          }
        };

        return (
          <div className="space-y-6">
            {/* ---------------------------------------------------------------- page header */}
            <header className="rise flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
              <div className="min-w-0">
                <h1 className="text-[23px] font-semibold text-ink-900 sm:text-[26px]">
                  {t('dash.greeting', { name: firstName })}
                </h1>
                <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-500">
                  <IconCalendar size={15} className="text-ink-400" />
                  <span>{f.date(d.businessDate, { weekday: 'long' })}</span>
                  <span aria-hidden className="text-ink-300">·</span>
                  <IconPin size={14} className="text-ink-400" />
                  <span>{t('dash.place')}</span>
                </p>
              </div>

              {/* Today's own verdict, at a glance, where the eye already is. */}
              {d.me.attendanceToday && (
                <div className="flex items-center gap-2 rounded-full border border-ink-200 bg-white px-3 py-1.5 text-[12.5px] text-ink-600 shadow-[var(--shadow-card)]">
                  <span className="font-medium text-ink-500">{t('dash.today')}</span>
                  <Badge status={d.me.attendanceToday.status} />
                  {d.me.attendanceToday.worked_minutes > 0 && (
                    <span className="num font-semibold text-ink-800">
                      {hm(d.me.attendanceToday.worked_minutes)}
                    </span>
                  )}
                </div>
              )}
            </header>

            {/*
              Two different rows, because the two audiences need different things.

              A manager or HR gets org-wide presence - that is their job. An employee has no
              business reason to know how many colleagues are absent today, so they get their OWN
              month instead. The API does not send the org figures to an employee at all, so this
              is a presentation of what arrived rather than a hidden field.
            */}
            {isManager && d.org ? (
              <section
                aria-label={t('dash.orgToday')}
                className="rise grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4"
                style={{ animationDelay: '40ms' }}
              >
                <KpiCard
                  icon={<IconUsers size={19} />}
                  label={t('nav.employees')}
                  value={f.number(Number(d.org.headcount))}
                  sub={t('dash.activeHeadcount')}
                  href="/employees"
                />
                <KpiCard
                  icon={<IconUserCheck size={19} />}
                  label={t('dash.presentToday')}
                  value={f.number(Number(d.org.present_today))}
                  sub={t('dash.includingLate')}
                  tone="good"
                />
                <KpiCard
                  icon={<IconHome size={19} />}
                  label={t('dash.wfh')}
                  value={f.number(Number(d.org.wfh_today))}
                  sub={t('dash.paidApprovedPresent')}
                  tone="info"
                />
                <KpiCard
                  icon={<IconCalendarOff size={19} />}
                  label={t('dash.onLeaveToday')}
                  value={f.number(Number(d.org.on_leave_today))}
                  sub={t('dash.approvedLeave')}
                  tone="violet"
                />
              </section>
            ) : (
              <section
                aria-label={t('dash.myMonth')}
                className="rise grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4"
                style={{ animationDelay: '40ms' }}
              >
                <KpiCard
                  icon={<IconUserCheck size={19} />}
                  label={t('dash.daysPresent')}
                  value={f.number(d.me.month.present)}
                  sub={t('dash.thisMonthWfh')}
                  tone="good"
                />
                <KpiCard
                  icon={<IconClockAlert size={19} />}
                  label={t('dash.lateArrivals')}
                  value={f.number(d.me.month.late)}
                  sub={t('dash.beyondGrace')}
                  tone={d.me.month.late > 0 ? 'warn' : 'plain'}
                />
                <KpiCard
                  icon={<IconBriefcase size={19} />}
                  label={t('dash.loggedThisWeek')}
                  value={hm(d.me.weekMinutes)}
                  sub={t('dash.effortAgainstProjects')}
                  tone="info"
                  href="/timesheet"
                />
                <KpiCard
                  icon={<IconSun size={19} />}
                  label={t('dash.leaveAvailable')}
                  value={f.number(Number(d.me.balances[0]?.available ?? 0))}
                  sub={d.me.balances[0]?.name ?? t('dash.casualLeaveDays')}
                  tone="violet"
                  href="/leave"
                />
              </section>
            )}

            <div className="grid gap-5 lg:grid-cols-3">
              <div className="space-y-5 lg:col-span-2">
                {/* Check in / out. The first thing anyone does each day, so it goes first. */}
                <div className="rise" style={{ animationDelay: '80ms' }}>
                  <PunchCard onChanged={() => void state.reload()} />
                </div>

                {/*
                  * QUICK ACTIONS, and every one of them goes somewhere real.
                  *
                  * Only routes this person is offered in the navigation appear here - approvals
                  * only for the reporting line - and there is no tile for anything unbuilt. The
                  * brief was explicit that a placeholder action is not wanted, and it is the
                  * fastest way to make a demo feel hollow.
                  */}
                <Card>
                  <CardHead title={t('dash.quickActions')} />
                  <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5 xl:grid-cols-3">
                    <ActionTile href="/leave" icon={<IconCalendarPlus size={16} />}
                                label={t('action.applyLeave')} tone="violet" />
                    <ActionTile href="/work" icon={<IconBriefcase size={16} />}
                                label={t('action.logWork')} tone="info" />
                    <ActionTile href="/attendance" icon={<IconClock size={16} />}
                                label={t('action.viewAttendance')} />
                    <ActionTile href="/timesheet" icon={<IconListCheck size={16} />}
                                label={t('action.openTimesheet')} />
                    <ActionTile href="/payslips" icon={<IconReceipt size={16} />}
                                label={t('action.viewPayslips')} />
                    {isTeamLead && (
                      <ActionTile href="/approvals" icon={<IconInbox size={16} />}
                                  label={t('action.reviewApprovals')}
                                  tone={pendingTotal > 0 ? 'warn' : 'plain'} />
                    )}
                  </div>
                </Card>

                {/*
                  * WAITING ON YOU, for whoever has people reporting to them.
                  *
                  * The endpoint sends COUNTS, not rows - so this card shows counts and hands over
                  * to /approvals for the detail. It would have been easy to render an
                  * employee/period/status table here from nothing, and it would have been fiction.
                  */}
                {isManager ? (
                  <Card className={pendingTotal > 0 ? 'ring-1 ring-amber-200' : ''}>
                    <CardHead
                      title={t('dash.waitingOnYou')}
                      hint={pendingTotal ? t('dash.approvalsHint') : undefined}
                      action={pendingTotal > 0
                        ? <Badge status="pending">{t('dash.needsDecision')}</Badge>
                        : undefined}
                    />
                    {pendingTotal === 0 ? (
                      <div className="px-4 py-6 text-center sm:px-5">
                        <IconTile icon={<IconUserCheck size={19} />} tone="good" className="mx-auto" />
                        <p className="mt-3 text-[13.5px] font-medium text-ink-700">
                          {t('dash.nothingToApprove')}
                        </p>
                        <p className="mx-auto mt-1 max-w-sm text-[13px] text-ink-500">
                          {t('dash.nothingToApproveHint')}
                        </p>
                      </div>
                    ) : (
                      <ul className="divide-y divide-ink-100">
                        {d.pending.leave > 0 && (
                          <li>
                            <Link href="/approvals"
                                  className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-ink-50 sm:px-5">
                              <IconTile icon={<IconCalendar size={16} />} tone="warn" size="sm" />
                              <span className="min-w-0 flex-1">
                                <span className="block text-[13.5px] font-medium text-ink-800">
                                  {t('common.leaveRequests')}
                                </span>
                                <span className="block text-[12.5px] text-ink-500">
                                  {t('dash.nPending', { n: d.pending.leave })}
                                </span>
                              </span>
                              <span className="flex items-center gap-1.5 text-[13px] font-medium text-brand-700">
                                {t('dash.review')}
                                <IconChevron size={14} className="flip-rtl" />
                              </span>
                            </Link>
                          </li>
                        )}
                        {d.pending.timesheets > 0 && (
                          <li>
                            <Link href="/approvals"
                                  className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-ink-50 sm:px-5">
                              <IconTile icon={<IconListCheck size={16} />} tone="warn" size="sm" />
                              <span className="min-w-0 flex-1">
                                <span className="block text-[13.5px] font-medium text-ink-800">
                                  {t('common.timesheets')}
                                </span>
                                <span className="block text-[12.5px] text-ink-500">
                                  {t('dash.nSubmitted', { n: d.pending.timesheets })}
                                </span>
                              </span>
                              <span className="flex items-center gap-1.5 text-[13px] font-medium text-brand-700">
                                {t('dash.review')}
                                <IconChevron size={14} className="flip-rtl" />
                              </span>
                            </Link>
                          </li>
                        )}
                      </ul>
                    )}
                  </Card>
                ) : (
                  /*
                   * An employee approves nothing, so the slot carries what is waiting on THEM
                   * instead of an empty approvals card. Same data the leave card used to bury in
                   * a footer, given a heading of its own.
                   */
                  <Card>
                    <CardHead title={t('dash.myRequests')} hint={t('dash.myRequestsHint')} />
                    {d.me.openRequests.length === 0 ? (
                      <Empty title={t('dash.noRequests')} hint={t('dash.noRequestsHint')} />
                    ) : (
                      <ul className="divide-y divide-ink-100">
                        {d.me.openRequests.map((r) => (
                          <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 sm:px-5">
                            <IconTile icon={<IconCalendar size={16} />} tone="violet" size="sm" />
                            <span className="min-w-0 flex-1">
                              <span className="block text-[13.5px] font-medium text-ink-800">{r.type}</span>
                              <span className="num block text-[12.5px] text-ink-500">
                                {f.date(r.from_date, { year: undefined })} – {f.date(r.to_date)}
                                {' · '}
                                {Number(r.working_days)} {t('dash.days')}
                              </span>
                            </span>
                            <Badge status={r.status} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>
                )}

                {/*
                  * LEAVE BALANCE.
                  *
                  * Available, used and pending, all read from `leave_account` - the ledger's
                  * constrained projection - and the bar is drawn against the ENTITLEMENT the
                  * database sends. The previous version drew it against a hardcoded `max={12}`,
                  * which was policy in the browser and wrong for sick leave.
                  */}
                <Card>
                  <CardHead
                    title={t('dash.myLeaveBalance')}
                    hint={t('dash.ledgerDerived')}
                    action={(
                      <Link href="/leave"
                            className="flex items-center gap-1 text-[13px] font-medium text-brand-700 hover:underline">
                        {t('dash.applyForLeave')}
                        <IconChevron size={13} className="flip-rtl" />
                      </Link>
                    )}
                  />
                  {d.me.balances.length === 0 ? (
                    <Empty title={t('dash.noRequests')} />
                  ) : (
                    <div className="grid gap-5 p-4 sm:grid-cols-2 sm:p-5">
                      {d.me.balances.map((b) => {
                        const available = Number(b.available);
                        const taken = Number(b.taken);
                        const held = Number(b.pending);
                        const entitled = Number(b.entitled);
                        return (
                          <div key={b.code}>
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="truncate text-[13.5px] font-medium text-ink-800">
                                {b.name}
                              </span>
                              <span className="num shrink-0 text-[13px] text-ink-500">
                                {available} / {entitled} {t('dash.days')}
                              </span>
                            </div>
                            {/*
                              * AVAILABLE IS A FILLED SEGMENT, not the empty remainder of the
                              * track. The first version drew only `used` and `pending`, so a
                              * full 12-day balance with nothing taken rendered as an entirely
                              * grey bar - which reads as "nothing left", the exact opposite of
                              * what the ledger says. What somebody has is the thing to show.
                              */}
                            <div className="mt-2.5">
                              <SegmentBar
                                max={entitled}
                                segments={[
                                  { value: available, tone: 'good' },
                                  { value: held, tone: 'warn' },
                                  { value: taken, tone: 'plain' },
                                ]}
                              />
                            </div>
                            <dl className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px]">
                              {([
                                [t('dash.available'), available, 'bg-emerald-500'],
                                [t('dash.pendingLabel'), held, 'bg-amber-500'],
                                [t('dash.used'), taken, 'bg-ink-400'],
                              ] as [string, number, string][]).map(([label, n, dot]) => (
                                <div key={label} className="flex items-center gap-1.5">
                                  <span aria-hidden className={`h-2 w-2 rounded-full ${dot}`} />
                                  <dt className="text-ink-500">{label}</dt>
                                  <dd className="num font-semibold text-ink-800">{n}</dd>
                                </div>
                              ))}
                            </dl>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </Card>

              </div>

              {/* ---------------------------------------------------------------- side column */}
              <div className="space-y-5">
                {/* Effort, which is a sibling of attendance and never a substitute for it. */}
                <Card>
                  <CardHead
                    title={t('dash.todaysWork')}
                    hint={t('dash.todaysWorkHint')}
                    action={(
                      <Link href="/work"
                            className="flex items-center gap-1 text-[13px] font-medium text-brand-700 hover:underline">
                        {t('dash.logWork')}
                        <IconChevron size={13} className="flip-rtl" />
                      </Link>
                    )}
                  />
                  <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-5">
                    <div className="flex items-center gap-3">
                      <IconTile icon={<IconBriefcase size={19} />} tone="info" />
                      <div>
                        <div className="num text-[24px] font-semibold leading-none text-ink-900">
                          {hm(d.me.todayMinutes)}
                        </div>
                        <div className="mt-1 text-[12.5px] text-ink-500">
                          {d.me.todayMinutes === 0
                            ? t('dash.nothingLoggedToday')
                            : t('dash.loggedSoFar')}
                        </div>
                      </div>
                    </div>
                    <div className="text-end">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-500">
                        {t('dash.myProjects')}
                      </div>
                      <div className="mt-1.5 flex flex-wrap justify-end gap-1">
                        {d.me.projects.length === 0
                          ? <span className="text-[13px] text-ink-500">{t('dash.noneAssigned')}</span>
                          : d.me.projects.map((p) => <Badge key={p.code}>{p.code}</Badge>)}
                      </div>
                    </div>
                  </div>
                </Card>

                <Card>
                  <CardHead title={t('dash.upcomingHolidays')} hint={t('dash.companyCalendar')} />
                  {d.upcomingHolidays.length === 0 ? (
                    <Empty title={t('dash.noHolidaysLeft')} />
                  ) : (
                    <ul className="divide-y divide-ink-100">
                      {d.upcomingHolidays.map((h) => (
                        <li key={h.holiday_on + h.name}
                            className="flex items-center gap-3 px-4 py-3 sm:px-5">
                          {/*
                            * A date CHIP rather than a line of grey text: the day and the month
                            * are what somebody scans a holiday list for, so they get the weight.
                            * Both parts are formatted through `Intl`, so the month is Arabic on
                            * the Arabic screen - the previous version used the English-only
                            * formatter, and a Latin month inside an RTL line also got reordered
                            * by the bidi algorithm into "Sep 2026 14".
                            */}
                          <span
                            aria-hidden
                            className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-brand-50 ring-1 ring-inset ring-brand-100"
                          >
                            <span className="num text-[15px] font-semibold leading-none text-ink-900">
                              {f.date(h.holiday_on, { day: 'numeric', month: undefined, year: undefined })}
                            </span>
                            <span className="mt-0.5 text-[10px] font-medium uppercase leading-none text-brand-700">
                              {f.date(h.holiday_on, { month: 'short', day: undefined, year: undefined })}
                            </span>
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[13.5px] font-medium text-ink-800">{h.name}</div>
                            <div className="text-[12.5px] text-ink-500">
                              {f.date(h.holiday_on, { weekday: 'long', day: undefined, month: undefined, year: undefined })}
                            </div>
                          </div>
                          {h.is_optional && <Badge status="holiday">{t('dash.optional')}</Badge>}
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>

                <Card>
                  <CardHead title={t('dash.recentActivity')} />
                  {d.recentActivity.length === 0 ? (
                    <Empty title={t('dash.noActivity')} />
                  ) : (
                    <ul className="divide-y divide-ink-100">
                      {d.recentActivity.map((a, i) => (
                        <li key={`${a.at}-${i}`} className="flex items-start gap-3 px-4 py-3 sm:px-5">
                          <Avatar name={a.who} size={30} tone="auto" />
                          <div className="min-w-0 flex-1">
                            <p className="text-[13px] leading-snug">
                              <span className="font-semibold text-ink-800">{a.who}</span>{' '}
                              <span className="text-ink-600">{activityText(a)}</span>
                            </p>
                            <p className="num mt-0.5 text-[12px] text-ink-500">{f.dateTime(a.at)}</p>
                          </div>
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
