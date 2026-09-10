'use client';

import { useEffect, useState } from 'react';
import { api, ApiError, hm, useData } from '@/lib/api';
import { Badge, Button, Card, IconTile, Toast, inputCls } from '@/components/ui';
import { IconClock, IconPin } from '@/components/icons';
import { useFormat, useT } from '@/lib/i18n';

/**
 * The attendance punch card.
 *
 * THE CARD HAS ONE JOB, AND IT IS NOW THE BIGGEST THING ON IT.
 *
 * The previous version gave its 30px hero to the elapsed TIME and put the action beside it as an
 * ordinary button - so before you had checked in, a meaningless `0h 0m` was the focal point and
 * the only thing you could actually do was the smallest element in the row. Three separate blocks
 * of prose (the header hint, the retention note, the office list) then out-measured both, and an
 * empty "no punches yet" panel added height to say nothing.
 *
 * So the card is built around THREE STATES, and in each one the hero is whatever matters:
 *
 *   NOT STARTED  the action is the hero. No zero, no empty punch list, one line of context.
 *   ON THE CLOCK the live elapsed time is the hero, because that is the number being asked for.
 *   DONE         the day's total is the hero, with checking in again offered quietly.
 *
 * WHAT DID NOT GET CUT: the sentence saying location is captured at the punch. Everything else
 * moved into a disclosure, but consent has to be legible BEFORE the action, not one click away
 * from it - so the one line that says what is about to happen sits next to the button that does
 * it. The retention detail and the office list are the answer to "tell me more", which is a
 * different question and belongs behind a summary.
 *
 * THE 2026-09-10 REDESIGN changed how this card looks and what language it speaks. Not one line
 * of the punch path moved: `locate()` still resolves rather than rejects, `punch()` still posts
 * to `/attendance/punch` with whatever fix it got, and `done`/`notStarted` are still decided by
 * the punch log rather than by a derived total. What DID change:
 *   * every string now comes from the dictionary. Nine of them were English literals, including
 *     the button itself - so the Arabic dashboard had an English "Check in" on it, and the
 *     straggler scan missed them because its patterns cannot cross a newline;
 *   * times and the day name go through `Intl` in the reader's locale instead of a hardcoded
 *     `en-IN`, which is what made the Arabic screen read "Thursday, 10 September";
 *   * the current office time is on the card, because "am I late?" is the question somebody asks
 *     while looking at a check-in button.
 */

interface Today {
  businessDate: string;
  punches: {
    id: number; punched_at: string; direction: 'in' | 'out';
    accuracy_m: number | null; distance_m: number | null;
    location_verified: boolean; location_source: string;
    note: string | null; location_name: string | null;
  }[];
  day: {
    status: string; first_in_at: string | null; last_out_at: string | null; worked_minutes: number;
  } | null;
  checkedIn: boolean;
  since: string | null;
  nextDirection: 'in' | 'out';
  offices: { code: string; name: string; address: string | null; radius_m: number }[];
}

interface PunchResult {
  punch: { direction: string; punched_at: string; location_verified: boolean; location_source: string };
  day: { status: string; worked_minutes: number } | null;
  location: { name: string; code: string; distanceM: number; radiusM: number; verified: boolean } | null;
  locationSource: string;
}

/** Elapsed minutes since check-in, ticking. */
function useElapsed(since: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return undefined;
    // Every 20s: the display is in minutes, so this is frequent enough that the number is never
    // visibly stale and rare enough to be free.
    const t = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(t);
  }, [since]);
  if (!since) return null;
  return Math.max(0, Math.round((now - new Date(since).getTime()) / 60000));
}

/**
 * The wall clock, for the card's "now".
 *
 * It starts as `null` and is set in an effect rather than during render. That is deliberate: a
 * time rendered during the server pass would differ from the client's first render and React
 * would report a hydration mismatch - and the fix is not to suppress the warning but to admit
 * that the current time is client state and has no server value.
 */
function useClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

type GeoState =
  | { kind: 'idle' }
  | { kind: 'locating' }
  | { kind: 'ok'; lat: number; lon: number; accuracy: number }
  | { kind: 'denied' }
  | { kind: 'unavailable'; reason: string };

export function PunchCard({ onChanged }: { onChanged?: () => void }) {
  const t = useT();
  const f = useFormat();
  const state = useData<Today>('/attendance/today');
  const [geo, setGeo] = useState<GeoState>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [toast, setToast] = useState<{ msg: string; tone: 'good' | 'bad' } | null>(null);
  const [lastResult, setLastResult] = useState<PunchResult | null>(null);

  const elapsed = useElapsed(state.data?.checkedIn ? state.data.since : null);
  const now = useClock();

  /**
   * Ask the browser for a fix. Resolves rather than rejects on failure: refusing location must
   * not block a punch, so every outcome is a state we can record honestly.
   */
  function locate(): Promise<GeoState> {
    return new Promise((resolve) => {
      if (typeof navigator === 'undefined' || !navigator.geolocation) {
        resolve({ kind: 'unavailable', reason: t('punch.noGeolocation') });
        return;
      }
      setGeo({ kind: 'locating' });
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({
          kind: 'ok',
          lat: Number(pos.coords.latitude.toFixed(6)),
          lon: Number(pos.coords.longitude.toFixed(6)),
          accuracy: Math.round(pos.coords.accuracy),
        }),
        (err) => resolve(
          err.code === err.PERMISSION_DENIED
            ? { kind: 'denied' }
            : {
              kind: 'unavailable',
              reason: err.code === err.TIMEOUT
                ? t('punch.locationTimeout')
                : t('punch.locationUnavailable'),
            },
        ),
        { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
      );
    });
  }

  async function punch(direction: 'in' | 'out') {
    setBusy(true);
    setLastResult(null);
    try {
      const fix = await locate();
      setGeo(fix);

      const res = await api.post<PunchResult>('/attendance/punch', {
        direction,
        latitude: fix.kind === 'ok' ? fix.lat : null,
        longitude: fix.kind === 'ok' ? fix.lon : null,
        accuracy: fix.kind === 'ok' ? fix.accuracy : null,
        locationSource: fix.kind === 'denied' ? 'denied'
          : fix.kind === 'unavailable' ? 'unavailable' : undefined,
        note: note || null,
      });

      setLastResult(res);
      setNote('');
      setNoteOpen(false);
      setToast({
        msg: direction === 'in'
          ? (res.location?.verified
            ? t('punch.toastInAt', { time: f.time(res.punch.punched_at), office: res.location.name })
            : t('punch.toastIn', { time: f.time(res.punch.punched_at) }))
          : t('punch.toastOut', {
            time: f.time(res.punch.punched_at),
            total: hm(res.day?.worked_minutes ?? 0),
          }),
        tone: 'good',
      });
      await state.reload();
      onChanged?.();
    } catch (err) {
      setToast({
        msg: err instanceof ApiError ? err.message : t('punch.couldNotRecord'),
        tone: 'bad',
      });
    } finally {
      setBusy(false);
    }
  }

  if (state.loading) {
    return (
      <Card>
        <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3 sm:px-5">
          <h2 className="text-[15px] font-semibold text-ink-900">{t('period.today')}</h2>
        </div>
        <div className="space-y-3 p-4 sm:p-5" role="status" aria-label={t('ui.loading')}>
          <div className="skeleton h-10 w-44" />
          <div className="skeleton h-4 w-56" />
        </div>
      </Card>
    );
  }
  if (state.error || !state.data) {
    return (
      <Card>
        <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3 sm:px-5">
          <h2 className="text-[15px] font-semibold text-ink-900">{t('period.today')}</h2>
        </div>
        <div
          role="alert"
          className="m-4 rounded-lg bg-rose-50 p-4 text-[13px] text-rose-800 ring-1 ring-inset ring-rose-200 sm:m-5"
        >
          {state.error ?? t('punch.couldNotLoadToday')}
          <Button variant="secondary" size="sm" className="mt-3" onClick={state.reload}>
            {t('common.retry')}
          </Button>
        </div>
      </Card>
    );
  }

  const d = state.data;
  const working = d.checkedIn;
  /*
   * THE DISCRIMINATOR IS THE PUNCH LOG, NOT THE WORKED MINUTES.
   *
   * The first version tested `worked_minutes > 0`, and checking in and out inside the same minute
   * produced `worked_minutes: 0` with two punches on the record - so the card fell through to
   * "Ready to start your day" for somebody who had just finished. That is the same incoherence
   * the seed was fixed for, reintroduced one layer up: a derived TOTAL is the wrong thing to ask
   * about whether something happened. The punches are the facts; the total is a summary of them,
   * and a summary is allowed to be zero.
   *
   * `d.day` is included because a future attendance regularization can produce a derived day with
   * no punches behind it (an approved correction), and that day is finished too.
   */
  const done = !working && (d.punches.length > 0 || d.day !== null);
  const notStarted = !working && !done;

  const locating = geo.kind === 'locating';
  const action = working ? 'out' : 'in';
  const label = locating ? t('punch.locating')
    : working ? t('punch.checkOut')
      : done ? t('punch.checkInAgain') : t('punch.checkIn');

  /*
   * The hero panel's tint carries the state, so it is readable before any text is.
   *
   * Gold for the pending action - DEC-054 confines gold to brand accents and keeps amber for
   * "pending / late", and this is a brand-forward call to action rather than a warning. Emerald
   * while on the clock, because that is the one state where something is actively true.
   */
  const panel = working
    ? 'bg-emerald-50/70 ring-emerald-200'
    : notStarted ? 'bg-brand-50 ring-brand-200' : 'bg-ink-50 ring-ink-200';

  return (
    <Card className="overflow-hidden">
      {/*
        * The head is written out rather than using `CardHead`, because this one carries three
        * things - the day, the live clock and the day's verdict - and a header component that
        * grew a third slot for one caller would be a worse component.
        */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-ink-100 px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2.5">
          <IconTile icon={<IconClock size={17} />} tone={working ? 'good' : 'plain'} size="sm" />
          <div>
            <h2 className="text-[15px] font-semibold text-ink-900">{t('period.today')}</h2>
            <p className="text-[12.5px] text-ink-500">
              {f.date(d.businessDate, { weekday: 'long', year: undefined })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {now && (
            <span className="flex items-baseline gap-1.5">
              <span className="text-[11px] font-medium uppercase tracking-[0.07em] text-ink-500">
                {t('punch.currentTime')}
              </span>
              <span className="num text-[15px] font-semibold text-ink-800">{f.time(now)}</span>
            </span>
          )}
          {d.day
            ? <Badge status={d.day.status} />
            : <Badge status="draft">{t('punch.notStarted')}</Badge>}
        </div>
      </div>

      <div className="p-4 sm:p-5">
        {/* THE ACTION ZONE. One panel, one decision. */}
        <div className={`rounded-xl p-4 ring-1 ring-inset sm:p-5 ${panel}`}>
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
            <div className="min-w-0">
              {working ? (
                <>
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="h-2 w-2 animate-pulse rounded-full bg-emerald-600"
                    />
                    <span className="text-[12px] font-semibold uppercase tracking-[0.07em] text-emerald-800">
                      {t('punch.onTheClock')}
                    </span>
                  </div>
                  <div className="num mt-1.5 text-[36px] font-semibold leading-none tracking-tight text-ink-900">
                    {hm(elapsed ?? 0)}
                  </div>
                  <p className="mt-2 text-[13px] text-ink-600">
                    {t('punch.since', { time: f.time(d.since) })}
                  </p>
                </>
              ) : done ? (
                <>
                  <span className="text-[12px] font-semibold uppercase tracking-[0.07em] text-ink-500">
                    {t('punch.recordedToday')}
                  </span>
                  <div className="num mt-1.5 text-[36px] font-semibold leading-none tracking-tight text-ink-900">
                    {hm(d.day?.worked_minutes ?? 0)}
                  </div>
                  <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
                    <div className="flex items-center gap-1.5">
                      <dt className="text-ink-500">{t('punch.firstIn')}</dt>
                      <dd className="num font-semibold text-ink-800">{f.time(d.day?.first_in_at)}</dd>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <dt className="text-ink-500">{t('punch.lastOut')}</dt>
                      <dd className="num font-semibold text-ink-800">{f.time(d.day?.last_out_at)}</dd>
                    </div>
                  </dl>
                </>
              ) : (
                <>
                  {/*
                    * No `0h 0m` here. A zero as the hero is worse than no number: it draws the eye
                    * to the one thing on the card that carries no information.
                    */}
                  <div className="text-[20px] font-semibold leading-tight text-ink-900">
                    {t('punch.ready')}
                  </div>
                  <p className="mt-1.5 text-[13.5px] text-ink-600">
                    {t('punch.notCheckedIn')}
                  </p>
                </>
              )}
            </div>

            <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
              <Button
                size="lg"
                variant={working ? 'secondary' : 'primary'}
                busy={busy}
                onClick={() => punch(action)}
                className="min-w-[11rem] shadow-[var(--shadow-card)]"
              >
                {label}
              </Button>
              {/*
                * The note is one click away rather than always on screen. It is used on a small
                * minority of punches, and an empty text field beside the primary action reads as
                * something you are expected to fill in first.
                */}
              {noteOpen ? (
                <>
                  <label htmlFor="punch-note" className="sr-only">{t('punch.noteForPunch')}</label>
                  <input
                    id="punch-note"
                    type="text"
                    autoFocus
                    className={`${inputCls} !mt-0 sm:w-[11rem]`}
                    placeholder={t('punch.reasonIfAny')}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setNoteOpen(true)}
                  className="text-[12.5px] font-medium text-ink-500 underline decoration-ink-300 underline-offset-2 transition-colors hover:text-ink-800"
                >
                  {t('punch.addNote')}
                </button>
              )}
            </div>
          </div>

          {/*
            * The consent line, next to the button rather than in a header or a footer. Somebody
            * about to punch should be able to see what the punch captures without moving their
            * eyes off the thing they are about to press.
            */}
          <p className="mt-4 flex items-start gap-2 border-t border-ink-900/5 pt-3 text-[12.5px] leading-relaxed text-ink-500">
            <IconPin size={14} className="mt-px shrink-0 text-ink-400" />
            <span>{t('punch.consent')}</span>
          </p>
        </div>

        {/* What happened to the location request, said plainly. */}
        {geo.kind === 'denied' && (
          <p
            role="status"
            className="mt-4 rounded-lg bg-amber-50 px-3.5 py-2.5 text-[13px] leading-relaxed text-amber-900 ring-1 ring-inset ring-amber-200"
          >
            <strong className="font-semibold">{t('punch.locationNotShared')}</strong>{' '}
            {t('punch.deniedBody')}
          </p>
        )}
        {geo.kind === 'unavailable' && (
          <p role="status" className="mt-4 rounded-lg bg-ink-100 px-3.5 py-2.5 text-[13px] leading-relaxed text-ink-700">
            <strong className="font-semibold">{geo.reason}.</strong> {t('punch.unavailableBody')}
          </p>
        )}

        {lastResult?.location && (
          <p
            role="status"
            className={`mt-4 rounded-lg px-3.5 py-2.5 text-[13px] leading-relaxed ring-1 ring-inset ${
              lastResult.location.verified
                ? 'bg-emerald-50 text-emerald-900 ring-emerald-200'
                : 'bg-amber-50 text-amber-900 ring-amber-200'
            }`}
          >
            {lastResult.location.verified ? (
              <>
                <strong className="font-semibold">{t('punch.locationConfirmed')}</strong>{' '}
                <span className="num">
                  {t('punch.confirmedBody', {
                    distance: lastResult.location.distanceM,
                    office: lastResult.location.name,
                    radius: lastResult.location.radiusM,
                  })}
                </span>
              </>
            ) : (
              <>
                <strong className="font-semibold">{t('punch.outsideGeofence')}</strong>{' '}
                {t('punch.outsideBody', {
                  distance: lastResult.location.distanceM,
                  office: lastResult.location.name,
                  radius: lastResult.location.radiusM,
                })}
              </>
            )}
          </p>
        )}
      </div>

      {/*
        * Today's punches - the raw facts the day above is derived from.
        *
        * Rendered ONLY when there are some. The old version showed an empty-state panel saying
        * "no punches yet / check in to start the day", which repeated the hero's message and cost
        * a third of the card's height to do it.
        */}
      {d.punches.length > 0 && (
        <div className="border-t border-ink-100">
          <p className="px-4 pt-3 text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-500 sm:px-5">
            {t('punch.todaysPunches')}
          </p>
          <ul className="divide-y divide-ink-100">
            {d.punches.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2.5 sm:px-5"
              >
                <div className="flex items-center gap-2.5">
                  <span className={`inline-flex min-w-[3.25rem] justify-center rounded-md px-1.5 py-0.5 text-[11.5px] font-semibold uppercase ring-1 ring-inset ${
                    p.direction === 'in'
                      ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                      : 'bg-ink-100 text-ink-600 ring-ink-200'
                  }`}>
                    {p.direction === 'in' ? t('punch.in') : t('punch.out')}
                  </span>
                  <span className="num text-[13.5px] font-semibold text-ink-900">
                    {f.time(p.punched_at)}
                  </span>
                  {p.note && <span className="text-[13px] text-ink-500">{p.note}</span>}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                  {p.location_verified ? (
                    <>
                      <Badge status="present">{t('punch.verified')}</Badge>
                      <span className="num text-ink-500">
                        {p.location_name} · {p.distance_m} m
                        {p.accuracy_m !== null && <> · ±{p.accuracy_m} m</>}
                      </span>
                    </>
                  ) : (
                    <>
                      <Badge status="pending">
                        {p.location_source === 'denied' ? t('punch.notShared')
                          : p.location_source === 'unavailable' ? t('punch.unavailableShort')
                            : t('punch.outsideShort')}
                      </Badge>
                      {p.distance_m !== null && (
                        <span className="num text-ink-500">
                          {p.distance_m} m · {p.location_name ?? ''}
                        </span>
                      )}
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/*
        * The retention detail and the office list, behind a disclosure.
        *
        * This is the "tell me more" answer, and it was four lines of prose taller than the action
        * it explained. It is NOT deleted - the transparency was a deliberate decision and the
        * short version above still states what is captured before you press anything. Native
        * <details> so it works with no JavaScript and is keyboard-operable for free.
        */}
      <details className="group border-t border-ink-100 px-4 py-2.5 sm:px-5">
        <summary className="cursor-pointer list-none text-[12.5px] font-medium text-ink-500 transition-colors hover:text-ink-800">
          <span className="underline decoration-ink-300 underline-offset-2">
            {t('punch.whatIsStored')}
          </span>
          <span aria-hidden className="ms-1.5 inline-block transition-transform group-open:rotate-90">
            ›
          </span>
        </summary>
        <div className="mt-2.5 space-y-1.5 text-[12.5px] leading-relaxed text-ink-500">
          <p>{t('punch.retention')}</p>
          {d.offices.length > 0 && (
            <p>
              <span className="font-medium text-ink-700">{t('punch.workLocations')}</span>{' '}
              {d.offices.map((o) => `${o.name} (${o.radius_m} m)`).join(' · ')}
            </p>
          )}
        </div>
      </details>

      {toast && <Toast message={toast.msg} tone={toast.tone} onDone={() => setToast(null)} />}
    </Card>
  );
}
