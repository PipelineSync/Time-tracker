import React from 'react'
import ReactDOM from 'react-dom/client'
import { Toaster } from 'sonner'
// Self-hosted Inter (the same face and weights 400–800 the app used to load
// from Google Fonts). Self-hosting removes a render-blocking cross-origin
// stylesheet, works offline inside the PWA/native shells, and keeps the
// Content-Security-Policy at 'self' with no font exceptions.
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/inter/800.css'
import { App } from './App'
import { StoreProvider } from '@/lib/store'
import { ThemeProvider } from '@/lib/theme'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { initNativeShell } from '@/lib/native'
import { isNativeShell } from '@/lib/platform'
import { isChristmasTheme } from '@/lib/christmas'
import { Snowfall } from '@/components/Snowfall'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      {/* Outside StoreProvider on purpose: a crash in the provider itself
          (a bad row shape on boot) must land here, not in a white screen. */}
      <ErrorBoundary>
        <StoreProvider>
          <App />
          {isChristmasTheme() && <Snowfall />}
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
