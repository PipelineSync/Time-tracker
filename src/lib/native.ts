import { Capacitor } from '@capacitor/core'
import { StatusBar, Style } from '@capacitor/status-bar'
import { SplashScreen } from '@capacitor/splash-screen'
import { App } from '@capacitor/app'
import { Keyboard, KeyboardResize } from '@capacitor/keyboard'

/**
 * Native-shell bootstrap (Capacitor iOS / Android).
 *
 * Every call is a no-op outside a Capacitor WebView, so the plain web build
 * never touches these plugins. Keeps the phone chrome in sync with the
 * PipelineSync navy brand colour and makes the Android hardware back button
 * behave like a browser back button.
 */
export async function initNativeShell(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return

  try {
    // Navy status bar, light content, drawn over the WebView so the app's own
    // header can sit under the notch (we pad with env(safe-area-inset-top)).
    await StatusBar.setStyle({ style: Style.Dark })
    await StatusBar.setBackgroundColor({ color: '#06245B' })
    await StatusBar.setOverlaysWebView({ overlay: true })
  } catch {
    /* status bar plugin unavailable — cosmetic only */
  }

  try {
    // Resize the WebView body when the soft keyboard opens so dialogs and the
    // clock form stay visible above it instead of being covered.
    await Keyboard.setResizeMode({ mode: KeyboardResize.Body })
  } catch {
    /* cosmetic only */
  }

  try {
    // Android hardware back = router back; on the root view it minimises the
    // app the way a native app would. The event carries `canGoBack`.
    await App.addListener('backButton', async ({ canGoBack }) => {
      if (canGoBack) {
        window.history.back()
        return
      }
      await App.minimizeApp().catch(() => undefined)
    })
  } catch {
    /* iOS / web: no hardware back button */
  }

  try {
    // Hand over from the native splash screen once React has mounted.
    await SplashScreen.hide()
  } catch {
    /* ignore */
  }
}
