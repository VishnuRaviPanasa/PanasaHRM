'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ComponentType } from 'react';
import { api, hasRole, useData, type Actor } from '@/lib/api';
import { Avatar, Skeleton } from '@/components/ui';
import { LanguageSwitcher, useT, type MessageKey } from '@/lib/i18n';
import { ArtLogo } from '@/components/logo';
import {
  IconBriefcase, IconBuilding, IconCalendar, IconChart, IconClock, IconFile, IconGrid,
  IconInbox, IconLayers, IconListCheck, IconLogOut, IconReceipt, IconSettings, IconUser,
  IconUserPlus, IconUsers, type IconProps,
} from '@/components/icons';
import dynamic from 'next/dynamic';

/*
 * The assistant is LAZY and does not server-render (ADR-0020).
 *
 * Nobody opens a page in order to use it, so it must not sit on the critical path of the page
 * they did open. Imported statically it joined the shell's hydration payload, and the browser
 * suite - which clicks as soon as the server-rendered text appears - started failing a different
 * client-data check on each run while the baseline was clean three times out of three. That was
 * the assistant delaying hydration, not a flaky suite, and shrinking the component would only
 * have moved the edge rather than removed it.
 *
 * `ssr: false` because a launcher button in the corner has nothing useful to render on the
 * server, and its whole state is client state.
 */
const Assistant = dynamic(
  () => import('@/components/assistant').then((m) => m.Assistant),
  { ssr: false },
);

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

/*
 * A nav entry names a MESSAGE KEY, not a label.
 *
 * The English string used to live here, which made this file the only place the sidebar could be
 * read from - and made a second language impossible without a conditional beside every entry.
 * The key resolves through the dictionary, so `nav-shell.test.mjs` now checks the routes AND that
 * every key exists in both locales, which the literal version could not have checked at all.
 */
/**
 * WHICH GLYPH MARKS WHICH DESTINATION.
 *
 * Keyed by href and declared ABOVE `NAV_GROUPS` on purpose: `nav-shell.test.mjs` parses the
 * NAV_GROUPS block for `href:` and `labelKey:` and fetches every route it finds, so the group
 * definitions stay a clean list of routes and permissions with no presentation mixed in.
 *
 * A missing entry renders no glyph rather than throwing - a route added without an icon should
 * still be reachable, and an icon is decoration on a row that already carries its own label.
 */
const NAV_ICON: Record<string, ComponentType<IconProps>> = {
  '/': IconGrid,
  '/profile': IconUser,
  '/documents': IconFile,
  '/attendance': IconClock,
  '/leave': IconCalendar,
  '/work': IconBriefcase,
  '/timesheet': IconListCheck,
  '/payslips': IconReceipt,
  '/approvals': IconInbox,
  '/team': IconUsers,
  '/employees': IconUsers,
  '/reports': IconChart,
  '/onboarding': IconUserPlus,
  '/organisation': IconBuilding,
  '/masters/work-management': IconLayers,
  '/settings': IconSettings,
};

interface NavItem { href: string; labelKey: MessageKey }
interface NavGroup {
  id: string;
  titleKey: MessageKey | null;
  items: readonly NavItem[];
  /** Which actors are OFFERED this group. The API decides who may pass. */
  when?: 'team' | 'hr' | 'hr_manage' | 'onboarding';
}

const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: 'top',
    titleKey: null,
    items: [{ href: '/', labelKey: 'nav.dashboard' }],
  },
  {
    // Identity first, then presence, then effort - the order somebody actually moves through a
    // day, rather than alphabetical.
    id: 'me',
    titleKey: 'nav.group.me',
    items: [
      { href: '/profile', labelKey: 'nav.profile' },
      { href: '/documents', labelKey: 'nav.documents' },
      { href: '/attendance', labelKey: 'nav.attendance' },
      { href: '/leave', labelKey: 'nav.leave' },
      { href: '/work', labelKey: 'nav.work' },
      { href: '/timesheet', labelKey: 'nav.timesheet' },
      // Under "My records" rather than a payroll section: for everyone except HR this screen IS
      // their own record, and HR reaches an employee's payslips from that employee's profile.
      { href: '/payslips', labelKey: 'nav.payslips' },
    ],
  },
  {
    id: 'team',
    titleKey: 'nav.group.team',
    when: 'team',
    items: [
      { href: '/approvals', labelKey: 'nav.approvals' },
      { href: '/team', labelKey: 'nav.team' },
    ],
  },
  {
    id: 'org',
    titleKey: 'nav.group.org',
    items: [
      /*
       * "Employees", not "People". The glossary keeps them apart on purpose - a Person is a human
       * being who survives rehire, an Employee is ONE employment relationship, and one person may
       * hold two over time. This screen lists employments, so the softer word would have been a
       * domain error rather than a friendlier label.
       */
      { href: '/employees', labelKey: 'nav.employees' },
      /*
       * Reports sits with the organisation rather than under "My records", and is offered to
       * everyone. Both are deliberate: the page asks the API which reports the caller may run
       * (DEC-067), and an employee's view of each is their own record - so the narrowing lives in
       * the policy, not in this list.
       */
      { href: '/reports', labelKey: 'nav.reports' },
    ],
  },
  {
    /*
     * Onboarding needs its OWN gate, and that is the point rather than an inconvenience: it is the
     * first screen shared by three roles who otherwise see nothing of each other's work. `hr` is
     * too wide (it includes the read-only auditor) and `hr_manage` too narrow (it excludes the two
     * approvers entirely), so neither existing gate fits - which is a fair summary of what the
     * approval chain added to this product.
     */
    id: 'onboarding',
    titleKey: 'nav.group.onboarding',
    when: 'onboarding',
    items: [{ href: '/onboarding', labelKey: 'nav.onboarding' }],
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
    titleKey: 'nav.group.masters',
    /*
     * `hr_manage`, not `hr`. The existing `hr` condition includes `auditor`, which may READ
     * configuration (that is why Settings uses it) but holds neither `org.unit.manage` nor
     * `org.designation.manage`. Offering an auditor these links would be offering a door that is
     * already locked - the exact thing DEC-053 recorded about the settings link.
     */
    when: 'hr_manage',
    items: [
      { href: '/organisation', labelKey: 'nav.organisation' },
      /*
       * The work hierarchy - projects, sub-projects, tasks, sub-tasks.
       *
       * In the SAME group as Organisation rather than a new one: both are HR master data,
       * both are governed by an `org`/`work` .manage action, and a second masters section
       * would be exactly the parallel architecture that was not wanted. `hr_manage` gates
       * the group, and work-masters.ts refuses anybody without work.project.manage or
       * work.task.manage regardless of what this list offers.
       */
      { href: '/masters/work-management', labelKey: 'nav.workStructure' },
    ],
  },
  {
    id: 'admin',
    titleKey: 'nav.group.admin',
    when: 'hr',
    items: [{ href: '/settings', labelKey: 'nav.settings' }],
  },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const t = useT();
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

  // The three people in the approval chain, and nobody else.
  const isOnboarding = hasRole(actor, 'hr_admin', 'finance', 'delivery_head');

  const groups = NAV_GROUPS.filter((g) => (
    g.when === 'team' ? isTeamLead
      : g.when === 'hr' ? isHr
        : g.when === 'hr_manage' ? isHrManage
          : g.when === 'onboarding' ? isOnboarding
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
    'group flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13.5px] transition-colors',
    isActive
      ? 'bg-brand-100 font-semibold text-ink-900 ring-1 ring-inset ring-brand-200'
      : 'font-medium text-ink-600 hover:bg-ink-100 hover:text-ink-900',
  ].join(' ');

  const navGroups = (idPrefix: string) => groups.map((g) => (
    <div key={g.id} className={g.titleKey ? 'mt-5 first:mt-0' : 'first:mt-0'}>
      {g.titleKey && (
        <h2
          id={`${idPrefix}-${g.id}`}
          className="mb-1.5 px-3 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-ink-500"
        >
          {t(g.titleKey)}
        </h2>
      )}
      <ul {...(g.titleKey ? { 'aria-labelledby': `${idPrefix}-${g.id}` } : {})} className="space-y-0.5">
        {g.items.map((i) => {
          const on = active(i.href);
          const Glyph = NAV_ICON[i.href];
          return (
            <li key={i.href}>
              <Link href={i.href} aria-current={on ? 'page' : undefined} className={rowClass(on)}>
                {Glyph && (
                  <Glyph
                    size={17}
                    className={on ? 'text-brand-700' : 'text-ink-400 transition-colors group-hover:text-ink-600'}
                  />
                )}
                <span className="truncate">{t(i.labelKey)}</span>
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
     * elements are the document preview, the toast and the assistant launcher - all three
     * viewport-anchored and unaffected by which element owns the scrollbar. Checked before
     * making the change, not assumed, and re-checked when the assistant was added (ADR-0020).
     */
    <div className="flex h-dvh flex-col">
      {/*
        * THE APPLICATION BAR.
        *
        * Three zones, in reading order: identity of the PRODUCT, then breathing space, then
        * identity of the PERSON and the controls that belong to them. The account chip, the
        * language switcher and sign-out are grouped together behind one hairline divider so they
        * read as one cluster rather than three loose controls floating at the end of the bar.
        *
        * THERE IS NO NOTIFICATION BELL, deliberately. The brief asks for a notification area "if
        * supported" - and it is not: there is no notifications endpoint and the `notifications`
        * module is unbuilt. A bell that never lights up, or worse one that opens an empty panel,
        * would be the one piece of this screen that lies about what the product does.
        */}
      <header className="z-30 shrink-0 border-b border-ink-200 bg-white/95 backdrop-blur">
        <div className="flex items-center gap-3 px-4 py-2.5 sm:px-6">
          <Link
            href="/"
            className="flex shrink-0 items-center gap-2 rounded-lg py-0.5 transition-opacity hover:opacity-80"
            aria-label={t('app.name')}
          >
            {/*
              * The wordmark hides below sm; the disc alone still identifies the product.
              *
              * THE DISPLAY CLASS GOES ON A WRAPPER, not on ArtLogo. Passing `hidden
              * sm:inline-flex` as its className produced "inline-flex ... hidden sm:inline-flex"
              * on one element - two competing `display` utilities of equal specificity, decided
              * by their order in the generated stylesheet rather than in the attribute. Tailwind
              * emits `inline-flex` after `hidden`, so below 640px BOTH lockups rendered and the
              * header showed the gold disc TWICE. Present since the sidebar shell was written and
              * invisible at every desktop width; the phone screenshots are what caught it.
              */}
            <span className="sm:hidden"><ArtLogo size={28} compact /></span>
            <span className="hidden sm:inline-flex"><ArtLogo size={28} /></span>
          </Link>

          <div className="ms-auto flex items-center gap-1.5 sm:gap-2">
            {/* The name badge is where people look for their own record, so it goes there. */}
            <Link
              href="/profile"
              className="flex items-center gap-2.5 rounded-lg p-1 transition-colors hover:bg-ink-100 sm:ps-2.5"
              aria-label={t('nav.profile')}
            >
              <span className="hidden text-end sm:block">
                <span className="block text-[13px] font-semibold leading-tight text-ink-900">{actor.name}</span>
                <span className="block text-[11.5px] leading-tight text-ink-500">
                  {(actor.roles ?? [actor.role]).join(' · ').replace(/_/g, ' ')} · {actor.employeeNumber}
                </span>
              </span>
              <Avatar name={actor.name} size={32} tone="dark" />
            </Link>

            <span aria-hidden className="hidden h-6 w-px bg-ink-200 sm:block" />

            {/* Beside the account controls, which is where somebody looks for it. */}
            <LanguageSwitcher />
            <button
              type="button"
              onClick={signOut}
              className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] font-medium text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-900"
            >
              <IconLogOut size={16} className="flip-rtl" />
              <span className="hidden sm:inline">{t('app.signOut')}</span>
              <span className="sr-only sm:hidden">{t('app.signOut')}</span>
            </button>
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-controls="mobile-nav"
              className="rounded-lg p-1.5 text-ink-600 transition-colors hover:bg-ink-100 lg:hidden"
            >
              <span className="sr-only">{t('app.menu')}</span>
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
          <nav id="mobile-nav" aria-label={t('app.mainContent')} className="max-h-[70vh] overflow-y-auto border-t border-ink-100 px-3 py-3 lg:hidden">
            {navGroups('mnav')}
          </nav>
        )}
      </header>

      {/* `min-h-0` lets this row shrink inside the column so its children can own the scroll. */}
      <div className="flex min-h-0 flex-1">
        {/* Its own scroll region, so a long report never pushes the navigation out of reach. */}
        {/*
          * `border-e`, not `border-r`. The divider belongs on the edge that FACES the content:
          * the sidebar's right in English, its left in Arabic. `border-r` put it on the outer
          * edge against the viewport in Arabic - a hairline in the wrong place, and one of the
          * physical-property mistakes that `i18n.test.mjs` R1 exists to catch (it scans margins
          * and text alignment, so a physical BORDER slipped through it).
          */}
        <nav
          aria-label={t('app.mainContent')}
          className="hidden w-60 shrink-0 overflow-y-auto border-e border-ink-200 bg-white/60 px-3 py-5 lg:block"
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

      {/*
        * The assistant (ADR-0020). Inside the authenticated shell only, so it never renders on
        * /login, and a sibling of the scrolling column rather than inside it - it is
        * viewport-anchored and must not scroll with the page.
        */}
      <Assistant />
    </div>
  );
}
