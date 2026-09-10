import { useMemo, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard,
  Timer,
  ListChecks,
  KanbanSquare,
  ListOrdered,
  CalendarDays,
  Users,
  BarChart3,
  Settings,
  Wallet,
  Landmark,
  CircleDollarSign,
  LogOut,
  KeyRound,
  Moon,
  Sun,
  Monitor,
} from 'lucide-react'
import { useStore } from '@/lib/store'
import type { Permission } from '@/lib/types'
import { useTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { BrandLogo } from '@/components/BrandLogo'
import { NotificationsBell } from '@/components/NotificationsBell'
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

const NAV = {
  dashboard: { to: '/', label: 'Dashboard', shortLabel: 'Home', icon: LayoutDashboard },
  tracker: { to: '/tracker', label: 'Clock In / Out', shortLabel: 'Clock', icon: Timer },
  entriesAll: { to: '/entries', label: 'Time Entries', shortLabel: 'Time', icon: ListChecks },
  entriesMine: { to: '/entries', label: 'My Time', shortLabel: 'Time', icon: ListChecks },
  tasksAll: { to: '/tasks', label: 'Tasks', shortLabel: 'Tasks', icon: KanbanSquare },
  tasksMine: { to: '/tasks', label: 'My Tasks', shortLabel: 'Tasks', icon: KanbanSquare },
  priorityBoard: { to: '/priority-board', label: 'Priority Board', shortLabel: 'Priority', icon: ListOrdered },
  meetings: { to: '/meetings', label: 'Meetings', shortLabel: 'Meet', icon: CalendarDays },
  // The Payments section lives inside Finance → Payroll now; workers without
  // Finance access get the direct, honestly-named "Payroll" entry.
  payroll: { to: '/finance?tab=payroll', label: 'Payroll', shortLabel: 'Pay', icon: Wallet },
  finance: { to: '/finance', label: 'Finance', shortLabel: 'Finance', icon: Landmark },
  workers: { to: '/workers', label: 'Workers', shortLabel: 'Workers', icon: Users },
  reports: { to: '/reports', label: 'Reports', shortLabel: 'Reports', icon: BarChart3 },
  settings: { to: '/settings', label: 'Settings', shortLabel: 'Settings', icon: Settings },
} satisfies Record<string, NavItem>

/**
 * The destinations this account can reach. The admin gets everything; a worker
 * gets their own screens plus whatever the admin granted them, in the same
 * order as the admin's menu so the two look alike.
 */
function buildNav(isAdmin: boolean, can: (p: Permission) => boolean): NavItem[] {
  if (isAdmin) {
    return [NAV.dashboard, NAV.entriesAll, NAV.tasksAll, NAV.priorityBoard, NAV.meetings, NAV.finance, NAV.workers, NAV.reports, NAV.settings]
  }
  const items: NavItem[] = []
  if (can('dashboard.view')) items.push(NAV.dashboard)
  // Only real workers clock in, so this stays first among their own screens.
  items.push(NAV.tracker)
  items.push(can('entries.view_all') ? NAV.entriesAll : NAV.entriesMine)
  items.push(can('tasks.view_all') ? NAV.tasksAll : NAV.tasksMine)
  // The client priority board is admin-only until the admin grants it.
  if (can('priority_board.view')) items.push(NAV.priorityBoard)
  // Same for the meetings schedule (`meetings.view`).
  if (can('meetings.view')) items.push(NAV.meetings)
  // Payments now live in Finance → Payroll. Workers always get in (their own
  // payment history sits in the Payroll tab); the extra tabs and the ledger
  // appear only once the admin grants Finance access (off by default).
  // The full Finance item appears for anyone the admin gave a Finance view —
  // finance.view (the whole ledger, which also covers finance.manage because
  // the store normalizes manage → view) or the granular subscription/payroll
  // keys. Everyone else gets the honest "Payroll" item (their own payments).
  const hasFinance = can('finance.view') || can('finance.subscription') || can('finance.payroll')
  if (hasFinance) {
    items.push(NAV.finance)
  } else {
    items.push(NAV.payroll)
  }
  if (can('workers.view')) items.push(NAV.workers)
  if (can('reports.view')) items.push(NAV.reports)
  items.push(NAV.settings)
  return items
}

export function AppLayout() {
  const { user, signOut, isAdmin, can, workers, settings } = useStore()
  const { setTheme } = useTheme()
  const navigate = useNavigate()
  const navItems = useMemo(() => buildNav(isAdmin, can), [isAdmin, can])
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
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
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
        </nav>
        <div className="border-t border-white/10 px-4 py-3">
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
            <BrandLogo className="h-6" />
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
          <Outlet />
        </div>
      </main>

      {/* Mobile bottom nav — sits above the iPhone home indicator */}
      <nav className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/95 backdrop-blur lg:hidden">
        <div className="grid" style={{ gridTemplateColumns: `repeat(${navItems.length}, minmax(0,1fr))` }}>
          {navItems.map((item) => (
            <NavLink
              key={item.to}
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
