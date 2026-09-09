import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <div className="text-center">
        <p className="text-[13px] font-semibold uppercase tracking-wide text-ink-400">404</p>
        <h1 className="mt-1 text-[20px] font-semibold text-ink-900">That page does not exist</h1>
        <Link href="/" className="mt-4 inline-block rounded-lg bg-ink-900 px-3.5 py-1.5 text-[13.5px] font-medium text-white hover:bg-ink-800">
          Back to dashboard
        </Link>
      </div>
    </main>
  );
}
