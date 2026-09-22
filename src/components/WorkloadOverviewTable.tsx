import { Users } from 'lucide-react'
import type { TaskStatus, Worker } from '@/lib/types'
import { TaskStatusNames } from '@/lib/types'
import { AvatarBubble } from '@/components/AvatarBubble'
import { cn, formatDateTime } from '@/lib/utils'

/** The open (not-yet-completed) stages that make up a member's load. */
const LOAD_STATUSES = ['todo', 'in_progress', 'waiting', 'for_review', 'rework'] as const
type LoadStatus = (typeof LOAD_STATUSES)[number]

export interface WorkloadOverviewRow {
  worker: Worker
  /** Open-task counts per stage. */
  counts: Record<LoadStatus, number>
  /** Sum of `counts`. */
  total: number
  /** How many of the member's open tasks are past due. */
  overdue: number
  /** When one of the member's open tasks was last changed. */
  lastUpdated?: string
}

/** Cell text colours — the numbers echo the board's column colours. */
const CELL_COLORS: Record<TaskStatus, string> = {
  todo: 'text-foreground',
  in_progress: 'text-sky-600 dark:text-sky-400',
  waiting: 'text-amber-600 dark:text-amber-500',
  for_review: 'text-violet-600 dark:text-violet-400',
  rework: 'text-rose-600 dark:text-rose-400',
  completed: 'text-emerald-600 dark:text-emerald-400',
}

function workloadLevel(total: number): { label: string; className: string } {
  if (total === 0) return { label: '—', className: 'border-border text-muted-foreground/60' }
  if (total <= 4) return { label: 'Light', className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' }
  if (total <= 8) return { label: 'Normal', className: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300' }
  return { label: 'Heavy', className: 'border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300' }
}

/**
 * The "Team Workload Overview" from the team task tracker: one row per member
 * with per-stage counts, the overdue slice, the total, a Light/Normal/Heavy
 * chip and when they last moved a task. Clicking a row narrows the board to
 * that member.
 */
export function WorkloadOverviewTable({
  rows,
  activeWorkerId,
  onRowClick,
}: {
  rows: WorkloadOverviewRow[]
  /** The member the board is currently filtered to (row highlight). */
  activeWorkerId?: string
  onRowClick?: (workerId: string) => void
}) {
  return (
    <section aria-label="Team workload overview" className="rounded-2xl border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b px-4 py-3 sm:px-5">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <Users className="h-4 w-4 text-primary" aria-hidden />
          </span>
          <div>
            <h2 className="text-base font-semibold leading-tight">Team Workload Overview</h2>
            <p className="text-xs text-muted-foreground">Stage counts and overdue slice from active tasks</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
          {/* Legend — same colours as the board columns. */}
          {LOAD_STATUSES.map((s) => (
            <span key={s} className="flex items-center gap-1.5">
              <span
                className={cn(
                  'h-2 w-2 rounded-full',
                  s === 'todo' && 'bg-slate-400',
                  s === 'in_progress' && 'bg-sky-500',
                  s === 'waiting' && 'bg-amber-500',
                  s === 'for_review' && 'bg-violet-500',
                  s === 'rework' && 'bg-rose-500'
                )}
                aria-hidden
              />
              {TaskStatusNames[s]}
            </span>
          ))}
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-red-500" aria-hidden />
            Overdue
          </span>

          <span className="hidden h-4 w-px bg-border sm:block" aria-hidden />

          <span className="flex items-center gap-1.5">
            Workload Guide:
            <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">Light</span>
            <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">Normal</span>
            <span className="rounded-full border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[10px] font-semibold text-rose-700 dark:text-rose-300">Heavy</span>
          </span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="px-4 py-2.5 font-medium sm:px-5">Team Member</th>
              <th className="px-3 py-2.5 font-medium">Role</th>
              {LOAD_STATUSES.map((s) => (
                <th key={s} className="px-3 py-2.5 text-center font-medium">{TaskStatusNames[s]}</th>
              ))}
              <th className="px-3 py-2.5 text-center font-medium">Overdue</th>
              <th className="px-3 py-2.5 text-center font-medium">Total</th>
              <th className="px-3 py-2.5 font-medium">Workload</th>
              <th className="px-4 py-2.5 text-right font-medium sm:px-5">Last Updated</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/70">
            {rows.map(({ worker, counts, total, overdue, lastUpdated }) => {
              const level = workloadLevel(total)
              const active = activeWorkerId === worker.id
              return (
                <tr
                  key={worker.id}
                  onClick={() => onRowClick?.(worker.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onRowClick?.(worker.id)
                    }
                  }}
                  tabIndex={onRowClick ? 0 : undefined}
                  aria-label={`Show ${worker.name}'s tasks on the board`}
                  className={cn(
                    'transition-colors',
                    onRowClick && 'cursor-pointer hover:bg-muted/60 focus-visible:outline-none focus-visible:bg-muted/60',
                    active && 'bg-primary/5'
                  )}
                >
                  <td className="px-4 py-2.5 sm:px-5">
                    <span className="flex items-center gap-2.5">
                      <AvatarBubble name={worker.name} avatarUrl={worker.avatar_url} size="sm" className="h-7 w-7 text-[10px]" />
                      <span className={cn('font-medium', active && 'text-primary')}>{worker.name}</span>
                    </span>
                  </td>
                  <td className="max-w-[180px] truncate px-3 py-2.5 text-xs text-muted-foreground">
                    {worker.position || '—'}
                  </td>
                  {LOAD_STATUSES.map((s) => (
                    <td key={s} className={cn('px-3 py-2.5 text-center tabular-nums', counts[s] > 0 ? CELL_COLORS[s] : 'text-muted-foreground/50')}>
                      {counts[s]}
                    </td>
                  ))}
                  <td className={cn('px-3 py-2.5 text-center font-semibold tabular-nums', overdue > 0 ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground/50')}>
                    {overdue}
                  </td>
                  <td className="px-3 py-2.5 text-center font-semibold tabular-nums">{total}</td>
                  <td className="px-3 py-2.5">
                    <span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-semibold', level.className)}>{level.label}</span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right text-xs text-muted-foreground sm:px-5">
                    {lastUpdated ? formatDateTime(lastUpdated) : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
