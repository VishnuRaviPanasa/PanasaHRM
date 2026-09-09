'use client';

import Link from 'next/link';
import { useState } from 'react';
import { fmtDate, useData } from '@/lib/api';
import { Async, Badge, Button, Card, CardHead, Empty, inputCls } from '@/components/ui';
import { AddEmployee } from '@/components/employee-master';
import { useT } from '@/lib/i18n';

interface Row {
  id: string; employee_number: string; full_name: string; work_email: string;
  joined_on: string; status: string;
  department: string | null; designation: string | null; manager: string | null;
  /**
   * Present only when the API decided the caller may see them - the decision is made by
   * `AuthorizationService` server-side, not by this component. A count of MEDICAL certificates
   * is information about somebody's health even without the files, so it is withheld from the
   * RESPONSE rather than hidden in the markup.
   */
  document_count: string | null;
  pending_count: string | null;
  expiring_count: string | null;
}

/** A compact "3 · 1 pending · 2 expiring" cell, so HR can spot gaps without opening anybody. */
function DocsCell({ e }: { e: Row }) {
  const total = Number(e.document_count ?? 0);
  const pending = Number(e.pending_count ?? 0);
  const expiring = Number(e.expiring_count ?? 0);

  if (total === 0 && pending === 0) {
    return <span className="text-[13px] text-ink-400">none</span>;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="num text-ink-800">{total}</span>
      {pending > 0 && <Badge status="submitted">{pending} awaiting scan</Badge>}
      {expiring > 0 && <Badge status="late">{expiring} expiring</Badge>}
    </span>
  );
}

export default function EmployeesPage() {
  const t = useT();
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [tick, setTick] = useState(0);
  const state = useData<{ employees: Row[]; showDocumentCounts?: boolean; canCreate?: boolean }>(
    `/employees${q ? `?q=${encodeURIComponent(q)}` : ''}`, [q, tick]);

  if (adding) {
    return (
      <div className="space-y-5">
        <AddEmployee
          onDone={() => { setAdding(false); setTick((t) => t + 1); }}
          onCancel={() => setAdding(false)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[21px] font-semibold text-ink-900">{t('nav.employees')}</h1>
          <p className="mt-0.5 text-[13.5px] text-ink-500">
          Department, designation and line manager are resolved as of today from the effective-dated
          assignment.
          {state.data?.showDocumentCounts
            ? ' Document counts are visible to you because you administer HR records.'
            : ''}
          </p>
        </div>
        {/* Offered only when the API says the caller holds people.employee.create. */}
        {state.data?.canCreate && (
          <Button onClick={() => setAdding(true)}>{t('emp.add')}</Button>
        )}
      </div>

      <Card>
        <CardHead
          title={t('emp.directory')}
          action={
            <div className="w-full sm:w-64">
              <label htmlFor="emp-search" className="sr-only">{t('emp.search')}</label>
              <input
                id="emp-search" type="search" className={inputCls} placeholder={t('emp.searchBy')}
                value={q} onChange={(e) => setQ(e.target.value)}
              />
            </div>
          }
        />
        <Async
          state={state}
          rows={5}
          isEmpty={(d) => d.employees.length === 0}
          empty={<Empty title={t('emp.noMatch')} hint={t('emp.noMatchHint')} />}
        >
          {(d) => (
            <>
              {/* Table on wide screens, cards on narrow. Same data, no horizontal scroll. */}
              <div className="hidden overflow-x-auto sm:block">
                <table className="w-full text-start text-[13.5px]">
                  <thead className="border-b border-ink-100 text-[12px] uppercase tracking-wide text-ink-400">
                    <tr>
                      <th scope="col" className="px-5 py-2.5 font-medium">{t('common.employee')}</th>
                      <th scope="col" className="px-3 py-2.5 font-medium">{t('emp.department')}</th>
                      <th scope="col" className="px-3 py-2.5 font-medium">{t('emp.designation')}</th>
                      <th scope="col" className="px-3 py-2.5 font-medium">{t('emp.manager')}</th>
                      <th scope="col" className="px-3 py-2.5 font-medium">{t('emp.joined')}</th>
                      {d.showDocumentCounts && (
                        <th scope="col" className="px-3 py-2.5 font-medium">{t('docs.title')}</th>
                      )}
                      <th scope="col" className="px-5 py-2.5 font-medium">{t('common.status')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {d.employees.map((e) => (
                      <tr key={e.id} className="hover:bg-ink-50">
                        <td className="px-5 py-2.5">
                          <Link href={`/employees/${e.id}`} className="font-medium text-brand-700 hover:underline">
                            {e.full_name}
                          </Link>
                          <div className="num text-[12.5px] text-ink-500">{e.employee_number}</div>
                        </td>
                        <td className="px-3 py-2.5 text-ink-700">{e.department ?? '—'}</td>
                        <td className="px-3 py-2.5 text-ink-700">{e.designation ?? '—'}</td>
                        <td className="px-3 py-2.5 text-ink-700">{e.manager ?? '—'}</td>
                        <td className="px-3 py-2.5 text-ink-600">{fmtDate(e.joined_on)}</td>
                        {d.showDocumentCounts && (
                          <td className="px-3 py-2.5">
                            <Link href={`/employees/${e.id}#documents`}
                              className="hover:underline" aria-label={`Documents for ${e.full_name}`}>
                              <DocsCell e={e} />
                            </Link>
                          </td>
                        )}
                        <td className="px-5 py-2.5"><Badge status={e.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <ul className="divide-y divide-ink-100 sm:hidden">
                {d.employees.map((e) => (
                  <li key={e.id} className="px-4 py-3">
                    <Link href={`/employees/${e.id}`} className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-medium text-brand-700">{e.full_name}</div>
                        <div className="num text-[12.5px] text-ink-500">{e.employee_number}</div>
                        <div className="mt-1 text-[13px] text-ink-600">
                          {e.designation ?? '—'} · {e.department ?? '—'}
                        </div>
                        {d.showDocumentCounts && (
                          <div className="mt-1 text-[12.5px]">
                            <span className="text-ink-400">{t('emp.documentsCount')} </span>
                            <DocsCell e={e} />
                          </div>
                        )}
                      </div>
                      <Badge status={e.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Async>
      </Card>
    </div>
  );
}
