'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, ApiError, type Actor } from '@/lib/api';
import { Avatar, Button, Field, PasswordInput, inputClsLg } from '@/components/ui';
import { ArtMark } from '@/components/logo';
import { IconHistory, IconLayers, IconListCheck, IconShield } from '@/components/icons';
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
 *
 * The 2026-09-10 redesign kept every line of that and only changed how it LOOKS. The brief asked
 * that demo accounts read as an intentional part of the product rather than as leftover developer
 * controls, so the panel is now a titled card with avatars - not a bare list of grey buttons.
 */
const SHOW_DEMO = process.env.NEXT_PUBLIC_SHOW_DEMO_ACCOUNTS === 'true';

export default function LoginPage() {
  const t = useT();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [shown, setShown] = useState(false);
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
      setError(err instanceof ApiError ? err.message : t('login.couldNotSignIn'));
      setBusy(false);
    }
  }

  /*
   * The four capabilities, each with a glyph. The COPY lives in the dictionary - it used to be an
   * array of English tuples in this file, which is why the Arabic sign-in page showed four
   * English paragraphs.
   *
   * `titleKey`/`bodyKey`, not `title`/`body` - the same naming NAV_GROUPS uses, and for the same
   * reason. `i18n.test.mjs` flags `title: '...'` as an untranslated string literal, which is
   * exactly the shape it should flag; naming the field for what it holds - a KEY - keeps the
   * check honest instead of teaching it to ignore a pattern that is usually a real defect.
   */
  const capabilities = [
    { Icon: IconHistory, titleKey: 'login.cap.temporal', bodyKey: 'login.cap.temporalBody' },
    { Icon: IconListCheck, titleKey: 'login.cap.ledger', bodyKey: 'login.cap.ledgerBody' },
    { Icon: IconLayers, titleKey: 'login.cap.domains', bodyKey: 'login.cap.domainsBody' },
    { Icon: IconShield, titleKey: 'login.cap.trail', bodyKey: 'login.cap.trailBody' },
  ] as const;

  return (
    <main
      id="main"
      className="relative min-h-dvh bg-ink-50 lg:grid lg:min-h-dvh lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]"
    >
      {/*
        * THE LANGUAGE SWITCHER SITS IN THE CORNER, which is where a page-level control belongs and
        * where people look for one. It used to sit inside the centred form block, so on a tall
        * window it floated halfway down the page above the heading - attached to nothing.
        *
        * `end-4`, not `right-4`: in Arabic the corner that means "here are the page's controls" is
        * the top LEFT, because that is where the reading direction starts. `dir` on <html> flips it.
        *
        * It stays over the LIGHT column at every width, and that is not incidental - it is the fix
        * from DEC-128 holding. On the dark pitch panel this control measured 2.07:1 against the
        * 4.5:1 WCAG needs, and that panel is `hidden lg:flex` so below 1024px it did not render at
        * all. The grid and `end-*` flip TOGETHER under `dir="rtl"`, so the corner lands over the
        * form column in both languages. Corner, light ground, present at every width.
        *
        * It is also the page's ONLY <select>, which the browser suite relies on (B02a-d locate the
        * switcher as `document.querySelector('select')`). Anything added above it in the DOM would
        * silently retarget four checks - so if this page ever needs a second dropdown, it goes
        * after this one.
        */}
      <div className="absolute top-4 end-4 z-20">
        <LanguageSwitcher />
      </div>

      {/*
        * The pitch panel: what the product is, before anybody has signed in.
        *
        * `justify-between` over three children used to leave the headline stranded a third of the
        * way down a tall window with a void above it. It is now a single vertically centred column
        * with the lockup pinned to the top and the legal line to the bottom, so the panel holds
        * its composition from 768px to an ultrawide.
        */}
      <section className="pitch relative hidden flex-col overflow-hidden p-10 text-white lg:flex xl:p-14">
        <div className="flex items-center gap-3">
          <ArtMark size={38} />
          <span className="text-[16px] font-semibold tracking-tight">
            ART <span className="font-normal text-ink-300">HRM</span>
          </span>
        </div>

        <div className="my-auto max-w-lg py-12">
          <h1 className="text-[32px] font-semibold leading-[1.15] tracking-tight xl:text-[38px]">
            {t('login.tagline')}
          </h1>
          <p className="mt-5 max-w-md text-[14.5px] leading-relaxed text-ink-300">
            {t('login.blurb')}
          </p>

          <ul className="mt-10 space-y-5">
            {capabilities.map(({ Icon, titleKey, bodyKey }) => (
              <li key={titleKey} className="flex items-start gap-3.5">
                <span
                  aria-hidden
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white/5 text-brand-500 ring-1 ring-inset ring-white/10"
                >
                  <Icon size={19} />
                </span>
                <div className="min-w-0">
                  <p className="text-[13.5px] font-semibold text-white">{t(titleKey)}</p>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-ink-400">{t(bodyKey)}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-ink-400">
          <span>{t('login.place')}</span>
          <span aria-hidden className="text-ink-700">·</span>
          <span>{t('login.rights')}</span>
        </div>
      </section>

      {/* The sign-in column. */}
      <section className="flex min-h-dvh items-center justify-center px-5 py-16 sm:px-8 lg:min-h-0 lg:py-10">
        <div className="rise w-full max-w-[25.5rem]">
          {/*
            * The compact lockup, for every width where the pitch panel is not rendered. It carries
            * the tagline too - on a phone this is the only place the product says what it is.
            */}
          <div className="mb-8 lg:hidden">
            <div className="flex items-center gap-3">
              <ArtMark size={34} />
              <span className="text-[15.5px] font-semibold tracking-tight text-ink-900">
                ART <span className="font-normal text-ink-500">HRM</span>
              </span>
            </div>
            <p className="mt-3 max-w-[22rem] text-[13.5px] leading-relaxed text-ink-500">
              {t('login.tagline')}
            </p>
          </div>

          <div className="rounded-2xl border border-ink-200 bg-white p-6 shadow-[var(--shadow-md)] sm:p-8">
            <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-brand-700">
              {t('login.welcome')}
            </p>
            <h2 className="mt-1.5 text-[24px] font-semibold text-ink-900">{t('login.title')}</h2>
            <p className="mt-1.5 text-[13.5px] text-ink-500">{t('login.subtitle')}</p>

            <form onSubmit={submit} className="mt-7 space-y-4" noValidate>
              <Field label={t('login.email')} htmlFor="email">
                <input
                  id="email"
                  type="email"
                  required
                  autoComplete="username"
                  autoFocus
                  className={inputClsLg}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  aria-invalid={!!error}
                  aria-describedby={error ? 'login-error' : undefined}
                />
              </Field>
              <Field label={t('login.password')} htmlFor="password">
                <PasswordInput
                  id="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  shown={shown}
                  onToggle={() => setShown((s) => !s)}
                  aria-invalid={!!error}
                  aria-describedby={error ? 'login-error' : undefined}
                />
              </Field>

              {error && (
                <p
                  id="login-error"
                  role="alert"
                  className="flex items-start gap-2 rounded-lg bg-rose-50 px-3.5 py-2.5 text-[13px] text-rose-800 ring-1 ring-inset ring-rose-200"
                >
                  <span aria-hidden className="mt-px font-semibold">!</span>
                  <span>{error}</span>
                </p>
              )}

              <Button type="submit" size="lg" busy={busy} className="mt-1 w-full">
                {t('login.submit')}
              </Button>
            </form>

            {/*
              * A new joiner arrives here first, code in hand, and there was nothing to click. It is
              * a quiet secondary route rather than a second call to action - most visitors already
              * have a password - but it is now separated by a rule so it reads as a different job
              * instead of a link hanging under the heading.
              */}
            <div className="mt-6 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-ink-100 pt-5 text-[13px]">
              <span className="text-ink-500">{t('login.newJoiner')}</span>
              <a
                href={withBasePath('/activate')}
                className="inline-flex items-center gap-1 font-semibold text-brand-700 hover:underline"
              >
                {t('login.activate')}
                <span aria-hidden className="flip-rtl">→</span>
              </a>
            </div>
          </div>

          <p className="mt-5 flex items-start gap-2 px-1 text-[12.5px] leading-relaxed text-ink-500">
            <span aria-hidden className="mt-px text-ink-400"><IconShield size={15} /></span>
            <span>{t('login.trust')}</span>
          </p>
          <p className="mt-2 px-1 text-[12.5px] leading-relaxed text-ink-500">{t('login.needHelp')}</p>

          {SHOW_DEMO && (
            <div className="mt-7 overflow-hidden rounded-xl border border-ink-200 bg-white shadow-[var(--shadow-card)]">
              <p className="border-b border-ink-100 bg-ink-50 px-4 py-2.5 text-[11.5px] font-semibold uppercase tracking-[0.07em] text-ink-500">
                {t('login.demoAccounts')}
              </p>
              <ul className="divide-y divide-ink-100">
                {DEMO_USERS.map((u) => (
                  <li key={u.email}>
                    <button
                      type="button"
                      onClick={() => { setEmail(u.email); setPassword(''); setError(null); }}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-start transition-colors hover:bg-ink-50"
                    >
                      <Avatar name={u.label} size={30} tone="auto" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-ink-800">{u.label}</span>
                        <span className="block truncate text-[12px] text-ink-500">{u.role}</span>
                      </span>
                      <span aria-hidden className="flip-rtl text-[13px] text-ink-300">→</span>
                    </button>
                  </li>
                ))}
              </ul>
              {/*
                * No password here, and not because it is inconvenient to show. The demo password
                * is whatever HRM_DEMO_PASSWORD was set to at seed time - this page cannot know it,
                * and the previous hardcoded value was wrong the moment a deployment set a real one.
                */}
              <p className="border-t border-ink-100 px-4 py-2.5 text-[12px] leading-relaxed text-ink-500">
                {t('login.demoHint')}
              </p>
            </div>
          )}

          {/* The legal line lives on the dark panel at lg and up; below that it belongs here. */}
          <p className="mt-8 text-center text-[12px] text-ink-400 lg:hidden">
            {t('login.place')} · {t('login.rights')}
          </p>
        </div>
      </section>
    </main>
  );
}
