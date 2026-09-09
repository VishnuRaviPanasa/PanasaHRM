import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ART HRM',
  description: 'HR management for Art Technology and Software',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2 focus:text-[13.5px] focus:font-medium focus:ring-2 focus:ring-ink-900"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
