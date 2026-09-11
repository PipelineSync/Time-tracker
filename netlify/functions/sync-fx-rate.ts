// Scheduled daily sync of the USD -> PHP reference rate.
//
// WHY THIS IS SERVER-SIDE AND DAILY
// ---------------------------------
// The rate comes from the ECB's reference rates via Frankfurter, which
// republishes once per business day (~16:00 CET, weekdays only). Fetching it
// from the browser on the app's 15-second poll would mean ~5,760 requests per
// open tab per day for a value that changes ~250 times a year — and would put
// an API key in the client bundle. So: one server-side call a day, written to
// the `settings` row, and every tab picks it up on the settings read it
// already makes (see the tick-budget comment in src/lib/store.tsx). Net cost
// to the database: one write per day, zero extra client queries.
//
// Netlify runs this on a schedule — see [functions."sync-fx-rate"] in
// netlify.toml ("@daily" = 00:00 UTC = 8:00 AM PHT, the same slot the
// supabase-keepalive ping already uses). Hitting the function's URL by hand
// also works, for an immediate refresh after a deploy.
//
// Writes with SUPABASE_SECRET_KEY (via adminClient), because a scheduled run
// has no user token and the settings table is RLS-locked to the admin. The
// rate itself is public reference data, so bypassing RLS here exposes nothing
// a client could not read from any currency site.

import { adminClient } from './lib/supabase'

const FX_URL = 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=PHP'

/** Frankfurter answers with the ECB's ~30-currency basket; PHP is in it. */
type FrankfurterLatest = {
  base?: string
  date?: string
  rates?: Record<string, number | undefined>
}

export default async function handler(_request: Request) {
  let rate: number | undefined
  let rateDate: string | undefined

  try {
    const response = await fetch(FX_URL, { headers: { accept: 'application/json' } })
    if (!response.ok) {
      return new Response(`Rate provider returned HTTP ${response.status}.`, { status: 502 })
    }
    const payload = (await response.json()) as FrankfurterLatest
    rate = payload.rates?.PHP
    rateDate = payload.date
  } catch (error) {
    return new Response(
      `Could not reach the rate provider: ${error instanceof Error ? error.message : 'unknown error'}.`,
      { status: 502 },
    )
  }

  // A missing or non-finite PHP rate is a provider problem, not a reason to
  // write junk. Leave the previous rate in place rather than nulling it.
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    return new Response(`Rate provider returned no usable PHP rate (got ${String(rate)}).`, {
      status: 502,
    })
  }

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
    const summary = `USD -> PHP = ${rate} (provider date ${rateDate ?? 'unknown'}) written to ${updated} workspace${updated === 1 ? '' : 's'}.`
    console.log(`sync-fx-rate: ${summary}`)
    return new Response(summary)
  } catch (error) {
    return new Response(
      `Supabase credentials are not configured: ${error instanceof Error ? error.message : 'unknown error'}`,
      { status: 500 },
    )
  }
}
