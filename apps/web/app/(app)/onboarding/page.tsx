'use client';

/**
 * Onboarding: the salary annexure, its two approvals, and the offer letter.
 *
 * ONE SCREEN FOR THREE PEOPLE. HR prepares, the finance head approves the money, the delivery head
 * approves the hire. They see the same queue and the same annexure; what differs is which buttons
 * are offered - and the buttons are only an OFFER. Every one of them is a distinct action in
 * `authz-matrix.yaml`, and the API refuses anything the caller does not hold whatever this file
 * renders. Deriving the offer from roles here is the same division the sidebar already uses:
 * "which actors are offered this; the API decides who may pass."
 *
 * WHY THE MONEY IS TYPED TWICE. The components are entered one by one, and the annual CTC is typed
 * again on its own. They must agree before the annexure may go to finance. That is not
 * belt-and-braces - it is the only thing standing between a component fat-fingered by a factor of
 * ten and an offer letter carrying the wrong number, because a wrong total looks exactly like a
 * right one. The running difference is shown live so the mismatch is visible before submitting.
 *
 * NOTHING HERE CALCULATES ANYTHING. ADR-0012 is BLOCKED, so no gross-to-net or statutory
 * arithmetic exists in this product. The total is a sum of what somebody typed.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, fmtDate, hasRole, useData, type Actor } from '@/lib/api';
import {
  Async, Badge, Button, Card, CardBody, CardHead, Empty, Field, Skeleton, Toast, inputCls,
} from '@/components/ui';
import { formatPaise } from '@/components/payslips';
import { useT } from '@/lib/i18n';
import { withBasePath } from '@/lib/base-path';

interface Row {
  id: string; status: string; ctc_minor: string; proposed_joining_on: string;
  employee_id: string; employee_number: string; full_name: string; employee_status: string;
  has_offer_letter: boolean; updated_at: string;
}
interface Component {
  id: string; kind: string; component_code: string; label: string; amount_minor: string;
}
interface Event {
  event_type: string; from_status: string; to_status: string; reason: string | null;
  created_at: string; actor_name: string | null; ctc_at_decision_minor: string | null;
}
interface Detail {
  annexure: {
    id: string; status: string; employeeId: string; employeeNumber: string; employeeName: string;
    ctcMinor: string; proposedJoiningOn: string; preparedByName: string | null;
  };
  components: Component[];
  events: Event[];
}

/*
 * MONEY IS FORMATTED BY THE ONE FUNCTION THAT ALREADY DOES IT. This page shipped with its own
 * copy, and the copy was wrong: `(\d{2})+` where Indian grouping needs `(\d{2})*`, so a
 * six-figure rupee amount rendered as `1,00000.00` instead of `1,00,000.00` - on the screen where
 * somebody approves it. `formatPaise` splits the digits as text (never a float) and is covered by
 * `payslip:test`; a second implementation of the same thing was the whole mistake.
 */

const TONE: Record<string, string> = {
  draft: 'pending',
  finance_review: 'submitted',
  delivery_review: 'submitted',
  delivery_approved: 'approved',
  offer_issued: 'approved',
  offer_accepted: 'present',
  offer_declined: 'rejected',
  withdrawn: 'returned',
};

export default function OnboardingPage() {
  const t = useT();
  const me = useData<{ actor: Actor }>('/auth/me');
  const actor = me.data?.actor;
  const isHr = hasRole(actor, 'hr_admin');
  const isFinance = hasRole(actor, 'finance');
  const isDelivery = hasRole(actor, 'delivery_head');

  const [filter, setFilter] = useState('all');
  const list = useData<{ rows: Row[] }>(`/onboarding/annexures?status=${filter}`, [filter]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const loadDetail = useCallback(async (id: string) => {
    setError(null);
    try { setDetail(await api.get<Detail>(`/onboarding/annexures/${id}`)); } catch (e) {
      setError(e instanceof ApiError ? e.message : t('onb.loadFailed'));
    }
  }, [t]);

  useEffect(() => { if (openId) void loadDetail(openId); else setDetail(null); }, [openId, loadDetail]);

  const act = async (move: string, reason?: string) => {
    if (!openId) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/onboarding/annexures/${openId}/${move}`, reason ? { reason } : {});
      setToast(t('onb.recorded'));
      await loadDetail(openId);
      list.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('onb.actionFailed'));
    } finally { setBusy(false); }
  };

  const askAndAct = (move: string, promptKey: 'onb.whyReject' | 'onb.whyWithdraw') => {
    // eslint-disable-next-line no-alert
    const reason = window.prompt(t(promptKey));
    if (reason && reason.trim().length >= 3) void act(move, reason.trim());
  };

  const st = detail?.annexure.status;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold text-ink-900">{t('onb.title')}</h1>
          <p className="mt-1 max-w-3xl text-[13.5px] leading-relaxed text-ink-500">
            {t('onb.intro')}
          </p>
        </div>
        {isHr && (
          <Button onClick={() => { setAdding((a) => !a); setOpenId(null); }}>
            {adding ? t('common.cancel') : t('onb.prepare')}
          </Button>
        )}
      </header>

      {error && (
        <p role="alert" className="rounded-lg bg-rose-50 px-4 py-2.5 text-[13px] text-rose-800 ring-1 ring-inset ring-rose-200">
          {error}
        </p>
      )}

      {adding && (
        <PrepareForm
          onDone={() => { setAdding(false); list.reload(); }}
          onError={setError}
        />
      )}

      <Card>
        <CardHead
          title={t('onb.queue')}
          hint={t('onb.queueHint')}
          action={(
            <select
              id="onb-filter"
              value={filter}
              onChange={(e) => { setFilter(e.target.value); setOpenId(null); }}
              className="rounded-lg border-0 bg-white px-2.5 py-1.5 text-[13px] text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-ink-900"
            >
              {['all', 'draft', 'finance_review', 'delivery_review', 'delivery_approved',
                'offer_issued', 'offer_accepted', 'offer_declined', 'withdrawn'].map((s) => (
                  <option key={s} value={s}>
                    {s === 'all' ? t('onb.allStatuses') : t(`onb.st.${s}` as 'onb.st.draft')}
                  </option>
              ))}
            </select>
          )}
        />
        <Async
          state={list}
          isEmpty={(d) => (d.rows ?? []).length === 0}
          empty={<Empty title={t('onb.none')} hint={t('onb.noneHint')} />}
        >
          {(d) => (
            <div className="overflow-x-auto">
              <table className="w-full text-start text-[13.5px]">
                <thead className="border-b border-ink-100 text-[12px] uppercase tracking-wide text-ink-500">
                  <tr>
                    <th scope="col" className="px-5 py-2.5 text-start font-medium">{t('onb.joiner')}</th>
                    <th scope="col" className="px-5 py-2.5 text-start font-medium">{t('common.status')}</th>
                    <th scope="col" className="px-5 py-2.5 text-end font-medium">{t('onb.annualCtc')}</th>
                    <th scope="col" className="px-5 py-2.5 text-start font-medium">{t('onb.joiningOn')}</th>
                    <th scope="col" className="px-5 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {d.rows.map((r) => (
                    <tr key={r.id} className={openId === r.id ? 'bg-ink-50' : undefined}>
                      <td className="px-5 py-2.5">
                        <span className="font-medium text-ink-900">{r.full_name}</span>
                        <span className="ms-2 text-[12.5px] text-ink-500">{r.employee_number}</span>
                      </td>
                      <td className="px-5 py-2.5">
                        <Badge status={TONE[r.status] ?? 'pending'}>
                          {t(`onb.st.${r.status}` as 'onb.st.draft')}
                        </Badge>
                      </td>
                      <td className="px-5 py-2.5 text-end num tabular-nums">₹{formatPaise(r.ctc_minor)}</td>
                      <td className="px-5 py-2.5">{fmtDate(r.proposed_joining_on)}</td>
                      <td className="px-5 py-2.5 text-end">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setOpenId(openId === r.id ? null : r.id)}
                        >
                          {openId === r.id ? t('common.close') : t('common.open')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Async>
      </Card>

      {openId && !detail && <Card><Skeleton rows={4} /></Card>}

      {detail && (
        <Card>
          <CardHead
            title={detail.annexure.employeeName}
            hint={t('onb.preparedBy', { name: detail.annexure.preparedByName ?? '—' })}
            /*
              * `id` and `data-status` so a test can read THIS annexure's state from one element.
              * A browser check that matched the status text anywhere in the page silently matched
              * the filter dropdown's option list instead - "With delivery" is always on screen -
              * and three assertions passed while nothing had happened.
              */
            action={(
              <span id="onb-status" data-status={detail.annexure.status}>
                <Badge status={TONE[detail.annexure.status] ?? 'pending'}>
                  {t(`onb.st.${detail.annexure.status}` as 'onb.st.draft')}
                </Badge>
              </span>
            )}
          />
          <CardBody className="space-y-4">
            <dl className="grid gap-3 sm:grid-cols-3">
              <div>
                <dt className="text-[12px] uppercase tracking-wide text-ink-500">{t('onb.annualCtc')}</dt>
                <dd className="mt-0.5 num text-[18px] font-semibold text-ink-900">
                  ₹{formatPaise(detail.annexure.ctcMinor)}
                </dd>
              </div>
              <div>
                <dt className="text-[12px] uppercase tracking-wide text-ink-500">{t('onb.joiningOn')}</dt>
                <dd className="mt-0.5 text-[14px] text-ink-900">
                  {fmtDate(detail.annexure.proposedJoiningOn)}
                </dd>
              </div>
              <div>
                <dt className="text-[12px] uppercase tracking-wide text-ink-500">{t('onb.employee')}</dt>
                <dd className="mt-0.5 text-[14px] text-ink-900">{detail.annexure.employeeNumber}</dd>
              </div>
            </dl>

            <div className="overflow-x-auto rounded-lg ring-1 ring-inset ring-ink-200">
              <table className="w-full text-[13.5px]">
                <tbody className="divide-y divide-ink-100">
                  {detail.components.map((c) => (
                    <tr key={c.id}>
                      <td className="px-3 py-2">
                        {c.label}
                        <span className="ms-2 text-[12px] text-ink-400">{c.component_code}</span>
                      </td>
                      <td className="px-3 py-2 text-end num tabular-nums">
                        {c.kind === 'deduction' ? '−' : ''}₹{formatPaise(c.amount_minor)}
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-ink-50 font-semibold">
                    <td className="px-3 py-2">{t('onb.total')}</td>
                    <td className="px-3 py-2 text-end num tabular-nums">
                      ₹{formatPaise(detail.components.reduce(
                        (n, c) => n + (c.kind === 'deduction' ? -1n : 1n) * BigInt(c.amount_minor),
                        0n,
                      ).toString())}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/*
              * The buttons each person is OFFERED. The API decides who may pass - these are
              * `onboarding.annexure.write`, `.approve_finance`, `.approve_delivery` and
              * `onboarding.offer.manage`, four separate matrix actions, and HR is denied both
              * approvals because HR typed the figures.
              */}
            <div className="flex flex-wrap items-center gap-2">
              {isHr && st === 'draft' && (
                <Button id="onb-submit" busy={busy} onClick={() => void act('submit')}>
                  {t('onb.submitToFinance')}
                </Button>
              )}
              {isFinance && st === 'finance_review' && (
                <>
                  <Button id="onb-fin-approve" busy={busy} onClick={() => void act('finance_approve')}>
                    {t('onb.financeApprove')}
                  </Button>
                  <Button variant="secondary" size="md"
                    onClick={() => askAndAct('finance_reject', 'onb.whyReject')}>
                    {t('onb.sendBack')}
                  </Button>
                </>
              )}
              {isDelivery && st === 'delivery_review' && (
                <>
                  <Button id="onb-del-approve" busy={busy} onClick={() => void act('delivery_approve')}>
                    {t('onb.deliveryApprove')}
                  </Button>
                  <Button variant="secondary" size="md"
                    onClick={() => askAndAct('delivery_reject', 'onb.whyReject')}>
                    {t('onb.sendBack')}
                  </Button>
                </>
              )}
              {isHr && st === 'delivery_approved' && (
                <Button id="onb-issue" busy={busy} onClick={() => void act('issue_offer')}>
                  {t('onb.issueOffer')}
                </Button>
              )}
              {isHr && st === 'offer_issued' && (
                <>
                  <Button id="onb-accept" busy={busy} onClick={() => void act('accept_offer')}>
                    {t('onb.markAccepted')}
                  </Button>
                  <Button variant="secondary" size="md"
                    onClick={() => askAndAct('decline_offer', 'onb.whyReject')}>
                    {t('onb.markDeclined')}
                  </Button>
                </>
              )}
              {/*
                * Withdraw is offered right through `offer_issued`, because an offer that was sent
                * and never answered has to be retractable - otherwise a silent candidate freezes
                * that person's onboarding permanently, since the one-live index counts an issued
                * offer and blocks a fresh annexure (0034).
                */}
              {isHr && ['draft', 'finance_review', 'delivery_review', 'delivery_approved',
                'offer_issued'].includes(st ?? '') && (
                <Button variant="ghost" size="md"
                  onClick={() => askAndAct('withdraw', 'onb.whyWithdraw')}>
                  {t('onb.withdraw')}
                </Button>
              )}
            </div>

            {/* The trail. Every decision, who made it, and the figure they approved. */}
            <div>
              <h3 className="text-[13px] font-semibold text-ink-900">{t('onb.trail')}</h3>
              <ol className="mt-2 space-y-2">
                {detail.events.length === 0 && (
                  <li className="text-[13px] text-ink-500">{t('onb.noTrail')}</li>
                )}
                {detail.events.map((ev, i) => (
                  <li key={`${ev.created_at}-${i}`} className="text-[13px] text-ink-700">
                    <span className="font-medium text-ink-900">
                      {t(`onb.ev.${ev.event_type}` as 'onb.ev.submit')}
                    </span>
                    {ev.actor_name && <span className="text-ink-500"> · {ev.actor_name}</span>}
                    <span className="text-ink-500"> · {fmtDate(ev.created_at)}</span>
                    {ev.ctc_at_decision_minor && (
                      <span className="text-ink-500"> · ₹{formatPaise(ev.ctc_at_decision_minor)}</span>
                    )}
                    {ev.reason && <div className="text-[12.5px] text-ink-500">“{ev.reason}”</div>}
                  </li>
                ))}
              </ol>
            </div>
          </CardBody>
        </Card>
      )}

      {toast && <Toast message={toast} tone="good" onDone={() => setToast(null)} />}
    </div>
  );
}

/** Prepare a new annexure. HR only, and only for somebody who has not started. */
function PrepareForm({ onDone, onError }: {
  onDone: () => void; onError: (m: string | null) => void;
}) {
  const t = useT();
  const people = useData<{ employees: { id: string; employee_number: string; full_name: string;
    status: string }[] }>('/employees');
  const [employeeId, setEmployeeId] = useState('');
  const [ctc, setCtc] = useState('');
  const [joiningOn, setJoiningOn] = useState('');
  const [lines, setLines] = useState([
    { code: 'BASIC', label: 'Basic', amount: '' },
    { code: 'HRA', label: 'House rent allowance', amount: '' },
  ]);
  const [busy, setBusy] = useState(false);

  const preBoarding = (people.data?.employees ?? []).filter((e) => e.status === 'pre_boarding');

  // Live, so a mismatch is visible BEFORE submitting rather than as a rejection afterwards.
  const sum = lines.reduce((n, l) => n + Math.round((Number(l.amount) || 0) * 100), 0);
  const declared = Math.round((Number(ctc) || 0) * 100);
  const agrees = declared > 0 && sum === declared;

  const save = async () => {
    setBusy(true);
    onError(null);
    try {
      await api.post('/onboarding/annexures', {
        employeeId,
        annualCtc: ctc,
        proposedJoiningOn: joiningOn,
        components: lines.filter((l) => l.amount.trim())
          .map((l) => ({ kind: 'earning', code: l.code, label: l.label, amount: l.amount })),
      });
      onDone();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : t('onb.createFailed'));
    } finally { setBusy(false); }
  };

  return (
    <Card>
      <CardHead title={t('onb.prepare')} hint={t('onb.prepareHint')} />
      <CardBody className="space-y-4">
        {preBoarding.length === 0 ? (
          /*
            * NOT A DEAD END. The first version said "create the employee first" and gave nothing
            * to click - the same trap as the activation page, which told people to ask HR without
            * naming anybody. Worse here, because the rule that puts somebody in this queue is not
            * obvious: it is a joining date in the FUTURE, and an employee created with today's
            * date is active before HR gets back to this screen.
            */
          <Empty
            title={t('onb.noJoiners')}
            hint={t('onb.noJoinersHint')}
            action={(
              <a
                href={withBasePath('/employees')}
                className="text-[13px] font-medium text-brand-700 hover:underline"
              >
                {t('onb.goCreate')} →
              </a>
            )}
          />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={t('onb.joiner')} htmlFor="onb-emp">
                <select id="onb-emp" value={employeeId} className={inputCls}
                  onChange={(e) => setEmployeeId(e.target.value)}
                >
                  <option value="">{t('onb.chooseJoiner')}</option>
                  {preBoarding.map((e) => (
                    <option key={e.id} value={e.id}>{e.full_name} · {e.employee_number}</option>
                  ))}
                </select>
              </Field>
              <Field label={t('onb.annualCtc')} hint={t('onb.ctcHint')} htmlFor="onb-ctc">
                <input id="onb-ctc" inputMode="decimal" value={ctc} placeholder="1200000"
                  onChange={(e) => setCtc(e.target.value)}
                  className={`${inputCls} num text-end`} />
              </Field>
              <Field label={t('onb.joiningOn')} htmlFor="onb-join">
                <input id="onb-join" type="date" value={joiningOn} className={inputCls}
                  onChange={(e) => setJoiningOn(e.target.value)} />
              </Field>
            </div>

            <div className="space-y-2">
              {lines.map((l, i) => (
                <div key={l.code} className="grid gap-2 sm:grid-cols-[1fr_10rem]">
                  <input
                    aria-label={t('onb.componentLabel')}
                    value={l.label}
                    onChange={(e) => setLines(lines.map((x, j) => (j === i
                      ? { ...x, label: e.target.value } : x)))}
                    className={inputCls}
                  />
                  <input
                    aria-label={l.label}
                    inputMode="decimal"
                    value={l.amount}
                    placeholder="0.00"
                    onChange={(e) => setLines(lines.map((x, j) => (j === i
                      ? { ...x, amount: e.target.value } : x)))}
                    className={`${inputCls} num text-end`}
                  />
                </div>
              ))}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setLines([...lines, {
                  code: `COMP${lines.length + 1}`, label: '', amount: '',
                }])}
              >
                {t('onb.addComponent')}
              </Button>
            </div>

            {/*
              * THE RECONCILIATION, SHOWN LIVE. The API refuses a mismatch at submission, but
              * discovering it there means retyping; discovering it here means noticing the extra
              * zero while it is still on screen.
              */}
            <p className={`text-[13px] ${agrees ? 'text-emerald-700' : 'text-amber-800'}`}>
              {t('onb.componentsTotal', { total: formatPaise(String(sum)) })}
              {declared > 0 && !agrees && ` · ${t('onb.mismatch', {
                diff: formatPaise(String(Math.abs(declared - sum))),
              })}`}
            </p>

            <Button
              id="onb-create"
              busy={busy}
              disabled={!employeeId || !joiningOn || !agrees || busy}
              onClick={() => void save()}
            >
              {t('onb.createDraft')}
            </Button>
          </>
        )}
      </CardBody>
    </Card>
  );
}
