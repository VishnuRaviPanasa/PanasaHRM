'use client';

import { useState } from 'react';
import { addDaysIso, api, ApiError, fmtDate, hm, useData, weekdayOf } from '@/lib/api';
import { Async, Badge, Button, Card, CardHead, Empty, Field, Toast, inputCls } from '@/components/ui';

interface Projects {
  projects: { id: string; code: string; name: string; client_name: string | null; role: string;
             tasks: { id: string; code: string | null; title: string }[] | null }[];
}
interface WorkLog {
  date: string;
  entries: { id: string; minutes: number; description: string | null;
             project_code: string; project_name: string; task_code: string | null; task_title: string | null }[];
  totalMinutes: number;
  period: { id: string; period_start: string; period_end: string; status: string } | null;
  locked: boolean;
}

export default function WorkPage() {
  const [date, setDate] = useState('2026-09-08');
  const projects = useData<Projects>('/projects');
  const log = useData<WorkLog>(`/work-log?date=${date}`, [date]);

  const [projectId, setProjectId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [hours, setHours] = useState('4');
  const [minutes, setMinutes] = useState('30');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; tone: 'good' | 'bad' } | null>(null);

  const chosen = projects.data?.projects.find((p) => p.id === projectId);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ entry: { minutes: number } }>('/work-log', {
        date, projectId, taskId: taskId || null,
        hours: Number(hours || 0), minutes: Number(minutes || 0),
        description: description || null,
      });
      setToast({ msg: `Logged ${hm(res.entry.minutes)}`, tone: 'good' });
      setDescription('');
      await log.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try {
      await api.del(`/work-log/${id}`);
      setToast({ msg: 'Entry removed', tone: 'good' });
      await log.reload();
    } catch (err) {
      setToast({ msg: err instanceof ApiError ? err.message : 'Could not remove', tone: 'bad' });
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[21px] font-semibold text-ink-900">My work</h1>
          <p className="mt-0.5 text-[13.5px] text-ink-500">
            What you worked on, and for which project. Effort is stored in whole minutes.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="secondary" size="sm" onClick={() => setDate((d) => addDaysIso(d, -1))} aria-label="Previous day">←</Button>
          <label htmlFor="work-date" className="sr-only">Date</label>
          <input id="work-date" type="date" className="rounded-lg border-0 bg-white px-2.5 py-1 text-[13.5px] ring-1 ring-inset ring-ink-300" value={date} onChange={(e) => setDate(e.target.value)} />
          <Button variant="secondary" size="sm" onClick={() => setDate((d) => addDaysIso(d, 1))} aria-label="Next day">→</Button>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHead
            title={`${weekdayOf(date)} ${fmtDate(date)}`}
            hint={log.data?.locked
              ? undefined
              : 'Add a line per project. Duplicate a description if the work spans tasks.'}
            action={
              <span className="num text-[15px] font-semibold text-ink-900">
                {hm(log.data?.totalMinutes ?? 0)}
              </span>
            }
          />

          {log.data?.locked && (
            <div role="status" className="mx-4 mt-4 rounded-lg bg-amber-50 p-3 text-[13px] text-amber-900 ring-1 ring-inset ring-amber-200 sm:mx-5">
              This week's timesheet is <strong className="font-semibold">{log.data.period?.status}</strong> and is
              locked. Entries cannot be added or removed — a correction needs an adjustment.
            </div>
          )}

          <Async
            state={log}
            rows={3}
            isEmpty={(d) => d.entries.length === 0}
            empty={
              <Empty
                title="Nothing logged for this day"
                hint="Add your first entry using the form on the right."
              />
            }
          >
            {(d) => (
              <ul className="divide-y divide-ink-100">
                {d.entries.map((en) => (
                  <li key={en.id} className="flex items-start justify-between gap-3 px-4 py-3 sm:px-5">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-[13.5px] font-medium text-ink-900">{en.project_name}</span>
                        <Badge>{en.project_code}</Badge>
                        {en.task_title && <span className="text-[12.5px] text-ink-500">{en.task_code} {en.task_title}</span>}
                      </div>
                      {en.description && <p className="mt-1 text-[13px] text-ink-600">{en.description}</p>}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="num text-[13.5px] font-medium text-ink-900">{hm(en.minutes)}</span>
                      {!d.locked && (
                        <Button variant="ghost" size="sm" onClick={() => remove(en.id)} aria-label={`Remove ${en.project_code} entry`}>
                          Remove
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Async>
        </Card>

        <Card className="lg:col-span-2">
          <CardHead title="Add effort" />
          <Async state={projects} rows={3} isEmpty={(p) => p.projects.length === 0}
                 empty={<Empty title="You are not on any project" hint="A project manager assigns project membership." />}>
            {(p) => (
              <form onSubmit={add} className="space-y-4 p-4 sm:p-5" noValidate>
                <Field label="Project" htmlFor="wk-project">
                  <select
                    id="wk-project" required className={inputCls} value={projectId}
                    onChange={(e) => { setProjectId(e.target.value); setTaskId(''); }}
                  >
                    <option value="">Choose a project…</option>
                    {p.projects.map((pr) => (
                      <option key={pr.id} value={pr.id}>{pr.code} — {pr.name}</option>
                    ))}
                  </select>
                </Field>

                <Field label="Task" htmlFor="wk-task" hint="Optional.">
                  <select id="wk-task" className={inputCls} value={taskId} disabled={!chosen}
                          onChange={(e) => setTaskId(e.target.value)}>
                    <option value="">No specific task</option>
                    {(chosen?.tasks ?? []).map((t) => (
                      <option key={t.id} value={t.id}>{t.code} — {t.title}</option>
                    ))}
                  </select>
                </Field>

                <fieldset>
                  <legend className="text-[13px] font-medium text-ink-700">Effort</legend>
                  <div className="mt-1 flex items-center gap-2">
                    <label htmlFor="wk-h" className="sr-only">Hours</label>
                    <input id="wk-h" type="number" min={0} max={23} className={`${inputCls} num w-20`} value={hours} onChange={(e) => setHours(e.target.value)} />
                    <span className="text-[13px] text-ink-500">h</span>
                    <label htmlFor="wk-m" className="sr-only">Minutes</label>
                    <input id="wk-m" type="number" min={0} max={59} step={5} className={`${inputCls} num w-20`} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
                    <span className="text-[13px] text-ink-500">m</span>
                  </div>
                  <p className="mt-1 text-[12.5px] text-ink-500">
                    Stored as {Number(hours || 0) * 60 + Number(minutes || 0)} minutes — never decimal hours.
                  </p>
                </fieldset>

                <Field label="What did you do?" htmlFor="wk-desc">
                  <input id="wk-desc" type="text" className={inputCls} value={description}
                         onChange={(e) => setDescription(e.target.value)}
                         placeholder="e.g. Implemented leave approval workflow" />
                </Field>

                {error && (
                  <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-[13px] text-rose-800 ring-1 ring-inset ring-rose-200">
                    {error}
                  </p>
                )}

                <Button type="submit" busy={busy} disabled={!projectId || log.data?.locked} className="w-full">
                  Add entry
                </Button>
              </form>
            )}
          </Async>
        </Card>
      </div>

      {toast && <Toast message={toast.msg} tone={toast.tone} onDone={() => setToast(null)} />}
    </div>
  );
}
