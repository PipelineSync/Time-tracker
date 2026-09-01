import { useEffect, useState } from 'react'
import { useStore } from '@/lib/store'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { TimerDisplay } from '@/components/TimerDisplay'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { toast } from 'sonner'
import { Square, Pause, PlayCircle, LogIn, TimerReset } from 'lucide-react'
import { formatMinutes, money, timerElapsedMs } from '@/lib/utils'

/**
 * Worker-only clock in / break / clock out screen.
 * The admin has no start-timer — they add time via manual entries.
 */
export function TrackerPage() {
  const { workers, activeTimer, startTimer, pauseTimer, resumeTimer, stopTimer, cancelTimer, settings, user, dataLoading } = useStore()

  const [starting, setStarting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [now, setNow] = useState(Date.now())

  const workerProfile = user?.workerId ? workers.find((w) => w.id === user.workerId) : null
  const currentWorkerId = user?.workerId ?? null
  // The backend already scopes activeTimer to the signed-in worker (including
  // self-healed leftovers from a previous session), so no extra matching here.
  const myTimer = activeTimer ?? null

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const elapsedMs = myTimer ? timerElapsedMs(myTimer, new Date(now)) : 0

  async function handleClockIn() {
    if (!currentWorkerId) {
      toast.error('No worker profile linked to this account. Please contact your administrator.')
      return
    }
    setStarting(true)
    const res = await startTimer({ worker_id: currentWorkerId })
    setStarting(false)
    if (res.error || !res.data) {
      toast.error(res.error || 'Could not clock in. Please try again.')
      return
    }
    // If the backend handed back an existing (unfinished) timer instead of
    // creating one, say so rather than pretending it's a fresh start.
    const startedAgoMs = Date.now() - new Date(res.data.start_time).getTime()
    if (startedAgoMs > 2 * 60 * 1000) {
      toast.success(`Resumed your unfinished timer from ${new Date(res.data.start_time).toLocaleString()} — clock out when ready.`, { duration: 8000 })
    } else {
      toast.success('Clocked in.')
    }
  }

  async function handlePause() {
    setBusy(true)
    const t = await pauseTimer()
    setBusy(false)
    if (t.error || !t.data) toast.error(t.error || 'Could not pause.')
    else toast.success('On break.')
  }

  async function handleResume() {
    setBusy(true)
    const t = await resumeTimer()
    setBusy(false)
    if (t.error || !t.data) toast.error(t.error || 'Could not resume.')
    else toast.success('Back to work.')
  }

  async function handleStop() {
    setBusy(true)
    const res = await stopTimer()
    setBusy(false)
    if (res.error || !res.data) {
      toast.error(res.error || 'Failed to save time.')
      return
    }
    toast.success(`Clocked out — ${formatMinutes(res.data.total_minutes)} · ${money(res.data.earnings, settings?.currency || 'USD')}`)
  }

  if (dataLoading && workers.length === 0 && !user?.workerId) {
    return (
      <div className="space-y-6">
        <PageHeader title="Clock In / Out" />
        <Card><CardContent className="flex h-64 items-center justify-center text-muted-foreground">Loading…</CardContent></Card>
      </div>
    )
  }

  const running = !!myTimer && !myTimer.paused
  const paused = !!myTimer && myTimer.paused

  return (
    <div className="space-y-6">
      <PageHeader title="Clock In / Out" description="Clock in, take breaks, and clock out." />

      {myTimer ? (
        <Card className="border-primary/40">
          <CardHeader className="text-center">
            <CardDescription className="flex items-center justify-center gap-2">
              <span className={`h-2 w-2 animate-pulse rounded-full ${running ? 'bg-[#F77A0A]' : 'bg-[#36B7C9]'}`} />
              {running ? 'On the clock' : 'On break'}
            </CardDescription>
            <CardTitle className="text-2xl">{workerProfile?.name || 'You'}</CardTitle>
            {workerProfile && (
              <CardDescription className="font-medium text-primary">
                {money(workerProfile.hourly_rate, settings?.currency || 'USD')}/hr
              </CardDescription>
            )}
          </CardHeader>
          <CardContent className="flex flex-col items-center space-y-6">
            <div className="rounded-2xl bg-primary/5 px-10 py-8">
              <TimerDisplay ms={elapsedMs} running={running} />
            </div>
            <p className="text-sm text-muted-foreground">Clocked in {new Date(myTimer.start_time).toLocaleString()}</p>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              {running ? (
                <Button size="lg" variant="secondary" className="gap-2" onClick={handlePause} disabled={busy}>
                  <Pause className="h-5 w-5" /> Break / Pause
                </Button>
              ) : (
                <Button size="lg" variant="secondary" className="gap-2" onClick={handleResume} disabled={busy}>
                  <PlayCircle className="h-5 w-5" /> Resume
                </Button>
              )}
              <Button size="lg" variant="default" className="gap-2 bg-[#06245B] hover:bg-[#0a306e] dark:bg-white dark:text-[#06245B] dark:hover:bg-white/90" onClick={handleStop} disabled={busy}>
                {busy ? 'Saving…' : (<><Square className="h-5 w-5" /> Clock Out</>)}
              </Button>
              <Button size="lg" variant="outline" onClick={() => setConfirmCancel(true)}>
                <TimerReset className="h-5 w-5" /> Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-primary/40 bg-primary/5">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">{workerProfile?.name || 'Welcome'}</CardTitle>
            {workerProfile && (
              <CardDescription className="font-medium text-primary">
                {money(workerProfile.hourly_rate, settings?.currency || 'USD')}/hr
              </CardDescription>
            )}
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-6">
            <div className="rounded-2xl bg-background px-10 py-8 dark:bg-white/5">
              <TimerDisplay ms={0} running={false} />
            </div>
            <Button
              size="lg"
              className="gap-2 bg-[#06245B] px-10 text-base hover:bg-[#0a306e] dark:bg-white dark:text-[#06245B] dark:hover:bg-white/90"
              onClick={handleClockIn}
              disabled={starting || !currentWorkerId}
            >
              {starting ? 'Clocking in…' : (<><LogIn className="h-5 w-5" /> Clock In</>)}
            </Button>
            <p className="text-xs text-muted-foreground">Your hourly rate is set by your administrator.</p>
          </CardContent>
        </Card>
      )}

      {confirmCancel && (
        <ConfirmDialog
          open={confirmCancel}
          onOpenChange={setConfirmCancel}
          title="Cancel timer?"
          description="This will discard the current timer without saving. This cannot be undone."
          confirmLabel="Cancel timer"
          onConfirm={async () => {
            await cancelTimer()
            toast.success('Timer cancelled.')
          }}
        />
      )}
    </div>
  )
}
