'use client';

import { useEffect, useState } from 'react';
import { api, ApiError, fmtDate, hasRole, useData, type Actor } from '@/lib/api';
import { Async, Badge, Button, Card, CardHead, Empty, Field, Skeleton, Toast, inputCls } from '@/components/ui';

type PolicyKind = 'attendance' | 'employment';

interface Settings {
  businessDate: string;
  attendance: Record<string, any> | null;
  employment: Record<string, any> | null;
  settings: { key: string; value: any; value_type: string; category: string; label: string; description: string | null; updated_at: string }[];
  leave: Record<string, any>[];
  badgedCount: number;
}
interface History {
  kind: string;
  versions: Record<string, any>[];
}
interface Impact {
  from: string; businessDate: string; backdated: boolean;
  attendanceDays: number; employees: number;
  lockedPeriodDays: number; payrollLockingImplemented: boolean; reasonRequired: boolean;
}

/** Field metadata: how to label, render and edit each policy value. */
const ATT_FIELDS = [
  { key: 'grace_period_minutes',  label: 'Grace period',        unit: 'min', note: 'Late if the first punch is after start + grace' },
  { key: 'half_day_min_minutes',  label: 'Half-day threshold',  unit: 'min', note: 'Below this and above zero counts as a half day' },
  { key: 'full_day_min_minutes',  label: 'Full-day threshold',  unit: 'min', note: 'Must stay reachable within the shift after the grace period' },
  { key: 'standard_day_minutes',  label: 'Standard day',        unit: 'min', note: 'Nominal day. Also the comp-off proof requirement' },
  { key: 'ot_enabled',            label: 'Overtime enabled',    unit: 'bool', note: 'Captured but unpaid until an overtime policy exists' },
  { key: 'ot_min_minutes',        label: 'Overtime minimum',    unit: 'min', note: 'Minimum extra time before overtime is recorded' },
] as const;

const EMP_FIELDS = [
  { key: 'notice_period_days',       label: 'Notice period',            unit: 'days', note: '' },
  { key: 'probation_months',         label: 'Probation length',         unit: 'months', note: 'Not set means unknown, never zero. Any calculation depending on it refuses rather than assuming' },
  { key: 'cl_blocked_in_notice',     label: 'CL blocked during notice', unit: 'bool', note: '' },
  { key: 'sl_extends_notice',        label: 'SL extends notice',        unit: 'bool', note: '' },
  { key: 'salary_disbursement_day',  label: 'Salary disbursement day',  unit: 'day-of-month', note: 'Capped at 28 so the date exists in February' },
] as const;

const fmtVal = (v: any, unit: string) => {
  if (v === null || v === undefined) return 'Not set';
  if (unit === 'bool') return v ? 'Yes' : 'No';
  if (unit === 'min') {
    const m = Number(v);
    return m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? String(m % 60).padStart(2, '0') : ''} (${m} min)` : `${m} min`;
  }
  return `${v} ${unit === 'days' ? 'days' : unit === 'months' ? 'months' : ''}`.trim();
};

export default function SettingsPage() {
  const me = useData<{ actor: Actor }>('/auth/me');
  const state = useData<Settings>('/settings');
  const [tab, setTab] = useState<'policy' | 'settings'>('policy');
  const [toast, setToast] = useState<{ msg: string; tone: 'good' | 'bad' } | null>(null);

  /*
   * `hr_admin` writes; `hr_ops` and `auditor` read. A manager or an employee reaches nothing at
   * all - `settings.ts` returns 403 through AuthorizationService - so the read-only banner is
   * now about the roles that CAN read but not change, rather than about a manager who should
   * never have got here.
   */
  const canEdit = hasRole(me.data?.actor, 'hr_admin');
  const canRead = hasRole(me.data?.actor, 'hr_admin', 'hr_ops', 'auditor');

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[21px] font-semibold text-ink-900">Company settings</h1>
        <p className="mt-0.5 max-w-3xl text-[13.5px] text-ink-500">
          A policy change is a bulk data operation wearing a form. Changing a threshold does not
          just update a row — it changes how every attendance day is classified. So policy has no
          Save button; it has <strong className="font-semibold text-ink-700">change with effect from</strong>.
        </p>
      </div>

      {!canRead && me.data && (
        <div role="status" className="rounded-lg bg-amber-50 px-3.5 py-2.5 text-[13px] text-amber-900 ring-1 ring-inset ring-amber-200">
          Company settings are restricted to HR. A policy row decides how every past attendance
          day is classified, so reading one is a privilege rather than a default
          (<span className="font-medium">ADR-0005</span>).
        </div>
      )}

      {canRead && !canEdit && me.data && (
        <div role="status" className="rounded-lg bg-ink-100 px-3.5 py-2.5 text-[13px] text-ink-700">
          You are signed in as <strong className="font-semibold">{(me.data.actor.roles ?? []).join(', ').replace(/_/g, ' ')}</strong>.
          Settings are read-only — only HR admin can change policy.
        </div>
      )}

      <Async state={state} rows={6}>
        {(d) => (
          <>
            {d.badgedCount > 0 && (
              <Card className="border-amber-200 bg-amber-50">
                <div className="flex flex-wrap items-start gap-3 p-4 sm:p-5">
                  <span aria-hidden className="mt-0.5 text-[15px]">⚠</span>
                  <div>
                    <p className="text-[13.5px] font-semibold text-amber-900">
                      {d.badgedCount} values are engineering defaults, not HR decisions
                    </p>
                    <p className="mt-1 max-w-2xl text-[13px] text-amber-800">
                      Making a value configurable does not make it correct — it moves the risk from
                      “the developer guessed” to “nobody looked, and the default became policy”,
                      which is worse because it looks settled. Badged values are marked{' '}
                      <Badge className="align-middle">unconfirmed</Badge> below, and any report built
                      on one must say so. Changing a badged value here removes its badge.
                    </p>
                  </div>
                </div>
              </Card>
            )}

            {/* Two tabs, because there are two classes of configuration (ADR-0019). */}
            <div role="tablist" aria-label="Settings sections" className="flex gap-1 border-b border-ink-200">
              {([['policy', 'Policy — effective-dated'], ['settings', 'Settings — mutable']] as const).map(([id, label]) => (
                <button
                  key={id}
                  role="tab"
                  id={`tab-${id}`}
                  aria-selected={tab === id}
                  aria-controls={`panel-${id}`}
                  onClick={() => setTab(id)}
                  className={`-mb-px border-b-2 px-3 py-2 text-[13.5px] font-medium transition-colors ${
                    tab === id
                      ? 'border-brand-600 text-brand-700'
                      : 'border-transparent text-ink-500 hover:text-ink-800'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {tab === 'policy' ? (
              <div role="tabpanel" id="panel-policy" aria-labelledby="tab-policy" className="space-y-5">
                <PolicyCard
                  kind="attendance" title="Attendance policy"
                  hint="Governs how every attendance day is classified. Resolved as of the date being computed, never 'current'."
                  fields={ATT_FIELDS} current={d.attendance} businessDate={d.businessDate}
                  canEdit={canEdit} onChanged={(m) => { setToast({ msg: m, tone: 'good' }); void state.reload(); }}
                  onError={(m) => setToast({ msg: m, tone: 'bad' })}
                />
                <PolicyCard
                  kind="employment" title="Employment policy"
                  hint="Notice periods, probation and the salary disbursement day."
                  fields={EMP_FIELDS} current={d.employment} businessDate={d.businessDate}
                  canEdit={canEdit} onChanged={(m) => { setToast({ msg: m, tone: 'good' }); void state.reload(); }}
                  onError={(m) => setToast({ msg: m, tone: 'bad' })}
                />
                <LeaveCard leave={d.leave} />
              </div>
            ) : (
              <div role="tabpanel" id="panel-settings" aria-labelledby="tab-settings">
                <MutableSettings
                  rows={d.settings} canEdit={canEdit}
                  onSaved={(m) => { setToast({ msg: m, tone: 'good' }); void state.reload(); }}
                  onError={(m) => setToast({ msg: m, tone: 'bad' })}
                />
              </div>
            )}
          </>
        )}
      </Async>

      {toast && <Toast message={toast.msg} tone={toast.tone} onDone={() => setToast(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function PolicyCard({ kind, title, hint, fields, current, businessDate, canEdit, onChanged, onError }: {
  kind: PolicyKind; title: string; hint: string;
  fields: readonly { key: string; label: string; unit: string; note: string }[];
  current: Record<string, any> | null; businessDate: string; canEdit: boolean;
  onChanged: (msg: string) => void; onError: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const badged: string[] = current?.unconfirmed_fields ?? [];

  if (!current) {
    return (
      <Card>
        <CardHead title={title} />
        <Empty title="No policy is in force today" hint="The policy epoch starts 2020-01-01." />
      </Card>
    );
  }

  return (
    <Card>
      <CardHead
        title={title}
        hint={hint}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <span className="num text-[12.5px] text-ink-500">
              in force since {fmtDate(current.valid_from)}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setShowHistory((s) => !s)} aria-expanded={showHistory}>
              {showHistory ? 'Hide history' : 'History'}
            </Button>
            {canEdit && (
              <Button size="sm" onClick={() => setEditing((e) => !e)} aria-expanded={editing}>
                {editing ? 'Cancel' : 'Change with effect from…'}
              </Button>
            )}
          </div>
        }
      />

      <dl className="divide-y divide-ink-100">
        {fields.map((f) => (
          <div key={f.key} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 py-2.5 sm:px-5">
            <div className="min-w-0">
              <dt className="flex flex-wrap items-center gap-2 text-[13.5px] font-medium text-ink-800">
                {f.label}
                {badged.includes(f.key) && <Badge status="pending">unconfirmed</Badge>}
              </dt>
              {f.note && <p className="mt-0.5 max-w-xl text-[12.5px] text-ink-500">{f.note}</p>}
            </div>
            <dd className={`num shrink-0 text-[13.5px] ${current[f.key] === null ? 'text-amber-800' : 'text-ink-900'}`}>
              {fmtVal(current[f.key], f.unit)}
            </dd>
          </div>
        ))}
      </dl>

      {editing && (
        <ChangeForm
          kind={kind} fields={fields} current={current} businessDate={businessDate}
          onDone={(msg) => { setEditing(false); onChanged(msg); }}
          onError={onError}
        />
      )}

      {showHistory && <PolicyHistory kind={kind} fields={fields} />}
    </Card>
  );
}

// ---------------------------------------------------------------------------

function ChangeForm({ kind, fields, current, businessDate, onDone, onError }: {
  kind: PolicyKind;
  fields: readonly { key: string; label: string; unit: string; note: string }[];
  current: Record<string, any>; businessDate: string;
  onDone: (msg: string) => void; onError: (msg: string) => void;
}) {
  const firstOfNextMonth = (() => {
    const [y, m] = businessDate.split('-').map(Number);
    return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  })();

  const [effectiveFrom, setEffectiveFrom] = useState(firstOfNextMonth);
  const [reason, setReason] = useState('');
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [impact, setImpact] = useState<Impact | null>(null);

  // Blast radius, refreshed as the effective date changes. Requirement 2: HR cannot tell a
  // harmless change from a payroll incident without being told what it touches.
  useEffect(() => {
    if (!effectiveFrom) { setImpact(null); return; }
    let cancelled = false;
    api.get<Impact>(`/settings/policy/${kind}/impact?from=${effectiveFrom}`)
      .then((i) => { if (!cancelled) setImpact(i); })
      .catch(() => { if (!cancelled) setImpact(null); });
    return () => { cancelled = true; };
  }, [kind, effectiveFrom]);

  const changed = Object.keys(draft).filter((k) => String(draft[k]) !== String(current[k] ?? ''));
  const backdated = !!impact?.backdated;
  const reasonMissing = backdated && !reason.trim();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const values: Record<string, any> = {};
      for (const k of changed) {
        const meta = fields.find((f) => f.key === k)!;
        values[k] = meta.unit === 'bool' ? Boolean(draft[k])
          : draft[k] === '' ? null : Number(draft[k]);
      }
      const res = await api.post<{ effectiveFrom: string; changed: string[]; confirmed: string[] }>(
        `/settings/policy/${kind}`, { effectiveFrom, reason: reason || null, values });
      onDone(
        `Policy changes take effect ${fmtDate(res.effectiveFrom)}` +
        (res.confirmed.length ? ` · ${res.confirmed.length} badge${res.confirmed.length === 1 ? '' : 's'} cleared` : ''),
      );
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not apply the change';
      setError(msg);
      onError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="border-t border-ink-200 bg-ink-50 p-4 sm:p-5" noValidate>
      <p className="text-[13.5px] font-semibold text-ink-900">Change with effect from</p>
      <p className="mt-0.5 text-[13px] text-ink-500">
        This closes the period in force and creates a successor. The existing period is never
        edited, so past dates keep resolving to the values that were true then.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Effective from" htmlFor={`${kind}-eff`}
               hint="Future dates are the normal case — HR usually knows a change is coming.">
          <input id={`${kind}-eff`} type="date" required className={inputCls}
                 value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
        </Field>
        <Field label={`Reason${backdated ? ' (required — back-dated)' : ' (optional)'}`}
               htmlFor={`${kind}-reason`}
               error={reasonMissing ? 'A back-dated change must say why' : undefined}>
          <input id={`${kind}-reason`} type="text" className={inputCls} value={reason}
                 onChange={(e) => setReason(e.target.value)}
                 placeholder="e.g. HR confirmed the threshold" />
        </Field>
      </div>

      <fieldset className="mt-4">
        <legend className="text-[13px] font-medium text-ink-700">New values</legend>
        <p className="mt-0.5 text-[12.5px] text-ink-500">
          Leave a field alone to carry it forward unchanged.
        </p>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {fields.map((f) => {
            const id = `${kind}-${f.key}`;
            const cur = current[f.key];
            const val = draft[f.key] ?? (cur === null ? '' : cur);
            return (
              <div key={f.key}>
                <label htmlFor={id} className="block text-[12.5px] text-ink-600">
                  {f.label} <span className="num text-ink-400">now {fmtVal(cur, f.unit)}</span>
                </label>
                {f.unit === 'bool' ? (
                  <select id={id} className={inputCls} value={String(Boolean(val))}
                          onChange={(e) => setDraft((s) => ({ ...s, [f.key]: e.target.value === 'true' }))}>
                    <option value="false">No</option>
                    <option value="true">Yes</option>
                  </select>
                ) : (
                  <input id={id} type="number" className={`${inputCls} num`} value={val}
                         onChange={(e) => setDraft((s) => ({ ...s, [f.key]: e.target.value }))} />
                )}
              </div>
            );
          })}
        </div>
      </fieldset>

      {/* Blast radius */}
      {impact && (
        <div className={`mt-4 rounded-lg p-3.5 text-[13px] ring-1 ring-inset ${
          backdated ? 'bg-amber-50 text-amber-900 ring-amber-200' : 'bg-white text-ink-700 ring-ink-200'
        }`} aria-live="polite">
          <p className="font-semibold">
            {backdated ? 'This is a back-dated change' : 'Forward-dated change'}
          </p>
          <p className="mt-1">
            Effective {fmtDate(impact.from)}. It affects{' '}
            <strong className="num font-semibold">{impact.attendanceDays}</strong> attendance day
            {impact.attendanceDays === 1 ? '' : 's'} across{' '}
            <strong className="num font-semibold">{impact.employees}</strong> employee
            {impact.employees === 1 ? '' : 's'}.
            {backdated
              ? ' Those days have already been computed and reported on, so they would be recomputed.'
              : ' No already-computed day is touched.'}
          </p>
          {!impact.payrollLockingImplemented && (
            <p className="mt-1 text-[12.5px] opacity-80">
              Payroll period locking is not built yet, so no locked-period adjustment count can be
              shown. Once it is, a back-dated change intersecting a paid period will emit
              adjustments rather than altering it.
            </p>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-[13px] text-rose-800 ring-1 ring-inset ring-rose-200">
          {error}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button type="submit" busy={busy} disabled={changed.length === 0 || reasonMissing}>
          {changed.length === 0 ? 'Change a value to continue' : `Apply ${changed.length} change${changed.length === 1 ? '' : 's'}`}
        </Button>
        <span className="text-[12.5px] text-ink-500">
          The database rejects an invalid combination even if this form lets it through.
        </span>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------

function PolicyHistory({ kind, fields }: {
  kind: PolicyKind;
  fields: readonly { key: string; label: string; unit: string; note: string }[];
}) {
  const state = useData<History>(`/settings/policy/${kind}/history`);

  return (
    <div className="border-t border-ink-200 bg-ink-50">
      <div className="px-4 pt-4 sm:px-5">
        <p className="text-[13.5px] font-semibold text-ink-900">Version history</p>
        <p className="mt-0.5 max-w-2xl text-[13px] text-ink-500">
          This is what answers “why was I marked half-day in March” — the March version is still
          here, unchanged.
        </p>
      </div>
      <Async state={state} rows={3} isEmpty={(h) => h.versions.length === 0}
             empty={<Empty title="No history yet" />}>
        {(h) => (
          <div className="overflow-x-auto p-4 sm:p-5">
            <table className="w-full min-w-[42rem] text-left text-[13px]">
              <thead className="text-[12px] uppercase tracking-wide text-ink-400">
                <tr>
                  <th scope="col" className="py-2 pr-3 font-medium">Effective</th>
                  {fields.map((f) => (
                    <th key={f.key} scope="col" className="py-2 pr-3 font-medium">{f.label}</th>
                  ))}
                  <th scope="col" className="py-2 pr-3 font-medium">Changed by</th>
                  <th scope="col" className="py-2 font-medium">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-200">
                {h.versions.map((v) => (
                  <tr key={v.id} className={v.valid_to === null ? 'bg-white' : ''}>
                    <td className="num whitespace-nowrap py-2 pr-3 text-ink-800">
                      {fmtDate(v.valid_from)} → {v.valid_to ? fmtDate(v.valid_to) : 'open'}
                      {v.valid_to === null && <Badge status="present" className="ml-2">current</Badge>}
                    </td>
                    {fields.map((f) => (
                      <td key={f.key} className="num py-2 pr-3 text-ink-700">
                        {fmtVal(v[f.key], f.unit)}
                      </td>
                    ))}
                    <td className="py-2 pr-3 text-ink-600">{v.created_by_name ?? 'system seed'}</td>
                    <td className="py-2 text-ink-600">{v.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Async>
    </div>
  );
}

// ---------------------------------------------------------------------------

function LeaveCard({ leave }: { leave: Record<string, any>[] }) {
  return (
    <Card>
      <CardHead
        title="Leave policy"
        hint="Read-only here. Leave types are a collection with their own admin screen, not a scalar setting."
      />
      {leave.length === 0 ? (
        <Empty title="No leave policy in force" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[46rem] text-left text-[13px]">
            <thead className="border-b border-ink-100 text-[12px] uppercase tracking-wide text-ink-400">
              <tr>
                <th scope="col" className="px-5 py-2.5 font-medium">Type</th>
                <th scope="col" className="px-3 py-2.5 font-medium">Per year</th>
                <th scope="col" className="px-3 py-2.5 font-medium">On probation</th>
                <th scope="col" className="px-3 py-2.5 font-medium">Usage cap</th>
                <th scope="col" className="px-3 py-2.5 font-medium">Carry-forward</th>
                <th scope="col" className="px-3 py-2.5 font-medium">Sandwich</th>
                <th scope="col" className="px-5 py-2.5 font-medium">Unconfirmed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {leave.map((l) => (
                <tr key={l.code}>
                  <td className="px-5 py-2.5">
                    <span className="font-medium text-ink-900">{l.code}</span>
                    <span className="text-ink-500"> {l.name}</span>
                  </td>
                  <td className="num px-3 py-2.5 text-ink-700">{Number(l.entitlement_days_confirmed)}</td>
                  <td className="num px-3 py-2.5 text-ink-700">{Number(l.entitlement_days_probation)}</td>
                  <td className="num px-3 py-2.5 text-ink-700">
                    {l.period_cap_days
                      ? `${Number(l.period_cap_days)} per ${l.period_cap_months} mo (${l.period_cap_enforcement})`
                      : '—'}
                  </td>
                  <td className="num px-3 py-2.5 text-ink-700">
                    {l.carry_forward_enabled ? `${Number(l.carry_forward_max_days)} days` : 'No'}
                  </td>
                  <td className="px-3 py-2.5 text-ink-700">{l.sandwich_rule}</td>
                  <td className="px-5 py-2.5">
                    {(l.unconfirmed_fields ?? []).length === 0
                      ? <span className="text-ink-400">—</span>
                      : <span className="flex flex-wrap gap-1">
                          {(l.unconfirmed_fields as string[]).map((f) => (
                            <Badge key={f} status="pending">{f.replace(/_/g, ' ')}</Badge>
                          ))}
                        </span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------

function MutableSettings({ rows, canEdit, onSaved, onError }: {
  rows: Settings['settings']; canEdit: boolean;
  onSaved: (msg: string) => void; onError: (msg: string) => void;
}) {
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const groups = [...new Set(rows.map((r) => r.category))];

  async function save(key: string, valueType: string) {
    setBusyKey(key);
    try {
      const raw = draft[key];
      await api.patch(`/settings/${encodeURIComponent(key)}`, {
        value: valueType === 'boolean' ? Boolean(raw) : raw,
      });
      setDraft((s) => { const n = { ...s }; delete n[key]; return n; });
      onSaved('Setting saved');
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not save');
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHead
          title="Mutable settings"
          hint="Nothing computes history from these, so a plain edit is correct. Changes are audited but not versioned."
        />
        {groups.map((g) => (
          <div key={g}>
            <p className="border-b border-ink-100 bg-ink-50 px-4 py-1.5 text-[12px] font-semibold uppercase tracking-wide text-ink-500 sm:px-5">
              {g}
            </p>
            <dl className="divide-y divide-ink-100">
              {rows.filter((r) => r.category === g).map((r) => {
                const dirty = Object.prototype.hasOwnProperty.call(draft, r.key);
                const shown = dirty ? draft[r.key] : r.value;
                const id = `set-${r.key}`;
                return (
                  <div key={r.key} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
                    <div className="min-w-0 flex-1">
                      <dt>
                        <label htmlFor={id} className="text-[13.5px] font-medium text-ink-800">{r.label}</label>
                      </dt>
                      <p className="num mt-0.5 text-[12px] text-ink-400">{r.key}</p>
                      {r.description && <p className="mt-0.5 max-w-xl text-[12.5px] text-ink-500">{r.description}</p>}
                    </div>
                    <dd className="flex shrink-0 items-center gap-2">
                      {r.value_type === 'boolean' ? (
                        <select id={id} className={`${inputCls} !mt-0 w-24`} disabled={!canEdit}
                                value={String(Boolean(shown))}
                                onChange={(e) => setDraft((s) => ({ ...s, [r.key]: e.target.value === 'true' }))}>
                          <option value="false">No</option>
                          <option value="true">Yes</option>
                        </select>
                      ) : (
                        <input id={id} type="text" className={`${inputCls} !mt-0 w-56`} disabled={!canEdit}
                               value={String(shown ?? '')}
                               onChange={(e) => setDraft((s) => ({ ...s, [r.key]: e.target.value }))} />
                      )}
                      {canEdit && dirty && (
                        <Button size="sm" busy={busyKey === r.key} onClick={() => save(r.key, r.value_type)}>
                          Save
                        </Button>
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>
        ))}
      </Card>

      <p className="text-[12.5px] text-ink-500">
        <strong className="font-semibold text-ink-700">Note:</strong> the business timezone sits here
        as a mutable setting, but changing it re-attributes punches — so it arguably belongs in the
        effective-dated class. That reclassification is a recorded open item, not an oversight.
      </p>
    </div>
  );
}
