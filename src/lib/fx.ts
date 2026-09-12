import type { Settings } from './types'

/**
 * USD → PHP reference rate — the single source of truth for the whole app.
 *
 * The live value is refreshed once a day into `settings.usd_php_rate` by the
 * `sync-fx-rate` Netlify Function (see netlify.toml). This constant is only
 * the fallback for when that value is absent: a fresh Supabase database whose
 * cron has not run yet, or demo mode, which has no server to run it at all.
 *
 * It is deliberately a round, obviously-approximate number rather than a
 * plausible-looking precise one, so a stale fallback never reads as a live
 * quote. Bump it whenever you touch this file.
 */
export const FALLBACK_USD_PHP_RATE = 58

/** What one US dollar is worth, as a peso amount: 62.63 → "₱62.63". */
export function formatRate(rate: number): string {
  return new Intl.NumberFormat('en-PH', {
    style: 'currency',
    currency: 'PHP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(rate)
}

/**
 * A USD amount rendered in pesos, for the "≈ ₱1,158" sub-line under a figure
 * that is already shown in USD. Whole pesos on purpose: these are rounded
 * reference conversions, and cents would imply a precision the daily ECB rate
 * does not have.
 */
export function formatPhp(amount: number, rate: number): string {
  return new Intl.NumberFormat('en-PH', {
    style: 'currency',
    currency: 'PHP',
    maximumFractionDigits: 0,
  }).format(amount * rate)
}

export interface UsdPhpRate {
  /** Pesos per US dollar. Always > 0. */
  rate: number
  /** When the daily sync wrote it, or null when using the bundled fallback. */
  updatedAt: string | null
  /** True when the rate is the bundled fallback, not today's synced value. */
  isFallback: boolean
}

/**
 * The USD → PHP rate to display for this workspace, or `null` when nothing
 * should be shown at all.
 *
 * Returns null unless the workspace bills in USD. A workspace whose currency
 * is already PHP has no use for a USD → PHP figure, and one billing in EUR or
 * GBP would get a conversion of a currency it never uses — so in both cases
 * the chip and the sub-lines stay hidden and those screens look exactly as
 * they did before this feature existed.
 */
export function usdPhpRate(settings: Settings | null | undefined): UsdPhpRate | null {
  if (!settings) return null
  if (settings.currency !== 'USD') return null

  const synced = settings.usd_php_rate
  if (typeof synced === 'number' && Number.isFinite(synced) && synced > 0) {
    return { rate: synced, updatedAt: settings.usd_php_rate_updated_at ?? null, isFallback: false }
  }
  return { rate: FALLBACK_USD_PHP_RATE, updatedAt: null, isFallback: true }
}

/**
 * The "≈ ₱1,158" sub-line for a USD amount, or undefined when the workspace
 * has no USD → PHP rate to show. Passing the result straight to a StatCard's
 * optional `sub` prop means "no rate" renders exactly as it always did.
 */
export function phpEquivalent(amount: number, fx: UsdPhpRate | null): string | undefined {
  if (!fx) return undefined
  if (!Number.isFinite(amount)) return undefined
  return `≈ ${formatPhp(amount, fx.rate)}`
}
