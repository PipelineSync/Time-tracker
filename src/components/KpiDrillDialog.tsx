import { useMemo } from 'react'
import type { Task } from '@/lib/types'
import { normalizeTaskStage, TaskStatusNames, QA_SCORE_NAMES, ReworkTypeNames, TaskPriorityNames, isEmployeeCausedRework } from '@/lib/types'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { formatDate, cn } from '@/lib/utils'
import {
  isOpen,
  isOverdueTask,
  isLegacyNoDue,
  monthLabel,
  openEstimatedHours,
  wasOnTime,
} from '@/lib/kpi'

/**
 * Which source tasks a KPI number drills into. Every metric on the Team KPI
 * page is traceable (§7): a click never shows a number without its tasks.
 */
export type KpiDrillKind =
  | 'active'
  | 'completed'
  | 'onTime'
  | 'overdue'
  | 'blocked'
  | 'qa'
  | 'rework'
  | 'workload'
  | 'score'
  | 'review'
  | 'goal'

export interface KpiDrillTarget {
  kind: KpiDrillKind
  /** null = every employee (team-wide card click). */
  workerId: string | null
  /** Extra narrowing for attention rows (high-only overdue, aged waits…). */
  flag?: boolean
}

const TITLES: Record<KpiDrillKind, string> = {
  active: 'Active tasks',
  completed: 'Completed',
  onTime: 'On-time sources',
  overdue: 'Overdue tasks',
  blocked: 'Waiting / blocked',
  qa: 'QA-reviewed work',
  rework: 'Rework (classified)',
  workload: 'Open work by estimate',
  score: 'What feeds the score',
  review: 'Awaiting review',
  goal: 'Toward the monthly goal',
}

const STATUS_TINTS: Record<string, string> = {
  todo: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  in_progress: 'bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300',
  waiting: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  for_review: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  rework: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
  completed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
}

/** Pick the tasks a drill target refers to, from the already-scoped list. */
export function drillTasks(tasks: Task[], target: KpiDrillTarget, month: string, _workerName: (id: string) => string): Task[] {
  let rows = tasks.filter((t) => !t.archived_at)
  if (target.workerId) rows = rows.filter((t) => t.worker_id === target.workerId)
  const completedInMonth = (t: Task) => normalizeTaskStage(t.status) === 'completed' && (t.completed_at ?? '').slice(0, 7) === month
  switch (target.kind) {
    case 'active':
      return rows.filter(isOpen)
    case 'completed':
      return rows.filter(completedInMonth)
    case 'onTime':
      return rows.filter(completedInMonth)
    case 'overdue':
      return rows.filter((t) => isOverdueTask(t) && (!target.flag || t.priority === 'high'))
    case 'blocked':
      return rows.filter((t) => normalizeTaskStage(t.status) === 'waiting')
    case 'review':
      return rows.filter((t) => normalizeTaskStage(t.status) === 'for_review')
    case 'qa':
      return rows.filter((t) => t.qa_score != null && completedInMonth(t))
    case 'rework':
      return rows.filter((t) => t.rework_required === true && completedInMonth(t))
    case 'workload':
      return rows.filter((t) => isOpen(t) && openEstimatedHours(t) > 0)
    case 'goal':
      return rows.filter(completedInMonth)
    case 'score':
      return rows.filter((t) => isOpen(t) || completedInMonth(t))
  }
}

/**
 * The source-task list behind a KPI number — opened by clicking any metric on
 * the Team KPI page. Shows each task's stage, due date, estimate and QA facts
 * so the arithmetic on the dashboard is always checkable (§7).
 */
export function KpiDrillDialog({
  open,
  onOpenChange,
  target,
  tasks,
  month,
  workerName,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  target: KpiDrillTarget | null
  /** Header-scoped tasks (employee/client/status filters already applied). */
  tasks: Task[]
  month: string
  workerName: (id: string) => string
}) {
  const rows = useMemo(() => {
    if (!target) return []
    return drillTasks(tasks, target, month, workerName).sort((a, b) => {
      const ad = a.due_date ?? '9999-12-31'
      const bd = b.due_date ?? '9999-12-31'
      return ad.localeCompare(bd)
    })
  }, [tasks, target, month, workerName])

  if (!target) return null
  const title = TITLES[target.kind]
  const flagNote =
    target.kind === 'overdue' && target.flag ? ' — high priority only' :
    target.kind === 'onTime' ? ` — ${monthLabel(month)} completions` :
    target.workerId ? ` — ${workerName(target.workerId)}` : ` — ${monthLabel(month)}`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="space-y-1 border-b px-5 py-4 pr-12 text-left">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {flagNote} · {rows.length} task{rows.length === 1 ? '' : 's'} in scope.
            Every KPI figure links back to tasks like these — nothing is typed twice.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {rows.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">No tasks in this slice.</p>
          ) : (
            <ul className="space-y-2">
              {rows.map((t) => {
                const stage = normalizeTaskStage(t.status)
                const verdict = wasOnTime(t)
                const legacy = isLegacyNoDue(t)
                return (
                  <li key={t.id} className="rounded-xl border bg-card p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{t.title}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {workerName(t.worker_id)}
                          {t.due_date ? ` · due ${formatDate(t.due_date)}` : ' · legacy (no due date)'}
                          {t.estimated_hours != null ? ` · ~${t.estimated_hours}h est.` : ''}
                          {' · '}
                          {TaskPriorityNames[t.priority]} priority
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                        <span
                          className={cn(
                            'inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                            STATUS_TINTS[stage] ?? STATUS_TINTS.todo,
                          )}
                        >
                          {TaskStatusNames[stage]}
                        </span>
                        {isOverdueTask(t) && (
                          <Badge variant="destructive" className="text-[10px]">Overdue</Badge>
                        )}
                        {verdict !== null && (
                          <Badge variant={verdict ? 'success' : 'destructive'} className="text-[10px]">
                            {verdict ? 'On time' : 'Late'}
                          </Badge>
                        )}
                        {legacy && (
                          <Badge variant="muted" className="text-[10px]">Legacy</Badge>
                        )}
                        {t.qa_score != null && (
                          <Badge variant="secondary" className="text-[10px]" title={QA_SCORE_NAMES[t.qa_score]}>
                            QA {t.qa_score}/5
                          </Badge>
                        )}
                        {t.rework_required && t.rework_type && (
                          <Badge
                            variant="outline"
                            className={cn(
                              'text-[10px]',
                              isEmployeeCausedRework(t.rework_type)
                                ? 'border-rose-300 text-rose-700 dark:text-rose-300'
                                : 'border-emerald-300 text-emerald-700 dark:text-emerald-300',
                            )}
                            title={ReworkTypeNames[t.rework_type]}
                          >
                            {ReworkTypeNames[t.rework_type]}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
