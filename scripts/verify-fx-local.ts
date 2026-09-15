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
 *    Supabase server: it prefers the keyed CurrencyFreaks feed (whose rates
 *    arrive as strings) and falls back to the keyless feeds when the key is
 *    missing, the quota is spent or the answers are junk; it refuses to write
 *    on an error or a nonsense rate; it throttles repeat runs so a public
 *    endpoint cannot be used to spend the monthly quota; it never echoes the
 *    API key; and it names the migration when the columns are missing
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
  assert(synced?.rate === 62.629, 'a rate the scheduled sync wrote is used verbatim')
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
/**
 * A stub PostgREST that records what the function tried to read and write.
 *
 * ONE server for the whole run, on a port chosen up front: lib/supabase.ts
 * reads SUPABASE_URL into a module-level const the first time it is imported,
 * so a fresh random port per test would leave the cached client pointing at a
 * closed socket.
 *
 * Answers are chosen per HTTP method, because the function now makes two kinds
 * of request: a GET of the last sync time (its throttle) and a PATCH of the
 * rate. A test that answered both the same way could not tell those apart.
 */
type StubAnswer = { status: number; body: unknown }
type StubRequest = { method: string; path: string; body: string }

class StubSupabase {
  readonly requests: StubRequest[] = []
  private server: Server
  private respond: (req: StubRequest) => StubAnswer = () => ({ status: 200, body: [] })

  private constructor(server: Server) {
    this.server = server
  }

  static async start() {
    const stub = new StubSupabase(
      createServer((req, res) => {
        let raw = ''
        req.on('data', (c) => (raw += c))
        req.on('end', () => {
          const request = { method: req.method || '', path: req.url || '', body: raw }
          stub.requests.push(request)
          const r = stub.respond(request)
          res.writeHead(r.status, { 'Content-Type': 'application/json' })
          res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body))
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
  setResponse(respond: (req: StubRequest) => StubAnswer) {
    this.respond = respond
    this.requests.length = 0
  }

  /** The simple case: the same answer whatever it asks. */
  setAnswer(answer: StubAnswer) {
    this.setResponse(() => answer)
  }

  /**
   * A settings table as the sync leaves it: the throttle read answers with the
   * given timestamp (null = "never synced yet") and the write is accepted.
   */
  setSettingsRow(lastSyncedAt: string | null) {
    this.setResponse((req) =>
      req.method === 'GET'
        ? { status: 200, body: lastSyncedAt ? [{ usd_php_rate_updated_at: lastSyncedAt }] : [] }
        : { status: 200, body: [{ id: 'settings-1' }] },
    )
  }

  get patches() {
    return this.requests.filter((r) => r.method === 'PATCH')
  }
  get selects() {
    return this.requests.filter((r) => r.method === 'GET')
  }
  get wroteAnything() {
    return this.patches.length > 0
  }
  /** The body of the single PATCH, if there was one. */
  get patchBody() {
    return this.patches.length === 1 ? JSON.parse(this.patches[0].body) : undefined
  }

  async stop() {
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    delete process.env.SUPABASE_URL
    delete process.env.VITE_SUPABASE_URL
    delete process.env.SUPABASE_SECRET_KEY
  }
}

/** The three feeds the function may call, in the order it tries them. */
const FEEDS = {
  currencyfreaks: 'https://api.currencyfreaks.com',
  'exchangerate-api': 'https://open.er-api.com',
  frankfurter: 'https://api.frankfurter.dev',
} as const
type Feed = keyof typeof FEEDS

/** A CurrencyFreaks-shaped answer: note the rate arrives as a STRING. */
const freaks = (php: string, base = 'USD') => ({
  status: 200,
  body: { date: '2026-09-15 00:02:00+00', base, rates: { USD: '1.0', PHP: php } },
})

/** ExchangeRate-API's keyless shape: numbers, not strings. */
const keyless = (php: number) => ({
  status: 200,
  body: {
    result: 'success',
    base_code: 'USD',
    time_last_update_utc: 'Tue, 15 Sep 2026 00:00:31 +0000',
    rates: { PHP: php },
  },
})

async function checkSyncFunction() {
  const realFetch = globalThis.fetch
  const KEY = 'cf-test-key-abc123'
  /** Providers actually called, in order — populated by stubProviders below. */
  let calls: Feed[] = []

  /**
   * Route each feed to a canned answer and record who was called. A feed left
   * out answers 503 rather than reaching the network, so "the function tried
   * the fallbacks too" and "it never touched the unconfigured primary" are both
   * observable instead of assumed.
   */
  const stubProviders = (answers: Partial<Record<Feed, StubAnswer>>) => {
    calls = []
    globalThis.fetch = (async (input: any, init?: any) => {
      const raw = typeof input === 'string' ? input : String(input?.url ?? input)
      const feed = (Object.keys(FEEDS) as Feed[]).find((name) => raw.startsWith(FEEDS[name]))
      if (!feed) return realFetch(input, init)
      calls.push(feed)
      const answer = answers[feed] ?? { status: 503, body: { message: `${feed} not stubbed in this test` } }
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch
  }

  const stub = await StubSupabase.start()
  const url = 'http://localhost/.netlify/functions/sync-fx-rate'
  const { default: handler } = await import('../netlify/functions/sync-fx-rate')
  const run = async () => {
    const res = await handler(new Request(url))
    return { status: res.status, text: await res.text() }
  }

  try {
    process.env.CURRENCYFREAKS_API_KEY = KEY

    // --- happy path: the keyed primary answers, nothing else is called ------
    stub.setSettingsRow(null)
    stubProviders({ currencyfreaks: freaks('56.1234') })
    let { status, text } = await run()
    assert(status === 200, `a CurrencyFreaks answer saves the rate (HTTP ${status}: ${text})`)
    assert(text.includes('56.1234'), `the summary names the rate (got "${text}")`)
    assert(text.includes('currencyfreaks'), `the summary names which feed it came from (got "${text}")`)
    assert(text.includes('2026-09-15'), `the summary carries the provider's own as-of date (got "${text}")`)
    assert(calls.length === 1 && calls[0] === 'currencyfreaks', `only the primary is called: ${calls.join(', ')}`)
    assert(stub.patchBody?.usd_php_rate === 56.1234, "its PHP rate is written as a number, from the API's string")
    const stamped = stub.patchBody?.usd_php_rate_updated_at
    assert(typeof stamped === 'string' && !Number.isNaN(Date.parse(stamped)), 'it stamps the time it wrote')
    assert(stub.selects.length === 1, 'it reads the last sync time exactly once')
    assert(
      stub.selects[0]?.path.includes('select=usd_php_rate_updated_at'),
      `and reads only that column (got "${stub.selects[0]?.path}")`,
    )

    // --- the throttle: two runs a day must not become two provider calls an hour
    stub.setSettingsRow(new Date(Date.now() - 30 * 60_000).toISOString())
    stubProviders({ currencyfreaks: freaks('56.9999') })
    ;({ status, text } = await run())
    assert(status === 200, `a sync 30 minutes after the last one is skipped, not an error (HTTP ${status})`)
    assert(/already synced/i.test(text), `and says so (got "${text}")`)
    assert(calls.length === 0, 'no rate provider is contacted at all, so no quota is spent')
    assert(!stub.wroteAnything, 'and the stored rate is left untouched')

    // ...but a scheduled run 12 h after the last one is never throttled.
    stub.setSettingsRow(new Date(Date.now() - (12 * 3_600_000 - 60_000)).toISOString())
    stubProviders({ currencyfreaks: freaks('56.9999') })
    ;({ status, text } = await run())
    assert(status === 200 && text.includes('56.9999'), `the twice-daily schedule is never throttled (got "${text}")`)
    assert(calls.length === 1, 'the second run of the day does reach the provider')

    // --- no key configured: fall back, loudly, without spending a request ----
    delete process.env.CURRENCYFREAKS_API_KEY
    stub.setSettingsRow(null)
    stubProviders({ 'exchangerate-api': keyless(56.3) })
    ;({ status, text } = await run())
    assert(status === 200 && text.includes('56.3'), `with no API key it still syncs from a keyless feed (got "${text}")`)
    assert(
      !calls.includes('currencyfreaks'),
      `and never calls the keyed feed it cannot authenticate to: ${calls.join(', ')}`,
    )
    process.env.CURRENCYFREAKS_API_KEY = KEY

    // --- a surprising base is refused, not converted wrongly -----------------
    stub.setSettingsRow(null)
    stubProviders({ currencyfreaks: freaks('91.5', 'EUR'), 'exchangerate-api': keyless(56.2) })
    ;({ status, text } = await run())
    assert(status === 200 && text.includes('56.2'), `a response based on something other than USD is rejected (got "${text}")`)
    assert(
      calls.join(',') === 'currencyfreaks,exchangerate-api',
      `and the next feed gets its turn (called: ${calls.join(', ')})`,
    )
    assert(text.includes('exchangerate-api'), `naming the feed that saved the run (got "${text}")`)

    // --- every failure mode the provider can hand back -----------------------
    for (const [label, answers, expectInText] of [
      [
        'an invalid API key',
        { currencyfreaks: { status: 401, body: { status: 401, message: `Provided API key ${KEY} is invalid.` } }, 'exchangerate-api': { status: 500, body: { message: 'boom' } }, frankfurter: { status: 500, body: { message: 'boom' } } },
        'check CURRENCYFREAKS_API_KEY',
      ],
      [
        'a spent monthly quota',
        { currencyfreaks: { status: 429, body: { status: 429, message: 'You have exceeded the limit of 1000 requests for your subscribed plan.' } }, 'exchangerate-api': { status: 500, body: { message: 'boom' } }, frankfurter: { status: 500, body: { message: 'boom' } } },
        'quota',
      ],
      [
        'nothing but 500s',
        { currencyfreaks: { status: 500, body: { message: 'boom' } }, 'exchangerate-api': { status: 500, body: { message: 'boom' } }, frankfurter: { status: 503, body: {} } },
        'HTTP 500',
      ],
      [
        'no PHP in any payload',
        { currencyfreaks: { status: 200, body: { base: 'USD', date: 'x', rates: {} } }, 'exchangerate-api': { status: 200, body: { rates: {} } }, frankfurter: { status: 200, body: { rates: {} } } },
        'no usable PHP rate',
      ],
      [
        'a zero rate',
        { currencyfreaks: { status: 200, body: { base: 'USD', rates: { PHP: '0' } } }, 'exchangerate-api': { status: 200, body: { rates: { PHP: 0 } } }, frankfurter: { status: 200, body: { rates: { PHP: 0 } } } },
        'no usable PHP rate',
      ],
      [
        'a rate that is not a number',
        { currencyfreaks: { status: 200, body: { base: 'USD', rates: { PHP: 'n/a' } } }, 'exchangerate-api': { status: 200, body: { rates: { PHP: null } } }, frankfurter: { status: 200, body: { rates: { PHP: NaN } } } },
        'no usable PHP rate',
      ],
    ] as [string, Partial<Record<Feed, StubAnswer>>, string][]) {
      stub.setSettingsRow(null)
      stubProviders(answers)
      ;({ status, text } = await run())
      assert(status === 502, `every feed answering ${label} → 502 (got ${status})`)
      assert(text.includes(expectInText), `and the failure says "${expectInText}" (got "${text}")`)
      assert(!stub.wroteAnything, `${label}: the stored rate is left untouched`)
      assert(!text.includes(KEY), `and the API key never reaches the response (got "${text}")`)
    }

    // A keyless feed failing is not the workspace owner's key problem, so the
    // advice for that must not be sprayed onto every 429.
    stub.setSettingsRow(null)
    stubProviders({ currencyfreaks: { status: 503, body: { message: 'upstream down' } }, 'exchangerate-api': { status: 429, body: {} } })
    ;({ status, text } = await run())
    assert(status === 502, `a keyless feed answering 429 still reaches the last feed (got ${status})`)
    assert(calls.join(',') === 'currencyfreaks,exchangerate-api,frankfurter', `trying each in turn: ${calls.join(', ')}`)
    assert(
      !text.includes('check CURRENCYFREAKS_API_KEY'),
      `and does not blame the API key for a fallback's 429 (got "${text}")`,
    )

    // --- an unmigrated database is named before a request is wasted ----------
    stub.setResponse((req) =>
      req.method === 'GET'
        ? { status: 400, body: { code: '42703', message: 'column "usd_php_rate" of relation "settings" does not exist' } }
        : { status: 200, body: [] },
    )
    stubProviders({})
    ;({ status, text } = await run())
    assert(status === 500, `an unmigrated database errors instead of silently doing nothing (got ${status})`)
    assert(text.includes('RUN-THIS-fx-rate.sql'), `and the error points at the migration to run (got "${text}")`)
    assert(calls.length === 0, 'without spending a provider request first')

    // ...including when only the WRITE is rejected (e.g. a policy change).
    stub.setResponse((req) =>
      req.method === 'GET'
        ? { status: 200, body: [] }
        : { status: 400, body: { code: '42703', message: 'column "usd_php_rate" of relation "settings" does not exist' } },
    )
    stubProviders({ currencyfreaks: freaks('56.1234') })
    ;({ status, text } = await run())
    assert(status === 500 && text.includes('RUN-THIS-fx-rate.sql'), `a rejected write says the same thing (got "${text}")`)
  } finally {
    delete process.env.CURRENCYFREAKS_API_KEY
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
