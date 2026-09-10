'use client';

import { useCallback, useEffect, useState } from 'react';

import { withBasePath } from './base-path';

/**
 * The single door to the API.
 *
 * Requests go to /api/* on the same origin, so the session cookie is same-origin and needs no
 * CORS or credentials handling. What sits behind that path differs by environment and neither
 * end of this module has to care:
 *   * development - next.config.ts rewrites /api/* to the NestJS app on :4000;
 *   * production  - the edge nginx routes /api/ straight to the API container.
 *
 * `apiUrl` applies the deployment's base path, because a bare fetch('/api/...') is
 * root-absolute and Next's basePath does not touch it (see lib/base-path.ts).
 */
const apiUrl = (path: string): string => withBasePath(`/api${path}`);

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    // A network failure is a different problem from a rejected request, and the user needs to
    // be told which. "Something went wrong" helps nobody.
    throw new ApiError(0, 'Cannot reach the server. Is the API running on port 4000?');
  }

  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }

  if (!res.ok) {
    const message = typeof body?.message === 'string' ? body.message
      : Array.isArray(body?.message) ? body.message.join(', ')
      : `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return body as T;
}

/**
 * Multipart upload. Deliberately NOT routed through `request`: that helper sets
 * `Content-Type: application/json`, and a multipart body needs the browser to set the header
 * itself so it can append the boundary. Setting it by hand is the classic way to get a
 * "Multipart: Boundary not found" error that looks like a server bug.
 */
async function upload<T>(path: string, form: FormData): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), { method: 'POST', body: form });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Is the API running on port 4000?');
  }
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const message = typeof body?.message === 'string' ? body.message
      : Array.isArray(body?.message) ? body.message.join(', ')
      : `Upload failed (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return body as T;
}

/**
 * Fetch a file and hand it to the browser as a download.
 *
 * The API streams document content rather than issuing a presigned URL (DEC-046), so this
 * cannot be a plain `<a href>` - the request needs the session cookie and the response is a
 * body, not a redirect.
 */
async function download(path: string, fallbackName: string): Promise<void> {
  const res = await fetch(apiUrl(path));
  if (!res.ok) {
    let message = `Download failed (${res.status})`;
    try {
      const j = await res.json();
      if (typeof j?.message === 'string') message = j.message;
    } catch { /* a non-JSON error body is not more informative than the status */ }
    throw new ApiError(res.status, message);
  }
  const blob = await res.blob();

  // The filename comes from Content-Disposition, which the API percent-encodes.
  const cd = res.headers.get('content-disposition') ?? '';
  const m = /filename="([^"]*)"/.exec(cd);
  let name = fallbackName;
  if (m?.[1]) { try { name = decodeURIComponent(m[1]); } catch { name = m[1]; } }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick: revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Fetch a file as an object URL, for previewing in the page.
 *
 * The API always sends `Content-Disposition: attachment` (a scripted PDF must never execute in
 * the origin holding the session cookie), so a preview cannot be a plain `<iframe src=api/...>`.
 * Fetching the bytes with JS and building a `blob:` URL sidesteps that entirely: the browser
 * never navigates to the API response, so the header never has to be relaxed.
 *
 * The caller MUST call `revoke()` when the preview closes, or the bytes stay in memory for the
 * life of the document.
 */
async function blob(path: string): Promise<{ url: string; contentType: string; revoke: () => void }> {
  const res = await fetch(apiUrl(path));
  if (!res.ok) {
    let message = `Could not open that file (${res.status})`;
    try {
      const j = await res.json();
      if (typeof j?.message === 'string') message = j.message;
    } catch { /* a non-JSON body is no more informative than the status */ }
    throw new ApiError(res.status, message);
  }
  const b = await res.blob();
  const url = URL.createObjectURL(b);
  return {
    url,
    contentType: res.headers.get('content-type') ?? b.type ?? '',
    revoke: () => URL.revokeObjectURL(url),
  };
}

/**
 * Server-Sent Events over POST. The FIRST streaming path in this codebase.
 *
 * It cannot go through `request()`, which does `await res.text()` and so waits for the whole
 * body - the one thing a stream must not do. It is a sibling of `upload`/`download`/`blob` for
 * the same reason those are: each has a body-handling rule that `request()` cannot express.
 *
 * `EventSource` is not used, deliberately: it is GET-only, and the question has to travel in a
 * body rather than a query string. A question is PERSONAL data (data-inventory.md) and a query
 * string reaches the access log, the browser history and any proxy in between.
 *
 * `onEvent` is called per event as it arrives. The returned promise settles when the stream ends;
 * `signal` aborts it.
 */
export async function stream(
  path: string,
  body: unknown,
  onEvent: (event: string, data: unknown) => void,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body ?? {}),
      ...(signal ? { signal } : {}),
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Is the API running on port 4000?');
  }

  if (!res.ok) {
    // An error before the stream starts is an ordinary JSON response.
    const text = await res.text();
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    throw new ApiError(res.status,
      typeof parsed?.message === 'string' ? parsed.message : `Request failed (${res.status})`);
  }
  if (!res.body) throw new ApiError(0, 'The server sent no response body.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Events are separated by a blank line. A chunk can split one anywhere, including mid-UTF-8,
  // so `stream: true` on the decoder and a carry-over buffer are both load-bearing.
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      let name = 'message';
      const dataLines: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) name = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
      }
      if (dataLines.length === 0) continue;
      try { onEvent(name, JSON.parse(dataLines.join('\n'))); } catch { /* ignore a partial frame */ }
    }
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  upload,
  download,
  blob,
  stream,
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

// Mirrors `packages/authz` Role, widened to seven by migration 0031: `finance` is the finance
// head and `delivery_head` the delivery head in the onboarding approval chain.
export type Role = 'employee' | 'manager' | 'hr_admin' | 'hr_ops' | 'finance' | 'auditor'
  | 'delivery_head';

export interface Actor {
  userId: string;
  employeeId: string;
  employeeNumber: string;
  name: string;
  email: string;
  /** Every role in force now, from `user_role` (migration 0016). Roles are ADDITIVE. */
  roles: Role[];
  isBreakGlass: boolean;
  sessionId: string;
  /** TRANSITIONAL - the superseded single column. Use `roles`. */
  role: 'employee' | 'manager' | 'hr_admin';
}

/** Does this actor hold any of these roles? The UI's only role check - gating what is SHOWN. */
export const hasRole = (actor: Actor | undefined | null, ...roles: Role[]): boolean =>
  !!actor && roles.some((r) => actor.roles?.includes(r));

/** Data with the three states every screen must handle, plus a reload for after a mutation. */
export function useData<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!path) { setLoading(false); return; }
    setError(null);
    try {
      setData(await api.get<T>(path));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [path, ...deps]);

  return { data, error, loading, reload: load };
}

// -- formatting -------------------------------------------------------------
// Effort is INTEGER MINUTES in the database (ADR-0016). Display converts; storage never does.
export const hm = (minutes: number | string | null | undefined): string => {
  const m = Math.round(Number(minutes ?? 0));
  if (!m) return '0h';
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
};

export const decimalHours = (minutes: number | string | null | undefined): string =>
  (Number(minutes ?? 0) / 60).toFixed(1);

/**
 * Dates arrive as plain 'YYYY-MM-DD' strings and are formatted without ever constructing a
 * Date in the local zone - that is what silently shifted every date back a day (Rule 5).
 */
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

export const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};

export const fmtDateShort = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const [, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
};

/** Day of week from a date string, computed arithmetically rather than via Date parsing. */
export const weekdayOf = (iso: string): string => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  const yy = m < 3 ? y - 1 : y;
  const dow = (yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) + t[m - 1] + d) % 7;
  return DAYS[(dow + 6) % 7];   // JS 0=Sun -> our 0=Mon
};

export const addDaysIso = (iso: string, n: number): string => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
};

/**
 * THE BUSINESS DATE, from the server. The only correct source of "today" in this application.
 *
 * WHAT THIS REPLACES. `todayIsoFallback = () => new Date().toISOString().slice(0, 10)` used to
 * live here. It was unused - but four screens had written the same expression inline, which is
 * what an available helper like that invites. It returns the UTC date, and between midnight and
 * 05:30 IST the UTC date is YESTERDAY, so for five and a half hours out of every twenty-four
 * those screens were a day behind. Not cosmetically:
 *
 *   * `/organisation` used it for `min` on a department move's effective-from, so before 05:30
 *     the form permitted a BACK-DATED effective period - which Rule 3 exists to forbid;
 *   * `/payslips` defaulted a pay period's end to it, ending the period a day short against
 *     0024's declared-net reconciliation invariant;
 *   * `/reports` defaulted its window to it, silently omitting the current day;
 *   * `/profile` computed length of service from it, reading a month short on the 1st.
 *
 * `fn_business_date()` resolves the date through the company timezone in `org_setting` and now
 * rides the `/auth/me` response, which every screen in the shell already fetches. So there is one
 * authoritative answer, it comes from the organisation's own mechanism rather than a clock, and
 * there is no new endpoint or second abstraction to keep in step.
 *
 * Returns `null` until it has loaded. Callers must handle that rather than substituting a local
 * date, which is the whole point - a screen that briefly shows nothing is correct, and one that
 * briefly shows yesterday is not.
 */
export function useBusinessDate(): string | null {
  const me = useData<{ businessDate: string }>('/auth/me');
  return me.data?.businessDate ?? null;
}
