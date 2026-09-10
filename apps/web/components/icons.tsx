/**
 * The icon set.
 *
 * WHY THESE ARE HAND-DRAWN AND NOT A LIBRARY
 *   `lucide-react` or `@heroicons/react` would each be one line in package.json - and CLAUDE.md
 *   requires a recorded reason for every dependency (supply chain, OWASP A03:2025). An icon pack
 *   is ~1,500 glyphs shipped to reach the twenty used here, and the two screens that needed
 *   iconography did not justify a new supply-chain surface. These are 20x20 stroke paths on one
 *   shared geometry, so they cost nothing at runtime and cannot drift from the design.
 *
 * THE GEOMETRY IS THE WHOLE POINT OF A SET
 *   One viewBox (0 0 20 20), one stroke width (1.6), round caps and joins, `currentColor`, no
 *   fills. That is what makes twenty separate drawings read as one family - a mixed set is the
 *   fastest way to make a considered interface look assembled from parts.
 *
 * ACCESSIBILITY
 *   Every icon is `aria-hidden` and decorative BY DEFAULT, because in this UI an icon always sits
 *   beside its own label. An icon that is the only content of a control must be given an
 *   accessible name by that control (`aria-label` on the button), never by the glyph - a
 *   screen reader should hear "Sign out", not "sign out icon".
 *
 * NO ICON CARRIES MEANING ALONE. Colour and glyph are both redundant here: the KPI cards, the
 * punch states and the approval rows all name their state in text as well. That is a WCAG 1.4.1
 * requirement, and it is also just how somebody scanning a dashboard actually reads it.
 */

import type { ReactNode } from 'react';

export interface IconProps {
  className?: string;
  /** Pixels. 16 for inline text, 18 in navigation, 20-22 in a tile. */
  size?: number;
}

/** One shared frame, so every glyph inherits the same geometry. */
const glyph = (children: ReactNode) =>
  function Glyph({ className = '', size = 18 }: IconProps) {
    return (
      <svg
        viewBox="0 0 20 20"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        className={`shrink-0 ${className}`}
      >
        {children}
      </svg>
    );
  };

// ---------------------------------------------------------------- people
export const IconUser = glyph(<>
  <circle cx="10" cy="6.5" r="3.1" />
  <path d="M3.8 17c.7-3.1 3.2-4.7 6.2-4.7s5.5 1.6 6.2 4.7" />
</>);

export const IconUsers = glyph(<>
  <circle cx="7.8" cy="6.8" r="2.8" />
  <path d="M2.5 16.8c.6-2.7 2.7-4.2 5.3-4.2s4.7 1.5 5.3 4.2" />
  <path d="M13.4 4.4a2.8 2.8 0 0 1 0 5.1M15.2 12.9c1.3.5 2.1 1.7 2.4 3.4" />
</>);

/** Present: a person, confirmed. */
export const IconUserCheck = glyph(<>
  <circle cx="8.2" cy="6.5" r="3" />
  <path d="M2.6 17c.6-2.9 2.9-4.5 5.6-4.5 .7 0 1.4.1 2 .3" />
  <path d="M12.4 14.2 14.3 16l3.1-3.6" />
</>);

export const IconUserPlus = glyph(<>
  <circle cx="8.2" cy="6.5" r="3" />
  <path d="M2.6 17c.6-2.9 2.9-4.5 5.6-4.5 .5 0 1 .05 1.5.15" />
  <path d="M15 11.6v4.6M12.7 13.9h4.6" />
</>);

// ---------------------------------------------------------------- time
export const IconClock = glyph(<>
  <circle cx="10" cy="10" r="7.2" />
  <path d="M10 6.1V10l2.7 1.9" />
</>);

/** Late / attention on a clock. */
export const IconClockAlert = glyph(<>
  <path d="M16.9 11.3A7.2 7.2 0 1 1 10 2.8" />
  <path d="M10 6.1V10l2.4 1.7" />
  <path d="M17.2 3.4v3.4M17.2 9.1v.05" />
</>);

export const IconCalendar = glyph(<>
  <rect x="2.9" y="4.3" width="14.2" height="12.8" rx="2.2" />
  <path d="M2.9 8.2h14.2M6.8 2.6v2.8M13.2 2.6v2.8" />
</>);

export const IconCalendarCheck = glyph(<>
  <rect x="2.9" y="4.3" width="14.2" height="12.8" rx="2.2" />
  <path d="M2.9 8.2h14.2M6.8 2.6v2.8M13.2 2.6v2.8" />
  <path d="m7.4 12.3 1.7 1.7 3.5-3.7" />
</>);

/** On leave: a day struck out. */
export const IconCalendarOff = glyph(<>
  <rect x="2.9" y="4.3" width="14.2" height="12.8" rx="2.2" />
  <path d="M2.9 8.2h14.2M6.8 2.6v2.8M13.2 2.6v2.8" />
  <path d="m8.1 11.1 3.8 3.8M11.9 11.1l-3.8 3.8" />
</>);

export const IconCalendarPlus = glyph(<>
  <rect x="2.9" y="4.3" width="14.2" height="12.8" rx="2.2" />
  <path d="M2.9 8.2h14.2M6.8 2.6v2.8M13.2 2.6v2.8" />
  <path d="M10 10.4v4.2M7.9 12.5h4.2" />
</>);

// ---------------------------------------------------------------- work
export const IconHome = glyph(<>
  <path d="M3.2 9.1 10 3.4l6.8 5.7" />
  <path d="M4.9 10.5v5.4a1.2 1.2 0 0 0 1.2 1.2h7.8a1.2 1.2 0 0 0 1.2-1.2v-5.4" />
  <path d="M8.3 17.1v-4h3.4v4" />
</>);

export const IconBriefcase = glyph(<>
  <rect x="2.6" y="6.4" width="14.8" height="10.2" rx="2" />
  <path d="M7.3 6.4V4.9a1.4 1.4 0 0 1 1.4-1.4h2.6a1.4 1.4 0 0 1 1.4 1.4v1.5" />
  <path d="M2.6 10.8h14.8" />
</>);

export const IconLayers = glyph(<>
  <path d="m10 2.9 6.6 3.4L10 9.7 3.4 6.3 10 2.9Z" />
  <path d="m3.4 10 6.6 3.4L16.6 10M3.4 13.7l6.6 3.4 6.6-3.4" />
</>);

export const IconListCheck = glyph(<>
  <path d="M8 5.6h9M8 10h9M8 14.4h9" />
  <path d="m3 5.3.9.9 1.7-1.8M3 9.7l.9.9 1.7-1.8M3 14.1l.9.9 1.7-1.8" />
</>);

export const IconFile = glyph(<>
  <path d="M11.4 2.9H6.5a1.9 1.9 0 0 0-1.9 1.9v10.4a1.9 1.9 0 0 0 1.9 1.9h7a1.9 1.9 0 0 0 1.9-1.9V6.9Z" />
  <path d="M11.4 2.9v4h4M7.6 11h4.8M7.6 13.8h3.2" />
</>);

/** Payslip: a document with a currency line. */
export const IconReceipt = glyph(<>
  <path d="M5 2.9h10v14.2l-2.5-1.4-2.5 1.4-2.5-1.4L5 17.1Z" />
  <path d="M7.8 6.6h4.4M7.8 9.7h4.4M7.8 12.4h2.6" />
</>);

export const IconChart = glyph(<>
  <path d="M3.2 16.8h13.6" />
  <path d="M6 16.8V9.4M10 16.8V4.9M14 16.8v-4.6" />
</>);

/** Approvals: an inbox with something waiting. */
export const IconInbox = glyph(<>
  <path d="M2.8 10.6 5 4.4a1.6 1.6 0 0 1 1.5-1h7a1.6 1.6 0 0 1 1.5 1l2.2 6.2" />
  <path d="M2.8 10.6v4.2a1.8 1.8 0 0 0 1.8 1.8h10.8a1.8 1.8 0 0 0 1.8-1.8v-4.2h-4.3a2 2 0 0 0-1.9 1.3 1.4 1.4 0 0 1-1.3.9h-.6a1.4 1.4 0 0 1-1.3-.9 2 2 0 0 0-1.9-1.3Z" />
</>);

export const IconBuilding = glyph(<>
  <path d="M4.2 17.1V4.4a1.5 1.5 0 0 1 1.5-1.5h5.2a1.5 1.5 0 0 1 1.5 1.5v12.7" />
  <path d="M12.4 8.4h2.4a1.5 1.5 0 0 1 1.5 1.5v7.2M2.9 17.1h14.2" />
  <path d="M6.8 6.4h3M6.8 9.6h3M6.8 12.8h3" />
</>);

export const IconGrid = glyph(<>
  <rect x="3" y="3" width="6" height="6" rx="1.6" />
  <rect x="11" y="3" width="6" height="6" rx="1.6" />
  <rect x="3" y="11" width="6" height="6" rx="1.6" />
  <rect x="11" y="11" width="6" height="6" rx="1.6" />
</>);

export const IconSettings = glyph(<>
  <path d="M4.1 6.1h11.8M4.1 13.9h11.8" />
  <circle cx="8" cy="6.1" r="2" />
  <circle cx="12.6" cy="13.9" r="2" />
</>);

// ---------------------------------------------------------------- feedback
export const IconChevron = glyph(<path d="m7.8 4.6 5.4 5.4-5.4 5.4" />);

export const IconArrowEnd = glyph(<>
  <path d="M3.6 10h12.8" />
  <path d="m11.6 5.2 4.8 4.8-4.8 4.8" />
</>);

export const IconEye = glyph(<>
  <path d="M1.9 10S5 4.8 10 4.8 18.1 10 18.1 10 15 15.2 10 15.2 1.9 10 1.9 10Z" />
  <circle cx="10" cy="10" r="2.4" />
</>);

export const IconEyeOff = glyph(<>
  <path d="M7.4 5.3A7.8 7.8 0 0 1 10 4.8c5 0 8.1 5.2 8.1 5.2a15 15 0 0 1-2.2 2.8M4.6 6.7A15.5 15.5 0 0 0 1.9 10s3.1 5.2 8.1 5.2a7.7 7.7 0 0 0 2.4-.4" />
  <path d="M8.4 8.5a2.4 2.4 0 0 0 3.3 3.4M2.9 2.9l14.2 14.2" />
</>);

export const IconCheck = glyph(<path d="m4.4 10.4 3.5 3.5 7.7-8" />);

export const IconShield = glyph(<>
  <path d="M10 2.7 4.3 5v4.6c0 3.3 2.3 6.3 5.7 7.7 3.4-1.4 5.7-4.4 5.7-7.7V5Z" />
  <path d="m7.6 9.9 1.8 1.8 3.3-3.5" />
</>);

export const IconHistory = glyph(<>
  <path d="M3.2 10a6.8 6.8 0 1 0 2.1-4.9L3.1 7.2" />
  <path d="M2.9 3.6v3.8h3.8M10 6.4V10l2.6 1.7" />
</>);

export const IconLogOut = glyph(<>
  <path d="M8.1 3.4H5.4a1.8 1.8 0 0 0-1.8 1.8v9.6a1.8 1.8 0 0 0 1.8 1.8h2.7" />
  <path d="M12.4 6.6 15.8 10l-3.4 3.4M7.6 10h8.2" />
</>);

export const IconBell = glyph(<>
  <path d="M15.1 12.9V9a5.1 5.1 0 0 0-10.2 0v3.9l-1.3 2h12.8Z" />
  <path d="M8.3 16.9a1.9 1.9 0 0 0 3.4 0" />
</>);

export const IconPin = glyph(<>
  <path d="M10 17.3s5.3-4.6 5.3-8.6a5.3 5.3 0 0 0-10.6 0c0 4 5.3 8.6 5.3 8.6Z" />
  <circle cx="10" cy="8.5" r="2.1" />
</>);

export const IconSun = glyph(<>
  <circle cx="10" cy="10" r="3.4" />
  <path d="M10 2.4v1.8M10 15.8v1.8M2.4 10h1.8M15.8 10h1.8M4.6 4.6l1.3 1.3M14.1 14.1l1.3 1.3M15.4 4.6l-1.3 1.3M5.9 14.1l-1.3 1.3" />
</>);
