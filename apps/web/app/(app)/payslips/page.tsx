'use client';

import { useState } from 'react';
import { PayslipDetail, PayslipList } from '@/components/payslips';
import { useT } from '@/lib/i18n';

/**
 * My Payslips.
 *
 * There is no role check here and there does not need to be one. `GET /payslips` composes the
 * scope predicate into its SQL, so an employee's list is their own record, HR's is the
 * organisation, and a line manager's is themselves alone - the narrowing lives in the policy
 * (Must-Know Rule 1), and this page renders whatever comes back.
 */
export default function PayslipsPage() {
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[21px] font-semibold text-ink-900">{t('payslips.title')}</h1>
        <p className="mt-0.5 text-[13.5px] text-ink-500">
          {t('payslips.subtitle')}
        </p>
      </div>

      {open
        ? <PayslipDetail id={open} onClose={() => setOpen(null)} />
        : (
          <PayslipList
            onOpen={setOpen}
            emptyHint={t('payslips.emptyHint')}
          />
        )}
    </div>
  );
}
