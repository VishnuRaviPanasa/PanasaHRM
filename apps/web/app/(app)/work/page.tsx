'use client';

import { useState } from 'react';
import { addDaysIso, api, ApiError, fmtDate, hm, useData, weekdayOf } from '@/lib/api';
import { Async, Badge, Button, Card, CardHead, Empty, Toast } from '@/components/ui';
import { WorkEntryForm } from '@/components/work-entry';
import { useT } from '@/lib/i18n';

interface WorkLog {
  date: string;
  entries: {
    id: string; minutes: number; description: string | null; entry_source: string;
    project_code: string; project_name: string;
    sub_project_code: string | null; sub_project_name: string | null;
    task_code: string | null; task_title: string | null;
    sub_task_code: string | null; sub_task_title: string | null;
    entered_by_name: string | null;
  }[];
  totalMinutes: number;
  period: { id: string; period_start: string; period_end: string; status: string } | null;
  locked: boolean;
}

/**
 * My work - and only ever mine.
 *
 * THE EMPLOYEE PICKER USED TO LIVE HERE and does not any more. HR needed to record effort for an
 * employee, so this screen grew a dropdown of other people and retitled itself from "My work" to
 * "Work log" when one was chosen. That put a screen named for the signed-in person in charge of
 * everybody else's day, and left the same page meaning two different things depending on a
 * dropdown. HR now does it from the employee's own profile, where that person is already the
 * subject of the page - see `WorkEntryForm` and `WorkLogCard` in the profile.
 *
 * Nothing was removed from the API: `POST /work-log` still accepts `employeeId` under
 * `work.log.write_for`, and this screen simply never sends it.
 */
export default function WorkPage() {
  const t = useT();

  /*
   * NO DATE LITERAL. The previous version opened on `useState('2026-09-08')`, so the form
   * defaulted to a fixed day forever - by October it was offering to log effort five weeks in the
   * past with no error to notice. The empty string means "ask the server", the response says
   * which business day that was, and only then do the arrows have an anchor. A browser must never
   * compute its own today: at 00:35 IST the UTC date is yesterday, which the effective-dated
   * rails correctly refuse as back-dating (DEC-091).
   */
  const [date, setDate] = useState('');
  const log = useData<WorkLog>(`/work-log${date ? `?date=${date}` : ''}`, [date]);
  const day = date || log.data?.date || '';

  const [toast, setToast] = useState<{ msg: string; tone: 'good' | 'bad' } | null>(null);

  async function remove(id: string) {
    try {
      await api.del(`/work-log/${id}`);
      setToast({ msg: t('work.entryRemoved'), tone: 'good' });
      await log.reload();
    } catch (err) {
      setToast({ msg: err instanceof ApiError ? err.message : t('work.couldNotRemove'), tone: 'bad' });
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[21px] font-semibold text-ink-900">{t('work.titleMine')}</h1>
          <p className="mt-0.5 text-[13.5px] text-ink-500">
            {t('work.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="secondary" size="sm" disabled={!day}
                  onClick={() => setDate(addDaysIso(day, -1))} aria-label={t('period.previousDay')}>←</Button>
          <label htmlFor="work-date" className="sr-only">{t('common.date')}</label>
          <input
            id="work-date" type="date" value={day}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-lg border-0 bg-white px-2.5 py-1 text-[13.5px] ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-ink-900"
          />
          <Button variant="secondary" size="sm" disabled={!day}
                  onClick={() => setDate(addDaysIso(day, 1))} aria-label={t('period.nextDay')}>→</Button>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHead
            title={day ? `${weekdayOf(day)} ${fmtDate(day)}` : t('app.loading')}
            hint={log.data?.locked ? undefined : t('work.addEffortHint')}
            action={
              <span className="num text-[15px] font-semibold text-ink-900">
                {hm(log.data?.totalMinutes ?? 0)}
              </span>
            }
          />

          {log.data?.locked && (
            <div role="status" className="mx-4 mt-4 rounded-lg bg-amber-50 p-3 text-[13px] text-amber-900 ring-1 ring-inset ring-amber-200 sm:mx-5">
              {t('work.locked', { status: log.data.period?.status ?? '' })}
            </div>
          )}

          <Async
            state={log}
            rows={3}
            isEmpty={(d) => d.entries.length === 0}
            empty={
              <Empty
                title={t('work.nothingLogged')}
                hint={t('work.nothingLoggedHint')}
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
                        {/*
                          * The whole path, not just the task. Effort attributed four levels deep
                          * displayed as though it had stopped at the task before the read query
                          * asked for the sub-task at all.
                          */}
                        {en.sub_project_name && (
                          <span className="text-[12.5px] text-ink-500">{en.sub_project_name}</span>
                        )}
                        {en.task_title && (
                          <span className="text-[12.5px] text-ink-500">
                            {en.sub_project_name ? '› ' : ''}{en.task_code} {en.task_title}
                          </span>
                        )}
                        {en.sub_task_title && (
                          <span className="text-[12.5px] text-ink-500">
                            › {en.sub_task_code} {en.sub_task_title}
                          </span>
                        )}
                      </div>
                      {en.description && <p className="mt-1 text-[13px] text-ink-600">{en.description}</p>}
                      {/*
                        * STILL SHOWN HERE, even though this screen can no longer create one.
                        *
                        * HR records an on-behalf entry from the employee's profile, and the
                        * employee sees it on this page - so this is the one place it matters most
                        * that a line they did not enter says so.
                        */}
                      {en.entry_source === 'hr_entry' && (
                        <p className="mt-1 text-[12px] text-ink-500">
                          {t('work.recordedBy', { name: en.entered_by_name ?? 'HR' })}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="num text-[13.5px] font-medium text-ink-900">{hm(en.minutes)}</span>
                      {!d.locked && (
                        <Button variant="ghost" size="sm" onClick={() => remove(en.id)}
                                aria-label={`${t('common.remove')} ${en.project_code}`}>
                          {t('common.remove')}
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
          <CardHead title={t('work.addEffort')} />
          {day && (
            <WorkEntryForm
              date={day}
              locked={log.data?.locked}
              onSaved={(mins) => {
                setToast({ msg: t('work.logged', { amount: hm(mins) }), tone: 'good' });
                void log.reload();
              }}
            />
          )}
        </Card>
      </div>

      {toast && <Toast message={toast.msg} tone={toast.tone} onDone={() => setToast(null)} />}
    </div>
  );
}
