/**
 * The bat silhouette, shared by the background bats and the flying flocks:
 * pointed ears, a body, and scalloped wings drawn once and mirrored. Each wing
 * flaps from its shoulder (`.halloween-bat-wing` in halloween.css).
 *
 * Kept as a static string so the flocks can be created without React; it
 * contains no user data.
 */
const WING =
  'M53 19 C57 11 65 4 75 2 C84 1 93 5 98 12 C94 13 92 16 92 21 C88 18 83 18 80 22 C77 18 72 18 69 23 C66 19 61 20 58 25 C57 23 55 21 53 21 Z'

const BODY =
  'M45.5 15 L43.5 5.5 L48 11.5 C49.3 11 50.7 11 52 11.5 L56.5 5.5 L54.5 15 C56.5 17 57 21 56 25 C55.2 29 53 33 50 36 C47 33 44.8 29 44 25 C43 21 43.5 17 45.5 15 Z'

/** Width ÷ height of the drawing (its 100 × 64 viewBox), for sizing its box. */
export const BAT_ASPECT = 100 / 64

export const BAT_SVG =
  `<svg viewBox="0 -14 100 64" overflow="visible" aria-hidden="true" focusable="false"><g fill="currentColor">` +
  `<path class="halloween-bat-wing" d="${WING}"/>` +
  `<g transform="translate(100 0) scale(-1 1)"><path class="halloween-bat-wing" d="${WING}"/></g>` +
  `<path d="${BODY}"/></g></svg>`
