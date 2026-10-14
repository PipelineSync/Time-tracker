import type { CueDef, SoundCue } from '@/lib/sounds'

/**
 * Spooky versions of the clock cues. They keep the standard shapes, so they
 * still read with your eyes shut: clock-in rises, clock-out falls, a break is
 * low, coming back is bright. Same master volume as the normal cues.
 */
export const HALLOWEEN_CUES: Record<SoundCue, CueDef> = {
  // A minor arpeggio climbing into the night.
  clock_in: {
    label: 'Clocked in',
    wave: 'triangle',
    level: 0.85,
    tones: [
      { freq: 440.0, at: 0.0, dur: 0.18 }, // A4
      { freq: 523.25, at: 0.1, dur: 0.18 }, // C5
      { freq: 659.25, at: 0.2, dur: 0.18 }, // E5
      { freq: 880.0, at: 0.3, dur: 0.4 }, // A5
    ],
  },
  // A falling witch's cackle: quick staccato steps down.
  clock_out: {
    label: 'Clocked out',
    wave: 'square',
    level: 0.32,
    tones: [
      { freq: 987.77, at: 0.0, dur: 0.07 },
      { freq: 880.0, at: 0.08, dur: 0.07 },
      { freq: 932.33, at: 0.16, dur: 0.07 },
      { freq: 783.99, at: 0.24, dur: 0.07 },
      { freq: 830.61, at: 0.32, dur: 0.07 },
      { freq: 659.25, at: 0.4, dur: 0.26 },
    ],
  },
  // A creaky door: low, uneven groans.
  break_start: {
    label: 'Break started',
    wave: 'sawtooth',
    level: 0.22,
    tones: [
      { freq: 196.0, at: 0.0, dur: 0.1 },
      { freq: 207.65, at: 0.06, dur: 0.1, gain: 0.8 },
      { freq: 185.0, at: 0.12, dur: 0.1 },
      { freq: 220.0, at: 0.19, dur: 0.12, gain: 0.85 },
      { freq: 174.61, at: 0.27, dur: 0.18 },
    ],
  },
  // Two church-bell ticks.
  break_end: {
    label: 'Back to work',
    wave: 'sine',
    level: 0.6,
    tones: [
      { freq: 1046.5, at: 0.0, dur: 0.14, gain: 0.85 },
      { freq: 1567.98, at: 0.12, dur: 0.32 },
    ],
  },
}

/** A haunted organ chord for finishing a task (D minor, held). */
export const ORGAN_CHORD: CueDef = {
  label: 'Task completed',
  wave: 'sawtooth',
  level: 0.12,
  tones: [
    { freq: 146.83, at: 0.0, dur: 1.1 }, // D3
    { freq: 293.66, at: 0.0, dur: 1.1 }, // D4
    { freq: 349.23, at: 0.02, dur: 1.05 }, // F4
    { freq: 440.0, at: 0.04, dur: 1.0 }, // A4
  ],
}
