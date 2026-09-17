import { Suspense, useMemo, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard,
  Timer,
  ListChecks,
  KanbanSquare,
  ListOrdered,
  CalendarDays,
  ReceiptText,
  StickyNote,
  Users,
  BarChart3,
  Settings,
  Wallet,
  Landmark,
  CircleDollarSign,
  Headset,
  LogOut,
  KeyRound,
  Moon,
  Sun,
  Monitor,
} from 'lucide-react'
import { useStore } from '@/lib/store'
import { buildNavPlan, type NavKey } from '@/lib/nav'
import { useTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { BrandLogo } from '@/components/BrandLogo'
import { NotificationsBell } from '@/components/NotificationsBell'
import { SectionTransition } from '@/components/SectionTransition'
import { ChangePasswordDialog } from '@/components/ChangePasswordDialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface NavItem {
  to: string
  label: string
  shortLabel: string
  icon: typeof LayoutDashboard
}

/**
 * Every destination the nav can show, keyed the way `buildNavPlan` names it
 * (`@/lib/nav`). Typed as a complete map, so adding a key to the plan without
 * giving it an icon + label here breaks `npm run typecheck`.
 */
const NAV: Record<NavKey, NavItem> = {
  dashboard: { to: '/', label: 'Dashboard', shortLabel: 'Home', icon: LayoutDashboard },
  tracker: { to: '/tracker', label: 'Clock In / Out', shortLabel: 'Clock', icon: Timer },
  entriesAll: { to: '/entries', label: 'Time Entries', shortLabel: 'Time', icon: ListChecks },
  // The same page in its own-rows mode — what a worker gets with no grant.
  entriesMine: { to: '/entries', label: 'My Time', shortLabel: 'Time', icon: ListChecks },
  tasksAll: { to: '/tasks', label: 'Tasks', shortLabel: 'Tasks', icon: KanbanSquare },
  tasksMine: { to: '/tasks', label: 'My Tasks', shortLabel: 'Tasks', icon: KanbanSquare },
  priorityBoard: { to: '/priority-board', label: 'Priority Board', shortLabel: 'Priority', icon: ListOrdered },
  meetings: { to: '/meetings', label: 'Meetings', shortLabel: 'Meet', icon: CalendarDays },
  invoicing: { to: '/invoices', label: 'Invoicing', shortLabel: 'Invoice', icon: ReceiptText },
  // Everyone's own private notepad — no grant needed, nothing is shared.
  notepad: { to: '/notepad', label: 'Notepad', shortLabel: 'Notes', icon: StickyNote },
  // The Payments section lives inside Finance → Payroll now; workers without
  // Finance access get the direct, honestly-named "Payroll" entry.
  payroll: { to: '/finance?tab=payroll', label: 'Payroll', shortLabel: 'Pay', icon: Wallet },
  finance: { to: '/finance', label: 'Finance', shortLabel: 'Finance', icon: Landmark },
  workers: { to: '/workers', label: 'Workers', shortLabel: 'Workers', icon: Users },
  reports: { to: '/reports', label: 'Reports', shortLabel: 'Reports', icon: BarChart3 },
  // The support desk. Shown only to a worker the admin granted it to — never
  // to the admin, who holds every other capability but not this one.
  itSupport: { to: '/it-support', label: 'IT Support', shortLabel: 'Support', icon: Headset },
  settings: { to: '/settings', label: 'Settings', shortLabel: 'Settings', icon: Settings },
}

/**
 * Demo-mode badge. Demo mode stores everything (including passwords, in
 * plaintext) in THIS browser only; the sign-in screen warns about it, but a
 * persistent badge here stops anyone mistaking local demo data for the
 * workspace's real data while actually using the app.
 */
function DemoModeBadge({ onNavy }: { onNavy?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        onNavy ? 'bg-amber-300/15 text-amber-300' : 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'
      }`}
      title="Demo mode: data lives only in this browser (no Supabase configured at build time)."
    >
      Demo mode
    </span>
  )
}

/**
 * Placeholder shown while a section's chunk downloads. Shaped like a page
 * header plus a couple of cards so the layout doesn't jump when the real
 * content arrives.
 */
function SectionLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading section…</span>
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
      <Skeleton className="h-64" />
    </div>
  )
}

export function AppLayout() {
  const { user, signOut, isAdmin, can, isItSupport, workers, settings, backend } = useStore()
  const isDemo = backend.kind === 'local'
  const { setTheme } = useTheme()
  const navigate = useNavigate()
  // The plan decides who sees what (`@/lib/nav`); here each key just becomes
  // its icon + label.
  const navSections = useMemo(
    () => buildNavPlan(isAdmin, can, isItSupport).map((section) => ({
      title: section.title,
      items: section.items.map((key) => NAV[key]),
    })),
    [isAdmin, can, isItSupport],
  )
  const navItems = useMemo(() => navSections.flatMap((s) => s.items), [navSections])
  const [changePwOpen, setChangePwOpen] = useState(false)

  // The signed-in user's avatar, if they have uploaded one. Workers see their
  // own worker row in `workers`; the admin's avatar is the business/account
  // picture stored in settings. Falls back to their initial.
  const accountAvatar = isAdmin
    ? settings?.avatar_url ?? null
    : workers.find((w) => w.id === user?.workerId)?.avatar_url ?? null
  const accountInitial = user?.email?.[0]?.toUpperCase() || 'U'

  const ThemeToggle = ({ onNavy }: { onNavy?: boolean }) => {
    const { theme } = useTheme()
    const btnCls = onNavy
      ? 'text-white/80 hover:bg-white/10 hover:text-white'
      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Theme" className={btnCls}>
            {theme === 'dark' ? <Moon className="h-5 w-5" /> : theme === 'light' ? <Sun className="h-5 w-5" /> : <Monitor className="h-5 w-5" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => setTheme('light')}><Sun className="mr-2 h-4 w-4" /> Light</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setTheme('dark')}><Moon className="mr-2 h-4 w-4" /> Dark</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setTheme('system')}><Monitor className="mr-2 h-4 w-4" /> System</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  const UserMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="min-w-0 gap-2">
          {accountAvatar ? (
            <img src={accountAvatar} alt="Your profile" className="h-6 w-6 shrink-0 rounded-full object-cover" />
          ) : (
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
              {accountInitial}
            </span>
          )}
          <span className="hidden max-w-[120px] truncate sm:inline">{user?.email}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="truncate">{user?.email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate('/personal')}><CircleDollarSign className="mr-2 h-4 w-4" /> Switch to Personal Tracker</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setChangePwOpen(true)}><KeyRound className="mr-2 h-4 w-4" /> Change password</DropdownMenuItem>
        <DropdownMenuItem
          onClick={async () => {
            await signOut()
            navigate('/')
          }}
          className="text-destructive"
        >
          <LogOut className="mr-2 h-4 w-4" /> Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    // Transparent on purpose: the Christmas snow layer sits at z-index -1 over
    // the body background, so an opaque wrapper here would hide it.
    <div className="min-h-screen">
      {/* Desktop sidebar (navy) */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col bg-sidebar lg:flex">
        <div className="flex h-16 items-center border-b border-white/10 px-6">
          <BrandLogo onNavy />
        </div>
        <nav className="flex-1 space-y-4 overflow-y-auto px-3 py-4">
          {navSections.map((section, si) => (
            <div key={section.title || `nav-${si}`} className="space-y-1">
              {section.title ? (
                <div className="flex items-center gap-2 px-3 pb-1 pt-2">
                  <div className="h-px flex-1 bg-white/15" />
                  <p className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/45">
                    {section.title}
                  </p>
                  <div className="h-px flex-1 bg-white/15" />
                </div>
              ) : null}
              {section.items.map((item) => (
                <NavLink
                  key={`${item.to}-${item.label}`}
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-white/15 text-white'
                        : 'text-white/70 hover:bg-white/10 hover:text-white'
                    )
                  }
                >
                  <item.icon className="h-5 w-5" />
                  <span className="flex-1">{item.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="border-t border-white/10 px-4 py-3">
          {isDemo && (
            <div className="mb-2 flex justify-center">
              <DemoModeBadge onNavy />
            </div>
          )}
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">{UserMenu}</div>
            <div className="flex shrink-0 items-center gap-1 rounded-lg bg-white/5 p-1">
              <ThemeToggle onNavy />
            </div>
          </div>
        </div>
      </aside>

      {/* Mobile header — padded out of the notch when installed / native */}
      <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur lg:hidden">
        <div className="pt-safe">
          <div className="flex h-14 items-center justify-between px-4">
            <div className="flex min-w-0 items-center gap-2">
              <BrandLogo className="h-6 shrink-0" />
              {isDemo && <DemoModeBadge />}
            </div>
            <div className="flex items-center gap-1">
              <NotificationsBell />
              <ThemeToggle />
              {UserMenu}
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="px-4 pb-24 pt-6 sm:px-6 lg:ml-64 lg:pb-10">
        <div className="mx-auto max-w-6xl">
          <div className="mb-2 hidden justify-end lg:flex"><NotificationsBell /></div>
          {/* Changing section fades + settles the new screen in (CSS only, and
              off for `prefers-reduced-motion`). The bell above stays put: only
              the page content moves, so the chrome never jitters. */}
          <SectionTransition>
            {/* Pages load as their own chunk (see `App.tsx`). This inner
                boundary catches that wait *inside* the shell, so a first visit
                to a section shows a placeholder where the page goes instead of
                replacing the whole app — sidebar and all — with the splash
                loader mid-transition. */}
            <Suspense fallback={<SectionLoading />}>
              <Outlet />
            </Suspense>
          </SectionTransition>
        </div>
      </main>

      {/* Mobile bottom nav — sits above the iPhone home indicator */}
      <nav className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/95 backdrop-blur lg:hidden">
        <div className="grid" style={{ gridTemplateColumns: `repeat(${navItems.length}, minmax(0,1fr))` }}>
          {navItems.map((item) => (
            <NavLink
              key={`${item.to}-${item.label}`}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                cn(
                  // Tight labels keep up to eight destinations readable on a phone width.
                  'flex flex-col items-center gap-0.5 overflow-hidden px-0.5 py-2 text-[10px] font-medium',
                  isActive ? 'text-primary' : 'text-muted-foreground'
                )
              }
            >
              <span className="relative">
                <item.icon className="h-5 w-5" />
              </span>
              <span className="w-full truncate text-center">{item.shortLabel}</span>
            </NavLink>
          ))}
        </div>
      </nav>

      <ChangePasswordDialog open={changePwOpen} onOpenChange={setChangePwOpen} />
    </div>
  )
}
