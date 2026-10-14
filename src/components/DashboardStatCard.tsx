import type { LucideIcon } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

export interface DashboardStatCardProps {
  icon: LucideIcon
  /** Icon chip colour classes. */
  iconCls: string
  value: number
  label: string
  /** Small line under the label. */
  sub?: string
  /** Colours the sub (e.g. red "Needs attention"). */
  subCls?: string
  valueCls?: string
  /** The board filter behind this card is currently applied. */
  active?: boolean
  /** Clicking toggles that board filter. */
  onClick?: () => void
  loading?: boolean
  /** Tooltip explaining the click behaviour. */
  hint?: string
}

/**
 * One of the big summary cards at the top of the team task tracker: a
 * coloured icon chip, the number, the label and a small context line. The
 * whole card is a button that toggles the matching board filter, so the
 * number you tap is exactly the pile the board then shows.
 */
export function DashboardStatCard({
  icon: Icon,
  iconCls,
  value,
  label,
  sub,
  subCls,
  valueCls,
  active,
  onClick,
  loading,
  hint,
}: DashboardStatCardProps) {
  const inner = (
    <>
      <span className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl', iconCls)}>
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        {loading ? (
          <Skeleton className="h-7 w-16" />
        ) : (
          <span className={cn('block text-2xl font-semibold leading-tight tracking-[-0.02em] tabular-nums', valueCls)}>{value}</span>
        )}
        <span className="mt-0.5 block truncate text-sm font-medium">{label}</span>
        {sub && <span className={cn('block truncate text-xs', subCls ?? 'text-muted-foreground')}>{sub}</span>}
      </span>
    </>
  )

  const base = cn(
    'ps-card ps-card-lift flex items-center gap-3 rounded-2xl p-4 text-left',
    onClick && 'cursor-pointer hover:border-brand/40',
    active && 'ring-2 ring-brand/40 border-brand/40 bg-brand/5'
  )

  if (onClick) {
    return (
      <button type="button" className={cn(base, 'w-full')} onClick={onClick} aria-pressed={active} title={hint}>
        {inner}
      </button>
    )
  }
  return <div className={base}>{inner}</div>
}
