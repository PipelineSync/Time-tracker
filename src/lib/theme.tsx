import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Theme } from './types'
import { storage } from './storage'
import { useSeasonClass } from '@/seasonal'

const KEY = 'wt_theme'
/** Every seasonal class theme-init.js may add before the app boots. */
const SEASON_CLASSES = ['halloween']

interface ThemeCtx {
  theme: Theme
  resolved: 'light' | 'dark'
  setTheme: (t: Theme) => void
}

const Ctx = createContext<ThemeCtx | null>(null)

function getSystemDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

function readTheme(): Theme {
  const s = storage.getItem(KEY)
  if (s === 'light' || s === 'dark' || s === 'system') return s
  return 'system'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => readTheme())
  const [systemDark, setSystemDark] = useState(getSystemDark)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  const resolved: 'light' | 'dark' = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme
  const seasonClass = useSeasonClass()

  useEffect(() => {
    const root = document.documentElement
    root.classList.remove('light', 'dark')
    root.classList.add(resolved)
  }, [resolved])

  // The seasonal skin layers on top of light/dark rather than replacing it
  // (see src/seasonal). theme-init.js may have added it before first paint;
  // this keeps it in step with the season and the Settings switch.
  useEffect(() => {
    const root = document.documentElement
    for (const c of SEASON_CLASSES) if (c !== seasonClass) root.classList.remove(c)
    if (seasonClass) root.classList.add(seasonClass)
  }, [seasonClass])

  const setTheme = (t: Theme) => {
    storage.setItem(KEY, t)
    setThemeState(t)
  }

  return <Ctx.Provider value={{ theme, resolved, setTheme }}>{children}</Ctx.Provider>
}

export function useTheme() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
