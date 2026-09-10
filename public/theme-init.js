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
    // Seasonal skin, applied before first paint so the festive palette
    // never flashes in as the bundle boots. This pre-paint hint is
    // always added; if the build disabled the theme
    // (VITE_CHRISTMAS_THEME=off) the app removes the class on mount —
    // see src/lib/theme.tsx.
    document.documentElement.classList.add('christmas')
  } catch (e) {
    /* private mode: default to light */
  }
})()
