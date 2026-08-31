import React from 'react'
import ReactDOM from 'react-dom/client'
import { Toaster } from 'sonner'
import { App } from './App'
import { StoreProvider } from '@/lib/store'
import { ThemeProvider } from '@/lib/theme'
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
