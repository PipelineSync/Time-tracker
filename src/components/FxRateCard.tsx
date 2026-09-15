import { useState } from 'react'
import { useStore } from '@/lib/store'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ArrowLeftRight, RefreshCw } from 'lucide-react'
import { formatRate, usdPhpRate } from '@/lib/fx'
import { cn, formatDateTime } from '@/lib/utils'

/**
 * Settings → General → **USD → PHP reference rate**.
 *
 * Not decoration: it is the control for the number the Dashboard and Clock In
 * screens print. It says where the shown rate came from (synced, or the bundled
 * approximate fallback), when it was last written, and — the point of the card
 * — gives the admin a **Refresh now** button that fetches from the rate
 * provider in this browser and saves it to the workspace through the normal
 * `saveSettings` path.
 *
 * That browser-side refresh is what makes the rate work in **demo mode**, which
 * has no server and therefore never received a scheduled sync: before this
 * card, a demo workspace was stuck on the bundled fallback for good. Under
 * Supabase the scheduled function still runs and the app still self-heals a
 * stale rate in the background — this is the manual override, and the only way
 * to see the fetch fail with a reason instead of silently doing nothing.
 *
 * Rendered only for an admin (or a worker holding `settings.manage`) of a USD
 * workspace: with no USD→PHP figure on screen there is nothing to control.
 */
export function FxRateCard({ className }: { className?: string }) {
  const { settings, saveSettings } = useStore()
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fx = usdPhpRate(settings)
  // A PHP/EUR/GBP workspace never shows a USD→PHP figure anywhere, so the
  // control for it would be noise.
  if (!fx) return null

  async function refresh() {
    setRefreshing(true)
    setError(null)
    try {
      // Imported on click: the parsers and provider list are tiny, but this
      // keeps them out of the initial bundle for the 99% of sessions that never
      // open Settings → General.
      const { fetchFreshRate } = await import('@/lib/fxRate')
      const fresh = await fetchFreshRate()
      if (!fresh) {
        setError(
          'Could not reach a rate provider from this browser. Your workspace keeps the rate it already has.'
        )
        return
      }
      const saved = await saveSettings({
        usd_php_rate: fresh.rate,
        usd_php_rate_updated_at: new Date().toISOString(),
      })
      if (!saved) {
        setError('The new rate could not be saved to this workspace.')
        return
      }
      // `settings` in the store is what every screen reads, so the chip changes
      // as soon as this resolves — no reload needed.
    } catch {
      setError('Could not refresh the rate. Check your connection and try again.')
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className={cn('flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between', className)}>
      <div className="space-y-1">
        <p className="flex items-center gap-2 font-medium">
          <ArrowLeftRight className="h-4 w-4" /> USD → PHP reference rate
        </p>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="muted" className="gap-1 font-medium">
            1 USD {fx.isFallback ? '≈' : '='} {formatRate(fx.rate)}
          </Badge>
          <span>
            {fx.isFallback
              ? 'Bundled approximate rate — no live rate has been saved for this workspace yet.'
              : `Synced ${fx.updatedAt ? formatDateTime(fx.updatedAt) : 'recently'}.`}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Shown on the Dashboard and Clock In screens. Indicative only — earnings are still stored and paid in{' '}
          {settings?.currency || 'USD'}.
        </p>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
      <Button type="button" variant="outline" onClick={refresh} disabled={refreshing} className="shrink-0">
        <RefreshCw className={cn('mr-1 h-4 w-4', refreshing && 'animate-spin')} />
        {refreshing ? 'Refreshing…' : 'Refresh now'}
      </Button>
    </div>
  )
}
