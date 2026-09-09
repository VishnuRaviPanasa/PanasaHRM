'use client';

/**
 * One work-log entry form, used for yourself and — by HR — for somebody else.
 *
 * WHY IT IS A COMPONENT AND NOT TWO FORMS. `/work` records your own effort; HR records an
 * employee's from that employee's profile. The two differ in exactly one value, the subject, and
 * agree on everything hard: a four-level cascade where a task may hang off a sub-project OR
 * directly off the project, children that must clear when a parent changes, and integer-minute
 * storage. Two copies of that would diverge, and the half that got the next fix would be a
 * coin toss.
 *
 * WHERE IT IS RENDERED IS THE WHOLE POINT. The employee picker used to live on `/work`, so a
 * screen called "My work" grew a dropdown of other people and retitled itself when one was
 * chosen. HR entering somebody else's effort belongs where that person is already the subject -
 * their profile - and `/work` goes back to meaning what it says. The API is unchanged either way:
 * `employeeId` present means `work.log.write_for` (hr_admin only) and stores `entry_source =
 * 'hr_entry'`; absent means `work.log.write` on the self graph.
 */

import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, hm, useData } from '@/lib/api';
import { Button, Empty, Field, Skeleton, inputCls } from '@/components/ui';
import { useT } from '@/lib/i18n';

interface Hierarchy {
  employeeId: string;
  projects: {
    id: string; code: string; name: string; client_name: string | null; role: string;
    tasks: { id: string; code: string | null; title: string; subProjectId: string | null }[] | null;
  }[];
  subProjects: { id: string; project_id: string; code: string | null; name: string }[];
  subTasks: { id: string; task_id: string; code: string | null; title: string }[];
}

/** A dependent selector that is empty for a legitimate reason, not because it is loading. */
function Dependent({
  label, htmlFor, hint, loading, empty, children,
}: {
  label: string; htmlFor: string; hint?: string; loading: boolean;
  empty?: string; children: React.ReactNode;
}) {
  return (
    <Field label={label} htmlFor={htmlFor} hint={hint}>
      {loading ? <Skeleton rows={1} /> : children}
      {/*
        * Says WHY a selector is empty. A disabled dropdown with nothing in it reads as broken;
        * "pick a project first" and "this project has no sub-projects" are different facts and
        * the person needs to know which one they are looking at.
        */}
      {!loading && empty && <p className="mt-1 text-[12.5px] text-ink-500">{empty}</p>}
    </Field>
  );
}

export function WorkEntryForm({
  employeeId, date, locked, onSaved, onCancel, idPrefix = 'wk',
}: {
  /** Omit for your own effort. Present means HR is recording for this employee. */
  employeeId?: string;
  date: string;
  locked?: boolean;
  onSaved: (minutes: number) => void;
  onCancel?: () => void;
  idPrefix?: string;
}) {
  const t = useT();
  const hq = employeeId ? `/projects?employeeId=${employeeId}` : '/projects';
  const tree = useData<Hierarchy>(hq, [hq]);

  const [projectId, setProjectId] = useState('');
  const [subProjectId, setSubProjectId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [subTaskId, setSubTaskId] = useState('');
  const [hours, setHours] = useState('4');
  const [minutes, setMinutes] = useState('30');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A different subject is on different projects, so nothing below survives the change.
  useEffect(() => {
    setProjectId(''); setSubProjectId(''); setTaskId(''); setSubTaskId(''); setError(null);
  }, [employeeId]);

  const project = tree.data?.projects.find((p) => p.id === projectId);

  /*
   * THE CASCADE, and the one subtlety in it.
   *
   * Sub-projects and sub-tasks filter on a parent id, which is straightforward. Tasks are not: a
   * task may belong to a sub-project OR directly to the project (`subProjectId === null`), and
   * both are legal. So with no sub-project chosen the list is EVERY task of the project, and with
   * one chosen it narrows. Filtering unconditionally on the selected sub-project would hide every
   * directly-attached task - the same mistake the first draft of `v_work_hierarchy` made in SQL.
   */
  const subProjects = useMemo(
    () => (tree.data?.subProjects ?? []).filter((sp) => sp.project_id === projectId),
    [tree.data, projectId],
  );
  const tasks = useMemo(
    () => (project?.tasks ?? []).filter((x) => !subProjectId || x.subProjectId === subProjectId),
    [project, subProjectId],
  );
  const subTasks = useMemo(
    () => (tree.data?.subTasks ?? []).filter((st) => st.task_id === taskId),
    [tree.data, taskId],
  );

  // Changing a parent invalidates its children. Left alone the form would submit a task from a
  // project no longer selected, which the server rejects - correctly, but opaquely.
  const pickProject = (id: string) => {
    setProjectId(id); setSubProjectId(''); setTaskId(''); setSubTaskId(''); setError(null);
  };
  const pickSubProject = (id: string) => {
    setSubProjectId(id); setTaskId(''); setSubTaskId(''); setError(null);
  };
  const pickTask = (id: string) => { setTaskId(id); setSubTaskId(''); setError(null); };

  const totalMinutes = Number(hours || 0) * 60 + Number(minutes || 0);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ entry: { minutes: number } }>('/work-log', {
        date,
        // Only sent when recording for somebody else, so the self path is byte-identical to
        // what it was before HR could do this at all.
        ...(employeeId ? { employeeId } : {}),
        projectId,
        taskId: taskId || null,
        subTaskId: subTaskId || null,
        hours: Number(hours || 0),
        minutes: Number(minutes || 0),
        description: description || null,
      });
      setDescription('');
      onSaved(res.entry.minutes);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('work.couldNotSave'));
    } finally {
      setBusy(false);
    }
  }

  if (tree.loading) return <Skeleton rows={4} />;

  if ((tree.data?.projects ?? []).length === 0) {
    return (
      <Empty
        title={employeeId ? t('work.notOnProjectOther') : t('work.notOnProject')}
        hint={employeeId ? t('work.notOnProjectOtherHint') : t('work.notOnProjectHint')}
      />
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4 p-4 sm:p-5" noValidate>
      <Field label={t('common.project')} htmlFor={`${idPrefix}-project`}>
        <select id={`${idPrefix}-project`} required className={inputCls} value={projectId}
                onChange={(e) => pickProject(e.target.value)}>
          <option value="">{t('work.chooseProject')}</option>
          {(tree.data?.projects ?? []).map((pr) => (
            <option key={pr.id} value={pr.id}>{pr.code} — {pr.name}</option>
          ))}
        </select>
      </Field>

      <Dependent
        label={t('common.subProject')} htmlFor={`${idPrefix}-subproject`} hint={t('common.optional')}
        loading={false}
        empty={!projectId
          ? t('work.chooseProjectFirst')
          : subProjects.length === 0 ? t('work.noSubProjects') : undefined}
      >
        <select id={`${idPrefix}-subproject`} className={inputCls} value={subProjectId}
                disabled={!projectId || subProjects.length === 0}
                onChange={(e) => pickSubProject(e.target.value)}>
          <option value="">{t('work.wholeProject')}</option>
          {subProjects.map((sp) => (
            <option key={sp.id} value={sp.id}>{sp.code ? `${sp.code} — ` : ''}{sp.name}</option>
          ))}
        </select>
      </Dependent>

      <Dependent
        label={t('common.task')} htmlFor={`${idPrefix}-task`} hint={t('common.optional')}
        loading={false}
        empty={!projectId
          ? t('work.chooseProjectFirst')
          : tasks.length === 0
            ? (subProjectId ? t('work.noSubProjectTasks') : t('work.noTasks'))
            : undefined}
      >
        <select id={`${idPrefix}-task`} className={inputCls} value={taskId}
                disabled={!projectId || tasks.length === 0}
                onChange={(e) => pickTask(e.target.value)}>
          <option value="">{t('work.noSpecificTask')}</option>
          {tasks.map((x) => (
            <option key={x.id} value={x.id}>{x.code ? `${x.code} — ` : ''}{x.title}</option>
          ))}
        </select>
      </Dependent>

      <Dependent
        label={t('common.subTask')} htmlFor={`${idPrefix}-subtask`} hint={t('common.optional')}
        loading={false}
        empty={!taskId
          ? t('work.chooseTaskFirst')
          : subTasks.length === 0 ? t('work.noSubTasks') : undefined}
      >
        <select id={`${idPrefix}-subtask`} className={inputCls} value={subTaskId}
                disabled={!taskId || subTasks.length === 0}
                onChange={(e) => setSubTaskId(e.target.value)}>
          <option value="">{t('work.noSpecificSubTask')}</option>
          {subTasks.map((st) => (
            <option key={st.id} value={st.id}>{st.code ? `${st.code} — ` : ''}{st.title}</option>
          ))}
        </select>
      </Dependent>

      <fieldset>
        <legend className="text-[13px] font-medium text-ink-700">{t('work.effort')}</legend>
        <div className="mt-1 flex items-center gap-2">
          <label htmlFor={`${idPrefix}-h`} className="sr-only">{t('common.hours')}</label>
          <input id={`${idPrefix}-h`} type="number" min={0} max={23} className={`${inputCls} num w-20`}
                 value={hours} onChange={(e) => setHours(e.target.value)} />
          <span className="text-[13px] text-ink-500">h</span>
          <label htmlFor={`${idPrefix}-m`} className="sr-only">{t('common.minutes')}</label>
          <input id={`${idPrefix}-m`} type="number" min={0} max={59} step={5} className={`${inputCls} num w-20`}
                 value={minutes} onChange={(e) => setMinutes(e.target.value)} />
          <span className="text-[13px] text-ink-500">m</span>
        </div>
        {/* ADR-0016. Said on the screen because the storage model is the point, not a detail. */}
        <p className="mt-1 text-[12.5px] text-ink-500">
          {t('work.storedAs', { n: totalMinutes })}
        </p>
      </fieldset>

      <Field label={t('work.whatWasDone')} htmlFor={`${idPrefix}-desc`}>
        <input id={`${idPrefix}-desc`} type="text" className={inputCls} value={description}
               onChange={(e) => setDescription(e.target.value)}
               placeholder={t('work.descriptionPlaceholder')} />
      </Field>

      {error && (
        <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-[13px] text-rose-800 ring-1 ring-inset ring-rose-200">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" busy={busy}
                disabled={!projectId || totalMinutes <= 0 || locked}>
          {employeeId ? t('work.recordEffort') : t('work.addEntry')}
        </Button>
        {onCancel && (
          <Button variant="ghost" size="md" type="button" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        )}
        <span className="num text-[12.5px] text-ink-500">{hm(totalMinutes)}</span>
      </div>
    </form>
  );
}
