/**
 * A tiny in-app event bus for moments other modules may want to react to
 * (seasonal decorations, celebrations) without the store knowing about them.
 *
 * Emitting never throws: a listener that fails is logged and skipped, so a
 * decoration can never break a clock-out or a task update.
 */
export interface AppEventMap {
  /** The signed-in user clocked themselves out. */
  clock_out: { minutes: number }
  /** The signed-in user moved a task to Completed. */
  task_completed: { title: string }
}

type Listener<K extends keyof AppEventMap> = (payload: AppEventMap[K]) => void

const listeners = new Map<keyof AppEventMap, Set<(payload: never) => void>>()

export function onAppEvent<K extends keyof AppEventMap>(event: K, fn: Listener<K>): () => void {
  let set = listeners.get(event)
  if (!set) listeners.set(event, (set = new Set()))
  set.add(fn)
  return () => {
    set.delete(fn)
  }
}

export function emitAppEvent<K extends keyof AppEventMap>(event: K, payload: AppEventMap[K]): void {
  const set = listeners.get(event) as Set<Listener<K>> | undefined
  if (!set) return
  for (const fn of set) {
    try {
      fn(payload)
    } catch (err) {
      console.error(`[work-tracker] ${event} listener failed`, err)
    }
  }
}
