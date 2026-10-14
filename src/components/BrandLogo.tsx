import { useTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { SeasonLogoHat } from '@/seasonal'

/**
 * PipelineSync brand lockup. Uses the white/orange variant on the dark
 * sidebar, otherwise auto-picks light/dark to match the active theme.
 *
 * A seasonal skin may dress the mark (a witch hat at Halloween); see
 * src/seasonal.
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
      <SeasonLogoHat dark={useDark} />
    </span>
  )
}
