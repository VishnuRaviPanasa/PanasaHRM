'use client';

import { useEffect, useState } from 'react';
import { ApiError, api, fmtDate } from '@/lib/api';
import { Badge, Button, Empty, Skeleton } from '@/components/ui';

/**
 * The shared document list and previewer, used by both `/documents` and the employee profile.
 *
 * PREVIEWING SAFELY, which is the whole reason this is not three lines of JSX:
 *
 * The API sends `Content-Disposition: attachment` on every document, always - a scripted PDF or
 * a polyglot must never execute in the origin that holds the session cookie. So a preview cannot
 * be `<iframe src="/api/documents/x/download">`, because that navigates the browser to the
 * response and would need the header relaxed.
 *
 * Instead the bytes are fetched with JS and rendered from a `blob:` URL:
 *
 *   * images go in an `<img>`, which cannot execute anything at all;
 *   * PDFs go in an `<iframe sandbox>` with NO allow tokens, so the frame gets an opaque origin
 *     and scripts are refused - a malicious PDF has nothing to reach;
 *   * DOCX and XLSX have no browser renderer, so they are honestly labelled as download-only
 *     rather than shown in a viewer that would just fail.
 *
 * Every preview is also a real disclosure, so it is fetched with `?mode=view` and the API audits
 * it as a view rather than a download - the same authorization, a distinct fact.
 */

export type DataClass = 'PUBLIC_INTERNAL' | 'PERSONAL' | 'SENSITIVE' | 'RESTRICTED';

export interface Doc {
  id: string;
  employee_id: string;
  document_type_code: string;
  document_type_name: string;
  data_class: DataClass;
  title: string;
  issued_on: string | null;
  expires_on: string | null;
  issuing_authority: string | null;
  original_name: string | null;
  content_type: string | null;
  size_bytes: string | null;
  /**
   * Availability is the presence of a PROMOTED version, not the status of the latest one.
   * v1 can be clean and current while v2 sits pending: the document is available AND has
   * something awaiting a scan, and one field cannot say both.
   */
  available: boolean;
  current_version_no: number | null;
  latest_version_no: number | null;
  latest_scan_status: 'pending' | 'clean' | 'infected' | 'failed' | null;
  version_count: string;
  uploaded_at: string;
  uploaded_by_name: string | null;
  withdrawn_at: string | null;
  withdrawn_reason: string | null;
}

export const CLASS_TONE: Record<DataClass, string> = {
  PUBLIC_INTERNAL: 'bg-ink-100 text-ink-600 ring-ink-200',
  PERSONAL: 'bg-sky-50 text-sky-700 ring-sky-200',
  SENSITIVE: 'bg-amber-50 text-amber-800 ring-amber-200',
  RESTRICTED: 'bg-rose-50 text-rose-700 ring-rose-200',
};

export const kb = (bytes: string | null): string => {
  const n = Number(bytes ?? 0);
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

const PREVIEWABLE = ['application/pdf', 'image/jpeg', 'image/png'];
export const canPreview = (contentType: string | null): boolean =>
  !!contentType && PREVIEWABLE.includes(contentType);

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

export function DocumentViewer({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'error'; message: string }
    | { kind: 'ready'; url: string; contentType: string }
  >({ kind: 'loading' });

  useEffect(() => {
    let revoke: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      try {
        const b = await api.blob(`/documents/${doc.id}/download?mode=view`);
        revoke = b.revoke;
        // If the dialog closed while the fetch was in flight, release immediately rather than
        // setting state on an unmounted component.
        if (cancelled) { b.revoke(); return; }
        setState({ kind: 'ready', url: b.url, contentType: b.contentType });
      } catch (e) {
        if (!cancelled) {
          setState({
            kind: 'error',
            message: e instanceof ApiError ? e.message : 'Could not open that file.',
          });
        }
      }
    })();

    return () => { cancelled = true; revoke?.(); };
  }, [doc.id]);

  // Escape closes, and focus is trapped loosely by the overlay taking the click.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Preview: ${doc.title}`}
      className="fixed inset-0 z-50 flex flex-col bg-ink-900/70 p-3 sm:p-6"
      onClick={onClose}
    >
      <div
        className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-wrap items-center gap-3 border-b border-ink-200 px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-semibold text-ink-900">{doc.title}</h2>
            <p className="mt-0.5 truncate text-[12.5px] text-ink-500">
              {doc.document_type_name} · {doc.original_name ?? '—'} · {kb(doc.size_bytes)}
            </p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void api
              .download(`/documents/${doc.id}/download`, doc.original_name ?? 'document')
              .catch(() => undefined)}
          >
            Download
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close preview">
            Close
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto bg-ink-100">
          {state.kind === 'loading' && <div className="p-6"><Skeleton rows={6} /></div>}

          {state.kind === 'error' && (
            <div className="p-6">
              <Empty title="Cannot preview this document" hint={state.message} />
            </div>
          )}

          {state.kind === 'ready' && state.contentType.startsWith('image/') && (
            /* An <img> cannot execute anything, so an image needs no further containment. */
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={state.url}
              alt={doc.title}
              className="mx-auto max-h-full max-w-full object-contain p-3"
            />
          )}

          {state.kind === 'ready' && state.contentType === 'application/pdf' && (
            <iframe
              src={state.url}
              title={doc.title}
              /* No allow tokens: opaque origin, scripts refused. A scripted PDF has nothing
                 to reach - not the session cookie, not the parent page. */
              sandbox=""
              className="h-full min-h-[60vh] w-full border-0 bg-white"
            />
          )}

          {state.kind === 'ready' && !canPreview(state.contentType) && (
            <div className="p-6">
              <Empty
                title="No preview for this file type"
                hint="Word and Excel files have no browser preview. Download it to open it."
                action={
                  <Button
                    size="sm"
                    onClick={() => void api
                      .download(`/documents/${doc.id}/download`, doc.original_name ?? 'document')
                      .catch(() => undefined)}
                  >
                    Download
                  </Button>
                }
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function DocumentList({
  documents, isHr, onChanged, onError,
}: {
  documents: Doc[];
  isHr: boolean;
  onChanged?: () => void | Promise<void>;
  onError?: (message: string) => void;
}) {
  const [viewing, setViewing] = useState<Doc | null>(null);

  const fail = (e: unknown) =>
    onError?.(e instanceof ApiError ? e.message : 'That did not work.');

  async function get(doc: Doc) {
    try {
      await api.download(`/documents/${doc.id}/download`, doc.original_name ?? 'document');
    } catch (e) { fail(e); }
  }

  async function clear(doc: Doc) {
    try {
      await api.post(`/documents/${doc.id}/scan`, { verdict: 'clean' });
      await onChanged?.();
    } catch (e) { fail(e); }
  }

  async function withdraw(doc: Doc) {
    const reason = window.prompt('Why is this document being withdrawn?');
    if (!reason?.trim()) return;
    try {
      await api.post(`/documents/${doc.id}/withdraw`, { reason: reason.trim() });
      await onChanged?.();
    } catch (e) { fail(e); }
  }

  if (documents.length === 0) {
    return <Empty title="No documents" hint="Nothing has been filed yet." />;
  }

  return (
    <>
      {viewing && <DocumentViewer doc={viewing} onClose={() => setViewing(null)} />}

      <ul className="divide-y divide-ink-100">
        {documents.map((doc) => {
          const available = doc.available && !doc.withdrawn_at;
          // A pending LATEST version is what HR must act on, and it is independent of whether an
          // older version is already being served.
          const awaitingScan = doc.latest_scan_status === 'pending' && !doc.withdrawn_at;
          const adverse = doc.latest_scan_status === 'infected'
            || doc.latest_scan_status === 'failed';
          const expiringSoon = !!doc.expires_on && !doc.withdrawn_at
            && doc.expires_on <= new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);

          return (
            <li key={doc.id} className="flex flex-wrap items-start gap-3 px-4 py-3 sm:px-5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13.5px] font-medium text-ink-900">{doc.title}</span>
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11.5px] font-medium ring-1 ring-inset ${CLASS_TONE[doc.data_class]}`}>
                    {doc.document_type_name}
                  </span>
                  {doc.withdrawn_at && <Badge status="rejected">withdrawn</Badge>}
                  {!doc.withdrawn_at && available && <Badge status="approved">available</Badge>}
                  {/* Both badges can appear at once - v1 served, v2 waiting. */}
                  {awaitingScan && (
                    <Badge status="submitted">
                      {available ? `v${doc.latest_version_no} awaiting scan` : 'awaiting scan'}
                    </Badge>
                  )}
                  {!doc.withdrawn_at && adverse && (
                    <Badge status="rejected">{doc.latest_scan_status}</Badge>
                  )}
                  {expiringSoon && available && <Badge status="late">expires soon</Badge>}
                </div>

                <p className="mt-0.5 text-[12.5px] text-ink-500">
                  {doc.original_name ?? '—'} · {kb(doc.size_bytes)}
                  {Number(doc.version_count) > 1 ? ` · ${doc.version_count} versions` : ''}
                  {doc.issued_on ? ` · issued ${fmtDate(doc.issued_on)}` : ''}
                  {doc.expires_on ? ` · expires ${fmtDate(doc.expires_on)}` : ''}
                  {doc.uploaded_by_name ? ` · filed by ${doc.uploaded_by_name}` : ''}
                </p>

                {awaitingScan && !available && (
                  <p className="mt-1 text-[12.5px] text-amber-800">
                    Not available yet — it is scanned before it can be opened.
                    {isHr ? ' Use Mark cleared once you are satisfied with it.' : ''}
                  </p>
                )}
                {awaitingScan && available && (
                  <p className="mt-1 text-[12.5px] text-amber-800">
                    Version {doc.latest_version_no} is awaiting a scan. Version{' '}
                    {doc.current_version_no} is being served meanwhile.
                  </p>
                )}
                {adverse && !doc.withdrawn_at && (
                  <p className="mt-1 text-[12.5px] text-rose-700">
                    The latest upload did not pass its scan and is not being served.
                  </p>
                )}
                {doc.withdrawn_at && (
                  <p className="mt-1 text-[12.5px] text-ink-500">
                    Withdrawn {fmtDate(doc.withdrawn_at)}
                    {doc.withdrawn_reason ? ` — ${doc.withdrawn_reason}` : ''}
                  </p>
                )}
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  disabled={!available || !canPreview(doc.content_type)}
                  onClick={() => setViewing(doc)}
                  title={!canPreview(doc.content_type)
                    ? 'Word and Excel files have no browser preview'
                    : undefined}
                >
                  View
                </Button>
                <Button size="sm" variant="secondary" disabled={!available}
                  onClick={() => void get(doc)}>
                  Download
                </Button>
                {isHr && awaitingScan && (
                  <Button size="sm" variant="secondary" onClick={() => void clear(doc)}>
                    Mark cleared
                  </Button>
                )}
                {isHr && !doc.withdrawn_at && (
                  <Button size="sm" variant="ghost" onClick={() => void withdraw(doc)}>
                    Withdraw
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
