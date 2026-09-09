'use client';

import Link from 'next/link';
import { hasRole, useData, type Actor } from '@/lib/api';
import { Async, Badge, Card, CardHead, Empty, Skeleton, Stat } from '@/components/ui';
import { DocumentList, type Doc } from '@/components/documents';

/**
 * Employee Self-Service: my own profile.
 *
 * Reads the existing `GET /employees/:id` with the caller's own id, so this screen adds NO new
 * API route and therefore no new authorization surface - which matters, because
 * `packages/authz/authz-matrix.yaml` does not exist yet and CLAUDE.md's Forbidden Actions bar
 * adding a route without an entry in it.
 *
 * The `personal` and `lifecycle` blocks come back only when the caller IS the subject (see the
 * field-allowlist comment in apps/api/src/hr.ts). Nothing here is reachable for somebody else's
 * record, so there is no client-side gate to get wrong.
 */

interface Row { label: string; value: unknown; hint?: string }

interface ProfileResponse {
  isSelf: boolean;
  employee: Record<string, any> | null;
  personal: Record<string, any> | null;
  lifecycle: {
    event_type: string; effective_on: string; from_status: string; to_status: string;
    last_working_day: string | null; exit_type: string | null; reason: string | null;
  }[];
  history: {
    valid_from: string; valid_to: string | null; department: string | null;
    designation: string | null; manager: string | null; reason: string | null;
  }[];
  balances: { code: string; available: string; taken: string }[];
  attendanceThisMonth: { present: string; wfh: string; late: string; absent: string } | null;
  projects: { code: string; name: string; role: string }[];
}

/** A date-only string is already correct from the API (Rule 5 - never reparse it into a Date). */
function fmtDate(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const [y, m, d] = v.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${Number(d)} ${months[Number(m) - 1]} ${y}`;
}

function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  const asDate = fmtDate(v);
  if (asDate) return asDate;
  if (typeof v === 'string') return v.replace(/_/g, ' ');
  return String(v);
}

/** Years and months of service, from a date-only string. No Date arithmetic on the value. */
function serviceLength(joined: unknown): string | null {
  const d = fmtDate(joined);
  if (!d || typeof joined !== 'string') return null;
  const [jy, jm] = joined.split('-').map(Number);
  const now = new Date();
  let months = (now.getFullYear() - jy!) * 12 + (now.getMonth() + 1 - jm!);
  if (months < 0) return null;
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (y === 0) return `${m} month${m === 1 ? '' : 's'}`;
  return m === 0 ? `${y} year${y === 1 ? '' : 's'}` : `${y}y ${m}m`;
}

function DetailList({ rows }: { rows: Row[] }) {
  const shown = rows.filter((r) => r.value !== undefined);
  return (
    <dl className="divide-y divide-ink-100">
      {shown.map((r) => (
        <div key={r.label} className="grid gap-0.5 px-4 py-2.5 sm:grid-cols-3 sm:gap-3 sm:px-5">
          <dt className="text-[13px] text-ink-500">{r.label}</dt>
          <dd className="sm:col-span-2">
            <span className={`text-[13.5px] ${r.value ? 'text-ink-900' : 'text-ink-400'}`}>
              {show(r.value)}
            </span>
            {r.hint && <span className="ml-2 text-[12px] text-ink-400">{r.hint}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const EVENT_LABEL: Record<string, string> = {
  joined: 'Joined',
  confirmed: 'Confirmed',
  probation_extended: 'Probation extended',
  transferred: 'Transferred',
  promoted: 'Promoted',
  resigned: 'Resignation submitted',
  termination_initiated: 'Notice served',
  resignation_withdrawn: 'Resignation withdrawn',
  exited: 'Left the company',
};

/** The caller's own documents. RESTRICTED types are absent from the response (OR-25). */
function MyDocuments({ employeeId, isHr }: { employeeId: string; isHr: boolean }) {
  const state = useData<{ documents: Doc[] }>(`/documents?employeeId=${employeeId}`, [employeeId]);
  const docs = state.data?.documents ?? [];
  if (state.loading || state.error) return null;

  return (
    <Card>
      <CardHead
        title="My documents"
        hint="Uploaded by you or filed by HR. Scanned before they become available."
        action={
          <Link href="/documents" className="text-[13px] font-medium text-brand-700 hover:underline">
            Upload
          </Link>
        }
      />
      {docs.length === 0
        ? (
          <Empty
            title="No documents yet"
            hint="Upload your ID proof, PAN card or certificates from the Documents screen."
          />
        )
        : <DocumentList documents={docs} isHr={isHr} onChanged={() => state.reload()} />}
    </Card>
  );
}

export default function MyProfilePage() {
  const me = useData<{ actor: Actor }>('/auth/me');
  const id = me.data?.actor.employeeId ?? null;
  const isHr = hasRole(me.data?.actor, 'hr_admin', 'hr_ops');
  const state = useData<ProfileResponse>(id ? `/employees/${id}` : null, [id]);

  if (me.loading) return <Skeleton rows={6} />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[19px] font-semibold tracking-tight text-ink-900">My Profile</h1>
          <p className="mt-0.5 text-[13.5px] text-ink-500">
            Your own record. Personal details on this page are visible to you alone.
          </p>
        </div>
        <Link
          href="/employees"
          className="rounded-lg px-2.5 py-1.5 text-[13.5px] font-medium text-ink-600 hover:bg-ink-100"
        >
          Employee directory
        </Link>
      </div>

      <Async state={state} rows={8}>
        {(d) => {
          const e = d.employee ?? {};
          const p = d.personal ?? {};
          const att = d.attendanceThisMonth;
          const initials = String(e.full_name ?? '')
            .split(' ').map((x: string) => x[0]).slice(0, 2).join('');

          return (
            <>
              {/* Identity ------------------------------------------------------------- */}
              <Card>
                <div className="flex flex-wrap items-center gap-4 px-4 py-4 sm:px-5">
                  <span
                    aria-hidden
                    className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-brand-50 text-[18px] font-semibold text-brand-700"
                  >
                    {initials}
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-[17px] font-semibold text-ink-900">{e.full_name}</h2>
                      <Badge status={e.status} />
                    </div>
                    <p className="mt-0.5 text-[13.5px] text-ink-600">
                      {e.designation ?? '—'}
                      {e.department ? ` · ${e.department}` : ''}
                    </p>
                    <p className="mt-0.5 text-[12.5px] text-ink-500">
                      {e.employee_number} · {e.work_email}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 border-t border-ink-100 px-4 py-4 sm:grid-cols-4 sm:px-5">
                  <Stat label="Joined" value={show(e.joined_on)} sub={serviceLength(e.joined_on) ?? undefined} />
                  <Stat label="Reporting to" value={e.manager ?? 'No manager'} />
                  <Stat label="Work location" value={show(e.work_location)} />
                  <Stat
                    label="This month"
                    value={att ? `${Number(att.present) + Number(att.wfh)} days` : '—'}
                    sub={att ? `${att.late} late · ${att.absent} absent` : undefined}
                  />
                </div>
              </Card>

              <div className="grid gap-5 lg:grid-cols-2">
                {/* Employment ------------------------------------------------------- */}
                <Card>
                  <CardHead title="Employment" hint="Your current terms and lifecycle dates" />
                  <DetailList
                    rows={[
                      { label: 'Employee ID', value: e.employee_number },
                      { label: 'Status', value: e.status },
                      { label: 'Employment type', value: e.employment_type },
                      { label: 'Department', value: e.department },
                      { label: 'Designation', value: e.designation },
                      { label: 'Reporting manager', value: e.manager },
                      { label: 'In this role since', value: e.assignment_since },
                      { label: 'Joined on', value: e.joined_on },
                      { label: 'Confirmed on', value: e.confirmed_on },
                      {
                        label: 'Probation ends',
                        value: p.probation_end_on,
                        hint: p.probation_end_on ? undefined : 'not configured',
                      },
                      ...(p.resigned_on
                        ? [
                            { label: 'Resignation date', value: p.resigned_on },
                            { label: 'Last working day', value: p.last_working_day },
                            { label: 'Notice days', value: p.notice_days },
                          ]
                        : []),
                      ...(p.exited_on
                        ? [
                            { label: 'Left on', value: p.exited_on },
                            { label: 'Exit type', value: p.exit_type },
                          ]
                        : []),
                    ]}
                  />
                </Card>

                {/* Personal --------------------------------------------------------- */}
                <Card>
                  <CardHead
                    title="Personal details"
                    hint="Visible only to you. Contact HR to correct anything here."
                  />
                  <DetailList
                    rows={[
                      { label: 'Date of birth', value: p.date_of_birth },
                      { label: 'Gender', value: p.gender },
                      { label: 'Personal phone', value: p.personal_phone },
                      { label: 'Personal email', value: p.personal_email },
                      { label: 'Blood group', value: p.blood_group },
                      {
                        label: 'Address',
                        value: [p.address_line1, p.address_line2, p.city, p.state_region, p.postal_code]
                          .filter(Boolean).join(', ') || null,
                      },
                      { label: 'Emergency contact', value: p.emergency_contact_name },
                      { label: 'Emergency phone', value: p.emergency_contact_phone },
                      { label: 'Relationship', value: p.emergency_contact_relation },
                    ]}
                  />
                  <p className="border-t border-ink-100 px-4 py-3 text-[12.5px] text-ink-500 sm:px-5">
                    Self-service editing is not built yet — the write path needs the audit trail
                    that every change to employee data is required to leave.
                  </p>
                </Card>
              </div>

              {/* Lifecycle ---------------------------------------------------------- */}
              <Card>
                <CardHead
                  title="Employment history"
                  hint="Every recorded change, newest first. This log is append-only — entries are never edited or removed."
                />
                {d.lifecycle.length === 0 ? (
                  <Empty title="No lifecycle events recorded" />
                ) : (
                  <ol className="divide-y divide-ink-100">
                    {d.lifecycle.map((ev, i) => (
                      <li key={`${ev.event_type}-${ev.effective_on}-${i}`} className="flex gap-3 px-4 py-3 sm:px-5">
                        <div className="mt-1 flex flex-col items-center" aria-hidden>
                          <span className="h-2 w-2 shrink-0 rounded-full bg-brand-500" />
                          {i < d.lifecycle.length - 1 && <span className="mt-1 w-px flex-1 bg-ink-200" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[13.5px] font-medium text-ink-900">
                              {EVENT_LABEL[ev.event_type] ?? show(ev.event_type)}
                            </span>
                            {ev.from_status !== ev.to_status && (
                              <span className="text-[12px] text-ink-500">
                                {show(ev.from_status)} → {show(ev.to_status)}
                              </span>
                            )}
                          </div>
                          <p className="mt-0.5 text-[12.5px] text-ink-500">
                            {fmtDate(ev.effective_on)}
                            {ev.reason ? ` · ${ev.reason}` : ''}
                            {ev.last_working_day ? ` · last working day ${fmtDate(ev.last_working_day)}` : ''}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </Card>

              <div className="grid gap-5 lg:grid-cols-2">
                {id && <MyDocuments employeeId={id} isHr={isHr} />}

              {/* Assignment history ---------------------------------------------- */}
                <Card>
                  <CardHead
                    title="Assignment history"
                    hint="Effective-dated. A transfer or promotion opens a new period rather than overwriting the old one."
                  />
                  {d.history.length === 0 ? (
                    <Empty title="No assignment periods" />
                  ) : (
                    <ul className="divide-y divide-ink-100">
                      {d.history.map((h) => (
                        <li key={h.valid_from} className="px-4 py-3 sm:px-5">
                          <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <span className="text-[13.5px] font-medium text-ink-900">
                              {h.designation ?? '—'}
                            </span>
                            <span className="text-[12.5px] text-ink-500">
                              {fmtDate(h.valid_from)} — {h.valid_to ? fmtDate(h.valid_to) : 'present'}
                            </span>
                          </div>
                          <p className="mt-0.5 text-[12.5px] text-ink-500">
                            {h.department ?? '—'}
                            {h.manager ? ` · reporting to ${h.manager}` : ''}
                            {h.reason ? ` · ${h.reason}` : ''}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>

                {/* Leave + projects ------------------------------------------------- */}
                <div className="space-y-5">
                  <Card>
                    <CardHead title="Leave balance" hint="Derived from the ledger, never edited directly" />
                    <div className="grid grid-cols-2 gap-3 px-4 py-4 sm:grid-cols-3 sm:px-5">
                      {d.balances.map((b) => (
                        <Stat key={b.code} label={b.code} value={b.available} sub={`${b.taken} taken`} />
                      ))}
                    </div>
                  </Card>

                  <Card>
                    <CardHead title="My projects" />
                    {d.projects.length === 0 ? (
                      <Empty title="Not assigned to a project" />
                    ) : (
                      <ul className="divide-y divide-ink-100">
                        {d.projects.map((pr) => (
                          <li key={pr.code} className="flex items-center justify-between gap-3 px-4 py-2.5 sm:px-5">
                            <span className="text-[13.5px] text-ink-900">{pr.name}</span>
                            <Badge>{pr.role.replace(/_/g, ' ')}</Badge>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>
                </div>
              </div>
            </>
          );
        }}
      </Async>
    </div>
  );
}
