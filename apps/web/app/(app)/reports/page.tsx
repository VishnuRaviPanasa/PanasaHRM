'use client';

import { useEffect, useState } from 'react';
import { decimalHours, fmtDate, fmtDateShort, hm, useBusinessDate, useData } from '@/lib/api';
import { Async, Badge, Bar, Card, CardHead, Empty, Stat } from '@/components/ui';
import { useT, type MessageKey } from '@/lib/i18n';

/**
 * HR reporting.
 *
 * THE TAB STRIP IS BUILT FROM THE SERVER'S ANSWER, NOT FROM THE ACTOR'S ROLE.
 *
 * The obvious way to write this page is `hasRole(actor, 'hr_admin') && <Tab name="documents"/>`.
 * That is Must-Know Rule 1 - an authorization decision inlined outside `packages/authz` - and it
 * fails in both directions: it hides a report from somebody entitled to a narrowed view of it,
 * and it offers one that then 404s. `GET /reports` asks the policy engine per report and returns
 * the names that will actually load, so this page renders exactly those.
 *
 * AND EVERY NUMBER HERE IS ALREADY SCOPED. A manager's "total" is the total over their subtree,
 * an employee's is their own. There is no client-side filtering left to do, and doing any would
 * be a bug: `ai/context/rbac-rules.md` is explicit that filtering after the fact leaks through
 * counts. What arrives is what may be shown.
 */

type Tab = 'headcount' | 'attendance' | 'leave' | 'wfh' | 'reconciliation' | 'timesheets'
  | 'documents' | 'tasks' | 'effort';

/*
 * KEYS, not text: this is a module-level constant, so it has no component to bind a
 * hook to and cannot call t(). Resolved where the tab strip renders.
 */
const TABS: { id: Tab; labelKey: MessageKey; blurbKey: MessageKey }[] = [
  { id: 'headcount', labelKey: 'rep.headcount', blurbKey: 'rep.blurb.headcount' },
  { id: 'attendance', labelKey: 'attendance.title', blurbKey: 'rep.blurb.attendance' },
  { id: 'leave', labelKey: 'rep.leaveLiability', blurbKey: 'rep.blurb.leave' },
  { id: 'wfh', labelKey: 'dash.wfh', blurbKey: 'rep.blurb.wfh' },
  { id: 'reconciliation', labelKey: 'rep.attendanceVsWork', blurbKey: 'rep.blurb.reconciliation' },
  { id: 'timesheets', labelKey: 'common.timesheets', blurbKey: 'rep.blurb.timesheets' },
  { id: 'documents', labelKey: 'docs.title', blurbKey: 'rep.blurb.documents' },
  // "Project tasks", because the glossary also uses Task for a single workflow approval step.
  { id: 'tasks', labelKey: 'rep.projectTasks', blurbKey: 'rep.blurb.tasks' },
  { id: 'effort', labelKey: 'rep.effort', blurbKey: 'rep.blurb.effort' },
];

/** A scrollable table. A wide report must scroll inside its own box, never the page. */
function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[38rem] text-start text-[13.5px]">
        <thead>
          <tr className="border-b border-ink-200">
            {head.map((h, i) => (
              // scope="col" on every header: this one helper renders every report table, so the
              // whole screen was announcing cells without their column to a screen reader.
              <th
                key={h}
                scope="col"
                className={`px-3 py-2 text-[12px] font-medium uppercase tracking-wide text-ink-400 ${i > 0 ? 'text-end' : ''}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">{children}</tbody>
      </table>
    </div>
  );
}

function Person({ name, num }: { name: string; num: string }) {
  return (
    <td className="px-3 py-2">
      <div className="font-medium text-ink-800">{name}</div>
      <div className="num text-[12px] text-ink-400">{num}</div>
    </td>
  );
}

function N({ children, tone = '' }: { children: React.ReactNode; tone?: string }) {
  return <td className={`num px-3 py-2 text-end ${tone || 'text-ink-700'}`}>{children}</td>;
}

// ---------------------------------------------------------------------------

export default function ReportsPage() {
  const t = useT();
  /*
   * The default window follows the SERVER's business date, not the browser's UTC date.
   *
   * `new Date().toISOString().slice(0, 10)` was cutting the current day out of every
   * report between midnight and 05:30 IST, and on the 1st of January it also picked the
   * previous year for the annual reports. The state starts empty and is filled once the
   * date arrives, so the first render asks for nothing rather than asking about the
   * wrong period.
   */
  const today = useBusinessDate();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [year, setYear] = useState(0);

  useEffect(() => {
    if (!today) return;
    // Only seeds the defaults - a range the person has already chosen is never overwritten.
    setFrom((v) => v || `${today.slice(0, 7)}-01`);
    setTo((v) => v || today);
    setYear((v) => v || Number(today.slice(0, 4)));
  }, [today]);
  const [tab, setTab] = useState<Tab>('attendance');

  const index = useData<{ available: string[] }>('/reports');
  const range = `?from=${from}&to=${to}`;

  // `effort` shares `work.log.read` with the reconciliation report rather than holding an action
  // of its own, so it is offered exactly when that one is.
  const offered = index.data?.available ?? [];
  const visible = TABS.filter((tab_) => (
    tab_.id === 'effort' ? offered.includes('reconciliation') : offered.includes(tab_.id)
  ));
  const active = visible.some((tab_) => tab_.id === tab) ? tab : visible[0]?.id;
  const meta = TABS.find((tab_) => tab_.id === active);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[21px] font-semibold text-ink-900">{t('rep.title')}</h1>
        <p className="mt-0.5 text-[13.5px] text-ink-500">
          Every figure below covers only the people you are permitted to see - your own record,
          your team, or the organisation.
        </p>
      </div>

      <Async state={index} rows={4}>
        {() => (visible.length === 0 ? (
          <Card>
            <Empty
              title={t('rep.none')}
              hint={t('rep.noneHint')}
            />
          </Card>
        ) : (
          <div className="space-y-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <nav className="flex flex-wrap gap-1.5" aria-label={t('rep.report')}>
                {visible.map((tab_) => (
                  <button
                    key={tab_.id}
                    type="button"
                    onClick={() => setTab(tab_.id)}
                    aria-current={active === tab_.id ? 'page' : undefined}
                    className={`rounded-lg px-3 py-1.5 text-[13px] font-medium transition ${
                      active === tab_.id
                        ? 'bg-brand-600 text-white'
                        : 'bg-white text-ink-600 ring-1 ring-inset ring-ink-200 hover:bg-ink-50'
                    }`}
                  >
                    {t(tab_.labelKey)}
                  </button>
                ))}
              </nav>

              {active === 'leave' && (
                <label className="flex items-center gap-2 text-[13px] text-ink-500">
                  {t('rep.year')}
                  <input
                    type="number"
                    min={2000}
                    max={2100}
                    value={year}
                    onChange={(e) => setYear(Number(e.target.value))}
                    className="num w-24 rounded-lg border border-ink-200 px-2.5 py-1.5 text-[13.5px]"
                  />
                </label>
              )}

              {active !== 'leave' && active !== 'documents' && active !== 'tasks' && (
                <div className="flex items-center gap-2 text-[13px] text-ink-500">
                  <input
                    type="date"
                    value={from}
                    max={to}
                    onChange={(e) => setFrom(e.target.value)}
                    aria-label={t('leave.from')}
                    className="num rounded-lg border border-ink-200 px-2.5 py-1.5 text-[13.5px]"
                  />
                  <span>to</span>
                  <input
                    type="date"
                    value={to}
                    min={from}
                    onChange={(e) => setTo(e.target.value)}
                    aria-label={t('leave.to')}
                    className="num rounded-lg border border-ink-200 px-2.5 py-1.5 text-[13.5px]"
                  />
                </div>
              )}
            </div>

            {meta && <p className="text-[13px] text-ink-500">{t(meta.blurbKey)}</p>}

            {active === 'headcount' && <Headcount range={range} />}
            {active === 'attendance' && <Attendance range={range} />}
            {active === 'leave' && <Leave year={year} />}
            {active === 'wfh' && <Wfh range={range} />}
            {active === 'reconciliation' && <Reconciliation range={range} />}
            {active === 'timesheets' && <Timesheets range={range} />}
            {active === 'documents' && <Documents />}
            {active === 'tasks' && <Tasks />}
            {active === 'effort' && <Effort range={range} />}
          </div>
        ))}
      </Async>
    </div>
  );
}

// ---------------------------------------------------------------------------

/*
 * Event code -> MESSAGE KEY, not text.
 *
 * A module-level constant has no component to bind a hook to, so t() cannot be called
 * here - the substitution pass put calls in this object and the build caught it. The keys
 * are resolved where a row renders. The event codes themselves are API values and are
 * never translated.
 */
const EVENT_LABEL: Record<string, MessageKey> = {
  joined: 'emp.joined',
  confirmed: 'rep.confirmed',
  promoted: 'rep.promoted',
  transferred: 'ev.transferred',
  resigned: 'rep.resigned',
  exited: 'rep.exited',
  probation_extended: 'ev.probationExtended',
};

interface MovementRow {
  employee_number: string; full_name: string; event_type: string; effective_on: string;
  exit_type: string | null; department_code: string | null; designation: string | null;
}

function Headcount({ range }: { range: string }) {
  const t = useT();
  const s = useData<{
    from: string; to: string; movement: MovementRow[];
    summary: {
      joiners: number; leavers: number; resignations: number;
      promotions: number; confirmations: number;
    } | null;
  }>(`/reports/headcount${range}`, [range]);

  return (
    <Async
      state={s}
      rows={4}
      isEmpty={(d) => d.movement.length === 0}
      empty={(
        <Card>
          <Empty
            title={t('rep.noMovement')}
            hint={t('rep.noMovementHint')}
          />
        </Card>
      )}
    >
      {(d) => (
        <div className="space-y-4">
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat label={t('emp.joined')} value={d.summary?.joiners ?? 0} tone="good" />
            <Stat label={t('rep.confirmed')} value={d.summary?.confirmations ?? 0} />
            <Stat label={t('rep.promoted')} value={d.summary?.promotions ?? 0} tone="brand" />
            <Stat label={t('rep.resigned')} value={d.summary?.resignations ?? 0} tone="warn" />
            <Stat label={t('rep.exited')} value={d.summary?.leavers ?? 0} tone="bad" />
          </section>
          <Card>
            <CardHead title={t('rep.movement')} hint={`${fmtDateShort(d.from)} - ${fmtDateShort(d.to)}`} />
            <Table head={[t('common.employee'), 'Event', t('set.effective'), t('emp.department'), t('emp.designation')]}>
              {d.movement.map((m, i) => (
                <tr key={`${m.employee_number}-${m.event_type}-${m.effective_on}-${i}`}>
                  <Person name={m.full_name} num={m.employee_number} />
                  <td className="px-3 py-2 text-end">
                    <Badge status={m.event_type === 'exited' ? 'absent' : m.event_type === 'resigned' ? 'late' : 'approved'}>
                      {EVENT_LABEL[m.event_type] ? t(EVENT_LABEL[m.event_type]) : m.event_type.replace(/_/g, ' ')}
                      {m.exit_type ? ` - ${m.exit_type}` : ''}
                    </Badge>
                  </td>
                  <N>{fmtDate(m.effective_on)}</N>
                  <N>{m.department_code ?? '-'}</N>
                  <N>{m.designation ?? '-'}</N>
                </tr>
              ))}
            </Table>
          </Card>
        </div>
      )}
    </Async>
  );
}

interface AttendanceRow {
  employee_number: string; full_name: string; present_days: number; late_days: number;
  wfh_days: number; absent_days: number; leave_days: number; week_off_days: number;
  holiday_days: number; worked_minutes: number; expected_days: number;
}

function Attendance({ range }: { range: string }) {
  const t = useT();
  const s = useData<{ from: string; to: string; rows: AttendanceRow[] }>(
    `/reports/attendance${range}`, [range]);

  return (
    <Async
      state={s}
      rows={4}
      isEmpty={(d) => d.rows.length === 0}
      empty={(
        <Card>
          <Empty
            title={t('rep.noAttendance')}
            hint={t('rep.noAttendanceHint')}
          />
        </Card>
      )}
    >
      {(d) => {
        // `tot`, not `t`: the translate function is in scope here and one name cannot be both.
        const tot = d.rows.reduce((a, r) => ({
          present: a.present + Number(r.present_days),
          late: a.late + Number(r.late_days),
          absent: a.absent + Number(r.absent_days),
          worked: a.worked + Number(r.worked_minutes),
        }), { present: 0, late: 0, absent: 0, worked: 0 });

        return (
          <div className="space-y-4">
            <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label={t('rep.presentDays')} value={tot.present} tone="good" />
              <Stat label={t('dash.lateArrivals')} value={tot.late} tone={tot.late > 0 ? 'warn' : 'plain'} />
              <Stat label={t('rep.absentDays')} value={tot.absent} tone={tot.absent > 0 ? 'bad' : 'plain'} />
              <Stat label={t('rep.timeWorked')} value={hm(tot.worked)} sub={`${decimalHours(tot.worked)} decimal hours`} />
            </section>
            <Card>
              <CardHead title={t('team.byPerson')} hint={`${fmtDateShort(d.from)} - ${fmtDateShort(d.to)}`} />
              <Table head={[t('common.employee'), t('attendance.present'), t('attendance.late'), 'WFH', t('attendance.absent'), t('nav.leave'), t('attendance.worked'), 'Expected']}>
                {d.rows.map((r) => (
                  <tr key={r.employee_number}>
                    <Person name={r.full_name} num={r.employee_number} />
                    <N tone="text-emerald-700">{r.present_days}</N>
                    <N tone={Number(r.late_days) > 0 ? 'text-amber-700' : 'text-ink-400'}>{r.late_days}</N>
                    <N>{r.wfh_days}</N>
                    <N tone={Number(r.absent_days) > 0 ? 'text-rose-700' : 'text-ink-400'}>{r.absent_days}</N>
                    <N>{r.leave_days}</N>
                    <N>{hm(r.worked_minutes)}</N>
                    <N tone="text-ink-400">{r.expected_days} d</N>
                  </tr>
                ))}
              </Table>
            </Card>
          </div>
        );
      }}
    </Async>
  );
}

interface LeaveRow {
  employee_number: string; full_name: string; leave_code: string; is_paid: boolean;
  accrued: string; taken: string; available: string;
}

function Leave({ year }: { year: number }) {
  const t = useT();
  const s = useData<{
    year: number; rows: LeaveRow[];
    byType: { leave_code: string; is_paid: boolean; outstanding: string; taken: string }[];
  }>(`/reports/leave?year=${year}`, [year]);

  return (
    <Async
      state={s}
      rows={4}
      isEmpty={(d) => d.rows.length === 0}
      empty={(
        <Card>
          <Empty
            title={t('rep.noBalances')}
            hint={t('rep.noBalancesHint')}
          />
        </Card>
      )}
    >
      {(d) => (
        <div className="space-y-4">
          {/*
            * PAID AND UNPAID ARE TWO GROUPS AND ARE NEVER ADDED UP.
            *
            * Unpaid leave is not an obligation - the company owes nothing for LWP - so a single
            * "total liability" spanning both would overstate what is actually owed. There is
            * deliberately no grand total on this screen.
            */}
          {(['paid', 'unpaid'] as const).map((kind) => {
            const group = d.byType.filter((b) => (kind === 'paid' ? b.is_paid : !b.is_paid));
            if (group.length === 0) return null;
            return (
              <Card key={kind}>
                <CardHead
                  title={kind === 'paid' ? 'Outstanding paid leave' : 'Unpaid leave taken'}
                  hint={kind === 'paid'
                    ? `An encashable or carry-forward obligation for ${d.year}`
                    : 'Recorded for completeness. Not a liability - nothing is owed for unpaid leave.'}
                />
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {group.map((b) => (
                    <Stat
                      key={b.leave_code}
                      label={b.leave_code}
                      value={kind === 'paid' ? b.outstanding : b.taken}
                      sub={kind === 'paid' ? 'days outstanding' : 'days taken'}
                      tone={kind === 'paid' ? 'brand' : 'plain'}
                    />
                  ))}
                </div>
              </Card>
            );
          })}
          <Card>
            <CardHead title={t('team.byPerson')} hint={`Leave year ${d.year}`} />
            <Table head={[t('common.employee'), t('leave.type'), t('payslips.paid'), 'Accrued', 'Taken', 'Available']}>
              {d.rows.map((r) => (
                <tr key={`${r.employee_number}-${r.leave_code}`}>
                  <Person name={r.full_name} num={r.employee_number} />
                  <N>{r.leave_code}</N>
                  <td className="px-3 py-2 text-end">
                    <Badge status={r.is_paid ? 'approved' : 'week_off'}>
                      {r.is_paid ? 'paid' : 'unpaid'}
                    </Badge>
                  </td>
                  <N>{r.accrued}</N>
                  <N>{r.taken}</N>
                  <N tone="font-medium text-ink-900">{r.available}</N>
                </tr>
              ))}
            </Table>
          </Card>
        </div>
      )}
    </Async>
  );
}

interface WfhRow {
  employee_number: string; full_name: string; attendance_days: number;
  approved_days: string; disagreement: number;
}

function Wfh({ range }: { range: string }) {
  const t = useT();
  const s = useData<{ from: string; to: string; note: string; rows: WfhRow[] }>(
    `/reports/wfh${range}`, [range]);

  return (
    <Async
      state={s}
      rows={4}
      isEmpty={(d) => d.rows.length === 0}
      empty={<Card><Empty title={t('rep.noWfh')} /></Card>}
    >
      {(d) => (
        <div className="space-y-4">
          <Card>
            <CardHead title={t('rep.twoSources')} />
            <p className="text-[13px] leading-relaxed text-ink-600">{d.note}</p>
          </Card>
          <Card>
            <CardHead title={t('team.byPerson')} hint={`${fmtDateShort(d.from)} - ${fmtDateShort(d.to)}`} />
            <Table head={[t('common.employee'), 'From attendance', 'From approved leave', 'Disagreement']}>
              {d.rows.map((r) => (
                <tr key={r.employee_number}>
                  <Person name={r.full_name} num={r.employee_number} />
                  <N>{r.attendance_days}</N>
                  <N>{r.approved_days}</N>
                  <N tone={Number(r.disagreement) !== 0 ? 'font-medium text-amber-700' : 'text-ink-400'}>
                    {Number(r.disagreement) === 0
                      ? 'agree'
                      : `${Number(r.disagreement) > 0 ? '+' : ''}${r.disagreement} d`}
                  </N>
                </tr>
              ))}
            </Table>
          </Card>
        </div>
      )}
    </Async>
  );
}

interface ReconRow {
  employee_number: string; full_name: string; business_date: string; attendance_status: string;
  attended_minutes: number; logged_minutes: number; variance_minutes: number; note: string;
}

function Reconciliation({ range }: { range: string }) {
  const t = useT();
  const s = useData<{
    from: string; to: string; principle: string; rows: ReconRow[];
    summary: { flagged_days: number; attended_minutes: string; logged_minutes: string } | null;
  }>(`/reports/reconciliation${range}`, [range]);

  return (
    <Async state={s} rows={4}>
      {(d) => (
        <div className="space-y-4">
          {/*
            * THE PRINCIPLE IS ON THE SCREEN, NOT ONLY IN THE ADR.
            *
            * ADR-0015: a gap between attended time and logged effort is a finding, not an error to
            * be corrected. So this view offers no adjust, reconcile or write-back affordance of any
            * kind - the two numbers sit side by side and both stand.
            */}
          <Card>
            <CardHead title={t('rep.whatFor')} />
            <p className="text-[13px] leading-relaxed text-ink-600">{d.principle}</p>
          </Card>

          <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat
              label={t('rep.daysFlagged')}
              value={d.summary?.flagged_days ?? 0}
              tone={Number(d.summary?.flagged_days ?? 0) > 0 ? 'warn' : 'good'}
            />
            <Stat label={t('rep.timeAttended')} value={hm(d.summary?.attended_minutes ?? 0)} />
            <Stat label={t('rep.effortLogged')} value={hm(d.summary?.logged_minutes ?? 0)} />
          </section>

          {d.rows.length === 0 ? (
            <Card>
              <Empty
                title={t('rep.nothingToReconcile')}
                hint={t('rep.reconcileOk')}
              />
            </Card>
          ) : (
            <Card>
              <CardHead
                title={t('rep.daysDisagree')}
                hint={`${fmtDateShort(d.from)} - ${fmtDateShort(d.to)}`}
              />
              <Table head={[t('common.employee'), t('common.date'), t('common.status'), 'Attended', 'Logged', 'Variance', 'Finding']}>
                {d.rows.map((r, i) => (
                  <tr key={`${r.employee_number}-${r.business_date}-${i}`}>
                    <Person name={r.full_name} num={r.employee_number} />
                    <N>{fmtDateShort(r.business_date)}</N>
                    <td className="px-3 py-2 text-end"><Badge status={r.attendance_status} /></td>
                    <N>{hm(r.attended_minutes)}</N>
                    <N>{hm(r.logged_minutes)}</N>
                    <N tone={Number(r.variance_minutes) < 0 ? 'text-rose-700' : 'text-amber-700'}>
                      {Number(r.variance_minutes) > 0 ? '+' : ''}{hm(r.variance_minutes)}
                    </N>
                    <td className="px-3 py-2 text-end text-[12.5px] text-ink-500">{r.note}</td>
                  </tr>
                ))}
              </Table>
            </Card>
          )}
        </div>
      )}
    </Async>
  );
}

interface TimesheetRow {
  employee_number: string; full_name: string; period_start: string; period_end: string;
  status: string; logged_minutes: number; days_waiting: number | null;
}

function Timesheets({ range }: { range: string }) {
  const t = useT();
  const s = useData<{ from: string; to: string; rows: TimesheetRow[] }>(
    `/reports/timesheets${range}`, [range]);

  return (
    <Async
      state={s}
      rows={4}
      isEmpty={(d) => d.rows.length === 0}
      empty={<Card><Empty title={t('rep.noPeriods')} /></Card>}
    >
      {(d) => {
        const waiting = d.rows.filter((r) => r.status === 'submitted' || r.status === 'under_review');
        const stale = waiting.filter((r) => Number(r.days_waiting) >= 3);
        return (
          <div className="space-y-4">
            <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label={t('rep.periods')} value={d.rows.length} />
              <Stat
                label={t('appr.approve')}
                value={d.rows.filter((r) => r.status === 'approved').length}
                tone="good"
              />
              <Stat
                label={t('rep.awaitingDecision')}
                value={waiting.length}
                tone={waiting.length > 0 ? 'warn' : 'plain'}
              />
              <Stat
                label={t('rep.waiting3')}
                value={stale.length}
                tone={stale.length > 0 ? 'bad' : 'plain'}
                sub={t('rep.bottleneck')}
              />
            </section>
            <Card>
              <CardHead title={t('rep.byPeriod')} hint={`${fmtDateShort(d.from)} - ${fmtDateShort(d.to)}`} />
              <Table head={[t('common.employee'), t('period.label'), t('common.status'), 'Logged', 'Waiting']}>
                {d.rows.map((r, i) => (
                  <tr key={`${r.employee_number}-${r.period_start}-${i}`}>
                    <Person name={r.full_name} num={r.employee_number} />
                    <N>{fmtDateShort(r.period_start)} - {fmtDateShort(r.period_end)}</N>
                    <td className="px-3 py-2 text-end"><Badge status={r.status} /></td>
                    <N>{hm(r.logged_minutes)}</N>
                    <N tone={Number(r.days_waiting) >= 3 ? 'font-medium text-rose-700' : 'text-ink-400'}>
                      {r.days_waiting == null ? '-' : `${r.days_waiting} d`}
                    </N>
                  </tr>
                ))}
              </Table>
            </Card>
          </div>
        );
      }}
    </Async>
  );
}

interface DocRow {
  employee_number: string; full_name: string; status: string; filed_types: number;
  pending_scan: number; expiring_soon: number; expired: number;
}

function Documents() {
  const t = useT();
  const s = useData<{ withinDays: number; rows: DocRow[] }>('/reports/documents');

  return (
    <Async
      state={s}
      rows={4}
      isEmpty={(d) => d.rows.length === 0}
      empty={<Card><Empty title={t('rep.noDocRecords')} /></Card>}
    >
      {(d) => (
        <div className="space-y-4">
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label={t('rep.peopleCovered')} value={d.rows.length} />
            <Stat
              label={t('rep.nothingOnFile')}
              value={d.rows.filter((r) => Number(r.filed_types) === 0).length}
              tone={d.rows.some((r) => Number(r.filed_types) === 0) ? 'warn' : 'good'}
            />
            <Stat
              label={t('rep.awaitingScan')}
              value={d.rows.reduce((a, r) => a + Number(r.pending_scan), 0)}
            />
            <Stat
              label={t('rep.expired')}
              value={d.rows.reduce((a, r) => a + Number(r.expired), 0)}
              tone={d.rows.some((r) => Number(r.expired) > 0) ? 'bad' : 'plain'}
            />
          </section>
          <Card>
            {/*
              * COUNTS ONLY, NEVER TYPES.
              *
              * "Rahul holds one expiring MEDICAL certificate" is information about his health. The
              * endpoint returns no type names at all, so this table cannot render one even by
              * accident - the restriction lives in the query, not in this component.
              */}
            <CardHead
              title={t('rep.filingPosture')}
              hint={`Expiry window: the next ${d.withinDays} days. Counts only - document types are not shown.`}
            />
            <Table head={[t('common.employee'), 'Types on file', t('rep.awaitingScan'), 'Expiring soon', t('rep.expired')]}>
              {d.rows.map((r) => (
                <tr key={r.employee_number}>
                  <Person name={r.full_name} num={r.employee_number} />
                  <N tone={Number(r.filed_types) === 0 ? 'text-amber-700' : 'text-ink-700'}>{r.filed_types}</N>
                  <N tone={Number(r.pending_scan) > 0 ? 'text-amber-700' : 'text-ink-400'}>{r.pending_scan}</N>
                  <N tone={Number(r.expiring_soon) > 0 ? 'text-amber-700' : 'text-ink-400'}>{r.expiring_soon}</N>
                  <N tone={Number(r.expired) > 0 ? 'font-medium text-rose-700' : 'text-ink-400'}>{r.expired}</N>
                </tr>
              ))}
            </Table>
          </Card>
        </div>
      )}
    </Async>
  );
}

function Effort({ range }: { range: string }) {
  const t = useT();
  const s = useData<{
    from: string; to: string;
    byProject: { code: string; name: string; minutes: number; contributors: number }[];
    byEmployee: { employee_number: string; full_name: string; minutes: number }[];
  }>(`/reports/effort${range}`, [range]);

  return (
    <Async
      state={s}
      rows={4}
      isEmpty={(d) => d.byProject.length === 0 && d.byEmployee.length === 0}
      empty={(
        <Card>
          <Empty
            title={t('rep.noEffort')}
            hint={t('rep.noEffortHint')}
          />
        </Card>
      )}
    >
      {(d) => {
        const total = d.byProject.reduce((a, p) => a + Number(p.minutes), 0);
        const maxP = Math.max(1, ...d.byProject.map((p) => Number(p.minutes)));
        const maxE = Math.max(1, ...d.byEmployee.map((e) => Number(e.minutes)));
        return (
          <div className="space-y-4">
            <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat label={t('rep.effortLogged')} value={hm(total)} sub={`${decimalHours(total)} decimal hours`} />
              <Stat label={t('ep.projects')} value={d.byProject.length} />
              <Stat label={t('team.peopleReporting')} value={d.byEmployee.length} />
            </section>
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHead title={t('team.byProject')} hint={`${fmtDateShort(d.from)} - ${fmtDateShort(d.to)}`} />
                <ul className="space-y-3">
                  {d.byProject.map((p) => (
                    <li key={p.code}>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="truncate text-[13.5px] font-medium text-ink-800">
                          <span className="num text-ink-400">{p.code}</span> {p.name}
                        </span>
                        <span className="num shrink-0 text-[13px] text-ink-600">{hm(p.minutes)}</span>
                      </div>
                      <div className="mt-1.5"><Bar value={Number(p.minutes)} max={maxP} /></div>
                      <div className="mt-0.5 text-[12px] text-ink-400">
                        {p.contributors} {Number(p.contributors) === 1 ? 'person' : 'people'}
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
              <Card>
                <CardHead title={t('team.byPerson')} />
                <ul className="space-y-3">
                  {d.byEmployee.map((e) => (
                    <li key={e.employee_number}>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="truncate text-[13.5px] font-medium text-ink-800">{e.full_name}</span>
                        <span className="num shrink-0 text-[13px] text-ink-600">{hm(e.minutes)}</span>
                      </div>
                      <div className="mt-1.5"><Bar value={Number(e.minutes)} max={maxE} tone="good" /></div>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          </div>
        );
      }}
    </Async>
  );
}

interface TaskAssigneeRow {
  employee_number: string; full_name: string; open_tasks: number; in_progress: number;
  blocked: number; done_tasks: number; cancelled_tasks: number; overdue: number;
  due_soon: number; no_due_date: number;
}

interface TaskProjectRow {
  code: string; name: string; client_name: string | null; total_tasks: number;
  unassigned: number; open_tasks: number; in_progress: number; blocked: number;
  done_tasks: number; cancelled_tasks: number; overdue: number; due_soon: number;
  assignees: number;
}

/**
 * The only report on this page with two tables, because it is the only one that uses two SCOPE
 * GRAPHS.
 *
 * "By assignee" resolves through the reporting line; "by project" through project membership. The
 * two can legitimately disagree for the same viewer - an ordinary employee sees ONE person and
 * TWO projects - so each heading says which graph it answers to. A reader who assumed a single
 * filter would otherwise read the second table as a bug.
 *
 * The unassigned column is why that second table has to exist: a task with nobody on it has no
 * subject, so the reporting line cannot account for it and only the project view can see it.
 */
function Tasks() {
  const t = useT();
  const s = useData<{
    dueWithinDays: number; note: string;
    byAssignee: TaskAssigneeRow[]; byProject: TaskProjectRow[];
  }>('/reports/tasks');

  return (
    <Async
      state={s}
      rows={4}
      isEmpty={(d) => d.byAssignee.length === 0 && d.byProject.length === 0}
      empty={(
        <Card>
          <Empty
            title={t('rep.noTasks')}
            hint={t('rep.noTasksHint')}
          />
        </Card>
      )}
    >
      {(d) => {
        const unassigned = d.byProject.reduce((a, r) => a + Number(r.unassigned), 0);
        const overdue = d.byProject.reduce((a, r) => a + Number(r.overdue), 0);
        const dueSoon = d.byProject.reduce((a, r) => a + Number(r.due_soon), 0);
        const openWork = d.byProject.reduce((a, r) => a
          + Number(r.open_tasks) + Number(r.in_progress) + Number(r.blocked), 0);
        return (
          <div className="space-y-4">
            <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label={t('rep.openWork')} value={openWork} />
              <Stat label={t('rep.overdue')} value={overdue} tone={overdue > 0 ? 'bad' : 'good'} />
              <Stat
                label={`Due in ${d.dueWithinDays} days`}
                value={dueSoon}
                tone={dueSoon > 0 ? 'warn' : 'plain'}
              />
              <Stat
                label={t('rep.assignedToNobody')}
                value={unassigned}
                tone={unassigned > 0 ? 'warn' : 'good'}
                sub={unassigned > 0 ? 'no owner, so no reporting line' : undefined}
              />
            </section>

            <Card>
              <CardHead title={t('rep.whyTwoTables')} />
              <p className="text-[13px] leading-relaxed text-ink-600">{d.note}</p>
            </Card>

            <Card>
              <CardHead
                title={t('rep.byAssignee')}
                hint={t('rep.reportingScope')}
              />
              {d.byAssignee.length === 0 ? (
                <Empty title={t('rep.noAssigned')} />
              ) : (
                <Table head={[t('common.employee'), t('common.open'), 'In progress', 'Blocked', 'Done', t('rep.overdue'), 'Due soon', 'No due date']}>
                  {d.byAssignee.map((r) => (
                    <tr key={r.employee_number}>
                      <Person name={r.full_name} num={r.employee_number} />
                      <N>{r.open_tasks}</N>
                      <N>{r.in_progress}</N>
                      <N tone={Number(r.blocked) > 0 ? 'text-rose-700' : 'text-ink-400'}>{r.blocked}</N>
                      <N tone="text-emerald-700">{r.done_tasks}</N>
                      <N tone={Number(r.overdue) > 0 ? 'font-medium text-rose-700' : 'text-ink-400'}>{r.overdue}</N>
                      <N tone={Number(r.due_soon) > 0 ? 'text-amber-700' : 'text-ink-400'}>{r.due_soon}</N>
                      <N tone="text-ink-400">{r.no_due_date}</N>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>

            <Card>
              <CardHead
                title={t('team.byProject')}
                hint={t('rep.projectScope')}
              />
              {d.byProject.length === 0 ? (
                <Empty title={t('rep.noProjectTasks')} />
              ) : (
                <Table head={[t('common.project'), 'Tasks', 'Unassigned', t('common.open'), 'In progress', 'Done', t('rep.overdue'), 'People']}>
                  {d.byProject.map((r) => (
                    <tr key={r.code}>
                      <td className="px-3 py-2">
                        <div className="font-medium text-ink-800">
                          <span className="num text-ink-400">{r.code}</span> {r.name}
                        </div>
                        {r.client_name && (
                          <div className="text-[12px] text-ink-400">{r.client_name}</div>
                        )}
                      </td>
                      <N>{r.total_tasks}</N>
                      <N tone={Number(r.unassigned) > 0 ? 'font-medium text-amber-700' : 'text-ink-400'}>{r.unassigned}</N>
                      <N>{r.open_tasks}</N>
                      <N>{r.in_progress}</N>
                      <N tone="text-emerald-700">{r.done_tasks}</N>
                      <N tone={Number(r.overdue) > 0 ? 'font-medium text-rose-700' : 'text-ink-400'}>{r.overdue}</N>
                      <N tone="text-ink-400">{r.assignees}</N>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
          </div>
        );
      }}
    </Async>
  );
}
