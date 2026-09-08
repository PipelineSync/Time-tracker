/**
 * Christmas theme (seasonal skin).
 *
 * Keeping the switch in one place means the whole festive layer — the Santa
 * hat on the logo, the red/green palette, and the falling snow — turns on and
 * off together, and can be lifted out again after the season without hunting
 * through components.
 *
 * Set `VITE_CHRISTMAS_THEME=off` at build time to ship the normal brand skin.
 */
export function isChristmasTheme(): boolean {
  return (import.meta.env.VITE_CHRISTMAS_THEME as string | undefined) !== 'off'
}
