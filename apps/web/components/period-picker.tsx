'use client';

/**
 * A date-period selector: presets, or an explicit range.
 *
 * ONE COMPONENT, TWO SCREENS. Attendance and team effort both grew a period filter, and both
 * resolve it through the same API contract (`?preset=` or `?from=&to=`). A second copy would have
 * drifted the moment one of them gained a preset.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: resolve dates. "This month" is computed by the SERVER, from
 * `fn_business_date()`, and echoed back in the response. A browser asking "what is today" at
 * 00:35 IST gets the previous day in UTC, which is the class of bug DEC-091 records - a client
 * that computes its own today is wrong for five and a half hours out of every twenty-four. So a
 * preset here sends a WORD, not a pair of dates, and the resolved period is displayed from what
 * came back rather than from anything computed locally.
 *
 * The custom range is the exception, because those dates come from the person. They are still
 * validated on the server: this component's own check exists to answer immediately rather than to
 * be the guarantee.
 */

import { useEffect, useId, useState } from 'react';
import { Button, inputCls } from '@/components/ui';
import { useFormat, useT, type MessageKey } from '@/lib/i18n';

/*
 * `monthOf` exists because "an explicit month window" and "a range the person typed" are the same
 * QUERY and two different pieces of UI.
 *
 * The month arrows used to set `preset: 'custom'` - both send explicit dates, so it looked
 * equivalent. It was not: `custom` is what reveals the two date inputs, so clicking an arrow
 * opened a form the person had not asked for, showing the picker's stale draft values while the
 * label underneath reported the month actually being queried. The screen said
 * "Showing 1 Dec 2025 - 31 Dec 2025" above two inputs reading 01-06-2026 and 09-09-2026.
 *
 * So the shape of the request and the shape of the control are now separate: `monthOf` sends
 * dates like `custom` and shows no inputs, and the arrows produce it.
 */
export type Preset = 'today' | 'week' | 'month' | 'monthOf' | 'custom';

export interface Period {
  preset: Preset;
  from: string;
  to: string;
}

/** Explicit dates for a range; the word for a named preset. */
export const periodQuery = (p: Period): string =>
  (p.preset === 'custom' || p.preset === 'monthOf') && p.from && p.to
    ? `from=${p.from}&to=${p.to}`
    // A half-filled custom range falls back to the month rather than asking for nothing.
    : `preset=${p.preset === 'custom' || p.preset === 'monthOf' ? 'month' : p.preset}`;

// Keys, not labels - the strings live in the dictionary so both locales carry them, and a key
// that does not exist is a compile error rather than a word missing from the Arabic screen.
export const PRESETS: { key: Preset; labelKey: MessageKey }[] = [
  { key: 'today', labelKey: 'period.today' },
  { key: 'week', labelKey: 'period.week' },
  { key: 'month', labelKey: 'period.month' },
  { key: 'custom', labelKey: 'period.custom' },
];

/**
 * The period actually in force, in words, from what the server resolved.
 *
 * The date formatting was pinned to 'en-IN' and now goes through `useFormat().date`, which picks
 * the tag from the locale and still constructs and reads the date as UTC - so the label never
 * shifts a day in either direction, in either language. What is DISPLAYED changes with the
 * locale; the ISO string in every request and every database row does not.
 */
export function PeriodLabel({ from, to }: { from?: string; to?: string }) {
  const t = useT();
  const fmt = useFormat();
  if (!from || !to) return null;
  return (
    <p className="text-[13px] text-ink-500">
      {t('period.showing')}{' '}
      <span className="font-medium text-ink-800">
        {from === to ? fmt.date(from) : `${fmt.date(from)} – ${fmt.date(to)}`}
      </span>
    </p>
  );
}

export function PeriodPicker({
  value, onChange, busy, label, resolved,
}: {
  value: Period;
  onChange: (p: Period) => void;
  busy?: boolean;
  label?: string;
  /*
   * The dates the SERVER resolved for the current period, when the caller has them.
   *
   * A named preset carries no dates of its own - `{ preset: 'month', from: '', to: '' }` - so
   * switching to Custom used to open two empty inputs, and the label underneath went on
   * describing the month still in force. Nothing contradicted anything, but the person was handed
   * a blank form and had to retype a range they could already see. Seeding from the resolved
   * period means Custom opens on exactly what is on screen, ready to be adjusted.
   */
  resolved?: { from?: string; to?: string };
}) {
  // Held locally so a half-typed range is never sent - the moment `from` is set and `to` is not,
  // an eager onChange would ask the server about a single day the person had not chosen.
  const [draft, setDraft] = useState({ from: value.from, to: value.to });
  const [error, setError] = useState<string | null>(null);

  /*
   * The draft follows the period when it changes from OUTSIDE this component.
   *
   * `useState` seeds once, so after the parent moved the period - a month arrow, a reset - the
   * inputs kept whatever was in them when the component first mounted, and displayed a range
   * that was not the one being queried. Anything the person is part-way through typing is
   * preserved, because this only runs when the resolved value actually changes.
   */
  useEffect(() => {
    setDraft({
      from: value.from || resolved?.from || '',
      to: value.to || resolved?.to || '',
    });
    setError(null);
  }, [value.from, value.to, resolved?.from, resolved?.to]);

  const id = useId();
  const t = useT();

  const apply = () => {
    if (!draft.from || !draft.to) { setError(t('period.pickBoth')); return; }
    if (draft.from > draft.to) { setError(t('period.startAfterEnd')); return; }
    setError(null);
    onChange({ preset: 'custom', from: draft.from, to: draft.to });
  };

  return (
    <div className="space-y-2">
      <div role="group" aria-label={label ?? t('period.label')} className="flex flex-wrap items-center gap-1.5">
        {PRESETS.map((p) => {
          const on = value.preset === p.key;
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => {
                setError(null);
                // Switching to Custom must not fire a request: there is nothing chosen yet.
                if (p.key === 'custom') onChange({ ...value, preset: 'custom' });
                else onChange({ preset: p.key, from: '', to: '' });
              }}
              aria-pressed={on}
              disabled={busy}
              className={`rounded-full px-3 py-1 text-[13px] font-medium transition
                focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-900
                focus-visible:ring-offset-1 disabled:opacity-50 ${
                on
                  ? 'bg-ink-900 text-white'
                  : 'bg-white text-ink-700 ring-1 ring-inset ring-ink-300 hover:bg-ink-50'
              }`}
            >
              {t(p.labelKey)}
            </button>
          );
        })}
      </div>

      {value.preset === 'custom' && (
        <div className="flex flex-wrap items-end gap-2.5 rounded-lg bg-ink-50 p-3">
          <div className="min-w-[9rem]">
            <label htmlFor={`${id}-from`} className="text-[12px] font-medium text-ink-600">
              {t('period.startDate')}
            </label>
            <input
              id={`${id}-from`}
              type="date"
              value={draft.from}
              max={draft.to || undefined}
              onChange={(e) => { setDraft((d) => ({ ...d, from: e.target.value })); setError(null); }}
              className={inputCls}
              aria-invalid={!!error}
              aria-describedby={error ? `${id}-err` : undefined}
            />
          </div>
          <div className="min-w-[9rem]">
            <label htmlFor={`${id}-to`} className="text-[12px] font-medium text-ink-600">
              {t('period.endDate')}
            </label>
            <input
              id={`${id}-to`}
              type="date"
              value={draft.to}
              min={draft.from || undefined}
              onChange={(e) => { setDraft((d) => ({ ...d, to: e.target.value })); setError(null); }}
              className={inputCls}
              aria-invalid={!!error}
              aria-describedby={error ? `${id}-err` : undefined}
            />
          </div>
          <Button size="sm" onClick={apply} busy={busy} disabled={busy}>{t('common.apply')}</Button>
          {error && (
            <p id={`${id}-err`} role="alert" className="w-full text-[12.5px] text-rose-700">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
