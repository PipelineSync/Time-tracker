// Apply the saved theme before first paint so installed apps and dark
// mode never flash white on launch. Loaded as a plain (non-module, non-defer)
// script from <head> in index.html, so it runs synchronously before the
// bundle boots — same behaviour the inline script used to have, but in an
// external file so the app's Content-Security-Policy can stay at
// script-src 'self' with no 'unsafe-inline'.
;(function () {
  try {
    var stored = localStorage.getItem('wt_theme')
    var dark =
      stored === 'dark' ||
      (stored !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.classList.add(dark ? 'dark' : 'light')
    // Seasonal skin, applied before first paint so the spooky palette
    // never flashes in as the bundle boots: October only, unless this
    // device switched it off in Settings. The app re-checks on mount
    // (build flag VITE_HALLOWEEN_THEME included) — see src/seasonal.
    if (new Date().getMonth() === 9 && localStorage.getItem('wt_halloween') !== 'off') {
      document.documentElement.classList.add('halloween')
    }
  } catch (e) {
    /* private mode: default to light */
  }
})()
