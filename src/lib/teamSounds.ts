/**
 * Turning the live "who is on the clock" list into sound events.
 *
 * The store refreshes `activeTimers` on a poll (~15 s, and immediately on tab
 * focus), so there is no stream of actions to listen to — only a list that
 * changes shape. This module compares two snapshots of that list and reports
 * what happened between them, which is enough to chime for it.
 *
 * Deliberately free of React, `window` and Web Audio: `scripts/
 * verify-sounds-local.ts` runs it in plain Node, and the player in
 * `src/lib/sounds.ts` stays a one-line call.
 */

import type { SoundCue } from './sounds'

/** The minimum a diff needs from an `ActiveTimer`. */
export interface TimerSnapshot {
  id: string
  worker_id: string
  paused: boolean
}

export interface TeamSoundEvent {
  cue: SoundCue
  timerId: string
  workerId: string
}

export interface DiffOptions {
  /**
   * Timers this device just acted on (its own clock-in, break, clock-out,
   * cancel or client switch). A local action plays its cue right away and then
   * lands in the same list this diff reads, so without this the person who
   * clicked would hear every event twice.
   */
  ignoreTimerIds?: Iterable<string> | null
  /** Chime only for these workers — e.g. a supervisor watching the team. */
  onlyWorkerIds?: Iterable<string> | null
}

/**
 * Compare two snapshots of the active-timer list.
 *
 *  - a timer appears in `next`                → clock in
 *  - a timer is in `prev`, gone from `next`   → clock out
 *  - `paused` false → true on a live timer    → break start
 *  - `paused` true → false on a live timer    → break end
 *
 * A worker can only hold one timer (both backends keep one row per
 * `worker_id`), and **"switch client" closes the current timer and opens a new
 * one under a fresh id** — to a snapshot diff that looks exactly like clocking
 * out and straight back in. So the two lists are matched up per worker first:
 * a timer that goes out and is replaced by another in the same window is a
 * swap, and it only reports a cue if the break state changed. A plain switch
 * therefore stays silent.
 *
 * Two honest limits of diffing a polled list:
 *  - a worker who clocks in *and* out between two polls appears in neither
 *    snapshot, so no event is invented for them;
 *  - someone else cancelling a shift (deleting the timer) reads as a clock-out
 *    — the list carries no reason, only presence.
 */
export function diffTimerSnapshots(
  prev: readonly TimerSnapshot[],
  next: readonly TimerSnapshot[],
  opts?: DiffOptions
): TeamSoundEvent[] {
  const ignore = opts?.ignoreTimerIds ? new Set(opts.ignoreTimerIds) : null
  const onlyWorkers = opts?.onlyWorkerIds ? new Set(opts.onlyWorkerIds) : null
  const counts = (t: TimerSnapshot) =>
    !ignore?.has(t.id) && (!onlyWorkers || onlyWorkers.has(t.worker_id))

  const before = new Map<string, TimerSnapshot>()
  for (const t of prev) before.set(t.id, t)
  const after = new Map<string, TimerSnapshot>()
  for (const t of next) after.set(t.id, t)

  const events: TeamSoundEvent[] = []
  const addedByWorker = new Map<string, TimerSnapshot[]>()
  const removedByWorker = new Map<string, TimerSnapshot[]>()
  const group = (map: Map<string, TimerSnapshot[]>, t: TimerSnapshot) => {
    const list = map.get(t.worker_id)
    if (list) list.push(t)
    else map.set(t.worker_id, [t])
  }

  // Timers that exist on both sides: their break state is the only thing that
  // can have changed.
  for (const t of after.values()) {
    const was = before.get(t.id)
    if (!was || !counts(t)) continue
    if (!!was.paused !== !!t.paused) {
      events.push({ cue: t.paused ? 'break_start' : 'break_end', timerId: t.id, workerId: t.worker_id })
    }
  }

  for (const t of after.values()) if (!before.get(t.id) && counts(t)) group(addedByWorker, t)
  for (const t of before.values()) if (!after.get(t.id) && counts(t)) group(removedByWorker, t)

  const workerIds = new Set([...addedByWorker.keys(), ...removedByWorker.keys()])
  for (const workerId of workerIds) {
    const added = addedByWorker.get(workerId) ?? []
    const removed = removedByWorker.get(workerId) ?? []
    const swapped = Math.min(added.length, removed.length)
    if (swapped > 0) {
      const wasPaused = removed.slice(0, swapped).some((t) => t.paused)
      const isPaused = added.slice(0, swapped).some((t) => t.paused)
      if (wasPaused !== isPaused) {
        events.push({
          cue: isPaused ? 'break_start' : 'break_end',
          timerId: added[swapped - 1].id,
          workerId,
        })
      }
    }
    for (const t of added.slice(swapped)) events.push({ cue: 'clock_in', timerId: t.id, workerId })
    for (const t of removed.slice(swapped)) events.push({ cue: 'clock_out', timerId: t.id, workerId })
  }

  return events
}

/**
 * Snapshots come from a refetch, so the array identity changes on every poll
 * even when nothing did. Cheap guard for effects that would otherwise redo the
 * diff (and could re-chime) on an unchanged list.
 */
export function snapshotsEqual(a: readonly TimerSnapshot[], b: readonly TimerSnapshot[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  const byId = new Map(a.map((t) => [t.id, !!t.paused]))
  for (const t of b) {
    const paused = byId.get(t.id)
    if (paused === undefined || paused !== !!t.paused) return false
  }
  return true
}

/** Shrink `ActiveTimer`-shaped rows to what the diff needs. */
export function timerSnapshots(timers: readonly TimerSnapshot[]): TimerSnapshot[] {
  return timers.map((t) => ({ id: t.id, worker_id: t.worker_id, paused: !!t.paused }))
}
