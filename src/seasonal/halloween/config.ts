import { useSyncExternalStore } from 'react'
import { storage } from '@/lib/storage'

/**
 * When the Halloween skin is on. Three switches, checked in this order:
 *
 * 1. Build flag `VITE_HALLOWEEN_THEME`:
 *      `off`  → never (for everyone),
 *      `on`   → always, even outside October,
 *      unset  → automatic: October only (Oct 1–31, the viewer's local date),
 *               so it switches itself off after Halloween with no deploy.
 * 2. Per-device choice: Settings → Appearance → "Halloween decorations".
 *    Turning it off is remembered on that device (`wt_halloween = off`).
 */
const PREF_KEY = 'wt_halloween'
const CHANGE_EVENT = 'wt:halloween-change'

/** The class put on <html> while the skin is on (styles: ./halloween.css). */
export const HALLOWEEN_CLASS = 'halloween'

type BuildMode = 'on' | 'off' | 'auto'

function buildMode(): BuildMode {
  const v = (import.meta.env.VITE_HALLOWEEN_THEME as string | undefined)?.toLowerCase()
  return v === 'on' || v === 'off' ? v : 'auto'
}

/** October in the viewer's local time. */
export function inHalloweenSeason(date = new Date()): boolean {
  return date.getMonth() === 9
}

/** Whether the season is running at all (so the Settings switch is worth showing). */
export function halloweenAvailable(): boolean {
  const mode = buildMode()
  if (mode === 'off') return false
  return mode === 'on' || inHalloweenSeason()
}

/** This device has not opted out. */
export function halloweenDeviceEnabled(): boolean {
  return storage.getItem(PREF_KEY) !== 'off'
}

export function isHalloweenTheme(): boolean {
  return halloweenAvailable() && halloweenDeviceEnabled()
}

export function setHalloweenDeviceEnabled(enabled: boolean): void {
  storage.setItem(PREF_KEY, enabled ? 'on' : 'off')
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange)
  return () => window.removeEventListener(CHANGE_EVENT, onChange)
}

/** React to the skin turning on or off (the Settings switch) without a reload. */
export function useHalloween(): boolean {
  return useSyncExternalStore(subscribe, isHalloweenTheme, () => false)
}
