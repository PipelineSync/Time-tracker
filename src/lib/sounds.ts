/**
 * Short confirmation cues for the clock: in, out, break start, break end.
 *
 * The tones are **synthesised with the Web Audio API** rather than shipped as
 * audio files on purpose:
 *   - the same bundle runs in a browser tab, an installed PWA, the Capacitor
 *     iOS/Android WebView and the Tauri desktop shell, and `AudioContext`
 *     exists in all four — no asset, no format, no per-platform audio bridge;
 *   - nothing to add to the PWA's Workbox precache (`vite.config.ts` only
 *     caches js/css/html/svg/png/ico/woff2), so the cues work offline as soon
 *     as the app itself is cached;
 *   - a few hundred bytes of code instead of ~40 KB of media.
 *
 * Autoplay policy: browsers only let a page make noise after a real user
 * gesture. `installAudioUnlock()` creates and resumes the context on the first
 * pointer/key/touch interaction, so by the time a clock-in round-trip finishes
 * the context is already running and the cue is never swallowed.
 *
 * There is deliberately **no mute switch for the user's own actions** — the
 * whole point is a confirmation you do not have to look at the screen for. The
 * one opt-in is the admin's "hear the team" cue (see `readTeamSoundsPref`),
 * which is per device and off by default because it plays for other people's
 * clock-ins.
 */

import { storage } from './storage'

export type SoundCue = 'clock_in' | 'clock_out' | 'break_start' | 'break_end'

/** A single beep: frequency, offset from the start of the cue, length. */
interface Tone {
  freq: number
  /** Seconds after the cue starts. */
  at: number
  /** Seconds the tone sounds (its decay). */
  dur: number
  /** 0–1 multiplier on the cue's own level, for notes that sit back a little. */
  gain?: number
}

interface CueDef {
  label: string
  wave: OscillatorType
  /** Overall level of this cue, before the master gain. */
  level: number
  tones: Tone[]
}

/**
 * Four shapes that are distinguishable with your eyes shut: clock-in rises,
 * clock-out falls (the two "shift" events read as open/close), a break is a
 * pair of soft low blips, and coming back is a pair of short bright ticks.
 */
export const CUES: Record<SoundCue, CueDef> = {
  clock_in: {
    label: 'Clocked in',
    wave: 'sine',
    level: 0.9,
    tones: [
      { freq: 523.25, at: 0.0, dur: 0.16 }, // C5
      { freq: 659.25, at: 0.09, dur: 0.16 }, // E5
      { freq: 783.99, at: 0.18, dur: 0.24 }, // G5
    ],
  },
  clock_out: {
    label: 'Clocked out',
    wave: 'triangle',
    level: 0.85,
    tones: [
      { freq: 783.99, at: 0.0, dur: 0.16 }, // G5
      { freq: 659.25, at: 0.1, dur: 0.16 }, // E5
      { freq: 523.25, at: 0.2, dur: 0.3 }, // C5
    ],
  },
  break_start: {
    label: 'Break started',
    wave: 'sine',
    level: 0.6,
    tones: [
      { freq: 392.0, at: 0.0, dur: 0.13 }, // G4
      { freq: 329.63, at: 0.17, dur: 0.2, gain: 0.9 }, // E4
    ],
  },
  break_end: {
    label: 'Back to work',
    wave: 'sine',
    level: 0.62,
    tones: [
      { freq: 587.33, at: 0.0, dur: 0.09, gain: 0.85 }, // D5
      { freq: 880.0, at: 0.11, dur: 0.18 }, // A5
    ],
  },
}

/** Order cues are played (and deduped) in. */
export const CUE_ORDER: SoundCue[] = ['clock_in', 'clock_out', 'break_start', 'break_end']

/** Master output level: audible on a phone in a quiet room, never startling. */
const MASTER_GAIN = 0.5
/** Second-identical cues this fast are treated as a double fire. */
const DEFAULT_MIN_GAP_MS = 400
/** Spacing between stacked team cues. */
const TEAM_STAGGER_MS = 340
/** How long the audio context may sit idle before we consider it stale. */
const SUSPEND_AFTER_MS = 90_000
/** Headroom before a note on a running context — enough to avoid a click. */
const PLAY_LEAD_SEC = 0.02
/** …and on one that is waking up, enough to keep stacked cues in order. */
const WAKE_LEAD_SEC = 0.3

let ctx: AudioContext | null = null
let master: GainNode | null = null
let unlockArmed = false
/** True once a real interaction has opened the context — what makes it legal to
 * wake it up again outside a gesture (the OS already granted it). */
let unlockedByGesture = false
let idleTimer: number | null = null
const lastPlayedAt = new Map<SoundCue, number>()

type AudioCtor = typeof AudioContext

function audioContextCtor(): AudioCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor }
  return w.AudioContext ?? w.webkitAudioContext ?? null
}

/** The one shared context, or null when this platform cannot make a sound. */
function getCtx(): AudioContext | null {
  if (ctx) return ctx
  const Ctor = audioContextCtor()
  if (!Ctor) return null
  try {
    ctx = new Ctor({ latencyHint: 'interactive' })
    master = ctx.createGain()
    master.gain.value = MASTER_GAIN
    master.connect(ctx.destination)
  } catch {
    // A webview that refuses an AudioContext must never break a clock-in.
    ctx = null
    master = null
    return null
  }
  return ctx
}

/**
 * Length of a cue in seconds — handy for previews and tests, and it keeps the
 * tail of the last note inside the envelope rather than being cut off by it.
 */
export function cueDuration(cue: SoundCue): number {
  const def = CUES[cue]
  return def.tones.reduce((end, t) => Math.max(end, t.at + t.dur), 0)
}

function scheduleTone(audio: AudioContext, dest: AudioNode, tone: Tone, wave: OscillatorType, start: number, level: number) {
  const osc = audio.createOscillator()
  const env = audio.createGain()
  const attack = 0.014
  const peak = Math.max(0.0002, level * (tone.gain ?? 1))
  osc.type = wave
  osc.frequency.setValueAtTime(tone.freq, start)
  // Short linear attack (no click) then an exponential decay, which is what a
  // struck note sounds like.
  env.gain.setValueAtTime(0.0001, start)
  env.gain.linearRampToValueAtTime(peak, start + attack)
  env.gain.exponentialRampToValueAtTime(0.0001, start + tone.dur)
  osc.connect(env)
  env.connect(dest)
  osc.start(start)
  osc.stop(start + tone.dur + 0.03)
  osc.onended = () => {
    try {
      osc.disconnect()
      env.disconnect()
    } catch {
      /* already torn down */
    }
  }
}

/**
 * @param lead seconds of headroom before the first note. A running context
 * needs almost none; a waking one gets enough that several cues scheduled in
 * the same instant still come out one after the other instead of stacked.
 */
function scheduleCue(audio: AudioContext, dest: AudioNode, cue: SoundCue, lead: number) {
  const def = CUES[cue]
  const t0 = audio.currentTime + lead
  for (const tone of def.tones) scheduleTone(audio, dest, tone, def.wave, t0 + tone.at, def.level)
}

/**
 * Play a cue. Returns whether sound was actually produced, so callers can log
 * or fall back; it never throws and never rejects.
 *
 * A **suspended** context is woken up rather than skipped: the browser suspends
 * an idle one, and the notes are scheduled against its own clock, so they land
 * the instant it resumes. Skipping instead would silently eat the first cue
 * after a quiet stretch — exactly the "did my tap land?" moment this exists for.
 * Before the very first gesture nothing may play at all, so that case returns
 * `false` instead of queueing a stale tone.
 */
export function playCue(cue: SoundCue, opts?: { minGapMs?: number }): boolean {
  const now = Date.now()
  const gap = opts?.minGapMs ?? DEFAULT_MIN_GAP_MS
  const last = lastPlayedAt.get(cue)
  if (last !== undefined && now - last < gap) return false
  const audio = getCtx()
  if (!audio || !master) return false
  const waking = audio.state !== 'running'
  if (waking && !unlockedByGesture) return false
  if (waking) void audio.resume().catch(() => undefined)
  lastPlayedAt.set(cue, now)
  try {
    scheduleCue(audio, master, cue, waking ? WAKE_LEAD_SEC : PLAY_LEAD_SEC)
  } catch {
    return false
  }
  // Contexts left open and idle get suspended by the browser; touching the
  // clock keeps ours warm between actions instead of it coming back cold.
  keepWarm()
  return true
}

/**
 * Shrink a pile of events to one cue per kind, in `CUE_ORDER`. A manager whose
 * four workers all clocked in during one poll interval hears a single tone, not
 * four — the cue says "the board just moved", the panel says who.
 */
export function selectCues(cues: readonly SoundCue[]): SoundCue[] {
  return CUE_ORDER.filter((cue) => cues.includes(cue))
}

/**
 * Play several cues one after another — the team-activity case, where a poll
 * can pick up four different workers' events at once. Identical cues collapse
 * into one (a manager does not need to hear "clock in" four times), so the
 * worst case is four tones, in `CUE_ORDER`.
 *
 * Returns the cues actually played.
 */
export function playCues(cues: SoundCue[], opts?: { staggerMs?: number }): SoundCue[] {
  const stagger = opts?.staggerMs ?? TEAM_STAGGER_MS
  const wanted = selectCues(cues)
  if (wanted.length === 0) return []
  // The first lands immediately, so the common single-event case is instant.
  const [head, ...rest] = wanted
  playCue(head)
  rest.forEach((cue, i) => {
    window.setTimeout(() => playCue(cue, { minGapMs: 0 }), (i + 1) * stagger)
  })
  return wanted
}

function keepWarm() {
  if (typeof window === 'undefined') return
  if (idleTimer !== null) window.clearTimeout(idleTimer)
  idleTimer = window.setTimeout(() => {
    idleTimer = null
    // Release the audio hardware when nobody has clocked in for a while, so an
    // open tab on a phone is not holding an output stream all day. The next cue
    // resumes it; `playCue` handles a sleeping context rather than skipping.
    if (ctx && ctx.state === 'running') void ctx.suspend().catch(() => undefined)
  }, SUSPEND_AFTER_MS)
}

/** Bring the audio context to life. Safe to call as often as you like. */
export function unlockAudio(): void {
  const audio = getCtx()
  if (!audio) return
  if (audio.state !== 'running') void audio.resume().catch(() => undefined)
}

/**
 * Listen for the first interaction and unlock audio there. Called once from
 * `main.tsx`. The listeners are capture-phase and passive, so they run before
 * any component handler (the click that starts a clock-in) and cost nothing.
 */
export function installAudioUnlock(): void {
  if (typeof window === 'undefined' || unlockArmed) return
  unlockArmed = true
  const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'touchstart']
  const onGesture = () => {
    unlockedByGesture = true
    unlockAudio()
    // Keep listening: a context can still be suspended by the OS (a call
    // coming in on a phone, a long background stretch) and the next tap
    // should bring it back.
    keepWarm()
  }
  for (const e of events) window.addEventListener(e, onGesture, { capture: true, passive: true })
}

// ---------------------------------------------------------------------------
// Admin "hear the team" preference
// ---------------------------------------------------------------------------

/** Per device *and per account*: two people sharing a laptop do not inherit
 * each other's noise settings. */
const TEAM_SOUNDS_KEY = 'wt_team_sounds'

function teamKey(userId: string): string {
  return `${TEAM_SOUNDS_KEY}:${userId}`
}

/** Opt-in, off by default. */
export function readTeamSoundsPref(userId: string | null | undefined): boolean {
  if (!userId) return false
  return storage.getItem(teamKey(userId)) === '1'
}

export function writeTeamSoundsPref(userId: string | null | undefined, enabled: boolean): void {
  if (!userId) return
  storage.setItem(teamKey(userId), enabled ? '1' : '0')
}
