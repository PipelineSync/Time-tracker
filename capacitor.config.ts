import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Capacitor turns the built web app (dist/) into native iOS and Android
 * projects. The native projects live in `ios/` and `android/` and are
 * committed so CI can sign and ship them without regenerating anything.
 *
 *   npm run build            # build dist/
 *   npx cap sync             # copy dist/ + plugins into ios/ & android/
 *   npx cap open ios         # Xcode (macOS only) — archive & upload
 *   npx cap open android     # Android Studio — run / generate signed bundle
 *
 * See docs/APPS.md for signing + store submission steps.
 */
const config: CapacitorConfig = {
  appId: 'com.pipelinesync.worktracker',
  appName: 'PipelineSync',
  webDir: 'dist',
  // Serve the WebView over https so localStorage, crypto and cookies behave
  // exactly like the production web app (Android only; iOS is capacitor://).
  server: {
    androidScheme: 'https',
  },
  plugins: {
    SplashScreen: {
      // React hides the splash itself (src/lib/native.ts) once mounted, so a
      // slow first paint never gets cut off by a timer.
      launchShowDuration: 0,
      launchAutoHide: false,
      backgroundColor: '#06245B',
      showSpinner: false,
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      splashFullScreen: true,
      splashImmersive: true,
    },
    StatusBar: {
      // Light content on the PipelineSync navy bar; the WebView paints under
      // it and the app pads with env(safe-area-inset-top).
      style: 'DARK',
      backgroundColor: '#06245B',
      overlaysWebView: true,
    },
  },
  ios: {
    // Keep content out from under the home indicator / notch by default.
    contentInset: 'always',
    scheme: 'capacitor',
  },
  android: {
    allowMixedContent: false,
    // Release builds should not expose WebView debugging.
    webContentsDebuggingEnabled: false,
  },
}

export default config
