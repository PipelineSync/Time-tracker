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

  // The function tries providers in order (open.er-api.com first, then
  // Frankfurter). These stub the primary's response shape; a stubbed failure
  // (non-200, or no PHP) makes the function fall through to the next provider,
  // so a stub that fails BOTH providers is what exercises the "provider
  // failure must not write junk" path below.
  const PRIMARY = 'https://open.er-api.com'
  const FALLBACK = 'https://api.frankfurter.dev'

  /** Route the provider call to a canned answer; let Supabase reach the stub. */
  const stubProvider = (answer: { status: number; body: unknown }) => {
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : String(input?.url ?? input)
      if (url.startsWith(PRIMARY) || url.startsWith(FALLBACK)) {
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
    stubProvider({
      status: 200,
      body: {
        result: 'success',
        base_code: 'USD',
        time_last_update_utc: 'Mon, 14 Sep 2026 00:02:31 +0000',
        rates: { PHP: 62.629 },
      },
    })
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

/**
 * The browser-side provider client (`src/lib/fxRate`) — the path that makes the
 * rate update where there is **no server to sync it**: demo mode, the sandbox
 * preview, any non-Netlify host. The old behaviour (never write a rate in demo
 * mode) is exactly what the "it is not updating" report was about.
 */
async function checkBrowserProviderClient() {
  const { fetchFreshRate, parseRatePayload, RATE_PROVIDERS } = await import('../src/lib/fxRate')

  // --- payload shapes -------------------------------------------------------
  const erApi = parseRatePayload({
    result: 'success',
    rates: { PHP: 57.83, EUR: 0.86 },
    time_last_update_utc: 'Tue, 16 Sep 2026 00:02:31 +0000',
  })
  assert(erApi?.rate === 57.83, `the open.er-api.com shape parses (got ${erApi?.rate})`)
  assert(erApi?.date === 'Tue, 16 Sep 2026 00:02:31 +0000', 'and keeps the provider timestamp')

  const frank = parseRatePayload({ date: '2026-09-15', rates: { PHP: 57.9 } })
  assert(frank?.rate === 57.9, `the Frankfurter shape parses (got ${frank?.rate})`)

  // --- junk must never be written ------------------------------------------
  assert(parseRatePayload({ result: 'error', 'error-type': 'quota' }) === undefined, 'an error envelope is rejected')
  assert(parseRatePayload({ rates: { EUR: 0.9 } }) === undefined, 'a payload without PHP is rejected')
  assert(parseRatePayload({ rates: { PHP: 0 } }) === undefined, 'a zero rate is rejected')
  assert(parseRatePayload({ rates: { PHP: Number.NaN } }) === undefined, 'a NaN rate is rejected')
  assert(parseRatePayload({ rates: { PHP: -3 } }) === undefined, 'a negative rate is rejected')
  assert(parseRatePayload(null) === undefined, 'a null payload is rejected')

  // --- provider order, fallback, and total failure --------------------------
  const tried: string[] = []
  const primaryDown = (async (url: unknown) => {
    tried.push(String(url))
    if (String(url).includes('er-api')) return { ok: false, status: 503, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => ({ date: '2026-09-15', rates: { PHP: 57.42 } }) }
  }) as unknown as typeof fetch
  const fellBack = await fetchFreshRate(primaryDown)
  assert(fellBack?.rate === 57.42, `a failed primary falls back to the next provider (got ${fellBack?.rate})`)
  assert(fellBack?.provider === 'frankfurter', 'and names the provider that answered')
  assert(tried.length === 2, 'both providers were tried, in order')

  const offline = (async () => {
    throw new Error('offline')
  }) as unknown as typeof fetch
  assert((await fetchFreshRate(offline)) === null, 'every provider failing resolves null instead of throwing')

  const allFail = (async () => {
    return { ok: true, status: 200, json: async () => ({ result: 'error' }) }
  }) as unknown as typeof fetch
  assert((await fetchFreshRate(allFail)) === null, 'a 200 with an unusable body also resolves null')

  // --- the sources are the keyless, daily-refreshing pair -------------------
  assert(RATE_PROVIDERS.length === 2, 'exactly two providers are configured')
  assert(
    RATE_PROVIDERS.every((p) => p.url.startsWith('https://')),
    'every provider is fetched over https'
  )
  assert(
    // Anything in this module also runs in a browser bundle, so a key here would
    // be public. Keys stay in the Netlify function's environment instead.
    RATE_PROVIDERS.every((p) => !/key|token|app_id/i.test(p.url)),
    'no provider URL carries an API key (this code also ships to the browser)'
  )

  // --- and they are the SAME sources the scheduled function uses ------------
  // The function keeps its own copy of the list on purpose (it must stay
  // deployable with no `src/` import), so nothing but a check keeps the two
  // from drifting apart and quietly showing two different numbers.
  const { readFile } = await import('node:fs/promises')
  const fnSource = await readFile(new URL('../netlify/functions/sync-fx-rate.ts', import.meta.url), 'utf8')
  for (const provider of RATE_PROVIDERS) {
    const host = new URL(provider.url).hostname
    assert(fnSource.includes(host), `the scheduled function also reads ${host}`)
  }
}

/**
 * End-to-end: the write the browser performs in demo mode, through the ordinary
 * backend, lands on the settings row and flips the UI out of fallback mode.
 */
async function checkDemoBackendWritePath() {
  const { localBackend } = await import('../src/lib/localDb')
  const { usdPhpRate } = await import('../src/lib/fx')

  await localBackend.signIn('admin', 'admin.pipelinesync')
  assert(usdPhpRate((await localBackend.getSettings()).data)?.isFallback === true, 'the demo workspace starts on the fallback rate')

  // This is exactly what FxRateCard (Refresh now) and the store's self-heal
  // both do: fetch a rate, save it with the normal settings call.
  const saved = await localBackend.saveSettings({
    usd_php_rate: 57.83,
    usd_php_rate_updated_at: new Date().toISOString(),
  } as any)
  assert(!saved.error, 'the browser-fetched rate saves through the ordinary settings path')

  const after = usdPhpRate((await localBackend.getSettings()).data)
  assert(after?.rate === 57.83, `the saved rate is what the app now reports (got ${after?.rate})`)
  assert(after?.isFallback === false, 'and the chip switches from "≈" to "=" because it is no longer the fallback')
  assert(after?.updatedAt !== null, 'with an "updated at" the card can show')

  // Leaving the demo workspace as it was found keeps later checks honest.
  await localBackend.saveSettings({ usd_php_rate: null, usd_php_rate_updated_at: null } as any)
  assert(usdPhpRate((await localBackend.getSettings()).data)?.isFallback === true, 'and clearing it returns to the fallback')
}

async function main() {
  console.log('\n— USD → PHP rate logic —')
  await checkPureLogic()
  console.log('\n— rendered markup —')
  await checkRenderedMarkup()
  console.log('\n— demo-mode settings —')
  await checkDemoBackend()
  console.log('\n— browser provider client (no-server path) —')
  await checkBrowserProviderClient()
  console.log('\n— demo-mode write path —')
  await checkDemoBackendWritePath()
  console.log('\n— sync-fx-rate function —')
  await checkSyncFunction()

  if (process.exitCode) {
    console.error('\nSome USD → PHP rate checks FAILED.')
  } else {
    console.log('\nAll USD → PHP rate checks passed.')
  }
}

void main()
