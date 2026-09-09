'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useParams } from 'next/navigation';
import { fmtDate, hasRole, useData, type Actor } from '@/lib/api';
import { Async, Badge, Button, Card, CardHead, Empty, Stat } from '@/components/ui';
import { DocumentList, type Doc } from '@/components/documents';
import { AddPayslip, PayslipDetail, PayslipList } from '@/components/payslips';
import { ChangeAssignment } from '@/components/employee-master';

interface Profile {
  /** True when this record belongs to the caller. Only then does `personal` come back. */
  isSelf: boolean;
  employee: {
    id: string; employee_number: string; full_name: string; work_email: string;
    joined_on: string; status: string; confirmed_on: string | null;
    department: string | null; designation: string | null; manager: string | null;
    work_location: string | null; employment_type: string | null; assignment_since: string | null;
  };
  /**
   * PERSONAL / SENSITIVE fields, served by the API only when the caller is the subject.
   * Date of birth, gender and phone used to render here for ANY colleague - see the
   * field-allowlist comment in apps/api/src/hr.ts.
   */
  personal: {
    date_of_birth: string | null; gender: string | null; personal_phone: string | null;
  } | null;
  history: {
    valid_from: string; valid_to: string | null;
    department: string | null; designation: string | null; manager: string | null; reason: string | null;
  }[];
  balances: { code: string; available: string; taken: string }[];
  attendanceThisMonth: { present: string; wfh: string; late: string; absent: string };
  projects: { code: string; name: string; role: string }[];
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[12px] font-medium uppercase tracking-wide text-ink-400">{label}</dt>
      <dd className="mt-0.5 text-[13.5px] text-ink-800">{value ?? '—'}</dd>
    </div>
  );
}

/**
 * The employee's documents, on their profile.
 *
 * Visibility is NOT decided here. The request is made unconditionally and the API returns an
 * empty list to anybody the documents policy does not admit - a line manager included
 * (DEC-049). So the card renders only when there is something to render, and a manager viewing
 * a report simply does not see it, without this component knowing why.
 */
function DocumentsCard({ employeeId, isHr }: { employeeId: string; isHr: boolean }) {
  const state = useData<{ documents: Doc[] }>(`/documents?employeeId=${employeeId}`, [employeeId]);
  const docs = state.data?.documents ?? [];

  // Nothing to show and nothing to say: an employee looking at a colleague should not be told
  // that documents exist but are withheld.
  if (state.loading || state.error || (docs.length === 0 && !isHr)) return null;

  return (
    <Card className="scroll-mt-20" >
      <div id="documents" />
      <CardHead
        title="Documents"
        hint={isHr
          ? 'Filed against this employee. Uploads are scanned before they become available.'
          : 'Your filed documents.'}
        action={
          <Link href="/documents" className="text-[13px] font-medium text-brand-700 hover:underline">
            Manage
          </Link>
        }
      />
      <DocumentList
        documents={docs}
        isHr={isHr}
        onChanged={() => state.reload()}
      />
    </Card>
  );
}

/**
 * Payslips for one employee, from HR's side. The user's flow starts here: open the profile, open
 * Payslips, add one.
 *
 * `isHrAdmin` is NOT the access control - `payroll.payslip.manage` is, server-side, and the API
 * refuses a caller who does not hold it whatever this component renders. What the flag decides is
 * whether to OFFER a door that is already locked, which is the same distinction DEC-053 drew for
 * settings. Note it is hr_admin only, not hr_ops: the salary register is need-to-know, and hr_ops
 * holds every other HR resource here.
 */
function PayslipsCard({ employeeId, employeeName, isHrAdmin }: {
  employeeId: string; employeeName: string; isHrAdmin: boolean;
}) {
  const [mode, setMode] = useState<'list' | 'add'>('list');
  const [open, setOpen] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  if (!isHrAdmin) return null;

  if (mode === 'add') {
    return (
      <Card className="scroll-mt-20">
        <AddPayslip
          employeeId={employeeId}
          employeeName={employeeName}
          onDone={() => { setMode('list'); setReloadKey((k) => k + 1); }}
          onCancel={() => setMode('list')}
        />
      </Card>
    );
  }

  if (open) {
    return (
      <Card className="scroll-mt-20">
        <PayslipDetail id={open} onClose={() => { setOpen(null); setReloadKey((k) => k + 1); }} />
      </Card>
    );
  }

  return (
    <Card className="scroll-mt-20">
      <CardHead
        title="Payslips"
        hint="Figures are entered from a finalised payroll result — nothing here is calculated."
        action={<Button size="sm" onClick={() => setMode('add')}>Add payslip</Button>}
      />
      <div key={reloadKey}>
        <PayslipList
          employeeId={employeeId}
          onOpen={setOpen}
          emptyHint="No payslips have been recorded for this employee yet."
        />
      </div>
    </Card>
  );
}

/**
 * The assignment change, offered beside the history it will extend.
 *
 * Placed here rather than as an "edit" on the information card on purpose: a transfer is not a
 * correction to what the record says, it is a new fact with a date. Putting it next to the
 * assignment HISTORY makes that visible - you can see the periods it will add to.
 */
function AssignmentCard({ employeeId, employeeName, current, onDone }: {
  employeeId: string;
  employeeName: string;
  current: { department?: string | null; designation?: string | null; manager?: string | null };
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);

  if (open) {
    return (
      <ChangeAssignment
        employeeId={employeeId}
        employeeName={employeeName}
        current={current}
        onDone={() => { setOpen(false); onDone(); }}
        onCancel={() => setOpen(false)}
      />
    );
  }

  return (
    <Card>
      <CardHead
        title="Assignment"
        hint="Transfers and promotions are recorded with a date, so earlier reports keep resolving to the earlier structure."
        action={<Button size="sm" onClick={() => setOpen(true)}>Change assignment</Button>}
      />
      <p className="text-[13px] text-ink-600">
        Currently{' '}
        <span className="font-medium text-ink-900">{current.designation ?? 'unassigned'}</span>
        {current.department && <> in <span className="font-medium text-ink-900">{current.department}</span></>}
        {current.manager && <>, reporting to <span className="font-medium text-ink-900">{current.manager}</span></>}.
      </p>
    </Card>
  );
}

export default function EmployeeProfilePage() {
  const { id } = useParams<{ id: string }>();
  const state = useData<Profile>(`/employees/${id}`);
  const me = useData<{ actor: Actor }>('/auth/me');
  const isHr = hasRole(me.data?.actor, 'hr_admin', 'hr_ops');

  return (
    <div className="space-y-5">
      <Link href="/employees" className="inline-flex items-center gap-1 text-[13px] font-medium text-brand-700 hover:underline">
        <span aria-hidden>←</span> All employees
      </Link>

      <Async state={state} rows={6}>
        {(d) => {
          const e = d.employee;
          const att = d.attendanceThisMonth;
          return (
            <div className="space-y-5">
              <div className="flex flex-wrap items-start gap-4">
                <span aria-hidden className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-brand-100 text-[18px] font-semibold text-brand-700">
                  {e.full_name.split(' ').map((p) => p[0]).slice(0, 2).join('')}
                </span>
                <div className="min-w-0 flex-1">
                  <h1 className="text-[21px] font-semibold text-ink-900">{e.full_name}</h1>
                  <p className="mt-0.5 text-[13.5px] text-ink-600">
                    {e.designation ?? '—'} · {e.department ?? '—'}
                  </p>
                  <p className="num mt-0.5 text-[12.5px] text-ink-500">
                    {e.employee_number} · {e.work_email}
                  </p>
                </div>
                <Badge status={e.status} />
              </div>

              <section aria-label="Attendance this month" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Present" value={att.present} tone="good" sub="this month" />
                <Stat label="WFH" value={att.wfh} tone="brand" sub="this month" />
                <Stat label="Late" value={att.late} tone="warn" sub="this month" />
                <Stat label="Absent" value={att.absent} tone={Number(att.absent) > 0 ? 'bad' : 'plain'} sub="this month" />
              </section>

              <div className="grid gap-5 lg:grid-cols-3">
                <Card className="lg:col-span-2">
                  <CardHead title="Employee information" />
                  <dl className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-3 sm:p-5">
                    <Detail label="Employee number" value={<span className="num">{e.employee_number}</span>} />
                    <Detail label="Work email" value={e.work_email} />
                    <Detail label="Department" value={e.department} />
                    <Detail label="Designation" value={e.designation} />
                    <Detail label="Reporting manager" value={e.manager ?? 'No manager (top of chain)'} />
                    <Detail label="Joined on" value={fmtDate(e.joined_on)} />
                    <Detail label="Confirmed on" value={fmtDate(e.confirmed_on)} />
                    <Detail label="Employment type" value={e.employment_type?.replace('_', ' ')} />
                    <Detail label="Work location" value={e.work_location} />
                    <Detail label="In current role since" value={fmtDate(e.assignment_since)} />

                    {/* Personal detail is the subject's own. It is absent from the response for
                        anyone else, so there is no client-side gate here to get wrong. */}
                    {d.personal && (
                      <>
                        <Detail label="Phone" value={d.personal.personal_phone} />
                        <Detail label="Date of birth" value={fmtDate(d.personal.date_of_birth)} />
                        <Detail label="Gender" value={d.personal.gender} />
                      </>
                    )}
                  </dl>
                  {!d.isSelf && (
                    <p className="border-t border-ink-100 px-4 py-3 text-[12.5px] text-ink-500 sm:px-5">
                      Personal contact details are visible only to the employee themselves.
                    </p>
                  )}
                </Card>

                <div className="space-y-5">
                  <Card>
                    <CardHead title="Leave balance" hint="Folded from the ledger" />
                    <ul className="divide-y divide-ink-100">
                      {d.balances.map((b) => (
                        <li key={b.code} className="flex items-center justify-between px-4 py-2.5 sm:px-5">
                          <span className="text-[13.5px] font-medium text-ink-700">{b.code}</span>
                          <span className="num text-[13.5px] text-ink-800">
                            {Number(b.available)} left
                            <span className="text-[12.5px] text-ink-500"> · {Number(b.taken)} taken</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </Card>

                  <Card>
                    <CardHead title="Projects" />
                    {d.projects.length === 0 ? (
                      <Empty title="Not assigned to any project" />
                    ) : (
                      <ul className="divide-y divide-ink-100">
                        {d.projects.map((p) => (
                          <li key={p.code} className="flex items-center justify-between gap-2 px-4 py-2.5 sm:px-5">
                            <div>
                              <div className="text-[13.5px] font-medium text-ink-800">{p.name}</div>
                              <div className="num text-[12.5px] text-ink-500">{p.code}</div>
                            </div>
                            <Badge>{p.role.replace('_', ' ')}</Badge>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>
                </div>
              </div>

              {/* THE point of effective dating. Not "current values" - the whole timeline. */}
              <Card>
                <CardHead
                  title="Assignment history"
                  hint="Every change created a new period. Nothing was overwritten, so the org can be reconstructed as it was on any past date."
                />
                <ol className="p-4 sm:p-5">
                  {d.history.map((h, i) => (
                    <li key={h.valid_from} className="relative flex gap-4 pb-5 last:pb-0">
                      {i < d.history.length - 1 && (
                        <span aria-hidden className="absolute left-[5px] top-4 h-full w-px bg-ink-200" />
                      )}
                      <span
                        aria-hidden
                        className={`relative z-10 mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-white ${
                          h.valid_to === null ? 'bg-emerald-600' : 'bg-ink-300'
                        }`}
                      />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-[13.5px] font-medium text-ink-900">{h.designation}</span>
                          <span className="text-[13px] text-ink-500">{h.department}</span>
                          {h.valid_to === null && <Badge status="present">current</Badge>}
                        </div>
                        <div className="num mt-0.5 text-[12.5px] text-ink-500">
                          {fmtDate(h.valid_from)} → {h.valid_to ? fmtDate(h.valid_to) : 'open'}
                          {h.manager && <span className="text-ink-400"> · reporting to {h.manager}</span>}
                        </div>
                        {h.reason && <div className="mt-1 text-[13px] text-ink-600">{h.reason}</div>}
                      </div>
                    </li>
                  ))}
                </ol>
              </Card>

              <DocumentsCard employeeId={e.id} isHr={isHr} />

              {isHr && (
                <AssignmentCard
                  employeeId={e.id}
                  employeeName={e.full_name}
                  current={{
                    department: e.department, designation: e.designation, manager: e.manager,
                  }}
                  onDone={() => state.reload()}
                />
              )}

              <PayslipsCard
                employeeId={e.id}
                employeeName={e.full_name}
                isHrAdmin={hasRole(me.data?.actor, 'hr_admin')}
              />
            </div>
          );
        }}
      </Async>
    </div>
  );
}
