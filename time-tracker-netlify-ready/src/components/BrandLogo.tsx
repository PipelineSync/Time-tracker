import { useTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'

/**
 * PipelineSync brand lockup. Uses the white/orange variant on navy
 * backgrounds, otherwise auto-picks light/dark to match the active theme.
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
    <img
      src={useDark ? '/brand/pipelinesync-logo-dark.png' : '/brand/pipelinesync-logo-light.png'}
      alt="PipelineSync"
      className={cn('h-7 w-auto select-none', className)}
      draggable={false}
    />
  )
}
