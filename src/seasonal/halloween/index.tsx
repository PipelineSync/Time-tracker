/**
 * Halloween seasonal skin — the one place the app plugs into it.
 *
 * The app imports these through `src/seasonal/index.ts`, never directly, so
 * this whole folder can be deleted (or replaced by another season) by
 * changing one line there. See ./README.md.
 */
import type { ReactNode } from 'react'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { onAppEvent } from '@/lib/appEvents'
import { playSound, setCueOverride } from '@/lib/sounds'
import { Cobweb } from './Cobweb'
import { HalloweenLayer } from './HalloweenLayer'
import { LogoHat } from './LogoHat'
import { PumpkinDot } from './PumpkinDot'
import {
  HALLOWEEN_CLASS,
  halloweenAvailable,
  isHalloweenTheme,
  setHalloweenDeviceEnabled,
  useHalloween,
} from './config'
import { HALLOWEEN_CUES, ORGAN_CHORD } from './sounds'
import './halloween.css'

/** Wire the non-visual parts: spooky sounds. Call once. */
export function installSeason(): void {
  // Asked at play time, so the Settings switch applies to the very next cue.
  setCueOverride((cue) => (isHalloweenTheme() ? HALLOWEEN_CUES[cue] : undefined))
  onAppEvent('task_completed', () => {
    if (!isHalloweenTheme()) return
    playSound(ORGAN_CHORD)
  })
}

/** Class for <html> while the season is on (palette in ./halloween.css). */
export function useSeasonClass(): string | null {
  return useHalloween() ? HALLOWEEN_CLASS : null
}

/** Bats, embers, page cobweb, cursor sparks and the clock-out ghost. */
export function SeasonLayer() {
  return useHalloween() ? <HalloweenLayer /> : null
}

/** The "on the clock" dot: a flickering pumpkin instead of the orange ping. */
export function SeasonLiveDot({ children }: { children: ReactNode }) {
  return useHalloween() ? <PumpkinDot /> : <>{children}</>
}

/** Sidebar decoration: a cobweb in the top corner. */
export function SeasonSidebarDecor() {
  return useHalloween() ? <Cobweb className="halloween-cobweb-sidebar" /> : null
}

/** The witch hat on the logo. */
export function SeasonLogoHat({ dark }: { dark: boolean }) {
  return useHalloween() ? <LogoHat dark={dark} /> : null
}

/** Settings → Appearance switch, shown only while the season is running. */
export function SeasonSettings() {
  const on = useHalloween()
  if (!halloweenAvailable()) return null
  return (
    <div className="mt-4 flex items-start justify-between gap-4 rounded-2xl border border-[var(--line)] p-4">
      <div className="space-y-1">
        <Label htmlFor="season-halloween">Halloween decorations</Label>
        <p className="text-sm text-muted-foreground">
          Pumpkins, bats, cobwebs and spooky sounds, on this device. They switch off by
          themselves after October 31.
        </p>
      </div>
      <Switch id="season-halloween" checked={on} onCheckedChange={setHalloweenDeviceEnabled} />
    </div>
  )
}
