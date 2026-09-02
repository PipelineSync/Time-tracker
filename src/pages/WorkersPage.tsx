import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '@/lib/store'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { WorkerFormDialog } from '@/components/WorkerFormDialog'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { EmptyState } from '@/components/EmptyState'
import { WorkerLoginDetails } from '@/components/WorkerLoginDetails'
import { SettleWorkerDialog } from '@/components/SettleWorkerDialog'
import { ResetWorkerPasswordDialog } from '@/components/ResetWorkerPasswordDialog'
import { toast } from 'sonner'
import { Users, Plus, UserRound, Pencil, Trash2, History, RotateCcw, KeyRound, Coffee } from 'lucide-react'
import type { Worker } from '@/lib/types'
import { cn, money, formatDate, formatMinutes, formatMsShort, timerBreakMs, timerElapsedMs } from '@/lib/utils'

export function WorkersPage() {
  const { workers, entries, activeTimers, deleteWorker, settings, dataLoading } = useStore()
  const navigate = useNavigate()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Worker | null>(null)
  const [deleting, setDeleting] = useState<Worker | null>(null)
  const [settling, setSettling] = useState<Worker | null>(null)
  const [resettingPw, setResettingPw] = useState<Worker | null>(null)

  const currency = settings?.currency || 'USD'

  // Live clock state per worker, refreshed every second.
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (activeTimers.length === 0) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [activeTimers.length])

  const timerByWorker = useMemo(() => {
    const map = new Map<string, (typeof activeTimers)[number]>()
    for (const t of activeTimers) map.set(t.worker_id, t)
    return map
  }, [activeTimers])

  const statsFor = (id: string) => {
    let minutes = 0
    let earnings = 0
    for (const e of entries) {
      if (e.worker_id === id) {
        minutes += e.total_minutes
        earnings += e.earnings
      }
    }
    return { minutes, earnings }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Workers" description="Manage workers and their hourly rates.">
        <Button onClick={() => { setEditing(null); setFormOpen(true); }}>
          <Plus className="mr-1" /> Add worker
        </Button>
      </PageHeader>

      {dataLoading && workers.length === 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-40" />)}
        </div>
      ) : workers.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No workers yet"
          description="Add workers with their hourly rate to start tracking time and earnings."
          action={<Button onClick={() => { setEditing(null); setFormOpen(true); }}><Plus className="mr-1" /> Add worker</Button>}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {workers.map((w) => {
            const s = statsFor(w.id)
            const timer = timerByWorker.get(w.id) || null
            const onBreak = !!timer?.paused
            return (
              <Card
                key={w.id}
                className={cn(
                  w.status === 'inactive' && 'opacity-70',
                  timer && (onBreak ? 'border-[#36B7C9]/50' : 'border-[#F77A0A]/50')
                )}
              >
                <CardContent className="p-5">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
                        <UserRound className="h-5 w-5" />
                      </div>
                      <div>
                        <p className="font-semibold">{w.name}</p>
                        {w.email && <p className="text-xs text-muted-foreground">{w.email}</p>}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <Badge variant={w.status === 'active' ? 'success' : 'muted'}>
                        {w.status === 'active' ? 'Active' : 'Inactive'}
                      </Badge>
                      {timer && (
                        onBreak ? (
                          <Badge className="gap-1 border-transparent bg-[#36B7C9]/15 text-[#0d7c8c] dark:text-[#7fdbe8]">
                            <Coffee className="h-3 w-3" /> On break
                          </Badge>
                        ) : (
                          <Badge className="gap-1 border-transparent bg-[#F77A0A]/15 text-[#b85c05] dark:text-[#ffb066]">
                            <span className="relative flex h-2 w-2">
                              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#F77A0A] opacity-75" />
                              <span className="relative inline-flex h-2 w-2 rounded-full bg-[#F77A0A]" />
                            </span>
                            Working
                          </Badge>
                        )
                      )}
                    </div>
                  </div>

                  {timer && (
                    <p className="mt-3 text-xs text-muted-foreground">
                      {onBreak
                        ? `On break for ${formatMsShort(timerBreakMs(timer, new Date(now)))} · worked ${formatMsShort(timerElapsedMs(timer, new Date(now)))} today`
                        : `On the clock for ${formatMsShort(timerElapsedMs(timer, new Date(now)))}`}
                    </p>
                  )}

                  <div className="mt-4 space-y-1 rounded-lg bg-muted/60 p-3 text-sm">
                    <div className="flex justify-between"><span className="text-muted-foreground">Rate</span><span className="font-semibold">{money(w.hourly_rate, currency)}/hr</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Total hours</span><span>{formatMinutes(s.minutes)}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Total earnings</span><span className="font-semibold">{money(s.earnings, currency)}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Added</span><span>{formatDate(w.created_at)}</span></div>
                  </div>

                  <div className="mt-3">
                    <WorkerLoginDetails workerId={w.id} />
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" className="flex-1 gap-1" onClick={() => navigate(`/entries?worker=${w.id}`)}>
                      <History className="h-4 w-4" /> History
                    </Button>
                    <Button variant="outline" size="sm" className="gap-1" onClick={() => { setEditing(w); setFormOpen(true); }}>
                      <Pencil className="h-4 w-4" /> Edit
                    </Button>
                    <Button variant="outline" size="sm" className="gap-1" onClick={() => setSettling(w)} title="Reset time & earnings">
                      <RotateCcw className="h-4 w-4" /> Reset
                    </Button>
                    <Button variant="outline" size="sm" className="gap-1" onClick={() => setResettingPw(w)} title="Reset worker password">
                      <KeyRound className="h-4 w-4" /> Password
                    </Button>
                    <Button variant="ghost" size="iconSm" className="text-destructive" onClick={() => setDeleting(w)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <WorkerFormDialog open={formOpen} onOpenChange={setFormOpen} worker={editing} />

      {settling && <SettleWorkerDialog worker={settling} open={!!settling} onOpenChange={(v) => { if (!v) setSettling(null); }} />}

      {resettingPw && <ResetWorkerPasswordDialog worker={resettingPw} open={!!resettingPw} onOpenChange={(v) => { if (!v) setResettingPw(null); }} />}

      {deleting && (
        <ConfirmDialog
          open={!!deleting}
          onOpenChange={(v) => { if (!v) setDeleting(null); }}
          title={`Delete ${deleting.name}?`}
          description="This will permanently remove the worker, all of their time entries, and disable their login account so they can no longer sign in. This cannot be undone."
          confirmLabel="Delete worker"
          onConfirm={async () => {
            const ok = await deleteWorker(deleting.id)
            if (ok) toast.success('Worker deleted — their login has been disabled.')
            else toast.error('Failed to delete worker.')
          }}
        />
      )}
    </div>
  )
}
