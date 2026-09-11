import { ArrowLeftRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn, formatDate } from '@/lib/utils'
import { formatRate, usdPhpRate } from '@/lib/fx'
import type { Settings } from '@/lib/types'

/**
 * The "1 USD = ₱62.63" reference chip that sits on a page's title row.
 *
 * Renders `null` — taking up no space at all — whenever `usdPhpRate()` says
 * there is nothing to show: no settings loaded yet, or a workspace that does
 * not bill in USD. Nothing here fetches anything; the rate arrives on the
 * `settings` row the store already refreshes about once a minute.
 *
 * A synced rate is stated with `=`, the bundled fallback with `≈`, so a
 * workspace whose daily sync has not run yet is not shown a round placeholder
 * as though it were today's quote.
 */
export function RateChip({ settings, className }: { settings: Settings | null; className?: string }) {
  const fx = usdPhpRate(settings)
  if (!fx) return null

  const title = fx.isFallback
    ? `Reference rate, approximate. The daily sync has not written a rate for this workspace yet — deploy the sync-fx-rate function, or run supabase/RUN-THIS-fx-rate.sql and wait for its next 8:00 AM PHT run.`
    : `USD to PHP reference rate, synced ${fx.updatedAt ? formatDate(fx.updatedAt) : 'recently'}. Refreshed once a day; conversions are indicative, not a payment quote.`

  return (
    <Badge variant="muted" title={title} className={cn('gap-1.5 font-medium', className)}>
      <ArrowLeftRight className="h-3 w-3" aria-hidden="true" />
      <span>
        1 USD {fx.isFallback ? '≈' : '='} {formatRate(fx.rate)}
      </span>
    </Badge>
  )
}
