/**
 * Ad-hoc verification of the USD → PHP reference rate:
 *  - the rate is shown ONLY for a USD workspace; PHP / EUR / GBP hide it
 *    entirely, so those screens render exactly as they did before
 *  - a synced rate wins; a null / zero / missing column falls back to the
 *    bundled rate and is flagged as approximate rather than shown as a quote
 *  - phpEquivalent() returns undefined with no rate, so a StatCard renders no
 *    sub-line at all
 *  - demo mode (local storage) really does carry the two new settings fields
 *  - the sync-fx-rate Netlify Function is exercised for real against a stub
 *    Supabase server: it writes the provider's rate, and it refuses to write
 *    when the provider answers with an error or a nonsense rate
 *
 * Run: npx tsx scripts/verify-fx-local.ts
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// Minimal browser stub so storage.ts / localDb.ts work in Node.
const mem = new Map<string, string>()
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
  },
}

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exitCode = 1
  } else {
    console.log(`ok: ${msg}`)
  }
}

/** A Settings with only the fields usdPhpRate() reads; the rest is filler. */
const settings = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    id: 'settings-1',
    business_name: 'My Business',
    currency: 'USD',
    timezone: 'UTC',
    default_hourly_rate: 20,
    avatar_url: null,
    usd_php_rate: null,
    usd_php_rate_updated_at: null,
    ...over,
  }) as any

async function checkPureLogic() {
  const { usdPhpRate, phpEquivalent, formatRate, FALLBACK_USD_PHP_RATE } = await import('../src/lib/fx')

  // --- who sees the chip at all -------------------------------------------
  assert(usdPhpRate(null) === null, 'no settings loaded → nothing shown')
  assert(usdPhpRate(undefined) === null, 'undefined settings → nothing shown')
  assert(usdPhpRate(settings({ currency: 'PHP' })) === null, 'a PHP workspace hides the rate entirely')
  assert(usdPhpRate(settings({ currency: 'EUR' })) === null, 'an EUR workspace hides the rate entirely')
  assert(usdPhpRate(settings({ currency: 'JPY' })) === null, 'a JPY workspace hides the rate entirely')
  assert(usdPhpRate(settings({ currency: 'USD' })) !== null, 'a USD workspace shows the rate')

  // --- which rate it shows -------------------------------------------------
  const synced = usdPhpRate(settings({ usd_php_rate: 62.629, usd_php_rate_updated_at: '2026-09-11T00:00:00.000Z' }))
  assert(synced?.rate === 62.629, 'a rate the daily sync wrote is used verbatim')
  assert(synced?.isFallback === false, 'a synced rate is not flagged as a fallback')
  assert(synced?.updatedAt === '2026-09-11T00:00:00.000Z', 'the sync timestamp rides along with the rate')

  const fallback = usdPhpRate(settings({ usd_php_rate: null }))
  assert(fallback?.rate === FALLBACK_USD_PHP_RATE, 'a null rate falls back to the bundled rate')
  assert(fallback?.isFallback === true, 'the bundled rate is flagged so the UI can mark it approximate')

  assert(
    usdPhpRate(settings({ usd_php_rate: 0 }))?.isFallback === true,
    'a zero rate falls back instead of zeroing every converted figure'
  )
  assert(
    usdPhpRate(settings({ usd_php_rate: -12 }))?.isFallback === true,
    'a negative rate falls back'
  )
  assert(
    usdPhpRate(settings({ usd_php_rate: undefined }))?.isFallback === true,
    'a pre-migration row (column absent → undefined) falls back instead of crashing'
  )
  assert(
    usdPhpRate(settings({ usd_php_rate: 'nope' }))?.isFallback === true,
    'a non-numeric rate falls back'
  )

  // --- the figures the UI renders ------------------------------------------
  assert(formatRate(62.629) === '₱62.63', `formatRate renders the peso sign and 2dp (got ${formatRate(62.629)})`)
  assert(
    phpEquivalent(100, synced) === '≈ ₱6,263',
    `100 USD at 62.629 renders as a whole-peso sub-line (got ${phpEquivalent(100, synced)})`
  )
  assert(phpEquivalent(0, synced) === '≈ ₱0', 'a zero amount still renders, not undefined')
  assert(phpEquivalent(100, null) === undefined, 'with no rate the sub-line is undefined, so StatCard renders none')
  assert(phpEquivalent(NaN, synced) === undefined, 'a NaN amount renders no sub-line')
}

async function checkDemoBackend() {
  const { localBackend } = await import('../src/lib/localDb')
  const { usdPhpRate } = await import('../src/lib/fx')

  const admin = await localBackend.signIn('admin', 'admin.pipelinesync')
  assert(!admin.error && admin.data?.role === 'admin', 'admin can sign in to the demo workspace')

  const s = (await localBackend.getSettings()).data
  assert(!!s, 'demo mode returns a settings row')
  assert('usd_php_rate' in (s as object), 'the demo settings row carries usd_php_rate')
  assert('usd_php_rate_updated_at' in (s as object), 'the demo settings row carries usd_php_rate_updated_at')
  assert(s?.usd_php_rate === null, 'demo mode ships no live rate (there is no server to sync one)')
  assert(
    usdPhpRate(s)?.isFallback === true,
    'so the demo workspace shows the bundled rate, marked approximate'
  )

  // Switching the demo workspace to PHP must make the chip disappear.
  const saved = await localBackend.saveSettings({ currency: 'PHP' } as any)
  assert(!saved.error && saved.data?.currency === 'PHP', 'the demo workspace can be switched to PHP')
  assert(usdPhpRate(saved.data) === null, 'and the rate chip then hides itself')

  await localBackend.saveSettings({ currency: 'USD' } as any)
}

/**
 * A stub PostgREST that records what the function tried to write.
 *
 * ONE server for the whole run, on a port chosen up front: lib/supabase.ts
 * reads SUPABASE_URL into a module-level const the first time it is imported,
 * so a fresh random port per test would leave the cached client pointing at a
 * closed socket.
 */
class StubSupabase {
  readonly writes: { method: string; path: string; body: any }[] = []
  private server: Server
  private respond: (body: string) => { status: number; body: string } = () => ({
    status: 200,
    body: '[]',
  })

  private constructor(server: Server) {
    this.server = server
  }

  static async start() {
    const stub = new StubSupabase(
      createServer((req, res) => {
        let raw = ''
        req.on('data', (c) => (raw += c))
        req.on('end', () => {
          stub.writes.push({ method: req.method || '', path: req.url || '', body: raw ? JSON.parse(raw) : null })
          const r = stub.respond(raw)
          res.writeHead(r.status, { 'Content-Type': 'application/json' })
          res.end(r.body)
        })
      }),
    )
    await new Promise<void>((resolve) => stub.server.listen(0, '127.0.0.1', resolve))
    const port = (stub.server.address() as AddressInfo).port
    // Must be set before netlify/functions/lib/supabase.ts is first imported.
    process.env.SUPABASE_URL = `http://127.0.0.1:${port}`
    process.env.VITE_SUPABASE_URL = `http://127.0.0.1:${port}`
    process.env.SUPABASE_SECRET_KEY = 'stub-secret-key'
    return stub
  }

  /** Point the stub at a new canned answer and forget earlier requests. */
  setResponse(respond: (body: string) => { status: number; body: string }) {
    this.respond = respond
    this.writes.length = 0
  }

  get wroteAnything() {
    return this.writes.some((w) => w.method === 'PATCH')
  }

  async stop() {
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    delete process.env.SUPABASE_URL
    delete process.env.VITE_SUPABASE_URL
    delete process.env.SUPABASE_SECRET_KEY
  }
}

async function checkSyncFunction() {
  const realFetch = globalThis.fetch

  /** Route the provider call to a canned answer; let Supabase reach the stub. */
  const stubProvider = (answer: { status: number; body: unknown }) => {
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : String(input?.url ?? input)
      if (url.startsWith('https://api.frankfurter.dev')) {
        return new Response(JSON.stringify(answer.body), {
          status: answer.status,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return realFetch(input, init)
    }) as typeof fetch
  }

  const stub = await StubSupabase.start()
  const url = 'http://localhost/.netlify/functions/sync-fx-rate'

  try {
    // --- happy path --------------------------------------------------------
    stub.setResponse(() => ({ status: 200, body: '[{"id":"settings-1"}]' }))
    stubProvider({ status: 200, body: { base: 'USD', date: '2026-09-11', rates: { PHP: 62.629 } } })
    const { default: handler } = await import('../netlify/functions/sync-fx-rate')

    let res = await handler(new Request(url))
    let text = await res.text()
    assert(res.status === 200, `a good provider answer saves the rate (HTTP ${res.status}: ${text})`)
    assert(text.includes('62.629'), `the summary names the rate (got "${text}")`)
    const patch = stub.writes.find((w) => w.method === 'PATCH' && w.path.startsWith('/rest/v1/settings'))
    assert(!!patch, 'the function PATCHes the settings table')
    assert(patch?.body?.usd_php_rate === 62.629, "it writes the provider's PHP rate, verbatim")
    assert(
      typeof patch?.body?.usd_php_rate_updated_at === 'string' &&
        !Number.isNaN(Date.parse(patch.body.usd_php_rate_updated_at)),
      'it stamps the time it wrote',
    )

    // --- provider failure must not write junk ------------------------------
    for (const [label, answer] of [
      ['an HTTP 500', { status: 500, body: { error: 'boom' } }],
      ['no PHP in the payload', { status: 200, body: { base: 'USD', date: '2026-09-11', rates: {} } }],
      ['a zero rate', { status: 200, body: { base: 'USD', rates: { PHP: 0 } } }],
      ['a null rate', { status: 200, body: { base: 'USD', rates: { PHP: null } } }],
    ] as const) {
      stub.setResponse(() => ({ status: 200, body: '[{"id":"settings-1"}]' }))
      stubProvider(answer as { status: number; body: unknown })
      res = await handler(new Request(url))
      assert(res.status === 502, `provider answering ${label} → 502 (got ${res.status})`)
      assert(!stub.wroteAnything, `provider answering ${label} leaves the stored rate untouched`)
    }

    // --- database without the migration ------------------------------------
    stub.setResponse(() => ({
      status: 400,
      body: JSON.stringify({
        code: '42703',
        message: 'column "usd_php_rate" of relation "settings" does not exist',
      }),
    }))
    stubProvider({ status: 200, body: { base: 'USD', rates: { PHP: 62.629 } } })
    res = await handler(new Request(url))
    text = await res.text()
    assert(res.status === 500, `an unmigrated database errors instead of silently doing nothing (got ${res.status})`)
    assert(text.includes('RUN-THIS-fx-rate.sql'), `and the error points at the migration to run (got "${text}")`)
  } finally {
    await stub.stop()
    globalThis.fetch = realFetch
  }
}

/**
 * Renders the REAL components with react-dom/server and inspects the markup.
 *
 * This is the part the pure-logic checks above cannot reach: that RateChip
 * actually paints "1 USD = ₱62.63", that it paints NOTHING (an empty string,
 * not an empty wrapper that would still occupy a slot) for a non-USD
 * workspace, and that the Dashboard's earnings card really carries the peso
 * sub-line. createElement rather than JSX so this stays a .ts file like every
 * other verify script.
 */
async function checkRenderedMarkup() {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { RateChip } = await import('@/components/RateChip')
  const { StatCard } = await import('@/components/StatCard')
  const { usdPhpRate, phpEquivalent } = await import('@/lib/fx')
  const { money } = await import('@/lib/utils')

  const chip = (over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(RateChip, { settings: settings(over) as any }))

  // --- a synced rate --------------------------------------------------------
  const synced = chip({ usd_php_rate: 62.629, usd_php_rate_updated_at: '2026-09-11T00:00:00.000Z' })
  assert(synced.includes('1 USD'), `the chip states the pair (got "${stripTags(synced)}")`)
  assert(synced.includes('₱62.63'), `the chip shows the synced rate (got "${stripTags(synced)}")`)
  assert(synced.includes('=') && !synced.includes('≈'), 'a synced rate is stated with "=", not the approximate "≈"')
  assert(synced.includes('<svg'), 'the chip renders its icon')
  assert(
    /title="[^"]*2026/.test(synced),
    'the tooltip names the day the rate was synced',
  )

  // --- the bundled fallback -------------------------------------------------
  const fallback = chip({ usd_php_rate: null })
  assert(fallback.includes('≈'), `an unsynced rate is marked approximate (got "${stripTags(fallback)}")`)
  assert(!/>[^<]*1 USD =/.test(fallback), 'and is NOT stated with "=" as though it were a live quote')
  assert(
    /title="[^"]*daily sync has not written/i.test(fallback),
    'its tooltip says why it is approximate',
  )

  // --- hidden entirely for a non-USD workspace ------------------------------
  // The whole point of the "hide it" decision: nothing is rendered at all, so
  // not even an empty pill is left taking up room on the title row.
  for (const currency of ['PHP', 'EUR', 'GBP', 'JPY']) {
    assert(chip({ currency }) === '', `a ${currency} workspace renders nothing at all`)
  }
  assert(chip({ currency: 'usd' }) === '', 'the currency match is case-sensitive, so a malformed code hides rather than shows')

  // --- the Dashboard earnings card ------------------------------------------
  const fx = usdPhpRate(settings({ usd_php_rate: 62.629 }))
  const card = renderToStaticMarkup(
    createElement(StatCard, {
      label: "Today's Earnings",
      value: money(120, 'USD'),
      sub: phpEquivalent(120, fx),
      loading: false,
    }),
  )
  assert(card.includes("Today&#x27;s Earnings") || card.includes("Today's Earnings"), 'the card keeps its label')
  assert(card.includes('$120.00'), `the card still leads with the workspace currency (got "${stripTags(card)}")`)
  assert(card.includes('₱7,515'), `and carries the peso equivalent underneath (got "${stripTags(card)}")`)

  // With no rate the sub prop is undefined, so the card must be byte-identical
  // in structure to how it rendered before this feature existed.
  const without = renderToStaticMarkup(
    createElement(StatCard, {
      label: "Today's Earnings",
      value: money(120, 'USD'),
      sub: phpEquivalent(120, usdPhpRate(settings({ currency: 'PHP' }))),
      loading: false,
    }),
  )
  assert(!without.includes('₱'), 'a non-USD workspace gets no peso sub-line on the card')
  assert(without === card.replace(/<p class="text-xs text-muted-foreground">≈ ₱7,515<\/p>/, ''),
    'and the card markup is otherwise unchanged — no empty sub-line element left behind')
}

/** Collapse rendered markup to its visible text, for readable failure output. */
function stripTags(html: string): string {
  return html.replace(/<svg[\s\S]*?<\/svg>/g, '[icon]').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

async function main() {
  console.log('\n— USD → PHP rate logic —')
  await checkPureLogic()
  console.log('\n— rendered markup —')
  await checkRenderedMarkup()
  console.log('\n— demo-mode settings —')
  await checkDemoBackend()
  console.log('\n— sync-fx-rate function —')
  await checkSyncFunction()

  if (process.exitCode) {
    console.error('\nSome USD → PHP rate checks FAILED.')
  } else {
    console.log('\nAll USD → PHP rate checks passed.')
  }
}

void main()
