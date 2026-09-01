import { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard,
  Timer,
  ListChecks,
  Users,
  BarChart3,
  Settings,
  Wallet,
  LogOut,
  KeyRound,
  Moon,
  Sun,
  Monitor,
} from 'lucide-react'
import { useStore } from '@/lib/store'
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

const adminNav = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/entries', label: 'Time Entries', icon: ListChecks },
  { to: '/payments', label: 'Payments', icon: Wallet },
  { to: '/workers', label: 'Workers', icon: Users },
  { to: '/reports', label: 'Reports', icon: BarChart3 },
  { to: '/settings', label: 'Settings', icon: Settings },
]

const workerNav = [
  { to: '/tracker', label: 'Clock In / Out', icon: Timer },
  { to: '/entries', label: 'My Time', icon: ListChecks },
  { to: '/payments', label: 'Payments', icon: Wallet },
]

export function AppLayout() {
  const { user, signOut, isAdmin } = useStore()
  const { setTheme } = useTheme()
  const navigate = useNavigate()
  const navItems = isAdmin ? adminNav : workerNav
  const [changePwOpen, setChangePwOpen] = useState(false)

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
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
            {user?.email?.[0]?.toUpperCase() || 'U'}
          </span>
          <span className="hidden max-w-[120px] truncate sm:inline">{user?.email}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="truncate">{user?.email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
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
    <div className="min-h-screen bg-background">
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
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-white/10 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">{UserMenu}</div>
            <div className="flex shrink-0 items-center gap-1 rounded-lg bg-white/5 p-1">
              <NotificationsBell onNavy />
              <ThemeToggle onNavy />
            </div>
          </div>
        </div>
      </aside>

      {/* Mobile header */}
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-background/95 px-4 backdrop-blur lg:hidden">
        <BrandLogo className="h-6" />
        <div className="flex items-center gap-1">
          <NotificationsBell />
          <ThemeToggle />
          {UserMenu}
        </div>
      </header>

      {/* Main content */}
      <main className="px-4 pb-24 pt-6 sm:px-6 lg:ml-64 lg:pb-10">
        <div className="mx-auto max-w-6xl">
          <Outlet />
        </div>
      </main>

      {/* Mobile bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/95 backdrop-blur lg:hidden">
        <div className="grid" style={{ gridTemplateColumns: `repeat(${navItems.length}, minmax(0,1fr))` }}>
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                cn(
                  'flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium',
                  isActive ? 'text-primary' : 'text-muted-foreground'
                )
              }
            >
              <item.icon className="h-5 w-5" />
              {item.label}
            </NavLink>
          ))}
        </div>
      </nav>

      <ChangePasswordDialog open={changePwOpen} onOpenChange={setChangePwOpen} />
    </div>
  )
}
