'use client';

import { useState } from 'react';
import { ApiError, api, useData } from '@/lib/api';
import { Button, Card, CardHead, ErrorBox, Field, Toast, inputCls } from '@/components/ui';

/**
 * Creating an employee, and moving one.
 *
 * A NEW EMPLOYEE IS THREE FACTS, and the form asks for all three because two of them cannot be
 * reconstructed later: who they are, what their job is from their joining date, and that they
 * JOINED. The last one is the lifecycle event, and it is the reason the API refuses to create a
 * person without a department and designation - somebody who exists with no job and no history is
 * not a record of anything.
 *
 * MOVING SOMEBODY IS NOT AN EDIT. Transfer, promotion and a change of line manager are one act -
 * close the assignment in force, open the next - so the form asks for a DATE and a REASON, and
 * says why. Presenting it as "edit department" would make a transfer look like a typo correction
 * and would quietly destroy the history that every as-of report depends on.
 *
 * Nobody can move THEMSELVES, and that is not enforced here: `people.assignment.change` carries
 * `isSelf` as a deny-override in `packages/authz`. This component does not know the rule; it just
 * reports the refusal.
 */

interface Option { id: string; code: string; name: string; retired?: boolean }

const err = (e: unknown) => (e instanceof ApiError ? e.message : 'That could not be saved.');

function useOptions() {
  const depts = useData<{ rows: Option[] }>('/org/departments');
  const desigs = useData<{ rows: Option[] }>('/org/designations');
  return {
    departments: depts.data?.rows ?? [],
    // A retired title must not be offered for a NEW assignment - the database refuses it
    // (DEC-044), and offering it anyway would just produce an error somebody has to decode.
    designations: (desigs.data?.rows ?? []).filter((d) => !d.retired),
    loading: depts.loading || desigs.loading,
  };
}

// ---------------------------------------------------------------------------

export function AddEmployee({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { departments, designations, loading } = useOptions();
  // The directory returns `employees`, not `rows` - checked rather than assumed, after a payslip
  // test failed on exactly that kind of guess.
  const people = useData<{ employees: { id: string; employee_number: string; full_name: string }[] }>(
    '/employees');
  const [f, setF] = useState({
    employeeNumber: '', fullName: '', workEmail: '', joinedOn: '',
    departmentId: '', designationId: '', managerId: '', workLocation: 'Kochi',
    employmentType: 'permanent',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const ready = f.employeeNumber.trim() && f.fullName.trim() && f.workEmail.trim()
    && f.joinedOn && f.departmentId && f.designationId;

  async function save() {
    setBusy(true); setError(null);
    try {
      await api.post('/people/employees', {
        ...f,
        managerId: f.managerId || null,
      });
      setToast(`${f.fullName} added.`);
      onDone();
    } catch (e) { setError(err(e)); } finally { setBusy(false); }
  }

  return (
    <Card>
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
      <CardHead
        title="Add an employee"
        hint="The joining date sets when their assignment begins. A future date leaves them pre-boarding until it arrives."
        action={<Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>}
      />

      {error && <div className="mb-3"><ErrorBox message={error} /></div>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Employee number" htmlFor="e-num">
          <input id="e-num" value={f.employeeNumber} placeholder="EMP006"
            onChange={(e) => setF({ ...f, employeeNumber: e.target.value.toUpperCase() })}
            className={`${inputCls} num`} />
        </Field>
        <Field label="Full name" htmlFor="e-name">
          <input id="e-name" value={f.fullName} placeholder="Meera Nair"
            onChange={(e) => setF({ ...f, fullName: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Work email" htmlFor="e-mail">
          <input id="e-mail" type="email" value={f.workEmail} placeholder="meera.nair@panasatech.com"
            onChange={(e) => setF({ ...f, workEmail: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Joining date" hint="may be in the past or the future" htmlFor="e-joined">
          <input id="e-joined" type="date" value={f.joinedOn}
            onChange={(e) => setF({ ...f, joinedOn: e.target.value })}
            className={`${inputCls} num`} />
        </Field>
        <Field label="Department" htmlFor="e-dept">
          <select id="e-dept" value={f.departmentId} disabled={loading}
            onChange={(e) => setF({ ...f, departmentId: e.target.value })} className={inputCls}>
            <option value="">— choose —</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.code} · {d.name}</option>)}
          </select>
        </Field>
        <Field label="Designation" htmlFor="e-desig">
          <select id="e-desig" value={f.designationId} disabled={loading}
            onChange={(e) => setF({ ...f, designationId: e.target.value })} className={inputCls}>
            <option value="">— choose —</option>
            {designations.map((d) => <option key={d.id} value={d.id}>{d.code} · {d.name}</option>)}
          </select>
        </Field>
        <Field label="Line manager" hint="optional" htmlFor="e-mgr">
          <select id="e-mgr" value={f.managerId}
            onChange={(e) => setF({ ...f, managerId: e.target.value })} className={inputCls}>
            <option value="">— none —</option>
            {(people.data?.employees ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.full_name} ({p.employee_number})</option>
            ))}
          </select>
        </Field>
        <Field label="Work location" htmlFor="e-loc">
          <input id="e-loc" value={f.workLocation}
            onChange={(e) => setF({ ...f, workLocation: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Employment type" htmlFor="e-type">
          <select id="e-type" value={f.employmentType}
            onChange={(e) => setF({ ...f, employmentType: e.target.value })} className={inputCls}>
            <option value="permanent">permanent</option>
            <option value="contract">contract</option>
            <option value="intern">intern</option>
          </select>
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button busy={busy} onClick={save} disabled={!ready}>Add employee</Button>
        {!ready && (
          <span className="text-[12.5px] text-ink-500">
            A department and designation are required — an employee with no assignment has no
            history to report on.
          </span>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

export function ChangeAssignment({ employeeId, employeeName, current, onDone, onCancel }: {
  employeeId: string;
  employeeName: string;
  current: { department?: string | null; designation?: string | null; manager?: string | null };
  onDone: () => void;
  onCancel: () => void;
}) {
  const { departments, designations, loading } = useOptions();
  // The directory returns `employees`, not `rows` - checked rather than assumed, after a payslip
  // test failed on exactly that kind of guess.
  const people = useData<{ employees: { id: string; employee_number: string; full_name: string }[] }>(
    '/employees');
  const [f, setF] = useState({
    departmentId: '', designationId: '', managerId: '', effectiveFrom: '', reason: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true); setError(null);
    try {
      await api.post(`/people/employees/${employeeId}/assignment`, {
        departmentId: f.departmentId || undefined,
        designationId: f.designationId || undefined,
        managerId: f.managerId || undefined,
        effectiveFrom: f.effectiveFrom,
        reason: f.reason,
      });
      onDone();
    } catch (e) { setError(err(e)); } finally { setBusy(false); }
  }

  return (
    <Card>
      <CardHead
        title="Change assignment"
        hint="Transfer, promotion or a new line manager — all the same record, with a date."
        action={<Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>}
      />

      {error && <div className="mb-3"><ErrorBox message={error} /></div>}

      <p className="mb-3 text-[13px] text-ink-600">
        {employeeName} is currently{' '}
        <span className="font-medium text-ink-900">{current.designation ?? 'unassigned'}</span>
        {current.department && <> in <span className="font-medium text-ink-900">{current.department}</span></>}
        {current.manager && <>, reporting to <span className="font-medium text-ink-900">{current.manager}</span></>}.
        {' '}Leave a field blank to keep it as it is.
      </p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="New department" htmlFor="a-dept">
          <select id="a-dept" value={f.departmentId} disabled={loading}
            onChange={(e) => setF({ ...f, departmentId: e.target.value })} className={inputCls}>
            <option value="">— unchanged —</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.code} · {d.name}</option>)}
          </select>
        </Field>
        <Field label="New designation" htmlFor="a-desig">
          <select id="a-desig" value={f.designationId} disabled={loading}
            onChange={(e) => setF({ ...f, designationId: e.target.value })} className={inputCls}>
            <option value="">— unchanged —</option>
            {designations.map((d) => <option key={d.id} value={d.id}>{d.code} · {d.name}</option>)}
          </select>
        </Field>
        <Field label="New line manager" htmlFor="a-mgr">
          <select id="a-mgr" value={f.managerId}
            onChange={(e) => setF({ ...f, managerId: e.target.value })} className={inputCls}>
            <option value="">— unchanged —</option>
            {(people.data?.employees ?? []).filter((p) => p.id !== employeeId).map((p) => (
              <option key={p.id} value={p.id}>{p.full_name} ({p.employee_number})</option>
            ))}
          </select>
        </Field>
        <Field label="Effective from" hint="the day the change takes effect" htmlFor="a-from">
          <input id="a-from" type="date" value={f.effectiveFrom}
            onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })}
            className={`${inputCls} num`} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Reason" hint="required — it is what explains the move a year from now"
            htmlFor="a-reason">
            <input id="a-reason" value={f.reason} placeholder="Promoted to Senior Engineer"
              onChange={(e) => setF({ ...f, reason: e.target.value })} className={inputCls} />
          </Field>
        </div>
      </div>

      {/*
        * Said plainly, because it is the part people find surprising: the old assignment is not
        * replaced. It is closed on the effective date and stays in the history, which is what
        * makes last quarter's report keep resolving to last quarter's department.
        */}
      <p className="mt-3 rounded-lg bg-ink-50 px-3.5 py-2.5 text-[12.5px] text-ink-600">
        The current assignment is not overwritten. It is closed on the effective date and stays in
        this employee&apos;s history, so reports covering earlier periods keep showing the old
        department and designation.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button busy={busy} onClick={save}
          disabled={!f.effectiveFrom || f.reason.trim().length < 3
            || (!f.departmentId && !f.designationId && !f.managerId)}>
          Record the change
        </Button>
        {(!f.departmentId && !f.designationId && !f.managerId) && (
          <span className="text-[12.5px] text-ink-500">Change at least one field.</span>
        )}
      </div>
    </Card>
  );
}
