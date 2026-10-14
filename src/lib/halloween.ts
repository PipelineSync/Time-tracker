/**
 * Halloween theme (seasonal skin).
 *
 * Keeping the switch in one place means the whole spooky layer — the witch
 * hat on the logo, the pumpkin/purple/slime palette, and the bats and embers
 * — turns on and off together, and can be lifted out again after the season
 * without hunting through components.
 *
 * Set `VITE_HALLOWEEN_THEME=off` at build time to ship the plain brand skin.
 */
export function isHalloweenTheme(): boolean {
  return (import.meta.env.VITE_HALLOWEEN_THEME as string | undefined) !== 'off'
}
