'use client';

import { useEffect, type ReactNode } from 'react';
import { useT } from '@/lib/i18n';

/** The small set of primitives every screen is built from. Deliberately few. */

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-ink-200 bg-white shadow-[0_1px_2px_rgba(23,26,32,0.04)] ${className}`}>
      {children}
    </div>
  );
}

export function CardHead({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-100 px-4 py-3 sm:px-5">
      <div>
        <h2 className="text-[15px] font-semibold text-ink-900">{title}</h2>
        {hint && <p className="mt-0.5 text-[13px] text-ink-500">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

export function Stat({ label, value, sub, tone = 'plain' }: {
  label: string; value: ReactNode; sub?: string;
  tone?: 'plain' | 'good' | 'warn' | 'bad' | 'brand';
}) {
  const tones = {
    plain: 'text-ink-900',
    good: 'text-emerald-700',
    warn: 'text-amber-700',
    bad: 'text-rose-700',
    brand: 'text-brand-700',
  } as const;
  return (
    <Card className="px-4 py-3.5">
      <div className="text-[12px] font-medium uppercase tracking-wide text-ink-400">{label}</div>
      <div className={`num mt-1 text-2xl font-semibold ${tones[tone]}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[12.5px] text-ink-500">{sub}</div>}
    </Card>
  );
}

const STATUS_TONES: Record<string, string> = {
  present: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  approved: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  wfh: 'bg-sky-50 text-sky-700 ring-sky-200',
  late: 'bg-amber-50 text-amber-800 ring-amber-200',
  pending: 'bg-amber-50 text-amber-800 ring-amber-200',
  submitted: 'bg-amber-50 text-amber-800 ring-amber-200',
  half_day: 'bg-amber-50 text-amber-800 ring-amber-200',
  absent: 'bg-rose-50 text-rose-700 ring-rose-200',
  rejected: 'bg-rose-50 text-rose-700 ring-rose-200',
  returned: 'bg-rose-50 text-rose-700 ring-rose-200',
  leave: 'bg-violet-50 text-violet-700 ring-violet-200',
  holiday: 'bg-brand-50 text-brand-700 ring-brand-100',
  week_off: 'bg-ink-100 text-ink-500 ring-ink-200',
  draft: 'bg-ink-100 text-ink-600 ring-ink-200',
};

export function Badge({ children, status, className = '' }: {
  children?: ReactNode; status?: string; className?: string;
}) {
  const key = (status ?? '').toLowerCase();
  const tone = STATUS_TONES[key] ?? 'bg-ink-100 text-ink-600 ring-ink-200';
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[12px] font-medium ring-1 ring-inset ${tone} ${className}`}>
      {children ?? key.replace(/_/g, ' ')}
    </span>
  );
}

export function Button({
  children, variant = 'primary', size = 'md', busy, className = '', ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'brand';
  size?: 'sm' | 'md' | 'lg'; busy?: boolean;
}) {
  const variants = {
    // NEAR-BLACK, not gold. Gold behind white text is ~1.7:1 (illegible), and the brand
    // itself pairs gold with near-black rather than white. This also keeps gold free to
    // mean "brand" instead of competing with amber, which already means pending/late.
    primary: 'bg-ink-900 text-white hover:bg-ink-800 disabled:bg-ink-900/40',
    secondary: 'bg-white text-ink-800 ring-1 ring-inset ring-ink-300 hover:bg-ink-50 disabled:opacity-50',
    ghost: 'text-ink-600 hover:bg-ink-100 disabled:opacity-50',
    danger: 'bg-white text-rose-700 ring-1 ring-inset ring-rose-300 hover:bg-rose-50 disabled:opacity-50',
    /** Gold, for the one place a brand-forward action is wanted. Dark text: 10.4:1. */
    brand: 'bg-brand-500 text-ink-900 hover:bg-brand-400 disabled:bg-brand-500/50',
  } as const;
  const sizes = {
    sm: 'px-2.5 py-1 text-[13px]',
    md: 'px-3.5 py-1.5 text-[13.5px]',
    // For a screen whose whole purpose is one action - the attendance punch. A hero action at
    // `md` competes with the text beside it instead of leading it.
    lg: 'px-5 py-2.5 text-[15px]',
  } as const;
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      aria-busy={busy || undefined}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed ${variants[variant]} ${sizes[size]} ${className}`}
    >
      {busy && (
        <span aria-hidden className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      {children}
    </button>
  );
}

export function Field({ label, hint, error, children, htmlFor }: {
  label: string; hint?: string; error?: string; children: ReactNode; htmlFor?: string;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-[13px] font-medium text-ink-700">{label}</label>
      {children}
      {hint && !error && <p className="mt-1 text-[12.5px] text-ink-500">{hint}</p>}
      {error && <p className="mt-1 text-[12.5px] text-rose-700">{error}</p>}
    </div>
  );
}

export const inputCls =
  'mt-1 block w-full rounded-lg border-0 bg-white px-3 py-1.5 text-[14px] text-ink-900 ring-1 ring-inset ring-ink-300 placeholder:text-ink-400 focus:ring-2 focus:ring-inset focus:ring-ink-900';

/** Loading. A shaped skeleton, not a spinner - it tells you what is arriving. */
export function Skeleton({ rows = 3, className = '' }: { rows?: number; className?: string }) {
  const t = useT();
  return (
    <div className={`space-y-2 p-4 sm:p-5 ${className}`} role="status" aria-label={t('ui.loading')}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton h-4" style={{ width: `${92 - i * 11}%` }} />
      ))}
      <span className="sr-only">{t('ui.loading')}</span>
    </div>
  );
}

/** Error. Says what failed and offers the way out. */
export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const t = useT();
  return (
    <div role="alert" className="m-4 rounded-lg bg-rose-50 p-4 ring-1 ring-inset ring-rose-200 sm:m-5">
      <p className="text-[13.5px] font-medium text-rose-900">{t('ui.couldNotLoad')}</p>
      <p className="mt-1 text-[13px] text-rose-800">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>{t('common.retry')}</Button>
      )}
    </div>
  );
}

/** Empty. Never a blank box - say why it is empty and what to do. */
export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  const t = useT();
  return (
    <div className="px-4 py-10 text-center sm:px-5">
      <p className="text-[13.5px] font-medium text-ink-700">{title}</p>
      {hint && <p className="mx-auto mt-1 max-w-sm text-[13px] text-ink-500">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Wraps the three states so no screen forgets one. */
export function Async<T>({ state, children, empty, isEmpty, rows }: {
  state: { data: T | null; loading: boolean; error: string | null; reload: () => void };
  children: (data: T) => ReactNode;
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
  rows?: number;
}) {
  const t = useT();
  if (state.loading) return <Skeleton rows={rows} />;
  if (state.error) return <ErrorBox message={state.error} onRetry={state.reload} />;
  if (!state.data) return <>{empty ?? <Empty title={t('ui.nothingHere')} />}</>;
  if (isEmpty?.(state.data)) return <>{empty ?? <Empty title={t('ui.nothingHere')} />}</>;
  return <>{children(state.data)}</>;
}

/**
 * A short-lived confirmation. Success needs feedback as much as failure does.
 *
 * Dismissal is on a timer rather than onAnimationEnd - there is no animation to end, so the
 * first version would have stayed on screen forever. Errors linger longer than successes.
 */
export function Toast({ message, tone = 'good', onDone }: {
  message: string; tone?: 'good' | 'bad'; onDone?: () => void;
}) {
  const t = useT();
  useEffect(() => {
    const t = setTimeout(() => onDone?.(), tone === 'bad' ? 6000 : 3500);
    return () => clearTimeout(t);
  }, [message, tone, onDone]);

  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed bottom-4 left-1/2 z-50 flex max-w-[92vw] -translate-x-1/2 items-center gap-2 rounded-lg px-4 py-2.5 text-[13.5px] font-medium text-white shadow-lg ${
        tone === 'good' ? 'bg-emerald-700' : 'bg-rose-700'
      }`}
    >
      <span aria-hidden>{tone === 'good' ? '✓' : '⚠'}</span>
      <span>{message}</span>
      <button
        type="button"
        onClick={() => onDone?.()}
        className="ms-1 rounded px-1 text-white/80 hover:text-white"
        aria-label={t('ui.dismiss')}
      >
        &times;
      </button>
    </div>
  );
}

export function Bar({ value, max, tone = 'brand' }: { value: number; max: number; tone?: 'brand' | 'good' }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-100">
      <div
        className={`h-full rounded-full ${tone === 'brand' ? 'bg-brand-600' : 'bg-emerald-600'}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
