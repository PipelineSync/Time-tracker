import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '@/lib/store'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Bell, BellOff, Check, Clock, Coffee, LogIn, LogOut, MessageSquare, Play, Plus, Wallet, type LucideIcon } from 'lucide-react'
import { formatDateTime } from '@/lib/utils'
import { cn } from '@/lib/utils'
import type { NotificationType } from '@/lib/types'

const typeMeta: Record<NotificationType, { icon: LucideIcon; color: string }> = {
  note: { icon: MessageSquare, color: 'text-primary' },
  time_in: { icon: LogIn, color: 'text-[#36B7C9]' },
  time_out: { icon: LogOut, color: 'text-[#F77A0A]' },
  time_added: { icon: Plus, color: 'text-[#36B7C9]' },
  payment: { icon: Wallet, color: 'text-emerald-600' },
  break_start: { icon: Coffee, color: 'text-[#36B7C9]' },
  break_end: { icon: Play, color: 'text-[#F77A0A]' },
}

export function NotificationsBell({ onNavy }: { onNavy?: boolean }) {
  const { notifications, unreadCount, markNotificationsRead } = useStore()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  const bellCls = onNavy
    ? 'text-white/80 hover:bg-white/10 hover:text-white'
    : 'text-muted-foreground hover:bg-muted hover:text-foreground'

  const recent = notifications.slice(0, 20)

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Notifications" className={cn('relative', bellCls)}>
          <Bell className="h-5 w-5" />
          {unreadCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#F77A0A] px-1 text-[10px] font-bold text-white">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0">
        <DropdownMenuLabel className="flex items-center justify-between px-4 py-3">
          <span>Notifications</span>
          {unreadCount > 0 && (
            <button className="flex items-center gap-1 text-xs font-medium text-primary hover:underline" onClick={() => markNotificationsRead()}>
              <Check className="h-3 w-3" /> Mark all read
            </button>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="max-h-96 overflow-y-auto">
          {recent.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground">
              <BellOff className="h-6 w-6" />
              No notifications yet.
            </div>
          ) : (
            recent.map((n) => {
              const meta = typeMeta[n.type] || typeMeta.note
              const Icon = meta.icon
              return (
                <DropdownMenuItem
                  key={n.id}
                  className={cn(
                    'items-start gap-3 whitespace-normal border-l-2 py-3',
                    n.read ? 'border-l-transparent' : 'border-l-[#F77A0A] bg-[#F77A0A]/5'
                  )}
                  onClick={() => {
                    if (n.entry_id) navigate(`/entries?entry=${n.entry_id}`)
                  }}
                >
                  <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', meta.color)} />
                  <div className="min-w-0 flex-1">
                    <p className={cn('text-sm leading-snug', !n.read && 'font-bold text-foreground')}>{n.message}</p>
                    <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" /> {formatDateTime(n.created_at)}
                    </p>
                  </div>
                  {!n.read && <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-[#F77A0A]" />}
                </DropdownMenuItem>
              )
            })
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
