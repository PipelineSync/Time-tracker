// Scheduled sync of the USD -> PHP reference rate, twice a day.
//
// WHY THIS IS SERVER-SIDE AT ALL
// ------------------------------
// Fetching the rate from the browser on the app's 15-second poll would mean
// ~5,760 requests per open tab per day for a value that only needs refreshing a
// couple of times a day. So: a few server-side calls a day, written to the
// `settings` row, and every tab picks it up on the settings read it already
// makes (see the tick-budget comment in src/lib/store.tsx). Net cost to the
// database: one write per run, zero extra client queries.
//
// WHY TWICE A DAY, AND WHY A KEYED PROVIDER (this was the bug)
// ------------------------------------------------------------
// This job used to read the ECB's reference rates via Frankfurter. The ECB only
// publishes on BUSINESS DAYS (~16:00 CET, weekdays), so that value does not
// move on weekends or holidays — and because the job ran at 00:00 UTC, even
// Monday morning still saw Friday's number. The result was a rate that visibly
// sat still from Saturday through Monday, i.e. "not updating".
//
// It then moved to ExchangeRate-API's keyless open endpoint, which republishes
// every calendar day and fixed the weekend freeze — but at exactly one refresh
// a day, with no way to go faster and no way to be told when the feed was down.
//
// The primary is now CurrencyFreaks (api.currencyfreaks.com), authenticated
// with CURRENCYFREAKS_API_KEY and read TWICE A DAY: 00:30 and 12:30 UTC, i.e.
// 8:30 AM and 8:30 PM in Manila. Two consequences worth knowing here:
//
//   * On their free plan the provider's own data refreshes once a day at
//     00:00 UTC, so the morning run is normally the one that picks up a new
//     number and the evening run confirms it. The evening run still earns its
//     place: it is what recovers a missed or failed morning run within 12 hours
//     instead of 24, and on a paid CurrencyFreaks plan (hourly on Starter,
//     every 10 minutes on Growth) it picks up intraday movement with no change
//     to this file.
//   * A keyed plan is metered — 1,000 requests a MONTH on the free tier, of
//     which two runs a day spend 60. The keyless feeds stay in the list as
//     fallbacks, so a bad key or a spent quota degrades to a slightly older
//     rate instead of to no rate, and the throttle below caps what anyone else
//     can spend through this endpoint.
//
// THE THROTTLE (which is what makes the endpoint safe to trigger by hand)
// ----------------------------------------------------------------------
// The app self-heals a missed cron by calling this endpoint from the browser
// (triggerFxSyncIfStale in src/lib/store.tsx), and the URL can be hit directly
// to refresh right after a deploy. A scheduled run cannot carry a user token,
// so the endpoint has to stay reachable without one — which means an anonymous
// stranger could otherwise poke it in a loop and spend the workspace's monthly
// quota. So every run first reads when it last wrote, and returns early if that
// was under MIN_REFRESH_INTERVAL_MS ago, without touching the provider at all.
// A caller in a loop therefore costs at most one provider request per interval
// (24h / 6h = 4 a day), however hard they push.
//
// Netlify runs this on the schedule in [functions."sync-fx-rate"] in
// netlify.toml. It writes with SUPABASE_SECRET_KEY (via adminClient), because a
// scheduled run has no user token and the settings table is RLS-locked to the
// admin. The rate itself is public reference data, so bypassing RLS here exposes
// nothing a client could not read from any currency site.

import { adminClient } from './lib/supabase'

/** A resolved rate plus a human-readable "as of" date for the log line. */
type ProviderResult = { rate: number; date: string }

/** How long to wait for a provider before treating it as down. */
const PROVIDER_TIMEOUT_MS = 10_000

/**
 * Shortest gap allowed between two provider calls. Kept well under the 12-hour
 * cron interval so the schedule is never throttled — this only absorbs
 * hand-triggered and self-heal traffic. See THE THROTTLE in the header.
 */
const MIN_REFRESH_INTERVAL_MS = 6 * 3_600_000

/** The CurrencyFreaks key, or '' when this deployment has none. Never logged. */
function apiKey(): string {
  return (process.env.CURRENCYFREAKS_API_KEY || '').trim()
}

/** Erase the key from anything about to go into a response or a log line. */
function redact(text: string): string {
  const key = apiKey()
  return key ? text.split(key).join('[api key]') : text
}

/**
 * CurrencyFreaks sends rate values as STRINGS ("58.1234") rather than JSON
 * numbers, so both spellings are accepted here. Anything that is not a positive
 * finite number is rejected, which hands the turn to the next provider instead
 * of writing junk into the ledger's reference conversions.
 */
function toRate(value: unknown): number | undefined {
  const rate = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(rate) || rate <= 0) return undefined
  return rate
}

/**
 * Rate providers, tried in order until one yields a usable PHP rate. Ordered
 * primary-first: the keyed feed the workspace configured, then keyless public
 * feeds, so a spent quota or a bad key still leaves a recent rate.
 */
const PROVIDERS: {
  name: string
  /** Returning undefined means "not configured here" — skipped, not a failure. */
  url: () => string | undefined
  parse: (payload: unknown) => ProviderResult | undefined
}[] = [
  {
    // CurrencyFreaks. `symbols=PHP` keeps the payload to one rate rather than
    // its ~1,000-currency dump, and no `base` param is sent because the free
    // plan is USD-base only — hence the base check in parse().
    // Shape: { base: "USD", date: "2026-09-15 00:02:00+00", rates: { PHP: "58.1234" } }
    name: 'currencyfreaks',
    url: () => {
      const key = apiKey()
      if (!key) return undefined
      const endpoint = new URL('https://api.currencyfreaks.com/v2.0/rates/latest')
      endpoint.searchParams.set('apikey', key)
      endpoint.searchParams.set('symbols', 'PHP')
      return endpoint.toString()
    },
    parse: (payload) => {
      const p = payload as { base?: string; date?: string; rates?: Record<string, unknown> }
      // Guard rather than assume: if this account ever gets a different
      // default base, the number in `rates.PHP` stops being pesos per US
      // dollar, and converting at the wrong rate is worse than not converting.
      if (p?.base && String(p.base).toUpperCase() !== 'USD') return undefined
      const rate = toRate(p?.rates?.PHP)
      if (rate === undefined) return undefined
      return { rate, date: p?.date ?? 'unknown' }
    },
  },
  {
    // ExchangeRate-API's open endpoint: no key, no quota, and it re-publishes
    // every calendar day (~00:00 UTC). Shape: { result: "success",
    // rates: { PHP: number, ... }, time_last_update_utc: string }.
    name: 'exchangerate-api',
    url: () => 'https://open.er-api.com/v6/latest/USD',
    parse: (payload) => {
      const p = payload as {
        result?: string
        rates?: Record<string, number | undefined>
        time_last_update_utc?: string
      }
      if (p?.result && p.result !== 'success') return undefined
      const rate = toRate(p?.rates?.PHP)
      if (rate === undefined) return undefined
      return { rate, date: p.time_last_update_utc ?? 'unknown' }
    },
  },
  {
    // Frankfurter republishes the ECB's ~30-currency basket (PHP is in it).
    // Business-day-only, so it is last in line — but a recent weekday rate
    // still beats writing nothing when both feeds above are unreachable.
    name: 'frankfurter',
    url: () => 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=PHP',
    parse: (payload) => {
      const p = payload as { date?: string; rates?: Record<string, number | undefined> }
      const rate = toRate(p?.rates?.PHP)
      if (rate === undefined) return undefined
      return { rate, date: p.date ?? 'unknown' }
    },
  },
]

/**
 * Pull the human-readable part out of a failed answer. CurrencyFreaks reports
 * errors as a 4xx with `{ timestamp, status, error, message, path }`; the keyless
 * feeds answer with whatever their proxy felt like, so a non-JSON body falls
 * back to the bare status.
 *
 * The two states worth naming out loud — an invalid key and a spent quota — are
 * only ever attributed to the keyed feed, because those are the failures that
 * otherwise read as "the rate is just not moving" and they are the two only the
 * workspace owner can fix.
 */
function describeHttpError(name: string, status: number, body: string): string {
  let message = ''
  try {
    const parsed = JSON.parse(body) as { message?: string; error?: string }
    message = (parsed.message || parsed.error || '').trim()
  } catch {
    /* non-JSON body — the status is all there is */
  }
  const detail = message ? ` ${message}` : ''
  if (name !== 'currencyfreaks') return `HTTP ${status}${detail}`
  if (status === 401) return `HTTP ${status}${detail} — check CURRENCYFREAKS_API_KEY in Netlify`
  // Their docs: past the plan's quota the API "stops serving your requests".
  if (status === 429) return `HTTP ${status}${detail} — monthly quota spent; falling back to a keyless feed`
  return `HTTP ${status}${detail}`
}

/**
 * When this job last wrote a rate, or null when it never has.
 *
 * Throws instead of reporting null on an error, because the caller has to tell
 * "never synced" (nothing to throttle, fetch away) apart from "the database
 * could not be read" (the throttle is not worth failing a sync over). A
 * column-not-found error is also how an unmigrated database shows up, and that
 * has to be reported as "run the migration" before paying for a provider fetch
 * whose write cannot land.
 */
async function lastSyncedAt(sb: ReturnType<typeof adminClient>): Promise<string | null> {
  const { data, error } = await sb
    .from('settings')
    .select('usd_php_rate_updated_at')
    .not('usd_php_rate_updated_at', 'is', null)
    .order('usd_php_rate_updated_at', { ascending: false })
    .limit(1)
  if (error) throw new Error(error.message || 'Could not read the last sync time.')
  const row = Array.isArray(data) ? (data[0] as { usd_php_rate_updated_at?: string } | undefined) : undefined
  return row?.usd_php_rate_updated_at ?? null
}

const NOT_MIGRATED =
  'The settings table has no usd_php_rate column. Run supabase/RUN-THIS-fx-rate.sql in the Supabase SQL editor, then retry.'

export default async function handler(_request: Request) {
  // One client for both the throttle read and the write, so a deployment
  // without the server credentials gets one clear message instead of two.
  let sb: ReturnType<typeof adminClient>
  try {
    sb = adminClient()
  } catch (error) {
    return new Response(
      `Supabase credentials are not configured: ${error instanceof Error ? error.message : 'unknown error'}`,
      { status: 500 },
    )
  }

  let lastSynced: string | null = null
  let canThrottle = true
  try {
    lastSynced = await lastSyncedAt(sb)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error'
    if (/usd_php_rate|column|42703/i.test(message)) {
      return new Response(NOT_MIGRATED, { status: 500 })
    }
    // A Supabase blip must not stop a sync: with no readable timestamp the
    // throttle is simply off, and a fresh rate is worth the extra call.
    canThrottle = false
  }

  if (canThrottle && lastSynced) {
    const ageMs = Date.now() - new Date(lastSynced).getTime()
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < MIN_REFRESH_INTERVAL_MS) {
      const mins = Math.round(ageMs / 60_000)
      const summary = `Already synced ${mins} minute${mins === 1 ? '' : 's'} ago, inside the ${Math.round(
        MIN_REFRESH_INTERVAL_MS / 3_600_000,
      )}h minimum between provider calls — the stored rate is left as it is.`
      console.log(`sync-fx-rate: ${summary}`)
      return new Response(summary)
    }
  }

  let result: (ProviderResult & { provider: string }) | undefined
  const failures: string[] = []
  let keyMissing = false

  for (const provider of PROVIDERS) {
    const url = provider.url()
    if (url === undefined) {
      if (provider.name === 'currencyfreaks') keyMissing = true
      continue
    }
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      })
      if (!response.ok) {
        failures.push(`${provider.name}: ${redact(describeHttpError(provider.name, response.status, await response.text()))}`)
        continue
      }
      const parsed = provider.parse(await response.json())
      // A missing or unusable PHP rate is a provider problem — move on to the
      // next provider rather than writing junk.
      if (!parsed) {
        failures.push(`${provider.name}: no usable PHP rate`)
        continue
      }
      result = { ...parsed, provider: provider.name }
      break
    } catch (error) {
      failures.push(`${provider.name}: ${redact(error instanceof Error ? error.message : 'unknown error')}`)
    }
  }

  // Every provider failed. Leave the previous rate in place rather than nulling
  // it, and say which providers failed and how.
  if (!result) {
    const why = failures.join('; ') || 'no rate provider is reachable'
    const hint = keyMissing ? ' CURRENCYFREAKS_API_KEY is not set in this deployment.' : ''
    return new Response(`Could not fetch a USD -> PHP rate. ${redact(why)}.${hint}`, { status: 502 })
  }

  const { rate, date: rateDate, provider } = result

  try {
    const { data, error } = await sb
      .from('settings')
      .update({ usd_php_rate: rate, usd_php_rate_updated_at: new Date().toISOString() })
      .select('id')

    if (error) {
      // Same "not migrated yet" diagnosis as the throttle read above, kept
      // here too because a read can succeed while the write is rejected.
      if (/usd_php_rate|column|42703/i.test(error.message || '')) {
        return new Response(NOT_MIGRATED, { status: 500 })
      }
      return new Response(`Could not save the rate: ${error.message}`, { status: 500 })
    }

    const updated = Array.isArray(data) ? data.length : 0
    const summary = `USD -> PHP = ${rate} (via ${provider}, provider date ${rateDate}) written to ${updated} workspace${
      updated === 1 ? '' : 's'
    }.`
    // A keyless fallback answering while the keyed primary sat unconfigured is
    // a misconfiguration worth saying out loud: the rate looks fine, but it is
    // not the feed the workspace asked for, so it moves once a day at 00:00 UTC
    // rather than on this 8:30/20:30 PHT schedule.
    if (keyMissing) {
      console.warn(`sync-fx-rate: ${summary} NOTE: used a keyless fallback — CURRENCYFREAKS_API_KEY is not set.`)
    } else {
      console.log(`sync-fx-rate: ${summary}`)
    }
    return new Response(summary)
  } catch (error) {
    return new Response(
      `Supabase credentials are not configured: ${error instanceof Error ? error.message : 'unknown error'}`,
      { status: 500 },
    )
  }
}
