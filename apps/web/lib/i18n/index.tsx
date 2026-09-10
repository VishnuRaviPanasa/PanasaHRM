'use client';

/**
 * The locale runtime: a provider, a `t()` hook, and a switcher.
 *
 * WHERE THE LOCALE LIVES, and why in two places. A COOKIE, because `<html lang dir>` is rendered
 * by a server component and must be correct on the FIRST paint - a client-only choice would paint
 * the page left-to-right and then flip it, which is visibly broken and moves focus. And
 * `localStorage`, because the cookie is not readable synchronously in every context and a
 * per-viewer preference is exactly what browser storage is for. The cookie is authoritative; the
 * mirror is a convenience, and both are wrapped because a browser with site data blocked throws
 * on the accessor itself rather than returning empty.
 *
 * WHY CHANGING LOCALE RELOADS. `dir` is on the `<html>` element, which this client tree does not
 * own. Setting it imperatively from here would work for the current page and then be undone by
 * the next server render, so the two would disagree depending on how you arrived. One reload
 * makes the server the single source of truth for direction, and it happens once per switch.
 */

import { createContext, useCallback, useContext, useMemo } from 'react';
import {
  DICTIONARIES, DIRECTION, LOCALES, LOCALE_COOKIE, LOCALE_NAME, isLocale,
  type Locale, type MessageKey,
} from './dictionary';

/*
 * Re-exported for client callers' convenience. `LOCALE_COOKIE` and `isLocale` are DEFINED in
 * dictionary.ts, not here: the root layout is a server component and calls them, which a
 * 'use client' module cannot serve. See the note beside them there.
 */
export {
  LOCALES, LOCALE_NAME, DIRECTION, LOCALE_COOKIE, isLocale, type Locale, type MessageKey,
} from './dictionary';

interface Ctx {
  locale: Locale;
  dir: 'ltr' | 'rtl';
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  setLocale: (l: Locale) => void;
}

const I18nContext = createContext<Ctx | null>(null);

/**
 * Substitutes `{name}` placeholders.
 *
 * Deliberately minimal - no plurals, no dates, no numbers. Plural rules differ between English
 * and Arabic in ways a naive `n === 1` cannot express (Arabic has six categories), so anything
 * genuinely count-dependent gets two keys and picks between them at the call site, where the
 * caller can see what it is choosing. Dates and numbers go through `Intl` instead, which already
 * knows both locales.
 */
const interpolate = (template: string, vars?: Record<string, string | number>): string => {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole);
};

export function I18nProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  const setLocale = useCallback((next: Locale) => {
    if (next === locale) return;
    try {
      // A year, path-wide, SameSite=Lax. Not a security-relevant value - it selects a dictionary
      // - so it is deliberately readable by the server render that needs it.
      document.cookie = `${LOCALE_COOKIE}=${next};path=/;max-age=31536000;samesite=lax`;
      window.localStorage.setItem(LOCALE_COOKIE, next);
    } catch {
      /* site data blocked - the cookie above is what matters, and the reload still applies it */
    }
    window.location.reload();
  }, [locale]);

  const value = useMemo<Ctx>(() => {
    const dict = DICTIONARIES[locale] ?? DICTIONARIES.en;
    return {
      locale,
      dir: DIRECTION[locale],
      setLocale,
      /*
       * A missing key cannot happen - `ar` is typed from `en`, so the build fails first. The
       * fallback exists for a value that arrives from outside TypeScript (an old cookie naming a
       * locale that has since been removed) and returns ENGLISH rather than the raw key, because
       * a person reading a screen is better served by the wrong language than by
       * "attendance.emptyHint".
       */
      t: (key, vars) => interpolate(dict[key] ?? DICTIONARIES.en[key] ?? key, vars),
    };
  }, [locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): Ctx {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    // Every screen sits inside the provider. Throwing beats silently rendering English, which is
    // the failure mode where half a page translates and nobody notices which half.
    throw new Error('useI18n outside I18nProvider - wrap the tree in <I18nProvider>');
  }
  return ctx;
}

/** The common case: just the translate function. */
export const useT = () => useI18n().t;

/**
 * Locale-aware formatting.
 *
 * NOTHING STORED CHANGES. These format for DISPLAY only: a date is still an ISO `YYYY-MM-DD` in
 * the database and in every request, and money is still integer paise. Arabic here uses
 * `ar-AE` with Latin digits (`nu-latn`) rather than Eastern Arabic numerals - an HR screen sits
 * beside payroll exports and bank files that use Latin digits, and a payslip whose net pay reads
 * ٦٢٨٠٠ next to a bank statement reading 62800 invites a transcription error. Direction changes;
 * the digits do not.
 */
export const localeTag = (l: Locale): string => (l === 'ar' ? 'ar-AE-u-nu-latn' : 'en-IN');

/**
 * The office timezone, for rendering a TIMESTAMP as a wall-clock time.
 *
 * A punch is a `timestamptz`; showing one requires choosing a zone, and the honest choice for a
 * single-site company in Kochi is the office's, not the reader's browser. It was already
 * hardcoded inside `punch-card.tsx`; naming it once here means the punch list, the elapsed clock
 * and the activity feed cannot disagree about what time something happened - which they would
 * have the moment a second screen picked a different default.
 *
 * KNOWN LIMITATION, recorded rather than hidden: the authoritative value is
 * `org_setting['company.timezone']`, which `fn_business_date()` already reads server-side. No
 * endpoint exposes it to the browser yet, so this constant duplicates it. When one does, this is
 * the single line to change - and a DATE never goes through here, only a timestamp.
 */
export const OFFICE_TZ = 'Asia/Kolkata';

export function useFormat() {
  const { locale } = useI18n();
  const tag = localeTag(locale);
  return useMemo(() => ({
    /** An ISO date, read back as UTC so the label never shifts a day in either direction. */
    date: (iso: string, opts?: Intl.DateTimeFormatOptions) => {
      if (!/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso;
      const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(tag, {
        day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC', ...opts,
      });
    },
    /**
     * A TIMESTAMP as a 24-hour wall-clock time in the office zone. 24-hour in both locales: an
     * attendance record read beside a payroll export should not need am/pm disambiguated.
     */
    time: (at: string | Date | null | undefined) => {
      if (!at) return '—';
      /* A `Date` is accepted as well as an ISO string so that a caller holding a live clock does
       * not have to serialise it first - `new Date().toISOString()` is banned in this codebase
       * (S2 in business-date.test.mjs), because that expression is how four screens ended up a
       * day behind before 05:30 IST. Nothing here derives a DATE; this formats a TIME. */
      const d = at instanceof Date ? at : new Date(at);
      if (Number.isNaN(d.getTime())) return '—';
      return d.toLocaleTimeString(tag, {
        hour: '2-digit', minute: '2-digit', hour12: false, timeZone: OFFICE_TZ,
      });
    },
    /** A timestamp as "12 Sep, 14:30" - for a feed, where the day matters as much as the time. */
    dateTime: (iso: string | null | undefined) => {
      if (!iso) return '—';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '—';
      return d.toLocaleString(tag, {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
        hour12: false, timeZone: OFFICE_TZ,
      });
    },
    number: (n: number) => new Intl.NumberFormat(tag).format(n),
  }), [tag]);
}

/**
 * The switcher.
 *
 * A real `<select>`, not a custom menu: it is keyboard operable, screen-reader labelled and
 * touch-friendly on every platform for free, and a language chooser is the last control that
 * should need JavaScript to be usable. Each language is named in its own language, so somebody
 * who cannot read the current one can still find theirs.
 *
 * IT LOOKS LIKE A CONTROL, which it previously did not. It was `border-0 bg-transparent` with a
 * transparent ring until hover, so it read as grey text that happened to sit near a globe - and
 * on the login page's dark panel `text-ink-600` (#4c4c47) on `bg-ink-900` (#17171a) is a contrast
 * ratio of **2.07:1** measured in the browser, against the 4.5:1 that 12.5px text needs. The
 * globe was `ink-400` and passed at 4.8:1, which is why the symptom was a visible globe beside an
 * unreadable word rather than a missing control. It now
 * carries the same inset ring the rest of the app's inputs use (`inputCls`), so the affordance is
 * the project's own rather than a new one, and it no longer depends on the surface behind it.
 */
export function LanguageSwitcher({ className = '' }: { className?: string }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <label className={`flex items-center gap-1.5 ${className}`}>
      <span className="sr-only">{t('app.language')}</span>
      <span aria-hidden="true" className="text-[12px] text-ink-500">🌐</span>
      <select
        value={locale}
        onChange={(e) => isLocale(e.target.value) && setLocale(e.target.value)}
        className="rounded-lg border-0 bg-white py-1 pe-1.5 ps-1.5 text-[12.5px] font-medium text-ink-800 ring-1 ring-inset ring-ink-300 hover:ring-ink-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink-900"
      >
        {LOCALES.map((l) => (
          <option key={l} value={l}>{LOCALE_NAME[l]}</option>
        ))}
      </select>
    </label>
  );
}
