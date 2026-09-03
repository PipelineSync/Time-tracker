import { useCallback, useEffect, useState } from 'react'
import { isStandalonePwa, onAppInstalled, onInstallPrompt, type InstallPromptEvent } from './platform'

/**
 * Bridges the browser's PWA install prompt (Chrome / Edge on desktop and
 * Android). Safari on iOS never fires `beforeinstallprompt`, so on that
 * platform `canPrompt` stays false and the UI shows the
 * Share → Add to Home Screen instructions instead.
 */
export function useInstallPrompt() {
  const [deferred, setDeferred] = useState<InstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState<boolean>(() => isStandalonePwa())

  useEffect(() => {
    const offPrompt = onInstallPrompt((e) => {
      // The event must be prevented to keep it around for our own button.
      e.preventDefault()
      setDeferred(e)
    })
    const offInstalled = onAppInstalled(() => {
      setInstalled(true)
      setDeferred(null)
    })
    return () => {
      offPrompt()
      offInstalled()
    }
  }, [])

  const promptInstall = useCallback(async (): Promise<'accepted' | 'dismissed' | 'unavailable'> => {
    if (!deferred) return 'unavailable'
    await deferred.prompt()
    const choice = await deferred.userChoice
    setDeferred(null)
    if (choice.outcome === 'accepted') setInstalled(true)
    return choice.outcome
  }, [deferred])

  return { canPrompt: deferred !== null, installed, promptInstall }
}
