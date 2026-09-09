'use client';

import { useState } from 'react';
import { api, ApiError, fmtDate, fmtDateShort, hm, useData } from '@/lib/api';
import { Async, Badge, Button, Card, CardHead, Empty, Toast, inputCls } from '@/components/ui';
import { useT } from '@/lib/i18n';

interface LeaveQueue {
  requests: {
    id: string; full_name: string; employee_number: string; type: string;
    from_date: string; to_date: string; working_days: string;
    reason: string | null; submitted_at: string; balance_now: string | null;
  }[];
}
interface TsQueue {
  periods: {
    id: string; full_name: string; employee_number: string;
    period_start: string; period_end: string; submitted_at: string; total_minutes: number;
  }[];
}

export default function ApprovalsPage() {
  const t = useT();
  const leave = useData<LeaveQueue>('/leave/approvals');
  const sheets = useData<TsQueue>('/timesheet/approvals');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<{ msg: string; tone: 'good' | 'bad' } | null>(null);

  async function decideLeave(id: string, decision: 'approve' | 'reject') {
    setBusyId(id);
    try {
      const res = await api.post<{ balanceAfter: number }>(`/leave/approvals/${id}/decide`, {
        decision, note: notes[id] || null,
      });
      setToast({
        msg: decision === 'approve'
          ? `Approved. Their balance is now ${res.balanceAfter} days.`
          : 'Rejected. The held days have been returned to their balance.',
        tone: 'good',
      });
      await leave.reload();
    } catch (err) {
      setToast({ msg: err instanceof ApiError ? err.message : 'Could not record the decision', tone: 'bad' });
    } finally {
      setBusyId(null);
    }
  }

  async function decideSheet(id: string, decision: 'approve' | 'return') {
    setBusyId(id);
    try {
      await api.post(`/timesheet/approvals/${id}/decide`, { decision, note: notes[id] || null });
      setToast({ msg: decision === 'approve' ? 'Timesheet approved' : 'Returned to the employee', tone: 'good' });
      await sheets.reload();
    } catch (err) {
      setToast({ msg: err instanceof ApiError ? err.message : 'Could not record the decision', tone: 'bad' });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[21px] font-semibold text-ink-900">{t('appr.title')}</h1>
        <p className="mt-0.5 text-[13.5px] text-ink-500">
          Only your direct reports appear here. Approving leave posts a ledger entry — the balance
          is a consequence, not a field that gets edited.
        </p>
      </div>

      <Card>
        <CardHead
          title={t('common.leaveRequests')}
          action={leave.data?.requests.length ? <Badge status="pending">{leave.data.requests.length} pending</Badge> : undefined}
        />
        <Async
          state={leave}
          rows={3}
          isEmpty={(d) => d.requests.length === 0}
          empty={<Empty title={t('appr.noLeave')} hint={t('appr.noLeaveHint')} />}
        >
          {(d) => (
            <ul className="divide-y divide-ink-100">
              {d.requests.map((r) => (
                <li key={r.id} className="p-4 sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-[14px] font-semibold text-ink-900">{r.full_name}</span>
                        <span className="num text-[12.5px] text-ink-500">{r.employee_number}</span>
                        <Badge>{r.type}</Badge>
                      </div>
                      <div className="num mt-1 text-[13.5px] text-ink-700">
                        {fmtDate(r.from_date)} → {fmtDate(r.to_date)}
                        <span className="font-medium"> · {Number(r.working_days)} working day{Number(r.working_days) === 1 ? '' : 's'}</span>
                      </div>
                      {r.reason && <p className="mt-1 text-[13px] text-ink-600">“{r.reason}”</p>}
                      <p className="mt-1 text-[12.5px] text-ink-500">
                        {t('appr.balanceAfterHold')} <span className="num font-medium">{Number(r.balance_now ?? 0)}</span> days
                      </p>
                    </div>

                    <div className="flex w-full flex-col gap-2 sm:w-auto sm:min-w-[16rem]">
                      <label htmlFor={`note-${r.id}`} className="sr-only">Note for {r.full_name}</label>
                      <input
                        id={`note-${r.id}`} type="text" className={inputCls} placeholder={t('appr.optionalNote')}
                        value={notes[r.id] ?? ''}
                        onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
                      />
                      <div className="flex gap-2">
                        <Button busy={busyId === r.id} onClick={() => decideLeave(r.id, 'approve')} className="flex-1">
                          {t('appr.approve')}
                        </Button>
                        <Button variant="danger" busy={busyId === r.id} onClick={() => decideLeave(r.id, 'reject')} className="flex-1">
                          {t('appr.reject')}
                        </Button>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Async>
      </Card>

      <Card>
        <CardHead
          title={t('common.timesheets')}
          action={sheets.data?.periods.length ? <Badge status="submitted">{sheets.data.periods.length} submitted</Badge> : undefined}
        />
        <Async
          state={sheets}
          rows={3}
          isEmpty={(d) => d.periods.length === 0}
          empty={<Empty title={t('appr.noTimesheets')} hint={t('appr.noTimesheetsHint')} />}
        >
          {(d) => (
            <ul className="divide-y divide-ink-100">
              {d.periods.map((p) => (
                <li key={p.id} className="p-4 sm:p-5">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-[14px] font-semibold text-ink-900">{p.full_name}</span>
                        <span className="num text-[12.5px] text-ink-500">{p.employee_number}</span>
                      </div>
                      <div className="num mt-1 text-[13.5px] text-ink-700">
                        {fmtDateShort(p.period_start)} – {fmtDateShort(p.period_end)}
                        <span className="font-medium"> · {hm(p.total_minutes)}</span>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button busy={busyId === p.id} onClick={() => decideSheet(p.id, 'approve')}>{t('appr.approve')}</Button>
                      <Button variant="secondary" busy={busyId === p.id} onClick={() => decideSheet(p.id, 'return')}>
                        {t('appr.return')}
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Async>
      </Card>

      {toast && <Toast message={toast.msg} tone={toast.tone} onDone={() => setToast(null)} />}
    </div>
  );
}
