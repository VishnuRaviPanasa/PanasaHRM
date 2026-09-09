'use client';

import { useMemo, useRef, useState } from 'react';
import { ApiError, api, fmtDate, hasRole, useData, type Actor } from '@/lib/api';
import {
  Async, Button, Card, CardHead, Empty, Field, Skeleton, Toast, inputCls,
} from '@/components/ui';
import { CLASS_TONE, DocumentList, type DataClass, type Doc } from '@/components/documents';
import { useT } from '@/lib/i18n';

/**
 * Employee documents.
 *
 * The screen's job beyond CRUD is to make three things impossible to misread:
 *
 *   1. A document awaiting a scan is NOT available. It is shown, because hiding an upload the
 *      user just made looks like a failure, but it cannot be downloaded and says why.
 *   2. Which document types the employee may upload themselves, and which HR handles. The
 *      selector only offers what the API will accept, so the refusal happens before the upload
 *      rather than after it.
 *   3. That RESTRICTED types are absent for a reason rather than missing by accident.
 *
 * The role checks here gate what is SHOWN. They are not the authorization - that is
 * `AuthorizationService` on the API, which refuses regardless of what this renders (and
 * `docs:test` proves it by calling the endpoints directly).
 */

interface DocType {
  code: string;
  name: string;
  data_class: DataClass;
  tracks_expiry: boolean;
  self_uploadable: boolean;
  description: string | null;
}

interface DocsResponse { documents: Doc[]; types?: DocType[] }
interface Employee { id: string; employee_number: string; full_name: string }

const ACCEPT = '.pdf,.jpg,.jpeg,.png,.docx,.xlsx';

export default function DocumentsPage() {
  const t = useT();
  const me = useData<{ actor: Actor }>('/auth/me');
  const actor = me.data?.actor;
  const isHr = hasRole(actor, 'hr_admin', 'hr_ops');

  const [forEmployee, setForEmployee] = useState<string>('');
  const subject = forEmployee || actor?.employeeId || '';

  const state = useData<DocsResponse>(
    subject ? `/documents?employeeId=${subject}` : null, [subject]);
  // HR may file a document against somebody else, so it needs the directory.
  const people = useData<{ employees: Employee[] }>(isHr ? '/employees' : null, [isHr]);

  const [toast, setToast] = useState<{ message: string; tone: 'good' | 'bad' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [typeCode, setTypeCode] = useState('');
  const [title, setTitle] = useState('');
  const [issuedOn, setIssuedOn] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const types = state.data?.types ?? [];
  const selected = types.find((t) => t.code === typeCode);

  /**
   * What this actor may actually upload for this subject. Filtering here means a refusal the
   * API would issue never gets as far as picking a file - and the hidden count is stated rather
   * than leaving the list looking short.
   */
  const { uploadable, hiddenCount } = useMemo(() => {
    const ownRecord = subject === actor?.employeeId;
    const allowed = types.filter((t) => (isHr ? true : t.self_uploadable && ownRecord));
    return { uploadable: allowed, hiddenCount: types.length - allowed.length };
  }, [types, isHr, subject, actor?.employeeId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) { setToast({ message: t('docs.chooseFileFirst'), tone: 'bad' }); return; }
    if (!typeCode) { setToast({ message: t('docs.chooseTypeFirst'), tone: 'bad' }); return; }

    const form = new FormData();
    form.set('file', file);
    form.set('documentTypeCode', typeCode);
    form.set('employeeId', subject);
    if (title.trim()) form.set('title', title.trim());
    if (issuedOn) form.set('issuedOn', issuedOn);
    if (expiresOn) form.set('expiresOn', expiresOn);

    setBusy(true);
    try {
      const res = await api.upload<{ message?: string }>('/documents', form);
      setToast({
        message: res.message ?? 'Uploaded and queued for scanning.',
        tone: 'good',
      });
      setTitle(''); setIssuedOn(''); setExpiresOn('');
      if (fileRef.current) fileRef.current.value = '';
      await state.reload();
    } catch (err) {
      // The API's rejection messages are written for a user ("That file is not the type it
      // claims to be") so they are shown as-is rather than replaced with something vaguer.
      setToast({
        message: err instanceof ApiError ? err.message : 'Upload failed.',
        tone: 'bad',
      });
    } finally {
      setBusy(false);
    }
  }




  if (me.loading) return <Skeleton rows={6} />;

  return (
    <div className="space-y-5">
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[19px] font-semibold tracking-tight text-ink-900">{t('docs.title')}</h1>
          <p className="mt-0.5 text-[13.5px] text-ink-500">
            {isHr
              ? 'Employee documents. Uploads are scanned before they become available.'
              : 'Your documents. Only you and HR can see them.'}
          </p>
        </div>

        {isHr && (
          <Field label={t('docs.whose')} htmlFor="who">
            <select
              id="who"
              className={inputCls}
              value={forEmployee}
              onChange={(e) => setForEmployee(e.target.value)}
            >
              <option value="">Mine ({actor?.employeeNumber})</option>
              {(people.data?.employees ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.employee_number} · {p.full_name}</option>
              ))}
            </select>
          </Field>
        )}
      </div>

      {/* ---------------- Upload ---------------- */}
      <Card>
        <CardHead
          title={t('docs.upload')}
          hint={t('docs.uploadHint')}
        />
        <form onSubmit={submit} className="grid gap-4 px-4 py-4 sm:grid-cols-2 sm:px-5">
          <Field label={t('docs.docType')} htmlFor="dtype">
            <select
              id="dtype"
              className={inputCls}
              value={typeCode}
              onChange={(e) => setTypeCode(e.target.value)}
              required
            >
              <option value="">{t('docs.choose')}</option>
              {uploadable.map((t) => (
                <option key={t.code} value={t.code}>{t.name}</option>
              ))}
            </select>
          </Field>

          <Field label={t('docs.file')} htmlFor="dfile">
            <input
              id="dfile"
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              className={`${inputCls} file:me-3 file:rounded-md file:border-0 file:bg-ink-100 file:px-3 file:py-1 file:text-[13px] file:font-medium file:text-ink-700`}
              required
            />
          </Field>

          <Field label={t('docs.docTitle')} hint={t('docs.titleHint')} htmlFor="dtitle">
            <input
              id="dtitle"
              className={inputCls}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={selected?.name ?? 'e.g. Aadhaar card'}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label={t('docs.issuedOn')} htmlFor="diss">
              <input id="diss" type="date" className={inputCls} value={issuedOn}
                onChange={(e) => setIssuedOn(e.target.value)} />
            </Field>
            {/* Only offered where the type says an expiry means something. */}
            {selected?.tracks_expiry && (
              <Field label={t('docs.expiresOn')} htmlFor="dexp">
                <input id="dexp" type="date" className={inputCls} value={expiresOn}
                  onChange={(e) => setExpiresOn(e.target.value)} />
              </Field>
            )}
          </div>

          <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
            <Button type="submit" busy={busy}>{t('docs.uploadAction')}</Button>
            <p className="text-[12.5px] text-ink-500">
              {t('docs.queuedForScan')}
            </p>
          </div>

          {selected && (
            <p className="sm:col-span-2 text-[12.5px] text-ink-500">
              <span className={`me-2 inline-flex items-center rounded-full px-2 py-0.5 text-[11.5px] font-medium ring-1 ring-inset ${CLASS_TONE[selected.data_class]}`}>
                {selected.data_class.replace('_', ' ').toLowerCase()}
              </span>
              {selected.description ?? 'No further description.'}
            </p>
          )}

          {hiddenCount > 0 && !isHr && (
            <p className="sm:col-span-2 rounded-lg bg-ink-50 px-3 py-2 text-[12.5px] text-ink-600">
              {hiddenCount} further document {hiddenCount === 1 ? 'type is' : 'types are'} handled
              by HR rather than uploaded here — contracts, offer letters and appraisal records
              among them.
            </p>
          )}
        </form>
      </Card>

      {/* ---------------- List ---------------- */}
      <Card>
        <CardHead
          title={t('docs.filed')}
          hint={t('docs.filedHint')}
          action={
            <Button variant="ghost" size="sm" onClick={() => void state.reload()}>{t('docs.refresh')}</Button>
          }
        />
        <Async
          state={state}
          rows={4}
          isEmpty={(d) => d.documents.length === 0}
          empty={
            <Empty
              title={t('docs.noneYet')}
              hint={isHr
                ? 'Nothing has been filed for this employee.'
                : 'Anything you upload will appear here once it has been scanned.'}
            />
          }
        >
          {(d) => (
            <DocumentList
              documents={d.documents}
              isHr={isHr}
              onChanged={() => state.reload()}
              onError={(message) => setToast({ message, tone: 'bad' })}
            />
          )}
        </Async>

        {isHr && (
          <p className="border-t border-ink-100 px-4 py-3 text-[12.5px] text-ink-500 sm:px-5">
            <strong className="font-medium text-ink-700">{t('docs.markCleared')}</strong> stands in for a
            virus scanner, which is not built yet. Until one exists, clearing a document records
            only that a person clicked it.
          </p>
        )}
      </Card>
    </div>
  );
}
