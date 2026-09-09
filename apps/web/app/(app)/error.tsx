'use client';

import { Button } from '@/components/ui';

export default function AppError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert" className="mx-auto max-w-md rounded-xl border border-rose-200 bg-white p-6 text-center">
      <h1 className="text-[16px] font-semibold text-ink-900">This screen hit a problem</h1>
      <p className="mt-1.5 text-[13.5px] text-ink-600">
        {error.message || 'An unexpected error occurred.'}
      </p>
      <div className="mt-4 flex justify-center gap-2">
        <Button onClick={reset}>Try again</Button>
        <Button variant="secondary" onClick={() => (window.location.href = '/')}>Back to dashboard</Button>
      </div>
    </div>
  );
}
