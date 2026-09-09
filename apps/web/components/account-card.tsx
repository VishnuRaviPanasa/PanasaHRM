'use client';

/**
 * The login panel on an employee's profile: does this person have a way in, and if not, give them
 * one.
 *
 * THE CODE IS SHOWN ONCE AND THE SCREEN SAYS SO. Only its SHA-256 was stored, so this is genuinely
 * the only moment the value exists outside the employee's head - not a UI convention that a later
 * "show again" button could quietly break. The panel therefore treats it as something to be handed
 * over now: large, monospaced, grouped in fives, with a copy button and an explicit warning that
 * closing the panel loses it. If it is lost the answer is a reissue, which is the other button.
 *
 * IT NEVER OFFERS A PASSWORD FIELD, because HR setting a password would mean HR knowing it. The
 * three states this renders - no login, code outstanding, active - are the three the API reports,
 * and there is deliberately no fourth "set a password for them".
 */

import { useCallback, useState } from 'react';
import { api, ApiError, fmtDate } from '@/lib/api';
import { Badge, Button, Card, CardHead, Empty } from '@/components/ui';
import { useT } from '@/lib/i18n';

export interface AccountState {
  hasAccount: boolean;
  userId?: string;
  email?: string;
  isEnabled?: boolean;
  activated?: boolean;
  lastLoginAt?: string | null;
  roles?: string[];
  activationsIssued?: number;
  liveActivationExpiresAt?: string | null;
  grants?: {
    role: string; valid_from: string; valid_to: string | null; reason: string | null;
    in_force: boolean; granted_by_name: string | null;
  }[];
  grantable?: string[];
}

/**
 * The fallback only. The real list comes from the API (`grantable`), so this screen cannot drift
 * from the database the way it just did - it offered three roles for hours after migration 0031
 * widened the column to seven.
 */
const ROLE_FALLBACK = ['employee', 'manager', 'hr_admin'] as const;

export function AccountCard({ employeeId, employeeName, isHrAdmin }: {
  employeeId: string; employeeName: string; isHrAdmin: boolean;
}) {
  const t = useT();
  const [state, setState] = useState<AccountState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [role, setRole] = useState<string>('employee');
  const [newRole, setNewRole] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setState(await api.get<AccountState>(`/identity/accounts/by-employee/${employeeId}`));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('acct.loadFailed'));
    } finally {
      setLoaded(true);
    }
  }, [employeeId, t]);

  // Loaded on demand rather than with the profile: an HR admin looking at somebody's leave has no
  // need to fetch their account state, and this is the one panel where a request is a privileged
  // read worth not making by default.
  if (!isHrAdmin) return null;
  if (!loaded) {
    return (
      <Card>
        <CardHead title={t('acct.title')} hint={t('acct.hint')} />
        <Empty
          title={t('acct.notLoaded')}
          action={<Button size="sm" onClick={() => void load()}>{t('acct.check')}</Button>}
        />
      </Card>
    );
  }

  const act = async (fn: () => Promise<{ activationCode: string }>) => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const r = await fn();
      setCode(r.activationCode);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('acct.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHead
        title={t('acct.title')}
        hint={t('acct.hint')}
        action={state?.hasAccount && state.activated
          ? <Badge status="active">{t('acct.active')}</Badge>
          : undefined}
      />

      {error && (
        <p className="border-b border-rose-100 bg-rose-50 px-4 py-2.5 text-[13px] text-rose-800 sm:px-5">
          {error}
        </p>
      )}

      {/*
        * THE ONE-TIME CODE. Rendered above everything else while it exists, because it is the only
        * thing on the screen that cannot be recovered.
        */}
      {code && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-4 sm:px-5">
          <p className="text-[12px] font-semibold uppercase tracking-wide text-amber-900">
            {t('acct.codeOnce')}
          </p>
          <p className="mt-2 select-all font-mono text-[19px] font-semibold tracking-[0.14em] text-ink-900">
            {code}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                // `navigator.clipboard` is unavailable over plain HTTP on some browsers, so the
                // code stays selectable (`select-all`) and the button is an accelerator, not the
                // only way to get it.
                void navigator.clipboard?.writeText(code).then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? t('acct.copied') : t('acct.copy')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setCode(null); setCopied(false); }}>
              {t('acct.handedOver')}
            </Button>
          </div>
          <p className="mt-2.5 text-[12.5px] leading-relaxed text-amber-900">
            {t('acct.codeWarning', { name: employeeName, days: 7 })}
          </p>
        </div>
      )}

      {/* ---------------------------------------------------------------- no login yet */}
      {!state?.hasAccount && (
        <div className="px-4 py-4 sm:px-5">
          <p className="text-[13.5px] text-ink-600">{t('acct.none', { name: employeeName })}</p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="text-[12.5px] font-medium text-ink-600">
              <span className="block">{t('acct.role')}</span>
              <select
                id="acct-role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="mt-1 rounded-lg border-0 bg-white px-2.5 py-1.5 text-[13.5px] text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-ink-900"
              >
                {(state?.grantable ?? ROLE_FALLBACK).map((r) => (
                  <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>
                ))}
              </select>
            </label>
            <Button
              id="acct-create"
              busy={busy}
              onClick={() => void act(() => api.post<{ activationCode: string }>(
                '/identity/accounts', { employeeId, role }))}
            >
              {t('acct.create')}
            </Button>
          </div>
          <p className="mt-2 text-[12.5px] text-ink-500">{t('acct.createHint')}</p>
        </div>
      )}

      {/* ---------------------------------------------------------------- has a login */}
      {state?.hasAccount && (
        <dl className="divide-y divide-ink-100">
          <Row label={t('acct.email')} value={state.email ?? '—'} />
          <Row
            label={t('acct.status')}
            value={state.activated
              ? t('acct.activatedOn', { when: fmtDate(state.lastLoginAt) || t('acct.neverIn') })
              : t('acct.awaiting')}
          />
          <Row
            label={t('acct.roles')}
            value={(state.roles ?? []).length
              ? (state.roles ?? []).join(' · ').replace(/_/g, ' ')
              : t('acct.noRoles')}
          />
          {!state.activated && (
            <Row
              label={t('acct.codeState')}
              value={state.liveActivationExpiresAt
                ? t('acct.codeLive', {
                  when: fmtDate(state.liveActivationExpiresAt),
                  n: state.activationsIssued ?? 1,
                })
                : t('acct.codeExpired')}
            />
          )}
        </dl>
      )}

      {/*
        * ROLES ARE A SET, NOT A SLOT. `user_role` is effective-dated and its EXCLUDE constraint
        * only stops the SAME role overlapping itself, so somebody holds as many as they are given
        * and `fn_user_roles` returns all of them. That is why this is a list with an add control
        * rather than a dropdown that replaces what is there.
        *
        * Revoking CLOSES the period rather than deleting the row - the only thing Rule 3 permits -
        * so a lapsed grant stays visible with its dates. "Who could have approved this in March"
        * is answerable precisely because nothing is erased.
        */}
      {state?.hasAccount && (
        <div className="border-t border-ink-100 px-4 py-3 sm:px-5">
          <p className="text-[12.5px] font-medium text-ink-600">{t('acct.rolesHeld')}</p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {(state.grants ?? []).filter((g) => g.in_force).map((g) => (
              <li key={`${g.role}-${g.valid_from}`}>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-ink-100 py-1 ps-2.5 pe-1.5 text-[12.5px] text-ink-800">
                  {g.role.replace(/_/g, ' ')}
                  {g.role !== 'employee' && (
                    <button
                      type="button"
                      aria-label={t('acct.revokeRole', { role: g.role.replace(/_/g, ' ') })}
                      className="rounded-full px-1 text-ink-500 transition hover:bg-ink-200 hover:text-ink-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-900"
                      onClick={() => {
                        // eslint-disable-next-line no-alert
                        const why = window.prompt(t('acct.whyRevoke', {
                          role: g.role.replace(/_/g, ' '),
                        }));
                        if (why && why.trim().length >= 3) {
                          void (async () => {
                            setBusy(true);
                            setError(null);
                            try {
                              await api.post(
                                `/identity/accounts/${state.userId}/roles/${g.role}/revoke`,
                                { reason: why.trim() },
                              );
                              await load();
                            } catch (e) {
                              setError(e instanceof ApiError ? e.message : t('acct.failed'));
                            } finally { setBusy(false); }
                          })();
                        }
                      }}
                    >
                      ✕
                    </button>
                  )}
                </span>
              </li>
            ))}
            {(state.grants ?? []).filter((g) => g.in_force).length === 0 && (
              <li className="text-[12.5px] text-ink-500">{t('acct.noRoles')}</li>
            )}
          </ul>

          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="text-[12.5px] font-medium text-ink-600">
              <span className="block">{t('acct.addRole')}</span>
              <select
                id="acct-add-role"
                value={newRole}
                onChange={(e) => setNewRole(e.target.value)}
                className="mt-1 rounded-lg border-0 bg-white px-2.5 py-1.5 text-[13.5px] text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-ink-900"
              >
                <option value="">{t('acct.chooseRole')}</option>
                {(state.grantable ?? [])
                  .filter((r) => !(state.roles ?? []).includes(r))
                  .map((r) => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
              </select>
            </label>
            <Button
              id="acct-grant"
              size="sm"
              busy={busy}
              disabled={!newRole || busy}
              onClick={() => void (async () => {
                setBusy(true);
                setError(null);
                try {
                  await api.post(`/identity/accounts/${state.userId}/roles`, { role: newRole });
                  setNewRole('');
                  await load();
                } catch (e) {
                  setError(e instanceof ApiError ? e.message : t('acct.failed'));
                } finally { setBusy(false); }
              })()}
            >
              {t('acct.grant')}
            </Button>
          </div>
          <p className="mt-1.5 text-[12.5px] text-ink-500">{t('acct.rolesHint')}</p>

          {/* Lapsed grants, kept visible: the record is the point. */}
          {(state.grants ?? []).some((g) => !g.in_force) && (
            <details className="mt-3">
              <summary className="cursor-pointer text-[12.5px] text-ink-500">
                {t('acct.pastRoles')}
              </summary>
              <ul className="mt-1.5 space-y-1">
                {(state.grants ?? []).filter((g) => !g.in_force).map((g) => (
                  <li key={`${g.role}-${g.valid_from}`} className="text-[12.5px] text-ink-500">
                    {g.role.replace(/_/g, ' ')} · {g.valid_from} → {g.valid_to ?? '—'}
                    {g.reason && ` · ${g.reason}`}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {/*
        * Reissue is offered ONLY while the account has no password. Once it has one, a new code
        * would be a password reset - a different act, belonging to the account holder - and both
        * the API and migration 0029 refuse it. Hiding the button is the third layer, not the
        * defence.
        */}
      {state?.hasAccount && !state.activated && (
        <div className="border-t border-ink-100 px-4 py-3 sm:px-5">
          <Button
            id="acct-reissue"
            size="sm"
            variant="ghost"
            busy={busy}
            onClick={() => void act(() => api.post<{ activationCode: string }>(
              `/identity/accounts/${state.userId}/activation`, {}))}
          >
            {t('acct.reissue')}
          </Button>
          <p className="mt-1.5 text-[12.5px] text-ink-500">{t('acct.reissueHint')}</p>
        </div>
      )}
    </Card>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-4 py-2.5 sm:px-5">
      <dt className="text-[12.5px] text-ink-500">{label}</dt>
      <dd className="text-end text-[13.5px] text-ink-900">{value}</dd>
    </div>
  );
}
