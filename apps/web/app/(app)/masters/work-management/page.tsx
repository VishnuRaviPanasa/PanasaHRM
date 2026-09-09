'use client';

/**
 * Work structure master data: Project -> Sub-project -> Task -> Sub-task.
 *
 * WHY IT LOOKS LIKE A TREE AND NOT FOUR TABLES. The thing being managed IS a hierarchy, and the
 * mistakes it exists to prevent are hierarchy mistakes - a task under the wrong project, a
 * sub-task orphaned from its task. Four independent tables with parent dropdowns would make those
 * mistakes easy to commit and invisible to review. Here a child is created from its parent's own
 * row, so the parent is never in question.
 *
 * RETIRE, NEVER DELETE. There is no delete control anywhere on this screen, and that is not an
 * omission: work logs reference these records, the foreign keys refuse to delete anything
 * referenced, and a historical timesheet must keep displaying the label it was filed against. The
 * `usage` count beside each node is how somebody sees, before clicking, that retiring it will
 * change what a live project can log against.
 */

import { useMemo, useState } from 'react';
import { api, ApiError, useData } from '@/lib/api';
import { useT, type MessageKey } from '@/lib/i18n';

import {
  Async, Badge, Button, Card, CardHead, Empty, Field, Toast, inputCls,
} from '@/components/ui';

interface SubTask { id: string; code: string | null; title: string; active: boolean; usage: number }
interface Task {
  id: string; code: string | null; title: string; status: string; active: boolean;
  subProjectId: string | null; usage: number; subTasks: SubTask[];
}
interface SubProject { id: string; code: string | null; name: string; active: boolean; tasks: Task[] }
interface Project {
  id: string; code: string; name: string; clientName: string | null; status: string;
  active: boolean; usage: number; subProjects: SubProject[]; tasks: Task[];
}
interface Tree { projects: Project[]; query: string | null }

type Kind = 'project' | 'sub-project' | 'task' | 'sub-task';

/*
 * The four levels, named through the dictionary.
 *
 * The generic components below took a `kind` string and interpolated it straight into
 * labels and toasts - `Add ${kind}`, `${kind} retired`. That works in English by accident of
 * the identifiers happening to be English words, and produces "Add sub-task" half-translated
 * in Arabic. These two maps turn a kind into a key, so the whole phrase comes from the
 * dictionary and can be worded naturally in each language.
 */
const KIND_KEY: Record<Kind, MessageKey> = {
  project: 'common.project',
  'sub-project': 'common.subProject',
  task: 'common.task',
  'sub-task': 'common.subTask',
};

const ADD_KEY: Record<Kind, MessageKey> = {
  project: 'masters.addProject',
  'sub-project': 'masters.addSubProject',
  task: 'masters.addTask',
  'sub-task': 'masters.addSubTask',
};

const ENDPOINT: Record<Kind, string> = {
  project: 'projects',
  'sub-project': 'sub-projects',
  task: 'tasks',
  'sub-task': 'sub-tasks',
};

/** Retired records stay visible but must not read as equal to live ones. */
const dim = (active: boolean) => (active ? '' : 'opacity-55');

function Retire({
  kind, id, active, usage, onDone,
}: { kind: Kind; id: string; active: boolean; usage: number; onDone: (m: string, bad?: boolean) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const go = async () => {
    setBusy(true);
    try {
      await api.patch(`/work-masters/${ENDPOINT[kind]}/${id}`, { active: !active });
      onDone(active
        ? t('masters.retiredToast', { kind: t(KIND_KEY[kind]) })
        : t('masters.reactivatedToast', { kind: t(KIND_KEY[kind]) }));
    } catch (e) {
      onDone(e instanceof ApiError ? e.message : t('masters.couldNotChange'), true);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  // Reactivating is harmless, so it never asks. Retiring something with effort against it
  // changes what a live project can log against, so that one does.
  if (!active || usage === 0) {
    return (
      <Button variant="ghost" size="sm" busy={busy} onClick={go}
              aria-label={`${active ? t('common.retire') : t('common.reactivate')} ${t(KIND_KEY[kind])}`}>
        {active ? t('common.retire') : t('common.reactivate')}
      </Button>
    );
  }

  return confirming ? (
    <span className="flex items-center gap-1.5">
      <span className="text-[12px] text-amber-800">
        {t('masters.inUseWarning', { n: usage })}
      </span>
      <Button variant="danger" size="sm" busy={busy} onClick={go}>{t('masters.retireAnyway')}</Button>
      <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
    </span>
  ) : (
    <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}
            aria-label={`${t('common.retire')} ${t(KIND_KEY[kind])}`}>
      {t('common.retire')}
    </Button>
  );
}

/** Inline "add a child" form, opened from the parent's own row. */
function AddChild({
  kind, parent, onDone,
}: { kind: Kind; parent: Record<string, string>; onDone: (m: string, bad?: boolean) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const titleField = kind === 'task' || kind === 'sub-task' ? 'title' : 'name';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api.post(`/work-masters/${ENDPOINT[kind]}`, {
        ...parent, code: code || null, [titleField]: name,
      });
      setCode(''); setName(''); setOpen(false);
      onDone(t('masters.added', { kind: t(KIND_KEY[kind]) }));
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : t('masters.couldNotAdd'));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        {t(ADD_KEY[kind])}
      </Button>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2 rounded-lg bg-white p-2.5 ring-1 ring-inset ring-ink-200">
      <div className="w-24">
        <label className="text-[12px] font-medium text-ink-600">{t('masters.code')}</label>
        <input className={inputCls} value={code} onChange={(e) => setCode(e.target.value)}
               placeholder={t('common.optional')} aria-label={`${t(KIND_KEY[kind])} ${t('masters.code')}`} />
      </div>
      <div className="min-w-[11rem] flex-1">
        <label className="text-[12px] font-medium text-ink-600">
          {titleField === 'title' ? t('masters.titleField') : t('masters.name')}
        </label>
        <input className={inputCls} value={name} required autoFocus
               onChange={(e) => setName(e.target.value)}
               aria-label={`${t(KIND_KEY[kind])} ${titleField === 'title' ? t('masters.titleField') : t('masters.name')}`} />
      </div>
      <Button type="submit" size="sm" busy={busy} disabled={!name.trim()}>{t('common.save')}</Button>
      <Button variant="ghost" size="sm" type="button" onClick={() => { setOpen(false); setErr(null); }}>
        {t('common.cancel')}
      </Button>
      {err && <p role="alert" className="w-full text-[12.5px] text-rose-700">{err}</p>}
    </form>
  );
}

function Rename({
  kind, id, current, onDone,
}: { kind: Kind; id: string; current: string; onDone: (m: string, bad?: boolean) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const field = kind === 'task' || kind === 'sub-task' ? 'title' : 'name';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.patch(`/work-masters/${ENDPOINT[kind]}/${id}`, { [field]: value });
      setOpen(false);
      onDone(t('masters.renamed', { kind: t(KIND_KEY[kind]) }));
    } catch (e2) {
      onDone(e2 instanceof ApiError ? e2.message : t('masters.couldNotRename'), true);
    } finally {
      setBusy(false);
    }
  };

  return open ? (
    <form onSubmit={submit} className="flex items-end gap-2">
      <input className={inputCls} value={value} autoFocus
             onChange={(e) => setValue(e.target.value)}
             aria-label={`${t('common.rename')} ${t(KIND_KEY[kind])}`} />
      <Button type="submit" size="sm" busy={busy} disabled={!value.trim()}>{t('common.save')}</Button>
      <Button variant="ghost" size="sm" type="button" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
    </form>
  ) : (
    <Button variant="ghost" size="sm" onClick={() => { setValue(current); setOpen(true); }}
            aria-label={`${t('common.rename')} ${t(KIND_KEY[kind])}`}>
      {t('common.rename')}
    </Button>
  );
}

function TaskRow({ task, refresh }: { task: Task; refresh: (m: string, bad?: boolean) => void }) {
  const t = useT();
  return (
    <li className={`border-t border-ink-100 py-2.5 ps-4 ${dim(task.active)}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[13px] text-ink-800">
          {task.code && <span className="num me-1.5 text-ink-500">{task.code}</span>}
          {task.title}
          {!task.active && <Badge status="pending">{t('common.retired')}</Badge>}
          {task.status === 'done' && <Badge status="approved">done</Badge>}
          {task.usage > 0 && (
            <span className="ms-1.5 text-[12px] text-ink-400">{t('masters.logged', { n: task.usage })}</span>
          )}
        </span>
        <span className="flex items-center gap-1">
          <Rename kind="task" id={task.id} current={task.title} onDone={refresh} />
          <Retire kind="task" id={task.id} active={task.active} usage={task.usage} onDone={refresh} />
        </span>
      </div>

      <ul className="mt-1">
        {task.subTasks.map((st) => (
          <li key={st.id} className={`flex flex-wrap items-baseline justify-between gap-2 py-1 ps-4 ${dim(st.active)}`}>
            <span className="text-[12.5px] text-ink-600">
              <span aria-hidden="true" className="me-1.5 text-ink-300">└</span>
              {st.code && <span className="num me-1.5 text-ink-400">{st.code}</span>}
              {st.title}
              {!st.active && <Badge status="pending">{t('common.retired')}</Badge>}
              {st.usage > 0 && <span className="ms-1.5 text-[12px] text-ink-400">{t('masters.logged', { n: st.usage })}</span>}
            </span>
            <span className="flex items-center gap-1">
              <Rename kind="sub-task" id={st.id} current={st.title} onDone={refresh} />
              <Retire kind="sub-task" id={st.id} active={st.active} usage={st.usage} onDone={refresh} />
            </span>
          </li>
        ))}
        <li className="py-1.5 ps-4">
          <AddChild kind="sub-task" parent={{ taskId: task.id }} onDone={refresh} />
        </li>
      </ul>
    </li>
  );
}

export default function WorkMastersPage() {
  const t = useT();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<{ msg: string; tone: 'good' | 'bad' } | null>(null);
  const state = useData<Tree>(`/work-masters/tree${search ? `?q=${encodeURIComponent(search)}` : ''}`, [search]);

  const refresh = (msg: string, bad = false) => {
    setToast({ msg, tone: bad ? 'bad' : 'good' });
    if (!bad) void state.reload();
  };

  const counts = useMemo(() => {
    const p = state.data?.projects ?? [];
    const tasks = p.flatMap((x) => [...x.tasks, ...x.subProjects.flatMap((s) => s.tasks)]);
    return {
      projects: p.length,
      subProjects: p.reduce((n, x) => n + x.subProjects.length, 0),
      tasks: tasks.length,
      subTasks: tasks.reduce((n, t) => n + t.subTasks.length, 0),
    };
  }, [state.data]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[21px] font-semibold text-ink-900">{t('masters.title')}</h1>
          <p className="mt-0.5 text-[13.5px] text-ink-500">
            {t('masters.subtitle')}
          </p>
        </div>
        <AddChild kind="project" parent={{}} onDone={refresh} />
      </div>

      <Card>
        {/*
          * THE BUTTONS SHARE A ROW WITH THE INPUT, and the hint sits under the whole thing.
          *
          * This was one flex row with `items-end`, holding a `Field` and the buttons. `Field`
          * stacks label, control and HINT, so its bottom edge is below the hint - and `items-end`
          * dutifully aligned the buttons to that, dropping them a line beneath the input they
          * belong to. The hint is what made the two disagree, so it moves out of the row rather
          * than the buttons being nudged with a margin.
          */}
        <form
          className="px-4 py-3.5"
          onSubmit={(e) => { e.preventDefault(); setSearch(q.trim()); }}
        >
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[14rem] flex-1">
              {/* No `hint` here - see above. */}
              <Field label={t('common.search')} htmlFor="wm-q">
                <input id="wm-q" className={inputCls} value={q} onChange={(e) => setQ(e.target.value)}
                       placeholder={t('masters.searchPlaceholder')} />
              </Field>
            </div>
            {/*
              * `md`, not `sm`: these sit beside a text input, and `sm` is 6px shorter than it. The
              * bottoms lined up either way - that is what `items-end` does - but the centres did
              * not, so the button read as sitting low next to the field. Matching the control
              * height is what makes the row look intentional rather than nearly right.
              */}
            <Button type="submit" size="md">{t('common.search')}</Button>
            {search && (
              <Button variant="secondary" size="md" type="button"
                      onClick={() => { setQ(''); setSearch(''); }}>
                {t('common.clear')}
              </Button>
            )}
          </div>

          <div className="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <p className="text-[12.5px] text-ink-500">{t('masters.searchHint')}</p>
            <p className="text-[12.5px] text-ink-500">{t('masters.counts', counts)}</p>
          </div>
        </form>
      </Card>

      {/*
        * Retiring is the only lifecycle action offered, and the screen says so once rather than
        * on every row. Somebody looking for a delete button needs to know it is absent on purpose.
        */}
      <p className="text-[12.5px] text-ink-500">
        {t('masters.retirePolicy')}
      </p>

      <Async
        state={state}
        rows={6}
        isEmpty={(d) => d.projects.length === 0}
        empty={
          <Card>
            <Empty
              title={search ? t('masters.noMatch') : t('masters.noProjects')}
              hint={search ? t('masters.noMatchHint') : t('masters.noProjectsHint')}
              action={search
                ? <Button variant="secondary" size="sm" onClick={() => { setQ(''); setSearch(''); }}>{t('common.clear')}</Button>
                : undefined}
            />
          </Card>
        }
      >
        {(d) => (
          <div className="space-y-4">
            {d.projects.map((p) => (
              <Card key={p.id} className={dim(p.active)}>
                <CardHead
                  title={`${p.code} — ${p.name}`}
                  hint={p.clientName ?? undefined}
                  action={
                    <span className="flex flex-wrap items-center gap-1">
                      {!p.active && <Badge status="pending">{p.status}</Badge>}
                      {p.usage > 0 && (
                        <span className="me-1 text-[12px] text-ink-400">{t('masters.logged', { n: p.usage })}</span>
                      )}
                      <Rename kind="project" id={p.id} current={p.name} onDone={refresh} />
                      <Retire kind="project" id={p.id} active={p.active} usage={p.usage} onDone={refresh} />
                    </span>
                  }
                />

                <div className="space-y-3 px-4 pb-4 sm:px-5">
                  {p.subProjects.map((sp) => (
                    <section key={sp.id} className={`rounded-lg bg-ink-50 p-3 ${dim(sp.active)}`}>
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <h3 className="text-[13.5px] font-medium text-ink-800">
                          {sp.code && <span className="num me-1.5 text-ink-500">{sp.code}</span>}
                          {sp.name}
                          {!sp.active && <Badge status="pending">{t('common.retired')}</Badge>}
                        </h3>
                        <span className="flex items-center gap-1">
                          <Rename kind="sub-project" id={sp.id} current={sp.name} onDone={refresh} />
                          <Retire kind="sub-project" id={sp.id} active={sp.active} usage={0} onDone={refresh} />
                        </span>
                      </div>
                      <ul>
                        {sp.tasks.map((t) => <TaskRow key={t.id} task={t} refresh={refresh} />)}
                      </ul>
                      <div className="mt-2">
                        <AddChild kind="task" parent={{ projectId: p.id, subProjectId: sp.id }} onDone={refresh} />
                      </div>
                    </section>
                  ))}

                  {/*
                    * Tasks directly under the project. A task may have no sub-project at all, and
                    * that shape has to be visible here or somebody would conclude the data is
                    * missing - it is the same case that vanished from v_work_hierarchy's first
                    * draft (check WH6).
                    */}
                  <section>
                    {p.tasks.length > 0 && (
                      <h3 className="text-[12px] font-medium uppercase tracking-wide text-ink-400">
                        {t('masters.directlyUnder')}
                      </h3>
                    )}
                    <ul>
                      {p.tasks.map((t) => <TaskRow key={t.id} task={t} refresh={refresh} />)}
                    </ul>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <AddChild kind="task" parent={{ projectId: p.id }} onDone={refresh} />
                      <AddChild kind="sub-project" parent={{ projectId: p.id }} onDone={refresh} />
                    </div>
                  </section>
                </div>
              </Card>
            ))}
          </div>
        )}
      </Async>

      {toast && <Toast message={toast.msg} tone={toast.tone} onDone={() => setToast(null)} />}
    </div>
  );
}
