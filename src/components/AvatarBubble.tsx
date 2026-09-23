import { cn, initials } from '@/lib/utils'
import { workerColorStyles } from '@/lib/types'

const sizes = {
  sm: 'h-7 w-7 text-[10px]',
  md: 'h-9 w-9 text-xs',
  lg: 'h-11 w-11 text-sm',
} as const

/**
 * A member's avatar bubble: uploaded profile picture or initials, with an
 * optional coloured ring reflecting their worker colour tag.
 */
export function AvatarBubble({
  name,
  avatarUrl,
  color,
  size = 'md',
  className,
}: {
  name?: string | null
  avatarUrl?: string | null
  color?: string | null
  size?: keyof typeof sizes
  className?: string
}) {
  const style = workerColorStyles(color)

  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/10 font-semibold text-primary transition-all',
        sizes[size],
        className
      )}
      style={
        style
          ? {
              boxShadow: `0 0 0 1.5px hsl(var(--background)), 0 0 0 3px ${style.chart}99`,
            }
          : undefined
      }
      title={name ? `${name}${color ? ` (${color})` : ''}` : undefined}
    >
      {avatarUrl ? (
        <img src={avatarUrl} alt={name ? `${name}'s profile picture` : 'Profile picture'} className="h-full w-full object-cover" />
      ) : (
        initials(name)
      )}
    </span>
  )
}
