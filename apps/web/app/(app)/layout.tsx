'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, hasRole, useData, type Actor } from '@/lib/api';
import { Button, Skeleton } from '@/components/ui';
import { ArtLogo } from '@/components/logo';

/**
 * The application shell.
 *
 * WHY THIS IS A GROUPED SIDEBAR AND NOT A ROW OF TABS.
 *
 * It was a single horizontal bar until twelve destinations were competing for it, at which point
 * "My Profile", "My Work" and "Team Effort" each wrapped onto two lines and the bar became a wall
 * of same-weight words with no structure to scan. Horizontal space is fixed and was already
 * exhausted; vertical space is not, and six more modules (payroll, performance, analytics,
 * workflow, notifications, helpdesk) are still to come - so a wider bar only postpones the
 * problem by one release.
 *
 * The grouping is not decoration either. It states the product's actual shape - what is about
 * ME, what is about the people who report to me, what is about the ORGANISATION - which is the
 * same distinction the authorization model draws, so the navigation and the permissions tell the
 * reader the same story instead of two different ones.
 *
 * NO GROUP IS CALLED "MANAGER". `ai/context/domain-glossary.md` bans the unqualified word -
 * "Two different graphs. This ambiguity is a security bug waiting to happen" - because a line
 * manager and a project manager resolve through different graphs and confer different access.
 * "My team" describes the reporting line without claiming the other one.
 *
 * VISIBILITY HERE IS AN AFFORDANCE, NEVER A CONTROL. Every route calls `assertCan` server-side;
 * hiding a link only stops offering a door that is already locked (DEC-053). If these two ever
 * disagree, the API is right.
 */

interface NavItem { href: string; label: string }
interface NavGroup {
  id: string;
  title: string | null;
  items: readonly NavItem[];
  /** Which actors are OFFERED this group. The API decides who may pass. */
  when?: 'team' | 'hr' | 'hr_manage';
}

const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: 'top',
    title: null,
    items: [{ href: '/', label: 'Dashboard' }],
  },
  {
    // Identity first, then presence, then effort - the order somebody actually moves through a
    // day, rather than alphabetical.
    id: 'me',
    title: 'My records',
    items: [
      { href: '/profile', label: 'My profile' },
      { href: '/documents', label: 'Documents' },
      { href: '/attendance', label: 'Attendance' },
      { href: '/leave', label: 'Leave' },
      { href: '/work', label: 'My work' },
      { href: '/timesheet', label: 'Timesheet' },
      // Under "My records" rather than a payroll section: for everyone except HR this screen IS
      // their own record, and HR reaches an employee's payslips from that employee's profile.
      { href: '/payslips', label: 'My payslips' },
    ],
  },
  {
    id: 'team',
    title: 'My team',
    when: 'team',
    items: [
      { href: '/approvals', label: 'Approvals' },
      { href: '/team', label: 'Team effort' },
    ],
  },
  {
    id: 'org',
    title: 'Organisation',
    items: [
      /*
       * "Employees", not "People". The glossary keeps them apart on purpose - a Person is a human
       * being who survives rehire, an Employee is ONE employment relationship, and one person may
       * hold two over time. This screen lists employments, so the softer word would have been a
       * domain error rather than a friendlier label.
       */
      { href: '/employees', label: 'Employees' },
      /*
       * Reports sits with the organisation rather than under "My records", and is offered to
       * everyone. Both are deliberate: the page asks the API which reports the caller may run
       * (DEC-067), and an employee's view of each is their own record - so the narrowing lives in
       * the policy, not in this list.
       */
      { href: '/reports', label: 'Reports' },
    ],
  },
  {
    /*
     * Settings is HR-only, not visible to a line manager.
     *
     * ADR-0005 amendment (a) makes `org_setting` and the policy tables ORGANISATION-scoped:
     * denied by default, reachable only by an explicit administrative permission, because a
     * policy row is a historical derivation input and reading one is a privilege.
     * `authz-matrix.yaml` says `manager: deny` for both `config.policy.read` and
     * `config.setting.read`, and `settings.ts` enforces it with `assertCan` regardless of this
     * list.
     */
    id: 'masters',
    title: 'Masters',
    /*
     * `hr_manage`, not `hr`. The existing `hr` condition includes `auditor`, which may READ
     * configuration (that is why Settings uses it) but holds neither `org.unit.manage` nor
     * `org.designation.manage`. Offering an auditor these links would be offering a door that is
     * already locked - the exact thing DEC-053 recorded about the settings link.
     */
    when: 'hr_manage',
    items: [{ href: '/organisation', label: 'Organisation' }],
  },
  {
    id: 'admin',
    title: 'Administration',
    when: 'hr',
    items: [{ href: '/settings', label: 'Settings' }],
  },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const me = useData<{ actor: Actor }>('/auth/me');
  const [open, setOpen] = useState(false);

  // Not signed in is not an error state - it is a redirect.
  useEffect(() => {
    if (!me.loading && me.error) router.replace('/login');
  }, [me.loading, me.error, router]);

  useEffect(() => { setOpen(false); }, [pathname]);

  if (me.loading) {
    return <div className="mx-auto max-w-2xl pt-16"><Skeleton rows={5} /></div>;
  }
  if (!me.data) return null;

  const actor = me.data.actor;
  const isTeamLead = hasRole(actor, 'manager', 'hr_admin', 'hr_ops');
  // auditor may READ configuration per the matrix, so it gets the link too.
  const isHr = hasRole(actor, 'hr_admin', 'hr_ops', 'auditor');

  // Manages the organisation - narrower than `isHr`, which includes the read-only auditor.
  const isHrManage = hasRole(actor, 'hr_admin', 'hr_ops');

  const groups = NAV_GROUPS.filter((g) => (
    g.when === 'team' ? isTeamLead
      : g.when === 'hr' ? isHr
        : g.when === 'hr_manage' ? isHrManage
          : true
  ));

  /*
   * `/` matches exactly; everything else matches its subtree so a detail page keeps its parent
   * highlighted. `startsWith` alone would light up every row for `/`, which is why it is special.
   */
  const active = (href: string) =>
    (href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`));

  async function signOut() {
    try { await api.post('/auth/logout'); } finally { router.replace('/login'); }
  }

  /*
   * THE GOLD PILL IS THE WHOLE ACTIVE INDICATOR, and there is deliberately no accent bar.
   *
   * A left accent bar was the first attempt and it broke alignment: sitting in the row's flow, it
   * pushed every label 11px right of the group headings above them, so the two columns of text
   * disagreed. Fixing that meant either hand-tuning the heading padding to match - a number that
   * moves whenever the bar does - or absolutely positioning the bar. Neither earns its keep: the
   * pill already carried this job in the previous top-bar layout, so a second indicator would be
   * a new visual idiom for no added information.
   *
   * Gold tint with near-black text (DEC-054): gold behind white is ~1.7:1 and illegible, so every
   * gold surface in this product carries ink-900. Rows and headings now share `px-3` and line up
   * by construction rather than by arithmetic.
   */
  const rowClass = (isActive: boolean) => [
    'block truncate rounded-lg px-3 py-[7px] text-[13.5px] transition-colors',
    isActive
      ? 'bg-brand-100 font-semibold text-ink-900'
      : 'font-medium text-ink-600 hover:bg-ink-100 hover:text-ink-900',
  ].join(' ');

  const navGroups = (idPrefix: string) => groups.map((g) => (
    <div key={g.id} className={g.title ? 'mt-4 first:mt-0' : 'first:mt-0'}>
      {g.title && (
        <h2
          id={`${idPrefix}-${g.id}`}
          className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-400"
        >
          {g.title}
        </h2>
      )}
      <ul {...(g.title ? { 'aria-labelledby': `${idPrefix}-${g.id}` } : {})} className="space-y-0.5">
        {g.items.map((i) => {
          const on = active(i.href);
          return (
            <li key={i.href}>
              <Link href={i.href} aria-current={on ? 'page' : undefined} className={rowClass(on)}>
                {i.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  ));

  return (
    /*
     * A FLEX COLUMN THAT FILLS THE VIEWPORT, rather than a sticky header over a document scroll.
     *
     * The first version pinned the sidebar with `top-[57px]` and `h-[calc(100vh-57px)]`, a header
     * height measured by hand - and measured wrong: the header is ~53px (10px padding, a 32px
     * avatar, 10px, 1px border), so it would have left a 4px strip of page showing above the
     * sidebar. Any change to the avatar size or the padding would move it again.
     *
     * Here the header simply takes the height it takes, and the row below fills whatever is left.
     * `h-dvh` rather than `h-screen` because on mobile `100vh` includes the browser chrome, which
     * pushes the bottom of the layout under the URL bar.
     *
     * Safe because nothing in the app relies on the DOCUMENT scroll: the only fixed-position
     * elements are the document preview and the toast, both viewport-anchored and unaffected by
     * which element owns the scrollbar. Checked before making the change, not assumed.
     */
    <div className="flex h-dvh flex-col">
      <header className="z-30 shrink-0 border-b border-ink-200 bg-white/95 backdrop-blur">
        <div className="flex items-center gap-3 px-4 py-2.5 sm:px-6">
          <Link href="/" className="flex shrink-0 items-center gap-2" aria-label="ART HRM home">
            {/* The wordmark hides below sm; the disc alone still identifies the product. */}
            <ArtLogo size={28} className="sm:hidden" compact />
            <ArtLogo size={28} className="hidden sm:inline-flex" />
          </Link>

          <div className="ml-auto flex items-center gap-2">
            {/* The name badge is where people look for their own record, so it goes there. */}
            <Link
              href="/profile"
              className="flex items-center gap-2 rounded-lg px-1 py-0.5 hover:bg-ink-100"
              aria-label="My profile"
            >
              <span className="hidden text-right sm:block">
                <span className="block text-[13px] font-medium leading-tight text-ink-900">{actor.name}</span>
                <span className="block text-[12px] leading-tight text-ink-500">
                  {(actor.roles ?? [actor.role]).join(' · ').replace(/_/g, ' ')} · {actor.employeeNumber}
                </span>
              </span>
              <span aria-hidden className="grid h-8 w-8 place-items-center rounded-full bg-ink-200 text-[12.5px] font-semibold text-ink-700">
                {actor.name.split(' ').map((p) => p[0]).slice(0, 2).join('')}
              </span>
            </Link>
            <Button variant="ghost" size="sm" onClick={signOut}>Sign out</Button>
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-controls="mobile-nav"
              className="rounded-lg p-1.5 text-ink-600 hover:bg-ink-100 lg:hidden"
            >
              <span className="sr-only">Menu</span>
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
                <path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>

        {/*
          * The small-screen drawer carries the SAME groups and headings rather than a flat grid.
          * The previous two-column grid is what made the labels wrap, and a list of twelve
          * unlabelled links is no easier to scan on a phone than on a desktop.
          */}
        {open && (
          <nav id="mobile-nav" aria-label="Main" className="max-h-[70vh] overflow-y-auto border-t border-ink-100 px-3 py-3 lg:hidden">
            {navGroups('mnav')}
          </nav>
        )}
      </header>

      {/* `min-h-0` lets this row shrink inside the column so its children can own the scroll. */}
      <div className="flex min-h-0 flex-1">
        {/* Its own scroll region, so a long report never pushes the navigation out of reach. */}
        <nav
          aria-label="Main"
          className="hidden w-56 shrink-0 overflow-y-auto border-r border-ink-200 px-2 py-4 lg:block"
        >
          {navGroups('snav')}
        </nav>

        {/*
          * `min-w-0` is load-bearing: a flex child otherwise refuses to shrink below its
          * content's intrinsic width, so the wide report tables would push the whole page
          * sideways instead of scrolling inside their own `overflow-x-auto` container.
          */}
        <main id="main" className="min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6 sm:py-7">
          <div className="mx-auto max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
