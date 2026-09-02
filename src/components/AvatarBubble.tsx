import { cn, initials } from '@/lib/utils'

const sizes = {
  sm: 'h-7 w-7 text-[10px]',
  md: 'h-9 w-9 text-xs',
  lg: 'h-11 w-11 text-sm',
} as const

/**
 * A member's face in the team chat: their uploaded profile picture when they have
 * one, otherwise an initials bubble (the same style used on the dashboard).
 */
export function AvatarBubble({
  name,
  avatarUrl,
  size = 'md',
  className,
}: {
  name?: string | null
  avatarUrl?: string | null
  size?: keyof typeof sizes
  className?: string
}) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/10 font-semibold text-primary',
        sizes[size],
        className
      )}
    >
      {avatarUrl ? (
        <img src={avatarUrl} alt={name ? `${name}'s profile picture` : 'Profile picture'} className="h-full w-full object-cover" />
      ) : (
        initials(name)
      )}
    </span>
  )
}
