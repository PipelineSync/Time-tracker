import type { LucideIcon } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

export function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  loading,
  className,
  accent,
}: {
  label: string
  value: string
  sub?: string
  icon?: LucideIcon
  loading?: boolean
  className?: string
  accent?: boolean
}) {
  return (
    <Card className={cn('ps-card-lift rounded-2xl', accent && 'border-brand/40 bg-brand/5', className)}>
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div className="space-y-1.5">
            <p className="ps-label">{label}</p>
            {loading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <p className="text-2xl font-semibold tracking-[-0.02em] tabular-nums">{value}</p>
            )}
            {sub && <p className="font-mono text-xs text-muted-foreground">{sub}</p>}
          </div>
          {Icon && (
            <div className="ps-icon-tile h-10 w-10 sm:h-[46px] sm:w-[46px]">
              <Icon className="h-5 w-5" />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
