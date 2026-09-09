import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import './globals.css';
// From dictionary.ts, NOT from the client barrel: this file is a server component and calls
// isLocale() during the render. Importing it from a 'use client' module compiles and then 500s
// on every request.
import {
  DICTIONARIES, DIRECTION, LOCALE_COOKIE, isLocale, type Locale,
} from '@/lib/i18n/dictionary';
import { I18nProvider } from '@/lib/i18n';
import { ShellChrome } from '@/components/shell-chrome';

/**
 * The document title, in the viewer's language.
 *
 * A static `metadata` export cannot call t() - it is evaluated on the server with no component
 * to bind a hook to, and the substitution pass put a call here that failed to compile.
 * `generateMetadata` is the supported way to make it dynamic, and it can read the same cookie the
 * layout below reads, so the browser tab matches the page rather than always saying English.
 *
 * DICTIONARIES is imported directly rather than through the client barrel, for the same reason
 * the layout imports from `dictionary` - see the note beside isLocale there.
 */
export async function generateMetadata(): Promise<Metadata> {
  const jar = await cookies();
  const raw = jar.get(LOCALE_COOKIE)?.value;
  const locale: Locale = isLocale(raw) ? raw : 'en';
  const dict = DICTIONARIES[locale];
  return {
    title: dict['app.name'],
    description: dict['login.tagline'],
  };
}

/**
 * The locale is resolved HERE, on the server, from a cookie.
 *
 * `dir` and `lang` live on the `<html>` element, so they have to be right in the first byte sent.
 * Resolving the locale in the client instead would paint every Arabic session left-to-right and
 * then flip it - a visible jump that also moves the focus ring and the scroll position. Reading a
 * cookie makes this layout dynamic, which is correct: the page genuinely differs per viewer.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  const raw = jar.get(LOCALE_COOKIE)?.value;
  const locale: Locale = isLocale(raw) ? raw : 'en';

  return (
    <html lang={locale} dir={DIRECTION[locale]}>
      <body>
        <I18nProvider locale={locale}>
          {/*
            * The skip link's text is translated, so it lives in a client component - `t()` needs
            * the provider. Its position uses `start-3` rather than `left-3`, because in Arabic
            * the skip link belongs at the start of the line, which is the right-hand side.
            */}
          <ShellChrome />
          {children}
        </I18nProvider>
      </body>
    </html>
  );
}
