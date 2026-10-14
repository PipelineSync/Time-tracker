import React from 'react'
import ReactDOM from 'react-dom/client'
import { Toaster } from 'sonner'
// Self-hosted Geist + Geist Mono (the PipelineSync brand faces). Self-hosting
// removes a render-blocking cross-origin stylesheet, works offline inside the
// PWA/native shells, and keeps the Content-Security-Policy at 'self' with no
// font exceptions.
import '@fontsource/geist-sans/400.css'
import '@fontsource/geist-sans/500.css'
import '@fontsource/geist-sans/600.css'
import '@fontsource/geist-sans/700.css'
import '@fontsource/geist-mono/400.css'
import '@fontsource/geist-mono/500.css'
import '@fontsource/geist-mono/600.css'
import { App } from './App'
import { StoreProvider } from '@/lib/store'
import { ThemeProvider } from '@/lib/theme'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { initNativeShell } from '@/lib/native'
import { isNativeShell } from '@/lib/platform'
import { installAudioUnlock } from '@/lib/sounds'
import { installSeason, SeasonLayer } from '@/seasonal'
import { AmbientBackground } from '@/components/AmbientBackground'
import { installCardSpotlight } from '@/lib/spotlight'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      {/* Outside StoreProvider on purpose: a crash in the provider itself
          (a bad row shape on boot) must land here, not in a white screen. */}
      <ErrorBoundary>
        <StoreProvider>
          <AmbientBackground />
          <App />
          <SeasonLayer />
          <Toaster position="top-center" richColors closeButton />
        </StoreProvider>
      </ErrorBoundary>
    </ThemeProvider>
  </React.StrictMode>
)

// PWA service worker — browser shells only. Native shells (Capacitor
// iOS/Android, Tauri desktop) already ship the bundle inside the app package
// and update through the stores, so a service worker there would only risk
// serving a stale build after an app update.
if (import.meta.env.PROD && !isNativeShell()) {
  void import('virtual:pwa-register').then(({ registerSW }) => {
    registerSW({ immediate: true })
  })
}

// Capacitor no-ops outside its WebView; hides the native splash once React is
// mounted and wires the status bar / Android back button.
void initNativeShell()

// Clock-in cues are synthesised, but no browser or WebView lets a page make a
// sound before the first real interaction. Arm the audio context on it, so the
// very first clock-in of a session is not silently swallowed.
installAudioUnlock()

// Seasonal extras (spooky sounds, treat milestones) — a no-op out of season.
installSeason()

// Cards light up around the cursor (fine pointers only, off for reduced motion).
installCardSpotlight()
