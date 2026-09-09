'use client';

/**
 * "Set up your login" - where a new joiner spends their activation code and chooses a password.
 *
 * OUTSIDE THE `(app)` ROUTE GROUP, deliberately. That group's layout fetches `/auth/me` and
 * renders the navigation shell, and the entire point of this page is that the person cannot
 * authenticate yet. Putting it inside would mean a page that requires a session in order to
 * create the credential that grants one.
 *
 * THE PASSWORD RULES ARE SHOWN BEFORE THEY ARE BROKEN. ADR-0009 binds the policy to NIST SP
 * 800-63B - length, no composition rules, no forced rotation - so there is one rule to state and
 * it is stated up front rather than delivered as a rejection after the fact. The server is still
 * the authority; this only spares somebody a round trip.
 *
 * The code field is forgiving on purpose: somebody is retyping it from a sticky note, so case,
 * spaces and the dashes are all normalised here and again on the server.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button, Field, inputCls } from '@/components/ui';
import { ArtMark } from '@/components/logo';
import { LanguageSwitcher, useT } from '@/lib/i18n';
import { withBasePath } from '@/lib/base-path';

const GROUPS = 4;
const GROUP = 5;
const LENGTH = GROUPS * GROUP;
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Normalise what was typed, AND report what had to be thrown away.
 *
 * The first version returned only the tidied string, so it silently deleted every character
 * outside the alphabet. Typing a few words produced `KANNA-NPANA-SATEC-HCM` - the exact shape of
 * a real code, out of text that was nothing of the kind - and the form then sat there with a
 * disabled button and no explanation at all. Reported as "unable to set password", and rightly.
 *
 * So the drop count comes back too. Silently reshaping somebody's input into something that looks
 * valid is worse than rejecting it, because it destroys the only clue they had.
 */
function tidy(raw: string): { display: string; flat: string; dropped: number } {
  const chars = raw.match(/[^\s-]/g) ?? [];
  const dropped = chars.filter((c) => !ALPHABET.includes(c.toUpperCase())).length;
  const flat = raw.toUpperCase().split('').filter((c) => ALPHABET.includes(c)).join('')
    .slice(0, LENGTH);
  return {
    display: flat.replace(new RegExp(`(.{${GROUP}})(?=.)`, 'g'), '$1-'),
    flat,
    dropped,
  };
}

export default function ActivatePage() {
  const t = useT();
  const router = useRouter();
  const [code, setCode] = useState('');
  const [dropped, setDropped] = useState(0);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const flat = code.replace(/-/g, '');
  const short = password.length > 0 && password.length < 12;
  const mismatch = confirm.length > 0 && confirm !== password;

  /*
   * WHY THE CODE PROBLEM IS SHOWN, AND WHY IT IS SPECIFIC.
   *
   * The activate endpoint gives one deliberately vague message for every failure, so nothing
   * confirms whether a code was real. LENGTH is different in kind: it says nothing about which
   * codes exist, only about what a code looks like, so being exact here leaks nothing - and it is
   * the difference between somebody fixing their typo and somebody staring at a grey button.
   */
  const codeProblem = flat.length === 0
    ? null
    : dropped > 0
      ? t('act.codeJunk')
      : flat.length !== LENGTH ? t('act.codeIncomplete', { have: flat.length, need: LENGTH })
        : null;

  // ENABLED as soon as every field has something in it. A disabled control that does not say why
  // is the defect that was reported; the form explains rather than refusing in silence.
  const filled = flat.length > 0 && password.length > 0 && confirm.length > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const problem = codeProblem
      ?? (password.length < 12 ? t('act.tooShort') : null)
      ?? (confirm !== password ? t('act.mismatch') : null);
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ ok: boolean; email: string }>('/identity/activate',
        { code, password });
      setDone(r.email);
      // Straight to sign-in, because activating does NOT create a session - the two are separate
      // acts and only the login path mints a cookie.
      setTimeout(() => router.replace('/login'), 2500);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('act.failed'));
      setBusy(false);
    }
  }

  return (
    <main id="main" className="relative flex min-h-screen items-center justify-center px-5 py-12">
      {/* Corner, matching the sign-in page it is reached from. */}
      <div className="absolute top-4 end-4 z-10">
        <LanguageSwitcher />
      </div>
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2.5">
          <ArtMark size={32} />
          <span className="text-[15px] font-semibold text-ink-900">{t('app.name')}</span>
        </div>

        {done ? (
          <div className="mt-8">
            <h1 className="text-[22px] font-semibold text-ink-900">{t('act.doneTitle')}</h1>
            <p className="mt-2 text-[13.5px] leading-relaxed text-ink-600">
              {t('act.doneBody', { email: done })}
            </p>
            <Button className="mt-5" onClick={() => router.replace('/login')}>
              {t('act.goSignIn')}
            </Button>
          </div>
        ) : (
          <>
            <h1 className="mt-8 text-[22px] font-semibold text-ink-900">{t('act.title')}</h1>
            <p className="mt-1 text-[13.5px] leading-relaxed text-ink-500">{t('act.intro')}</p>

            <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
              <Field
                label={t('act.code')}
                hint={t('act.codeHint')}
                error={codeProblem ?? undefined}
                htmlFor="act-code"
              >
                <input
                  id="act-code"
                  value={code}
                  onChange={(e) => {
                    const r = tidy(e.target.value);
                    setCode(r.display);
                    setDropped(r.dropped);
                    setError(null);
                  }}
                  autoComplete="one-time-code"
                  inputMode="text"
                  spellCheck={false}
                  aria-invalid={!!codeProblem}
                  placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
                  className={`${inputCls} font-mono tracking-[0.12em]`}
                />
              </Field>

              <Field
                label={t('act.password')}
                hint={t('act.passwordHint')}
                error={short ? t('act.tooShort') : undefined}
                htmlFor="act-pw"
              >
                <input
                  id="act-pw" type="password" value={password} autoComplete="new-password"
                  onChange={(e) => setPassword(e.target.value)} className={inputCls}
                  aria-invalid={short}
                />
              </Field>

              <Field
                label={t('act.confirm')}
                error={mismatch ? t('act.mismatch') : undefined}
                htmlFor="act-pw2"
              >
                <input
                  id="act-pw2" type="password" value={confirm} autoComplete="new-password"
                  onChange={(e) => setConfirm(e.target.value)} className={inputCls}
                  aria-invalid={mismatch}
                />
              </Field>

              {error && (
                <p id="act-error" role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-[13px] text-rose-800 ring-1 ring-inset ring-rose-200">
                  {error}
                </p>
              )}

              <Button
                id="act-submit"
                type="submit"
                busy={busy}
                disabled={!filled || busy}
                className="w-full"
              >
                {t('act.submit')}
              </Button>
            </form>

            {/*
              * THE MISSING EXIT. This page assumed everybody arriving had been given a code.
              * Somebody who has not - which is how the defect above was found - had nothing to
              * click and no idea who to ask.
              */}
            <p className="mt-5 text-[12.5px] leading-relaxed text-ink-600">
              <span className="font-medium">{t('act.noCode')}</span> {t('act.noCodeHint')}{' '}
              <a href={withBasePath('/login')} className="font-medium text-brand-700 hover:underline">
                {t('act.backToSignIn')}
              </a>
            </p>
            <p className="mt-3 text-[12.5px] leading-relaxed text-ink-500">{t('act.privacy')}</p>
          </>
        )}
      </div>
    </main>
  );
}
