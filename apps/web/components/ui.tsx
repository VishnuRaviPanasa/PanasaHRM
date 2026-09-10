'use client';

import Link from 'next/link';
import { useEffect, type ReactNode } from 'react';
import { useT } from '@/lib/i18n';
import { IconChevron, IconEye, IconEyeOff } from '@/components/icons';

/** The small set of primitives every screen is built from. Deliberately few. */

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-ink-200 bg-white shadow-[var(--shadow-card)] ${className}`}>
      {children}
    </div>
  );
}

/**
 * A card header.
 *
 * ITS DOM SHAPE IS LOAD-BEARING, so this component is deliberately unchanged by the 2026-09-10
 * redesign. An earlier draft added an optional `icon` and wrapped the title in one more `<div>`
 * to hold it. That broke `browser:test` B15d on the PAYSLIP screen - a screen the redesign never
 * touched - because the check finds the payslip `<h2>` and then walks UP a fixed number of
 * parents to reach the card (`h.closest('div').parentElement.parentElement`). One extra level and
 * it lands on the header instead, so the View/Download buttons it measures are no longer inside
 * what it thinks is the card, and a layout check that cannot find its subject reports as failed.
 *
 * The icon prop was never used by any caller, so the fix was to delete it rather than to loosen
 * the check. The lesson worth keeping: a shared component's markup is an interface too, and
 * "additive" props are not free when something measures the tree.
 */
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

/**
 * The padded inside of a card.
 *
 * `Card` carries NO padding and `CardHead` supplies its own `px-4 sm:px-5`, which means any body
 * placed after a head has to remember to bring the same inset - and several did not. The symptom
 * was reported twice: the payslip document actions sat ~23px left of the heading above them, and
 * then the whole "Change assignment" form ran flush to the card border while every card around it
 * was inset. Both were the same omission at different call sites.
 *
 * Naming it makes the padding the default thing to reach for instead of a value to remember. It
 * is deliberately NOT folded into `Card`: plenty of cards hold a table, a `<dl>` with its own
 * dividers, or an `Empty` that must span the full width, and blanket padding would break those -
 * which is why `Card` had none to begin with.
 */
export function CardBody({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`px-4 py-4 sm:px-5 ${className}`}>{children}</div>;
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

/* ===========================================================================
 * The pieces the redesigned sign-in and dashboard are built from.
 *
 * They live HERE, beside the other primitives, rather than inside the two screens that needed
 * them - a KPI card, an avatar and an action tile are the three things every screen added after
 * this one will want, and a copy inside `page.tsx` is how a design system stops being one.
 *
 * TONE IS SEMANTIC AND IT IS SPENT SPARINGLY. `tone` tints an icon tile and a bar; it never
 * tints a large area, and it is never the only carrier of meaning (WCAG 1.4.1) - every caller
 * names the state in text too. `brand` gold stays confined to brand accents and the pending
 * action, exactly as DEC-054 and the header of globals.css require, so that amber keeps meaning
 * "pending / late" rather than competing with the logo.
 * =========================================================================== */

export type Tone = 'plain' | 'good' | 'warn' | 'bad' | 'brand' | 'info' | 'violet';

const TILE: Record<Tone, string> = {
  plain: 'bg-ink-100 text-ink-600 ring-ink-200',
  good: 'bg-emerald-50 text-emerald-700 ring-emerald-100',
  warn: 'bg-amber-50 text-amber-700 ring-amber-100',
  bad: 'bg-rose-50 text-rose-700 ring-rose-100',
  brand: 'bg-brand-50 text-brand-700 ring-brand-100',
  info: 'bg-sky-50 text-sky-700 ring-sky-100',
  /* Violet already means "leave" in STATUS_TONES above; reusing it keeps one meaning per hue. */
  violet: 'bg-violet-50 text-violet-700 ring-violet-100',
};

const FILL: Record<Tone, string> = {
  plain: 'bg-ink-400',
  good: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-rose-500',
  brand: 'bg-brand-500',
  info: 'bg-sky-500',
  violet: 'bg-violet-500',
};

/** A tinted square holding one icon. The unit of iconography in this UI. */
export function IconTile({ icon, tone = 'plain', size = 'md', className = '' }: {
  icon: ReactNode; tone?: Tone; size?: 'sm' | 'md' | 'lg'; className?: string;
}) {
  const dims = { sm: 'h-7 w-7 rounded-md', md: 'h-9 w-9 rounded-lg', lg: 'h-11 w-11 rounded-xl' }[size];
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center ring-1 ring-inset ${dims} ${TILE[tone]} ${className}`}
    >
      {icon}
    </span>
  );
}

/**
 * A summary figure.
 *
 * NOT a restyled `Stat`. `Stat` has 55 call sites across six screens where `tone` colours the
 * VALUE and that is load-bearing - the reports screen uses it to mark a figure as good or bad.
 * Rewriting it would have quietly restyled all six. This is the dashboard's card: the value stays
 * near-black and authoritative, and the semantic lives in the icon tile beside it, which is what
 * keeps a four-card row from turning into four competing colours.
 *
 * `href` is optional. Where a figure has an obvious destination the whole card becomes the link -
 * a 200px target instead of a 60px one - and where it does not, no affordance is invented.
 */
export function KpiCard({ icon, label, value, sub, tone = 'plain', href }: {
  icon: ReactNode; label: string; value: ReactNode; sub?: string; tone?: Tone; href?: string;
}) {
  const body = (
    <div className="flex items-start gap-3">
      <IconTile icon={icon} tone={tone} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px] font-medium text-ink-500">{label}</p>
        <p className="num mt-1 text-[26px] font-semibold leading-none tracking-tight text-ink-900">
          {value}
        </p>
        {sub && <p className="mt-1.5 text-[12.5px] leading-snug text-ink-500">{sub}</p>}
      </div>
    </div>
  );
  const shell = 'block rounded-xl border border-ink-200 bg-white p-4 shadow-[var(--shadow-card)]';
  return href
    ? <Link href={href} className={`${shell} lift`}>{body}</Link>
    : <div className={shell}>{body}</div>;
}

/**
 * Initials, as a stand-in for a photograph this product does not store.
 *
 * `tone="auto"` derives a tint from the name so that the same person is always the same colour in
 * an activity list - which is the only reason to tint one at all. It is a display detail computed
 * from a name already on screen: nothing is stored, logged or sent.
 */
const AVATAR_TINTS = [
  'bg-ink-100 text-ink-700',
  'bg-brand-50 text-brand-700',
  'bg-sky-50 text-sky-700',
  'bg-emerald-50 text-emerald-700',
  'bg-violet-50 text-violet-700',
];

export function Avatar({ name, size = 32, tone = 'plain', className = '' }: {
  name: string; size?: number; tone?: 'plain' | 'auto' | 'dark'; className?: string;
}) {
  const initials = name.trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 997;
  const tint = tone === 'dark'
    ? 'bg-ink-900 text-brand-500'
    : tone === 'auto' ? AVATAR_TINTS[hash % AVATAR_TINTS.length] : 'bg-ink-100 text-ink-700';
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-full font-semibold ${tint} ${className}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
    >
      {initials}
    </span>
  );
}

/**
 * A quick action: one tap to a screen the person can actually use.
 *
 * The caller decides whether to offer it, using the same affordance rule the sidebar follows -
 * visibility is a courtesy, `assertCan` on the route is the control (DEC-053). There is no
 * placeholder variant on purpose: an action tile that does nothing is worse than an absent one.
 */
export function ActionTile({ href, icon, label, tone = 'plain' }: {
  href: string; icon: ReactNode; label: string; tone?: Tone;
}) {
  return (
    <Link
      href={href}
      className="lift group flex items-center gap-3 rounded-xl border border-ink-200 bg-white px-3.5 py-3 shadow-[var(--shadow-card)]"
    >
      <IconTile icon={icon} tone={tone} size="sm" />
      <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink-800">{label}</span>
      <span aria-hidden className="text-ink-300 transition-colors group-hover:text-ink-500">
        <IconChevron size={14} className="flip-rtl" />
      </span>
    </Link>
  );
}

/**
 * A stacked bar: several quantities that together make up a whole.
 *
 * `aria-hidden`, deliberately. Every caller renders the same numbers as text beside it, and a bar
 * that also announces itself makes a screen reader read the leave balance twice. The bar is the
 * redundant, visual copy - so it is the one that stays silent.
 */
export function SegmentBar({ segments, max, className = '' }: {
  segments: { value: number; tone: Tone }[]; max: number; className?: string;
}) {
  const total = max > 0 ? max : 0;
  return (
    <div aria-hidden className={`flex h-2 w-full gap-px overflow-hidden rounded-full bg-ink-100 ${className}`}>
      {segments.map((s, i) => {
        const pct = total > 0 ? Math.max(0, Math.min(100, (s.value / total) * 100)) : 0;
        if (pct <= 0) return null;
        return <span key={i} className={`h-full ${FILL[s.tone]}`} style={{ width: `${pct}%` }} />;
      })}
    </div>
  );
}

/**
 * The taller input the sign-in form uses.
 *
 * A SECOND class rather than a change to `inputCls`: that one is on every form in the product and
 * its vertical rhythm is asserted by the browser suite (B15e-h measure that the masters search
 * input and its button share a row and line up). A login field wants ~44px and a table filter
 * does not, so they are two decisions, not one.
 */
const inputLgBase =
  'block w-full rounded-lg border-0 bg-white px-3.5 py-2.5 text-[14.5px] text-ink-900 ring-1 ring-inset ring-ink-300 transition-shadow placeholder:text-ink-400 hover:ring-ink-400 focus:ring-2 focus:ring-inset focus:ring-ink-900 focus-visible:outline-none';

/**
 * The margin is SEPARATE from the field styling.
 *
 * `inputCls` folds its `mt-1` into the class string, which is fine for a bare input under a
 * label - and wrong the moment the input is wrapped. `PasswordInput` puts the reveal button in a
 * `relative` box and centres it with `top-1/2`: with the margin on the INPUT, the box is 6px
 * taller than the field and the button sits visibly low inside it. So the wrapper owns the
 * spacing and the field owns its own appearance.
 */
export const inputClsLg = `mt-1.5 ${inputLgBase}`;

/**
 * A password field with a show/hide control.
 *
 * The toggle is a real `<button type="button">` - not a div, so it is tabbable and operable by
 * keyboard for free, and `type="button"` because a bare button inside a form submits it, which
 * would have made revealing the password attempt a sign-in. `aria-pressed` states which mode it
 * is in rather than relying on the icon, and the icon is decorative.
 *
 * The input keeps whatever `id` the caller gives it, and toggling only its `type` - so autofill,
 * password managers and the browser suite that drives `#password` are all unaffected.
 */
export function PasswordInput({
  id, value, onChange, shown, onToggle, className = '', ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & {
  id: string; shown: boolean; onToggle: () => void;
}) {
  const t = useT();
  return (
    <div className="relative mt-1.5">
      <input
        {...rest}
        id={id}
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        className={`${inputLgBase} pe-11 ${className}`}
      />
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={shown}
        aria-label={shown ? t('login.hidePassword') : t('login.showPassword')}
        aria-controls={id}
        className="absolute end-1.5 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-md text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-700"
      >
        {shown ? <IconEyeOff size={17} /> : <IconEye size={17} />}
      </button>
    </div>
  );
}
