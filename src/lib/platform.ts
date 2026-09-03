/**
 * Runtime shell detection.
 *
 * The same React bundle ships in four shells:
 *   1. plain browser tab        — BrowserRouter + service worker (PWA)
 *   2. installed PWA            — same as (1), `display-mode: standalone`
 *   3. Capacitor native app     — iOS / Android WebView (capacitor:// or https://localhost)
 *   4. Tauri desktop app        — Windows / macOS / Linux webview (tauri://localhost)
 *
 * Native shells (3, 4) need two behaviour changes: hash-based routing (their
 * webviews resolve `/entries` to a file that does not exist, so a reload or a
 * deep link would 404 with BrowserRouter) and no service worker (the OS
 * already caches the app bundle; a SW would serve stale builds after an
 * app-store update).
 */

/** True inside a Capacitor iOS/Android WebView. */
export function isCapacitorNative(): boolean {
  const w = window as unknown as {
    Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string }
  }
  if (w.Capacitor?.isNativePlatform) return w.Capacitor.isNativePlatform()
  return /^(capacitor|https):\/\/localhost$/.test(window.location.href) && !!w.Capacitor
}

/** True inside a Tauri desktop window (Windows / macOS / Linux). */
export function isTauri(): boolean {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown }
  return Boolean(w.__TAURI_INTERNALS__ ?? w.__TAURI__) || window.location.protocol === 'tauri:'
}

/** Any packaged native shell (Capacitor or Tauri). */
export function isNativeShell(): boolean {
  return isCapacitorNative() || isTauri()
}

/** True when running as an installed PWA (home-screen / desktop installed). */
export function isStandalonePwa(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean }
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: window-controls-overlay)').matches ||
    nav.standalone === true
  )
}

export type PlatformKind = 'ios' | 'android' | 'macos' | 'windows' | 'linux' | 'web'

/** Coarse OS family, used to show the right install instructions. */
export function platformKind(): PlatformKind {
  if (isCapacitorNative()) {
    const w = window as unknown as { Capacitor?: { getPlatform?: () => string } }
    const p = w.Capacitor?.getPlatform?.()
    if (p === 'ios') return 'ios'
    if (p === 'android') return 'android'
  }
  if (isTauri()) {
    const ua = navigator.userAgent
    if (/Macintosh|Mac OS X/.test(ua)) return 'macos'
    if (/Windows/.test(ua)) return 'windows'
    return 'linux'
  }
  const ua = navigator.userAgent
  // iPadOS 13+ lies and reports as Macintosh; touch support reveals the truth.
  if (/iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios'
  if (/Android/.test(ua)) return 'android'
  if (/Macintosh|Mac OS X/.test(ua)) return 'macos'
  if (/Windows/.test(ua)) return 'windows'
  if (/Linux/.test(ua)) return 'linux'
  return 'web'
}

export const PLATFORM_LABEL: Record<PlatformKind, string> = {
  ios: 'iPhone / iPad',
  android: 'Android',
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
  web: 'Browser',
}

/**
 * Captures the browser's PWA install prompt (Chrome/Edge desktop + Android).
 * Safari on iOS never fires this — users install via Share → Add to Home
 * Screen, so the UI falls back to instructions on that platform.
 */
export interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

export function onInstallPrompt(handler: (e: InstallPromptEvent) => void): () => void {
  const listener = (e: Event) => handler(e as InstallPromptEvent)
  window.addEventListener('beforeinstallprompt', listener)
  return () => window.removeEventListener('beforeinstallprompt', listener)
}

/** Fires when the PWA has actually been installed from the browser. */
export function onAppInstalled(handler: () => void): () => void {
  const listener = () => handler()
  window.addEventListener('appinstalled', listener)
  return () => window.removeEventListener('appinstalled', listener)
}
