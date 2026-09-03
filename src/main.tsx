import React from 'react'
import ReactDOM from 'react-dom/client'
import { Toaster } from 'sonner'
import { App } from './App'
import { StoreProvider } from '@/lib/store'
import { ThemeProvider } from '@/lib/theme'
import { initNativeShell } from '@/lib/native'
import { isNativeShell } from '@/lib/platform'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <StoreProvider>
        <App />
        <Toaster position="top-center" richColors closeButton />
      </StoreProvider>
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
