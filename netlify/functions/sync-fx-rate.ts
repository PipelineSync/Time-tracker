// Scheduled daily sync of the USD -> PHP reference rate.
//
// WHY THIS IS SERVER-SIDE AND DAILY
// ---------------------------------
// Fetching the rate from the browser on the app's 15-second poll would mean
// ~5,760 requests per open tab per day for a value that only needs refreshing
// once a day. So: one server-side call a day, written to the `settings` row,
// and every tab picks it up on the settings read it already makes (see the
// tick-budget comment in src/lib/store.tsx). Net cost to the database: one
// write per day, zero extra client queries.
//
// WHY A CALENDAR-DAILY PROVIDER (this was the bug)
// ------------------------------------------------
// This job used to read the ECB's reference rates via Frankfurter. The ECB
// only publishes on BUSINESS DAYS (~16:00 CET, weekdays), so that value does
// not move on weekends or holidays — and because this job runs at 00:00 UTC,
// even Monday morning still saw Friday's number (Monday's ECB rate isn't out
// until Monday afternoon). The result was a rate that visibly sat still from
// Saturday through Monday, i.e. "not updating every day".
//
// The fix: read from a provider that refreshes EVERY calendar day. The
// primary is ExchangeRate-API's open endpoint (open.er-api.com): no API key,
// no quota for a once-a-day call, PHP included, and it re-publishes every 24h
// (see its `time_next_update_utc`). Frankfurter is kept as a fallback so a
// provider outage still leaves us with a recent rate rather than none.
//
// Netlify runs this on a schedule — see [functions."sync-fx-rate"] in
// netlify.toml. It runs at 00:30 UTC, just after open.er-api.com's ~00:00 UTC
// daily refresh, so each run picks up that day's fresh value. Hitting the
// function's URL by hand also works, for an immediate refresh after a deploy.
//
// Writes with SUPABASE_SECRET_KEY (via adminClient), because a scheduled run
// has no user token and the settings table is RLS-locked to the admin. The
// rate itself is public reference data, so bypassing RLS here exposes nothing
// a client could not read from any currency site.

import { adminClient } from './lib/supabase'

/** A resolved rate plus a human-readable "as of" date for the log line. */
type ProviderResult = { rate: number; date: string }

/**
 * Rate providers, tried in order until one yields a usable PHP rate. Ordered
 * primary-first: a source that updates every calendar day, then the ECB feed
 * as a fallback for when the primary is unreachable.
 */
const PROVIDERS: {
  name: string
  url: string
  parse: (payload: unknown) => ProviderResult | undefined
}[] = [
  {
    // ExchangeRate-API open endpoint. Refreshes once every 24h, every day of
    // the week — no key required. Shape: { rates: { PHP: number, ... },
    // time_last_update_utc: string, result: "success" }.
    name: 'exchangerate-api',
    url: 'https://open.er-api.com/v6/latest/USD',
    parse: (payload) => {
      const p = payload as {
        result?: string
        rates?: Record<string, number | undefined>
        time_last_update_utc?: string
      }
      if (p?.result && p.result !== 'success') return undefined
      const rate = p?.rates?.PHP
      if (typeof rate !== 'number') return undefined
      return { rate, date: p.time_last_update_utc ?? 'unknown' }
    },
  },
  {
    // Frankfurter republishes the ECB's ~30-currency basket (PHP is in it).
    // Business-day-only, so it is the fallback, not the primary — but a recent
    // weekday rate still beats writing nothing when the primary is down.
    name: 'frankfurter',
    url: 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=PHP',
    parse: (payload) => {
      const p = payload as { date?: string; rates?: Record<string, number | undefined> }
      const rate = p?.rates?.PHP
      if (typeof rate !== 'number') return undefined
      return { rate, date: p.date ?? 'unknown' }
    },
  },
]

export default async function handler(_request: Request) {
  let result: ProviderResult | undefined
  const failures: string[] = []

  for (const provider of PROVIDERS) {
    try {
      const response = await fetch(provider.url, { headers: { accept: 'application/json' } })
      if (!response.ok) {
        failures.push(`${provider.name}: HTTP ${response.status}`)
        continue
      }
      const parsed = provider.parse(await response.json())
      // A missing or non-finite PHP rate is a provider problem — move on to the
      // next provider rather than writing junk.
      if (!parsed || !Number.isFinite(parsed.rate) || parsed.rate <= 0) {
        failures.push(`${provider.name}: no usable PHP rate`)
        continue
      }
      result = parsed
      break
    } catch (error) {
      failures.push(`${provider.name}: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
  }

  // Every provider failed. Leave the previous rate in place rather than nulling
  // it, and say which providers failed and how.
  if (!result) {
    return new Response(`Could not fetch a USD -> PHP rate. ${failures.join('; ')}.`, { status: 502 })
  }

  const { rate, date: rateDate } = result

  try {
    const sb = adminClient()
    const { data, error } = await sb
      .from('settings')
      .update({ usd_php_rate: rate, usd_php_rate_updated_at: new Date().toISOString() })
      .select('id')

    if (error) {
      // The overwhelmingly likely cause: RUN-THIS-fx-rate.sql has not been run
      // on this project yet, so the columns do not exist. Say so plainly
      // instead of surfacing a raw Postgres message.
      if (/usd_php_rate|column|42703/i.test(error.message || '')) {
        return new Response(
          'The settings table has no usd_php_rate column. Run supabase/RUN-THIS-fx-rate.sql in the Supabase SQL editor, then retry.',
          { status: 500 },
        )
      }
      return new Response(`Could not save the rate: ${error.message}`, { status: 500 })
    }

    const updated = Array.isArray(data) ? data.length : 0
    const summary = `USD -> PHP = ${rate} (provider date ${rateDate}) written to ${updated} workspace${updated === 1 ? '' : 's'}.`
    console.log(`sync-fx-rate: ${summary}`)
    return new Response(summary)
  } catch (error) {
    return new Response(
      `Supabase credentials are not configured: ${error instanceof Error ? error.message : 'unknown error'}`,
      { status: 500 },
    )
  }
}
