# Halloween seasonal skin

Everything Halloween lives in this folder. The app reaches it only through
`src/seasonal/index.ts`.

## What it adds

| Feature | Where |
| --- | --- |
| Pumpkin/purple/slime palette | `halloween.css` (top) |
| Witch hat on the logo | `LogoHat.tsx`, `WitchHat.tsx` |
| Rising embers behind the app | `HalloweenLayer.tsx` |
| Flickering pumpkin "on the clock" dot | `PumpkinDot.tsx` |
| Cobwebs (page corner + sidebar corner) | `Cobweb.tsx` |
| Ember trail behind the mouse (desktop only) | `HalloweenLayer.tsx` (`useCursorSparks`) |
| Candy-corn stripes on progress bars | `halloween.css` (`.ps-progress-fill`) |
| Ghost floating up on clock-out | `HalloweenLayer.tsx` (`useClockOutGhost`) |
| Spooky clock sounds + organ chord on task completion | `sounds.ts` |
| Settings → Appearance switch | `index.tsx` (`SeasonSettings`) |

All motion stops for `prefers-reduced-motion`. Decorations never take clicks.

## Turning it off

- **Automatically:** with no build flag it only runs in October (viewer's
  local date), so it disappears by itself on November 1. No deploy needed.
- **For one device:** Settings → Appearance → *Halloween decorations*.
- **For everyone:** build with `VITE_HALLOWEEN_THEME=off`. Use `on` to force it
  outside October.

## Removing it for good

1. In `src/seasonal/index.ts`, change `export * from './halloween'` to
   `export * from './none'`.
2. Delete this folder.
3. In `public/theme-init.js`, delete the seasonal `if (…) classList.add('halloween')`
   block.

That's it. The app keeps working with no seasonal code.

## Swapping in another season

Create a sibling folder (e.g. `src/seasonal/christmas/`) whose `index.tsx`
exports the same names as `src/seasonal/none.tsx`, then point
`src/seasonal/index.ts` at it.
