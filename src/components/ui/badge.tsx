import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  // Tinted mono chips: text in the colour, ~10% fill, ~30% border.
  'inline-flex items-center rounded-full border px-2.5 py-0.5 font-mono text-[11.5px] font-medium transition-colors focus:outline-none',
  {
    variants: {
      variant: {
        default: 'border-brand/30 bg-brand/10 text-brand-2',
        secondary: 'border-[var(--line-2)] bg-[var(--surface-2)] text-foreground',
        destructive: 'border-red-500/35 bg-red-500/10 text-red-700 dark:text-red-400',
        outline: 'border-[var(--line-2)] text-foreground',
        success: 'border-ps-green/35 bg-ps-green/10 text-ps-green',
        muted: 'border-[var(--line)] bg-muted text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  }
)

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
