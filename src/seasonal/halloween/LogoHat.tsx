import { WitchHat } from './WitchHat'

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
 * A witch hat tilted over the logo's "S" mark. Rendered inside BrandLogo's
 * relatively-positioned wrapper; everything is a fraction of the logo's
 * rendered height, so the hat tracks the logo at every size.
 */
export function LogoHat({ dark }: { dark: boolean }) {
  const mark = dark ? MARK.dark : MARK.light
  const hatTop = mark.top + BRIM_OVERLAP - BRIM_BOTTOM_IN_VIEWBOX * HAT_SIZE
  const hatLeft = mark.left + 0.005
  return (
    // A square anchor box whose side equals the logo's HEIGHT: offsets in it
    // are height-relative, which matters because the two lockups have
    // different aspect ratios (width-relative offsets would drift).
    <span className="pointer-events-none absolute left-0 top-0 aspect-square h-full">
      <WitchHat
        className="absolute -rotate-[14deg] drop-shadow-sm"
        style={{
          top: `${hatTop * 100}%`,
          left: `${hatLeft * 100}%`,
          width: `${HAT_SIZE * 100}%`,
          height: `${HAT_SIZE * 100}%`,
          // Pivot on the brim so the tilt swings the cap over without walking
          // the brim off the mark.
          transformOrigin: '50% 94%',
        }}
      />
    </span>
  )
}
