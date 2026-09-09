'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * The single door to the API.
 *
 * Requests go to /api/* on the same origin; next.config.ts rewrites them to the NestJS app, so
 * the session cookie is same-origin and needs no CORS or credentials handling.
 */

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
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
    res = await fetch(`/api${path}`, { method: 'POST', body: form });
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
  const res = await fetch(`/api${path}`);
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
  const res = await fetch(`/api${path}`);
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

export const api = {
  get: <T>(path: string) => request<T>(path),
  upload,
  download,
  blob,
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

export type Role = 'employee' | 'manager' | 'hr_admin' | 'hr_ops' | 'finance' | 'auditor';

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

export const todayIsoFallback = () => new Date().toISOString().slice(0, 10);
