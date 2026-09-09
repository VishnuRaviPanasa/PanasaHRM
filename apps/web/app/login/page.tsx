'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, ApiError, type Actor } from '@/lib/api';
import { Button, Field, inputCls } from '@/components/ui';
import { ArtMark } from '@/components/logo';
import { LanguageSwitcher, useT } from '@/lib/i18n';
import { withBasePath } from '@/lib/base-path';

const DEMO_USERS = [
  { email: 'vishnu.ravi@panasatech.com', label: 'Vishnu Ravi', role: 'Senior Engineer' },
  { email: 'priya.menon@panasatech.com', label: 'Priya Menon', role: 'Engineering Manager' },
  { email: 'deepa.suresh@panasatech.com', label: 'Deepa Suresh', role: 'HR Manager' },
];

/*
 * THE DEMO PANEL IS OFF UNLESS SOMEBODY TURNS IT ON, and it never shows a password.
 *
 * This page used to hardcode the shared demo password in three places: the initial password
 * state, the per-account click handler, and a line that displayed it outright. On localhost that
 * is a convenience. On a reachable host it is a working credential published on an unauthenticated
 * page - anyone who finds the URL signs in as HR Manager and reads every payslip, document, salary
 * figure and home address in the system. The literal is not repeated here, so a secret scanner
 * has nothing to find and nobody can copy it out of a comment.
 *
 * It also actively broke the first hosted deployment. The deploy correctly set HRM_DEMO_PASSWORD
 * to a generated value, so the prefilled literal was simply wrong, and the page confidently
 * displayed a password that could not work - which reads as "the app is broken" rather than
 * "you typed the wrong password".
 *
 * So: opt-in, and the password is never rendered at all. Selecting an account fills the EMAIL and
 * clears the password, because the point of the shortcut is not having to type an address.
 */
const SHOW_DEMO = process.env.NEXT_PUBLIC_SHOW_DEMO_ACCOUNTS === 'true';

export default function LoginPage() {
  const t = useT();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post<{ actor: Actor }>('/auth/login', { email, password });
      router.replace('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in');
      setBusy(false);
    }
  }

  return (
    <main id="main" className="relative grid min-h-screen lg:grid-cols-2">
      {/*
        * THE LANGUAGE SWITCHER SITS IN THE CORNER, which is where a page-level control belongs and
        * where people look for one. It used to sit inside the centred form block, so on a tall
        * window it floated halfway down the page above the heading - attached to nothing.
        *
        * `end-4`, not `right-4`: in Arabic the corner that means "here are the page's controls" is
        * the top LEFT, because that is where the reading direction starts. `dir` on <html> flips it.
        *
        * It stays over the LIGHT column at every width. That is not incidental - it is the fix
        * from DEC-128 holding: on the dark pitch panel this control measured 2.07:1 against the
        * 4.5:1 WCAG needs, and that panel is `hidden lg:flex` so below 1024px it did not render at
        * all. Corner, light ground, present at every width.
        */}
      <div className="absolute top-4 end-4 z-10">
        <LanguageSwitcher />
      </div>
      {/* The pitch, so the first screen already says what the product is. */}
      <section className="hidden flex-col justify-between bg-ink-900 p-10 text-white lg:flex">
        <div className="flex items-center gap-2.5">
          <ArtMark size={32} />
          <span className="text-[15px] font-semibold">{t('app.name')}</span>
        </div>
        <div className="max-w-md">
          <h1 className="text-[30px] font-semibold leading-tight">
            {t('login.tagline')}
          </h1>
          <p className="mt-4 text-[14.5px] leading-relaxed text-ink-300">
            HR gets employee, leave and attendance visibility. Managers also get project and
            work-effort visibility — without treating work logs as attendance.
          </p>
          <dl className="mt-8 grid grid-cols-2 gap-x-6 gap-y-4 text-[13px]">
            {[
              ['Effective-dated records', 'Reconstruct the org as it was on any past date'],
              ['Leave as a ledger', 'Every balance traces to an entry, never overwritten'],
              ['Separate domains', 'Attendance and effort reconcile, neither derives'],
              ['Approvals with a trail', 'Who decided what, and when'],
            ].map(([t, d]) => (
              <div key={t}>
                <dt className="font-medium text-white">{t}</dt>
                <dd className="mt-0.5 text-ink-400">{d}</dd>
              </div>
            ))}
          </dl>
        </div>
        <p className="text-[12.5px] text-ink-500">{t('login.place')}</p>
      </section>

      <section className="flex items-center justify-center px-5 py-12 sm:px-8">
        <div className="w-full max-w-sm">
          {/* The wordmark, for the narrow layout where the pitch panel is not rendered. */}
          <div className="flex items-center gap-2.5 lg:hidden">
            <ArtMark size={32} />
            <span className="text-[15px] font-semibold text-ink-900">{t('app.name')}</span>
          </div>

          <h2 className="mt-8 text-[22px] font-semibold text-ink-900 lg:mt-0">{t('login.title')}</h2>
          {/*
            * A new joiner arrives here first, code in hand, and there was nothing to click. The
            * link is quiet rather than prominent - most visitors already have a password.
            */}
          <a
            href={withBasePath('/activate')}
            className="mt-2 inline-block text-[12.5px] font-medium text-brand-700 hover:underline"
          >
            {t('login.activate')} →
          </a>

          <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
            <Field label={t('login.email')} htmlFor="email">
              <input
                id="email" type="email" required autoComplete="username" className={inputCls}
                value={email} onChange={(e) => setEmail(e.target.value)}
                aria-invalid={!!error} aria-describedby={error ? 'login-error' : undefined}
              />
            </Field>
            <Field label={t('login.password')} htmlFor="password">
              <input
                id="password" type="password" required autoComplete="current-password" className={inputCls}
                value={password} onChange={(e) => setPassword(e.target.value)}
                aria-invalid={!!error} aria-describedby={error ? 'login-error' : undefined}
              />
            </Field>

            {error && (
              <p id="login-error" role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-[13px] text-rose-800 ring-1 ring-inset ring-rose-200">
                {error}
              </p>
            )}

            <Button type="submit" busy={busy} className="w-full">{t('login.submit')}</Button>
          </form>

          {SHOW_DEMO && (
            <div className="mt-8 rounded-lg bg-ink-100 p-3.5">
              <p className="text-[12px] font-semibold uppercase tracking-wide text-ink-500">
                {t('login.demoAccounts')}
              </p>
              <ul className="mt-2 space-y-1">
                {DEMO_USERS.map((u) => (
                  <li key={u.email}>
                    <button
                      type="button"
                      onClick={() => { setEmail(u.email); setPassword(''); setError(null); }}
                      className="flex w-full items-baseline justify-between gap-3 rounded px-1.5 py-1 text-start text-[13px] hover:bg-white"
                    >
                      <span className="font-medium text-ink-800">{u.label}</span>
                      <span className="text-ink-500">{u.role}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {/*
                * No password here, and not because it is inconvenient to show. The demo password
                * is whatever HRM_DEMO_PASSWORD was set to at seed time - this page cannot know it,
                * and the previous hardcoded value was wrong the moment a deployment set a real one.
                */}
              <p className="mt-2 px-1.5 text-[12px] text-ink-500">
                Selecting a name fills the email. Ask whoever set up this environment for the
                password.
              </p>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
