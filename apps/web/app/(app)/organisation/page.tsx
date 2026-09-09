'use client';

import { useState } from 'react';
import { ApiError, api, fmtDateShort, useData } from '@/lib/api';
import {
  Async, Badge, Button, Card, CardHead, Empty, ErrorBox, Field, Toast, inputCls,
} from '@/components/ui';

/**
 * The organisation masters: departments and designations.
 *
 * THE SCREEN IS SHAPED BY THE DATA MODEL, NOT BY CRUD.
 *
 * A department has two kinds of change and they are not the same act. Renaming is an edit -
 * identity is mutable, and a department that changes its name is the same department. MOVING it is
 * a new effective-dated period, so it needs a date and a reason, and last quarter's reports keep
 * resolving to last quarter's parent. Offering one "Edit department" form for both would have made
 * a reorganisation look like a typo correction.
 *
 * A designation is RETIRED with a date rather than deleted, so the screen shows retired titles
 * instead of hiding them, and tells you how many people hold one before you retire it.
 *
 * THE AS-OF CONTROL IS THE POINT, not a nicety. The whole reason placements are effective-dated is
 * that "which department sat under which" has a different answer per date - so a scheduled
 * reorganisation is visible before it happens, which is when somebody wants to check it.
 */

interface Dept {
  id: string; code: string; name: string; description: string | null;
  parent_department_id: string | null; parent_code: string | null; parent_name: string | null;
  valid_from: string | null; valid_to: string | null; reason: string | null;
  head_name: string | null;
  direct_headcount: number; subtree_headcount: number;
  unplaced: boolean; has_future_placement: boolean;
}

interface Desig {
  id: string; code: string; name: string; grade: number; description: string | null;
  retired_on: string | null; retired: boolean; holders: number;
}

const err = (e: unknown) => (e instanceof ApiError ? e.message : 'That change could not be saved.');

export default function OrganisationPage() {
  const today = new Date().toISOString().slice(0, 10);
  const [asOf, setAsOf] = useState('');
  const [toast, setToast] = useState<{ msg: string; tone: 'good' | 'bad' } | null>(null);
  const [tick, setTick] = useState(0);

  const q = asOf ? `?asOf=${asOf}` : '';
  const depts = useData<{ asOf: string | null; rows: Dept[] }>(`/org/departments${q}`, [q, tick]);
  const desigs = useData<{ rows: Desig[] }>('/org/designations', [tick]);

  const reload = () => setTick((t) => t + 1);
  const done = (msg: string) => { setToast({ msg, tone: 'good' }); reload(); };
  const failed = (e: unknown) => setToast({ msg: err(e), tone: 'bad' });

  return (
    <div className="space-y-5">
      {toast && <Toast message={toast.msg} tone={toast.tone} onDone={() => setToast(null)} />}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[21px] font-semibold text-ink-900">Organisation</h1>
          <p className="mt-0.5 text-[13.5px] text-ink-500">
            Departments and designations. Renaming takes effect immediately; moving a department is
            recorded with a date, so past reports keep resolving to the structure of their time.
          </p>
        </div>
        <label className="flex items-center gap-2 text-[13px] text-ink-500">
          Structure as of
          <input
            type="date"
            value={asOf || today}
            onChange={(e) => setAsOf(e.target.value)}
            className={`${inputCls} num !mt-0 w-[9.5rem]`}
          />
        </label>
      </div>

      <DepartmentMaster state={depts} onDone={done} onFail={failed} today={today} />
      <DesignationMaster state={desigs} onDone={done} onFail={failed} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function DepartmentMaster({ state, onDone, onFail, today }: {
  state: ReturnType<typeof useData<{ asOf: string | null; rows: Dept[] }>>;
  onDone: (m: string) => void; onFail: (e: unknown) => void; today: string;
}) {
  const [adding, setAdding] = useState(false);
  const [moving, setMoving] = useState<Dept | null>(null);
  const [renaming, setRenaming] = useState<Dept | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ code: '', name: '', parentId: '' });
  const [move, setMove] = useState({ parentId: '', effectiveFrom: '', reason: '' });
  const [rename, setRename] = useState('');

  const rows = state.data?.rows ?? [];

  async function create() {
    setBusy(true);
    try {
      await api.post('/org/departments', {
        code: form.code, name: form.name, parentId: form.parentId || null,
      });
      setForm({ code: '', name: '', parentId: '' });
      setAdding(false);
      onDone(`Department ${form.code.toUpperCase()} created.`);
    } catch (e) { onFail(e); } finally { setBusy(false); }
  }

  async function submitMove() {
    if (!moving) return;
    setBusy(true);
    try {
      await api.post(`/org/departments/${moving.id}/reparent`, {
        parentId: move.parentId || null,
        effectiveFrom: move.effectiveFrom || undefined,
        reason: move.reason,
      });
      setMoving(null);
      setMove({ parentId: '', effectiveFrom: '', reason: '' });
      onDone('Reorganisation recorded.');
    } catch (e) { onFail(e); } finally { setBusy(false); }
  }

  async function submitRename() {
    if (!renaming) return;
    setBusy(true);
    try {
      await api.patch(`/org/departments/${renaming.id}`, { name: rename });
      setRenaming(null);
      onDone('Department renamed.');
    } catch (e) { onFail(e); } finally { setBusy(false); }
  }

  return (
    <Card>
      <CardHead
        title="Departments"
        hint={state.data?.asOf ? `Structure in force on ${fmtDateShort(state.data.asOf)}` : undefined}
        action={<Button size="sm" onClick={() => setAdding((a) => !a)}>
          {adding ? 'Cancel' : 'Add department'}
        </Button>}
      />

      {adding && (
        <div className="mb-4 rounded-lg bg-ink-50 p-4 ring-1 ring-inset ring-ink-200">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Code" hint="short, e.g. ENG" htmlFor="d-code">
              <input id="d-code" value={form.code} placeholder="ENG"
                onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                className={`${inputCls} num`} />
            </Field>
            <Field label="Name" htmlFor="d-name">
              <input id="d-name" value={form.name} placeholder="Engineering"
                onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} />
            </Field>
            <Field label="Sits under" hint="leave blank for a root" htmlFor="d-parent">
              <select id="d-parent" value={form.parentId}
                onChange={(e) => setForm({ ...form, parentId: e.target.value })}
                className={inputCls}>
                <option value="">— no parent —</option>
                {rows.map((r) => <option key={r.id} value={r.id}>{r.code} · {r.name}</option>)}
              </select>
            </Field>
          </div>
          <div className="mt-3">
            <Button size="sm" busy={busy} onClick={create}
              disabled={!form.code.trim() || !form.name.trim()}>
              Create department
            </Button>
          </div>
        </div>
      )}

      <Async state={state} rows={4} isEmpty={(d) => d.rows.length === 0}
        empty={<Empty title="No departments yet" hint="Add the first one to start the structure." />}>
        {(d) => (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[42rem] text-left text-[13.5px]">
              <thead>
                <tr className="border-b border-ink-200">
                  {['Department', 'Sits under', 'Headcount', 'Placed since', ''].map((h, i) => (
                    <th key={h || 'a'}
                      className={`px-3 py-2 text-[12px] font-medium uppercase tracking-wide text-ink-400 ${i > 1 ? 'text-right' : ''}`}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {d.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-ink-800">
                        <span className="num text-ink-400">{r.code}</span> {r.name}
                      </div>
                      {r.head_name && (
                        <div className="text-[12px] text-ink-400">Head: {r.head_name}</div>
                      )}
                      {r.unplaced && (
                        <Badge status="pending" className="mt-1">not placed on this date</Badge>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-ink-600">
                      {r.parent_code
                        ? <span><span className="num text-ink-400">{r.parent_code}</span> {r.parent_name}</span>
                        : <span className="text-ink-400">— root —</span>}
                      {/* A future placement is a SCHEDULED reorganisation, which is exactly what
                          the as-of control is for. Saying so beats making somebody find it. */}
                      {r.has_future_placement && (
                        <Badge status="submitted" className="ml-2">move scheduled</Badge>
                      )}
                    </td>
                    <td className="num px-3 py-2.5 text-right text-ink-700">
                      {r.direct_headcount}
                      {Number(r.subtree_headcount) !== Number(r.direct_headcount) && (
                        <span className="text-ink-400"> / {r.subtree_headcount}</span>
                      )}
                    </td>
                    <td className="num px-3 py-2.5 text-right text-ink-500">
                      {r.valid_from ? fmtDateShort(r.valid_from) : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="flex justify-end gap-1.5">
                        <Button variant="ghost" size="sm"
                          onClick={() => { setRenaming(r); setRename(r.name); setMoving(null); }}>
                          Rename
                        </Button>
                        <Button variant="secondary" size="sm"
                          onClick={() => {
                            setMoving(r); setRenaming(null);
                            setMove({ parentId: r.parent_department_id ?? '', effectiveFrom: '', reason: '' });
                          }}>
                          Move
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Async>

      {renaming && (
        <div className="mt-4 rounded-lg bg-ink-50 p-4 ring-1 ring-inset ring-ink-200">
          <p className="mb-2 text-[13px] text-ink-600">
            Renaming <span className="font-medium text-ink-900">{renaming.code}</span>. A
            department that changes its name is the same department, so this takes effect
            everywhere at once and no history changes.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="New name" htmlFor="d-rename">
              <input id="d-rename" value={rename} onChange={(e) => setRename(e.target.value)}
                className={`${inputCls} sm:w-72`} />
            </Field>
            <Button size="sm" busy={busy} onClick={submitRename}>Save</Button>
            <Button variant="ghost" size="sm" onClick={() => setRenaming(null)}>Cancel</Button>
          </div>
        </div>
      )}

      {moving && (
        <div className="mt-4 rounded-lg bg-brand-50 p-4 ring-1 ring-inset ring-brand-200">
          {/*
            * Gold rather than grey: moving a department is the consequential act on this screen.
            * It is not an edit - it closes the current placement and opens a new one, so the date
            * and the reason are both required and the copy says why.
            */}
          <p className="mb-3 text-[13px] text-ink-700">
            Moving <span className="font-medium text-ink-900">{moving.code} · {moving.name}</span>.
            This is recorded as a change with a date — reports before that date keep resolving to
            the old structure.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="New parent" hint="blank makes it a root" htmlFor="m-parent">
              <select id="m-parent" value={move.parentId}
                onChange={(e) => setMove({ ...move, parentId: e.target.value })}
                className={inputCls}>
                <option value="">— no parent —</option>
                {(state.data?.rows ?? [])
                  .filter((r) => r.id !== moving.id)
                  .map((r) => <option key={r.id} value={r.id}>{r.code} · {r.name}</option>)}
              </select>
            </Field>
            <Field label="Effective from" hint="today or later" htmlFor="m-from">
              <input id="m-from" type="date" min={today} value={move.effectiveFrom}
                onChange={(e) => setMove({ ...move, effectiveFrom: e.target.value })}
                className={`${inputCls} num`} />
            </Field>
            <Field label="Reason" hint="required — it explains the move later" htmlFor="m-reason">
              <input id="m-reason" value={move.reason} placeholder="Delivery reorganisation"
                onChange={(e) => setMove({ ...move, reason: e.target.value })}
                className={inputCls} />
            </Field>
          </div>
          <div className="mt-3 flex gap-2">
            <Button size="sm" busy={busy} onClick={submitMove}
              disabled={move.reason.trim().length < 3}>
              Record the move
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setMoving(null)}>Cancel</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------

function DesignationMaster({ state, onDone, onFail }: {
  state: ReturnType<typeof useData<{ rows: Desig[] }>>;
  onDone: (m: string) => void; onFail: (e: unknown) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ code: '', name: '', grade: '2' });
  const [confirming, setConfirming] = useState<Desig | null>(null);

  async function create() {
    setBusy(true);
    try {
      await api.post('/org/designations', {
        code: form.code, name: form.name, grade: Number(form.grade),
      });
      setForm({ code: '', name: '', grade: '2' });
      setAdding(false);
      onDone(`Designation ${form.code.toUpperCase()} created.`);
    } catch (e) { onFail(e); } finally { setBusy(false); }
  }

  async function retire(d: Desig, reinstate: boolean) {
    setBusy(true);
    try {
      const r = await api.post<{ holders: number }>(`/org/designations/${d.id}/retire`, { reinstate });
      setConfirming(null);
      onDone(reinstate
        ? `${d.code} is available again.`
        : `${d.code} retired. ${r.holders > 0
          ? `${r.holders} ${r.holders === 1 ? 'person' : 'people'} still hold it — they keep it; nobody new can be given it.`
          : 'Nobody held it.'}`);
    } catch (e) { onFail(e); } finally { setBusy(false); }
  }

  return (
    <Card>
      <CardHead
        title="Designations"
        hint="Retired titles stay on this list — historical assignments keep pointing at them."
        action={<Button size="sm" onClick={() => setAdding((a) => !a)}>
          {adding ? 'Cancel' : 'Add designation'}
        </Button>}
      />

      {adding && (
        <div className="mb-4 rounded-lg bg-ink-50 p-4 ring-1 ring-inset ring-ink-200">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Code" htmlFor="g-code">
              <input id="g-code" value={form.code} placeholder="SE"
                onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                className={`${inputCls} num`} />
            </Field>
            <Field label="Name" htmlFor="g-name">
              <input id="g-name" value={form.name} placeholder="Senior Engineer"
                onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} />
            </Field>
            <Field label="Grade" hint="1 to 20" htmlFor="g-grade">
              <input id="g-grade" type="number" min={1} max={20} value={form.grade}
                onChange={(e) => setForm({ ...form, grade: e.target.value })}
                className={`${inputCls} num`} />
            </Field>
          </div>
          <div className="mt-3">
            <Button size="sm" busy={busy} onClick={create}
              disabled={!form.code.trim() || !form.name.trim()}>
              Create designation
            </Button>
          </div>
        </div>
      )}

      <Async state={state} rows={4} isEmpty={(d) => d.rows.length === 0}
        empty={<Empty title="No designations yet" />}>
        {(d) => (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-left text-[13.5px]">
              <thead>
                <tr className="border-b border-ink-200">
                  {['Designation', 'Grade', 'Held by', 'Status', ''].map((h, i) => (
                    <th key={h || 'a'}
                      className={`px-3 py-2 text-[12px] font-medium uppercase tracking-wide text-ink-400 ${i > 0 ? 'text-right' : ''}`}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {d.rows.map((r) => (
                  <tr key={r.id} className={r.retired ? 'opacity-60' : ''}>
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-ink-800">
                        <span className="num text-ink-400">{r.code}</span> {r.name}
                      </div>
                    </td>
                    <td className="num px-3 py-2.5 text-right text-ink-600">{r.grade}</td>
                    <td className="num px-3 py-2.5 text-right text-ink-700">{r.holders}</td>
                    <td className="px-3 py-2.5 text-right">
                      {r.retired
                        ? <Badge status="week_off">retired {fmtDateShort(r.retired_on!)}</Badge>
                        : <Badge status="approved">available</Badge>}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {r.retired
                        ? (
                          <Button variant="secondary" size="sm" busy={busy}
                            onClick={() => retire(r, true)}>
                            Make available
                          </Button>
                        )
                        : (
                          <Button variant="ghost" size="sm" onClick={() => setConfirming(r)}>
                            Retire
                          </Button>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Async>

      {confirming && (
        <div className="mt-4 rounded-lg bg-amber-50 p-4 ring-1 ring-inset ring-amber-200">
          {/*
            * The count is the whole reason this is a confirmation rather than a click. Retiring a
            * title 40 people hold is a different act from retiring an empty one, and the person
            * doing it should see which before they do it.
            */}
          <p className="text-[13px] text-ink-800">
            Retire <span className="font-medium">{confirming.code} · {confirming.name}</span>?
            {confirming.holders > 0
              ? ` ${confirming.holders} ${confirming.holders === 1 ? 'person holds' : 'people hold'} it today. They keep it — it just cannot be given to anybody new.`
              : ' Nobody holds it today.'}
            {' '}It stays on this list, and it can be made available again.
          </p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" busy={busy} onClick={() => retire(confirming, false)}>Retire it</Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>Cancel</Button>
          </div>
        </div>
      )}
    </Card>
  );
}
