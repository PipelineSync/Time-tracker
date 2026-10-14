/**
 * "No season" — drop-in replacement for a seasonal folder. Point
 * src/seasonal/index.ts at this file to run the plain brand theme with no
 * seasonal code at all.
 */
import type { ReactNode } from 'react'

export function installSeason(): void {}
export function useSeasonClass(): string | null {
  return null
}
export function SeasonLayer() {
  return null
}
export function SeasonLiveDot({ children }: { children: ReactNode }) {
  return <>{children}</>
}
export function SeasonSidebarDecor() {
  return null
}
export function SeasonLogoHat(_props: { dark: boolean }) {
  return null
}
export function SeasonSettings() {
  return null
}
