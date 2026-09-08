import { useTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { SantaHat } from '@/components/SantaHat'
import { isChristmasTheme } from '@/lib/christmas'

/**
 * Where the "S" mark sits inside each logo file, measured from the artwork
 * itself and expressed as a fraction of the image's HEIGHT. The two lockups
 * are exported with different padding (the dark one has noticeably more), so
 * a single offset would put the hat in the right place on one and the wrong
 * place on the other.
 */
const MARK = {
  light: { left: 0.014, top: 0.005 },
  dark: { left: 0.083, top: 0.075 },
} as const

/** Hat height, as a fraction of the logo height. */
const HAT_SIZE = 0.62
/** How far the brim overlaps down onto the mark (fraction of logo height). */
const BRIM_OVERLAP = 0.27
/** The brim's bottom edge sits at y=94/100 in the hat's viewBox. */
const BRIM_BOTTOM_IN_VIEWBOX = 0.94

/**
 * PipelineSync brand lockup. Uses the white/orange variant on navy
 * backgrounds, otherwise auto-picks light/dark to match the active theme.
 *
 * While the Christmas theme is on, a Santa hat is tilted over the "S" mark so
 * the logo itself looks like it is wearing it. Everything is sized as a
 * fraction of the logo's rendered height, so the hat tracks the logo at every
 * size it appears at (sidebar, mobile header, sign-in card).
 */
export function BrandLogo({
  className,
  onNavy = false,
}: {
  className?: string
  onNavy?: boolean
}) {
  const { resolved } = useTheme()
  const useDark = onNavy || resolved === 'dark'
  const festive = isChristmasTheme()

  const mark = useDark ? MARK.dark : MARK.light
  // Place the hat so its brim lands just over the top of the mark.
  const hatTop = mark.top + BRIM_OVERLAP - BRIM_BOTTOM_IN_VIEWBOX * HAT_SIZE
  const hatLeft = mark.left + 0.005

  return (
    // Height comes from the logo image, so the hat's percentage-based
    // size/offsets scale with whatever height the logo is rendered at.
    <span className="relative inline-block leading-none">
      <img
        src={useDark ? '/brand/pipelinesync-logo-dark.png' : '/brand/pipelinesync-logo-light.png'}
        alt="PipelineSync"
        className={cn('block h-7 w-auto select-none', className)}
        draggable={false}
      />
      {festive && (
        // A square anchor box whose side equals the logo's HEIGHT: offsets in
        // it are height-relative, which matters because the two lockups have
        // different aspect ratios (width-relative offsets would drift).
        <span className="pointer-events-none absolute left-0 top-0 aspect-square h-full">
          <SantaHat
            className="absolute -rotate-[20deg] drop-shadow-sm"
            style={{
              top: `${hatTop * 100}%`,
              left: `${hatLeft * 100}%`,
              width: `${HAT_SIZE * 100}%`,
              height: `${HAT_SIZE * 100}%`,
              // Pivot on the brim (its spot in the hat's viewBox) so the tilt
              // swings the cap over without walking the brim off the mark.
              transformOrigin: '50% 94%',
            }}
          />
        </span>
      )}
    </span>
  )
}
