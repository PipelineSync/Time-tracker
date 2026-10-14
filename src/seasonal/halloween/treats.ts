import { useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { storage } from '@/lib/storage'

/**
 * Trick-or-treat milestones. Kept in this browser only (no backend, no
 * table): a light reward, not a record.
 *
 *   finish a task            → +1 candy
 *   clock out                → +1 candy
 *   reach 8 hours in a day   → +3 candy, once per day ("full bag")
 *
 * The bag empties at midnight (local time).
 */
const KEY = 'wt_halloween_treats'
const CHANGE_EVENT = 'wt:treats-change'
const FULL_DAY_MINUTES = 8 * 60

export interface TreatState {
  day: string
  candy: number
  minutes: number
  fullBag: boolean
  /** Bumps on every award, so the bag can replay its pop animation. */
  bump: number
}

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const EMPTY = (): TreatState => ({ day: today(), candy: 0, minutes: 0, fullBag: false, bump: 0 })

let cache: TreatState | null = null

function read(): TreatState {
  if (cache && cache.day === today()) return cache
  try {
    const raw = storage.getItem(KEY)
    const parsed = raw ? (JSON.parse(raw) as TreatState) : null
    cache = parsed && parsed.day === today() ? parsed : EMPTY()
  } catch {
    cache = EMPTY()
  }
  return cache
}

function write(next: TreatState) {
  cache = next
  storage.setItem(KEY, JSON.stringify(next))
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function awardTaskTreat(): void {
  const s = read()
  write({ ...s, candy: s.candy + 1, bump: s.bump + 1 })
}

export function awardClockOutTreat(minutes: number): void {
  const s = read()
  const total = s.minutes + Math.max(0, minutes)
  const earnedFullBag = !s.fullBag && total >= FULL_DAY_MINUTES
  write({
    ...s,
    minutes: total,
    candy: s.candy + 1 + (earnedFullBag ? 3 : 0),
    fullBag: s.fullBag || earnedFullBag,
    bump: s.bump + 1,
  })
  if (earnedFullBag) {
    toast.success('Full bag of treats', { description: '8 hours logged today. Go enjoy the candy.' })
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGE_EVENT, onChange)
  return () => window.removeEventListener(CHANGE_EVENT, onChange)
}

export function useTreats(): TreatState {
  return useSyncExternalStore(subscribe, read, read)
}

const MESSAGES = [
  'A full-size chocolate bar. The good house on the street.',
  'Candy corn. Love it or hate it, it counts.',
  'A caramel apple, slightly sticky. Worth it.',
  'Gummy worms, still wriggling.',
  'A handful of mini peanut-butter cups.',
  'A lollipop shaped like a bat.',
  'One mysterious unwrapped candy. Maybe skip that one.',
  'Sour skulls. Very sour. Very skull.',
]

export function randomTreatMessage(): string {
  return MESSAGES[Math.floor(Math.random() * MESSAGES.length)]
}
