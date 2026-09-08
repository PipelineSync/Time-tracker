import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Theme } from './types'
import { storage } from './storage'
import { isChristmasTheme } from './christmas'

const KEY = 'wt_theme'

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

  useEffect(() => {
    const root = document.documentElement
    root.classList.remove('light', 'dark')
    root.classList.add(resolved)
    // The seasonal skin layers on top of light/dark rather than replacing it,
    // so both `.christmas` and `.christmas.dark` are meaningful.
    root.classList.toggle('christmas', isChristmasTheme())
  }, [resolved])

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
