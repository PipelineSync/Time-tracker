/**
 * Fresh USD → PHP rates from the rate providers, for **every** back end.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The rate used to be refreshed only by the scheduled `sync-fx-rate` Netlify
 * Function, which needs three things to be true: the deploy is on Netlify, the
 * function ran (or the browser could reach it), and the workspace is actually
 * connected to Supabase (`store.tsx` only asked for a refresh when Supabase was
 * configured). A **demo-mode** workspace — no `VITE_SUPABASE_*` at build time,
 * which is exactly what the sandbox preview runs — had `usd_php_rate: null`
 * forever and therefore sat on the bundled fallback (see `FALLBACK_USD_PHP_RATE`
 * in `./fx`). The chip then read the same `≈ ₱58.00` no matter how often the
 * page was reloaded: correct behaviour for "no server", useless for anyone
 * looking at it.
 *
 * So the provider list lives here, in one place, and is used by two callers:
 * the browser (which can fetch it directly — see `fetchFreshRate`) and the
 * scheduled function (`netlify/functions/sync-fx-rate.ts`, unchanged shape:
 * same providers, same order, same validation). Same sources either way, so a
 * demo workspace and a Supabase workspace show the same number on the same day.
 *
 * PROVIDER ORDER
 * --------------
 * Both are keyless and refresh **every** calendar day: ExchangeRate-API's open
 * endpoint firsts, then Frankfurter (the ECB basket, business days only) as the
 * fallback for when the primary is unreachable. Deliberately no key-bearing
 * provider here — anything in this file also runs in the browser, so a key
 * would ship in the bundle.
 *
 * The same pair lives in the function, which can additionally read the metered
 * `CURRENCYFREAKS_API_KEY` server-side. Keeping the list duplicated there is
 * intentional: that function must stay deployable with no import from `src/`.
 */

export interface RateProvider {
  name: string
  url: string
}

export interface FreshRate {
  /** Pesos per US dollar. Always finite and > 0. */
  rate: number
  /** The provider's own "as of" date, for the log line / tooltip. */
  date: string
  /** Which provider answered. */
  provider: string
}

/** Keyless, daily-refreshing sources, tried in order. */
export const RATE_PROVIDERS: RateProvider[] = [
  { name: 'exchangerate-api', url: 'https://open.er-api.com/v6/latest/USD' },
  { name: 'frankfurter', url: 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=PHP' },
]

/**
 * Pull the USD → PHP rate out of a provider payload. Returns `undefined` for
 * anything unusable (an error envelope, a missing PHP entry, a zero/NaN rate)
 * so the caller moves on to the next provider instead of writing junk.
 */
export function parseRatePayload(payload: unknown): { rate: number; date: string } | undefined {
  const p = payload as {
    result?: string
    date?: string
    rates?: Record<string, number | undefined>
    time_last_update_utc?: string
  }
  // ExchangeRate-API wraps failures in `result: "error"` with no rates.
  if (p?.result && p.result !== 'success') return undefined
  const rate = p?.rates?.PHP
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return undefined
  return { rate, date: p.date ?? p.time_last_update_utc ?? 'unknown' }
}

/**
 * Fetch a fresh rate from the first provider that answers with something
 * usable. Resolves `null` — never throws, never rejects — when every provider
 * fails or the network is unavailable, so callers can treat "no fresh rate" as
 * an ordinary outcome (keep the stored rate) rather than an error path.
 *
 * `fetchImpl` is injectable purely so the verification harness can exercise
 * the provider order, the error paths and the validation without a network.
 */
export async function fetchFreshRate(
  fetchImpl: typeof fetch = fetch
): Promise<FreshRate | null> {
  for (const provider of RATE_PROVIDERS) {
    try {
      const ac = typeof AbortController !== 'undefined' ? new AbortController() : null
      // A provider that hangs must not hold the sync open indefinitely.
      const timer = ac ? setTimeout(() => ac.abort(), 10_000) : null
      const response = await fetchImpl(provider.url, {
        headers: { accept: 'application/json' },
        signal: ac?.signal,
      })
      if (timer) clearTimeout(timer)
      if (!response.ok) continue
      const parsed = parseRatePayload(await response.json())
      if (!parsed) continue
      return { ...parsed, provider: provider.name }
    } catch {
      // Offline, blocked by CSP, DNS failure, aborted — all mean "try the next
      // provider", and finally "no fresh rate this time".
      continue
    }
  }
  return null
}
