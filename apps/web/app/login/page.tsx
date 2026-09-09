'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, ApiError, type Actor } from '@/lib/api';
import { Button, Field, inputCls } from '@/components/ui';
import { ArtMark } from '@/components/logo';

const DEMO_USERS = [
  { email: 'vishnu.ravi@panasatech.com', label: 'Vishnu Ravi', role: 'Senior Engineer' },
  { email: 'priya.menon@panasatech.com', label: 'Priya Menon', role: 'Engineering Manager' },
  { email: 'deepa.suresh@panasatech.com', label: 'Deepa Suresh', role: 'HR Manager' },
];

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('vishnu.ravi@panasatech.com');
  const [password, setPassword] = useState('panasa2026');
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
    <main id="main" className="grid min-h-screen lg:grid-cols-2">
      {/* The pitch, so the first screen already says what the product is. */}
      <section className="hidden flex-col justify-between bg-ink-900 p-10 text-white lg:flex">
        <div className="flex items-center gap-2.5">
          <ArtMark size={32} />
          <span className="text-[15px] font-semibold">ART HRM</span>
        </div>
        <div className="max-w-md">
          <h1 className="text-[30px] font-semibold leading-tight">
            People, leave, attendance and project effort in one place.
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
        <p className="text-[12.5px] text-ink-500">Art Technology and Software · Kochi, Kerala</p>
      </section>

      <section className="flex items-center justify-center px-5 py-12 sm:px-8">
        <div className="w-full max-w-sm">
          <div className="flex items-center gap-2.5 lg:hidden">
            <ArtMark size={32} />
            <span className="text-[15px] font-semibold text-ink-900">ART HRM</span>
          </div>

          <h2 className="mt-8 text-[22px] font-semibold text-ink-900 lg:mt-0">Sign in</h2>
          <p className="mt-1 text-[13.5px] text-ink-500">Use your ART work email.</p>

          <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
            <Field label="Work email" htmlFor="email">
              <input
                id="email" type="email" required autoComplete="username" className={inputCls}
                value={email} onChange={(e) => setEmail(e.target.value)}
                aria-invalid={!!error} aria-describedby={error ? 'login-error' : undefined}
              />
            </Field>
            <Field label="Password" htmlFor="password">
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

            <Button type="submit" busy={busy} className="w-full">Sign in</Button>
          </form>

          <div className="mt-8 rounded-lg bg-ink-100 p-3.5">
            <p className="text-[12px] font-semibold uppercase tracking-wide text-ink-500">Demo accounts</p>
            <ul className="mt-2 space-y-1">
              {DEMO_USERS.map((u) => (
                <li key={u.email}>
                  <button
                    type="button"
                    onClick={() => { setEmail(u.email); setPassword('panasa2026'); setError(null); }}
                    className="flex w-full items-baseline justify-between gap-3 rounded px-1.5 py-1 text-left text-[13px] hover:bg-white"
                  >
                    <span className="font-medium text-ink-800">{u.label}</span>
                    <span className="text-ink-500">{u.role}</span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-2 px-1.5 text-[12px] text-ink-500">Password for all: panasa2026</p>
          </div>
        </div>
      </section>
    </main>
  );
}
