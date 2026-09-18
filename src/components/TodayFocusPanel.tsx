import { Target } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

export interface FocusItem {
  id: string
  label: string
  /** True when this row's board filter is already applied. */
  active?: boolean
  /** Apply the matching board filter. Omit for a purely informational row. */
  onClick?: () => void
}

/**
 * "Today's focus" — the mockup's numbered checklist, but generated from live
 * board data instead of being static text: review the overdue pile, follow up
 * on what's due today, chase blocked items, clear the approval queue, and
 * rebalance when someone is carrying too much. Up to four rows, worst first.
 * Clicking a row applies the matching board filter, so the click is also the
 * start of the work.
 */
export function TodayFocusPanel({ items, loading }: { items: FocusItem[]; loading?: boolean }) {
  if (loading) {
    return (
      <div className="rounded-xl border border-emerald-500/30 p-3.5 dark:border-emerald-400/20">
        <Skeleton className="h-4 w-28" />
        <div className="mt-3 space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-3/5" />
        </div>
      </div>
    )
  }
  return (
    <section
      className="rounded-xl border border-emerald-500/30 bg-emerald-50/70 p-3.5 dark:border-emerald-400/20 dark:bg-emerald-900/15"
      aria-label="Today's focus"
    >
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <Target className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
        Today's focus
      </h2>
      {items.length === 0 ? (
        <p className="mt-2.5 text-xs text-muted-foreground">Nothing urgent — the board is clear. ✓</p>
      ) : (
        <ol className="mt-2 space-y-0.5">
          {items.map((item, i) => (
            <li key={item.id}>
              <button
                type="button"
                disabled={!item.onClick}
                onClick={item.onClick}
                title={item.onClick ? 'Filter the board to this' : undefined}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left transition',
                  item.onClick && 'hover:bg-emerald-600/10',
                  item.active && 'bg-emerald-600/10'
                )}
              >
                <span
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-600/15 text-[9px] font-bold text-emerald-700 dark:bg-emerald-400/20 dark:text-emerald-300"
                  aria-hidden
                >
                  {i + 1}
                </span>
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-xs',
                    item.active ? 'font-semibold text-emerald-800 dark:text-emerald-200' : 'text-foreground/90'
                  )}
                >
                  {item.label}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
