'use client';

/**
 * The skip link.
 *
 * Split out of the root layout because its text is translated and `useT` needs the provider,
 * which the layout renders rather than sits inside. It is the first focusable thing on every
 * page, so it is also the first place a direction mistake shows: `start-3` follows the writing
 * direction, where `left-3` would put the Arabic skip link at the far end of the line from where
 * the eye starts.
 */

import { useT } from '@/lib/i18n';

export function ShellChrome() {
  const t = useT();
  return (
    <a
      href="#main"
      className="sr-only focus:not-sr-only focus:absolute focus:start-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2 focus:text-[13.5px] focus:font-medium focus:ring-2 focus:ring-ink-900"
    >
      {t('app.skipToContent')}
    </a>
  );
}
