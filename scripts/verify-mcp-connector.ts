/**
 * End-to-end verification of the Claude Connector (remote MCP server).
 *
 * Runs the **real** handlers — netlify/functions/mcp.ts, oauth-register.ts,
 * oauth-authorize.ts, oauth-token.ts — against a fake Supabase (see
 * scripts/mcp-mock/fake-supabase.mjs). Nothing in netlify/functions is stubbed,
 * rewritten or monkey-patched: only the database behind it is replaced. That
 * is what makes the interesting assertions possible — that the OAuth flow
 * really issues a usable token, that PKCE really is enforced, and that a
 * worker's connector really cannot read another worker's hours.
 *
 * Run: npx tsx scripts/verify-mcp-connector.ts
 */

// The connector reads its Supabase credentials from the environment at call
// time, so the fake server has to be up before any handler module is imported.
const { startFakeSupabase, state, resetState, addAccount, table, makeJwt } = await import(
  './mcp-mock/fake-supabase.mjs'
)

const server = await startFakeSupabase()
process.env.VITE_SUPABASE_URL = server.url
process.env.VITE_SUPABASE_PUBLISHABLE_KEY = server.anonKey
process.env.VITE_SUPABASE_ANON_KEY = server.anonKey
process.env.SUPABASE_URL = server.url
process.env.SUPABASE_SECRET_KEY = server.serviceRoleKey
process.env.MCP_PUBLIC_URL = 'https://tracker.example.com'

const mcp = (await import('../netlify/functions/mcp')).default
const register = (await import('../netlify/functions/oauth-register')).default
const authorize = (await import('../netlify/functions/oauth-authorize')).default
const token = (await import('../netlify/functions/oauth-token')).default
const discovery = (await import('../netlify/functions/oauth-discovery')).default

let failures = 0
let checks = 0
function assert(condition: boolean, message: string) {
  checks += 1
  if (condition) {
    console.log(`ok: ${message}`)
  } else {
    failures += 1
    console.error(`FAIL: ${message}`)
  }
}

const json = (value: unknown) => JSON.stringify(value)

/** POST a JSON-RPC body to /mcp, optionally with a bearer token. */
async function rpc(body: unknown, opts: { token?: string; method?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const request = new Request('https://tracker.example.com/mcp', {
    method: opts.method ?? 'POST',
    headers,
    body: body === null ? undefined : json(body),
  })
  return mcp(request)
}

async function rpcJson(body: unknown, opts: { token?: string } = {}) {
  const response = await rpc(body, opts)
  return { status: response.status, headers: response.headers, body: await response.json() }
}

/** Call a tool the way Claude does, and pull the payload back out. */
async function callTool(name: string, args: Record<string, unknown>, token: string) {
  const { status, body } = await rpcJson(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    { token },
  )
  const result = (body as { result?: { content?: { text: string }[]; isError?: boolean } }).result
  let parsed: unknown = undefined
  if (result?.content?.[0]?.text) {
    try {
      parsed = JSON.parse(result.content[0].text)
    } catch {
      parsed = result.content[0].text
    }
  }
  return { status, isError: Boolean(result?.isError), data: parsed, raw: body }
}

const ORIGIN = 'https://tracker.example.com'

// ===========================================================================
// Seed a two-person workspace
// ===========================================================================

const ADMIN_ID = '11111111-1111-4111-8111-111111111111'
const ANA_ID = '22222222-2222-4222-8222-222222222222'
const BEN_ID = '33333333-3333-4333-8333-333333333333'
const ANA_WORKER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const BEN_WORKER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const CLIENT_ACME = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function seed() {
  resetState()
  addAccount({ userId: ADMIN_ID, email: 'admin@example.com', password: 'admin.pipelinesync', role: 'admin' })
  addAccount({ userId: ANA_ID, email: 'ana@example.com', password: 'ana-password', role: 'worker', workerId: ANA_WORKER })
  addAccount({ userId: BEN_ID, email: 'ben@example.com', password: 'ben-password', role: 'worker', workerId: BEN_WORKER })

  table('settings').push({
    user_id: ADMIN_ID,
    business_name: 'PipelineSync',
    currency: 'PHP',
    timezone: 'Asia/Manila',
    default_hourly_rate: 250,
  })

  table('workers').push(
    { id: ANA_WORKER, user_id: ADMIN_ID, name: 'Ana Reyes', email: 'ana@example.com', hourly_rate: 300, status: 'active', position: 'Designer', permissions: [] },
    { id: BEN_WORKER, user_id: ADMIN_ID, name: 'Ben Cruz', email: 'ben@example.com', hourly_rate: 200, status: 'active', position: 'Developer', permissions: [] },
  )

  table('clients').push({ id: CLIENT_ACME, user_id: ADMIN_ID, name: 'Acme Corp', status: 'active' })

  table('time_entries').push(
    { id: 'eeeeeee1-1111-4111-8111-111111111111', user_id: ADMIN_ID, worker_id: ANA_WORKER, client_id: CLIENT_ACME, start_time: '2026-09-01T01:00:00.000Z', end_time: '2026-09-01T09:00:00.000Z', break_minutes: 60, hourly_rate: 300, total_minutes: 420, earnings: 2100, settled_at: null, notes: null },
    { id: 'eeeeeee2-2222-4222-8222-222222222222', user_id: ADMIN_ID, worker_id: BEN_WORKER, client_id: CLIENT_ACME, start_time: '2026-09-01T02:00:00.000Z', end_time: '2026-09-01T06:00:00.000Z', break_minutes: 0, hourly_rate: 200, total_minutes: 240, earnings: 800, settled_at: null, notes: null },
  )

  table('tasks').push({
    id: 'ddddddd1-1111-4111-8111-111111111111', user_id: ADMIN_ID, worker_id: ANA_WORKER, title: 'Redesign the header',
    status: 'todo', priority: 'high', due_date: '2026-09-30', stage_history: [], archived_at: null,
  })
}

seed()

// ===========================================================================
// 1. OAuth discovery — the first thing Claude fetches
// ===========================================================================

console.log('\n--- OAuth discovery ---')

const asMetadata = await (
  await discovery(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`))
).json()
assert((asMetadata as { issuer: string }).issuer === ORIGIN, 'authorization server metadata names this site as the issuer')
assert(
  (asMetadata as { token_endpoint: string }).token_endpoint === `${ORIGIN}/oauth/token`,
  'metadata points at the /oauth/token endpoint',
)
assert(
  (asMetadata as { registration_endpoint: string }).registration_endpoint === `${ORIGIN}/oauth/register`,
  'metadata advertises Dynamic Client Registration',
)
assert(
  JSON.stringify((asMetadata as { code_challenge_methods_supported: string[] }).code_challenge_methods_supported) ===
    '["S256"]',
  'metadata advertises PKCE S256 only',
)

const prMetadata = await (
  await discovery(new Request(`${ORIGIN}/.well-known/oauth-protected-resource`))
).json()
assert(
  (prMetadata as { resource: string }).resource === `${ORIGIN}/mcp`,
  'protected resource metadata names the /mcp endpoint',
)

// ===========================================================================
// 2. Unauthenticated requests are rejected with OAuth discovery info
// ===========================================================================

console.log('\n--- Authentication gate ---')

const noToken = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
assert(noToken.status === 401, 'tools/list without a token is refused with 401')
const wwwAuthenticate = noToken.headers.get('www-authenticate') ?? ''
assert(
  wwwAuthenticate.includes(`${ORIGIN}/.well-known/oauth-protected-resource`),
  'the 401 carries resource_metadata so Claude can discover the OAuth server',
)
assert(wwwAuthenticate.includes('error="missing"'), 'the 401 says the token is missing')

const initNoAuth = await rpcJson({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'claude', version: '1' } } })
assert(initNoAuth.status === 200, 'initialize works without a token (needed for discovery)')
assert(
  (initNoAuth.body as { result: { serverInfo: { name: string } } }).result.serverInfo.name ===
    'pipelinesync-work-tracker',
  'initialize returns the server name',
)
const negotiated = (initNoAuth.body as { result: { protocolVersion: string } }).result.protocolVersion
assert(negotiated === '2025-06-18', `negotiates protocol ${negotiated}`)

const badToken = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: 'not-a-real-token' })
assert(badToken.status === 401, 'an unknown token is refused with 401')

// ===========================================================================
// 3. Dynamic Client Registration
// ===========================================================================

console.log('\n--- Dynamic Client Registration ---')

const CLAUDE_REDIRECT = 'https://claude.ai/api/mcp/auth_callback'

const regResponse = await register(
  new Request(`${ORIGIN}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: json({ client_name: 'Claude', redirect_uris: [CLAUDE_REDIRECT], grant_types: ['authorization_code', 'refresh_token'] }),
  }),
)
assert(regResponse.status === 201, 'Claude can register itself (HTTP 201)')
const registration = (await regResponse.json()) as { client_id: string; token_endpoint_auth_method: string }
assert(typeof registration.client_id === 'string' && registration.client_id.length > 20, 'a client_id is issued')
assert(
  registration.token_endpoint_auth_method === 'none',
  'the registered client is public (PKCE only, no secret to leak)',
)

const badRedirect = await register(
  new Request(`${ORIGIN}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: json({ client_name: 'Evil', redirect_uris: ['https://evil.example.com/callback'] }),
  }),
)
assert(badRedirect.status === 400, 'a redirect_uri outside the allow-list is rejected')

// ===========================================================================
// 4. Sign-in page
// ===========================================================================

console.log('\n--- Authorization page ---')

// Real PKCE: verifier + S256 challenge, computed exactly as a client would.
const encoder = new TextEncoder()
async function pkcePair() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const verifier = Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(verifier))
  const challenge = Buffer.from(digest)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return { verifier, challenge }
}

const { verifier, challenge } = await pkcePair()
const authorizeUrl = new URL(`${ORIGIN}/oauth/authorize`)
authorizeUrl.searchParams.set('client_id', registration.client_id)
authorizeUrl.searchParams.set('redirect_uri', CLAUDE_REDIRECT)
authorizeUrl.searchParams.set('response_type', 'code')
authorizeUrl.searchParams.set('state', 'state-abc')
authorizeUrl.searchParams.set('code_challenge', challenge)
authorizeUrl.searchParams.set('code_challenge_method', 'S256')

const loginPage = await authorize(new Request(authorizeUrl.toString()))
const loginHtml = await loginPage.text()
assert(loginPage.status === 200, 'the sign-in page renders')
assert(loginHtml.includes('Connect Claude to Work Tracker'), 'the page says what is being connected')
assert(loginHtml.includes('name="email"') && loginHtml.includes('name="password"'), 'the page has email and password fields')
assert(loginHtml.includes('code_challenge'), 'the page carries the PKCE challenge through to the POST')
assert(
  !loginHtml.includes('<script'),
  'the page ships no JavaScript (nothing to hijack on a credentials form)',
)

// ===========================================================================
// 5. Sign-in → authorization code → token
// ===========================================================================

console.log('\n--- Sign-in and token exchange ---')

async function signIn(email: string, password: string) {
  const form = new URLSearchParams({
    client_id: registration.client_id,
    redirect_uri: CLAUDE_REDIRECT,
    state: 'state-abc',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    email,
    password,
  })
  return authorize(
    new Request(`${ORIGIN}/oauth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    }),
  )
}

const wrongPassword = await signIn('admin@example.com', 'nope')
assert(wrongPassword.status === 401, 'a wrong password is refused')
assert((await wrongPassword.text()).includes('do not match an account'), 'the failure does not reveal which half was wrong')

const adminSignIn = await signIn('admin@example.com', 'admin.pipelinesync')
assert(adminSignIn.status === 302, 'a correct password redirects back to Claude')
const redirectTarget = new URL(adminSignIn.headers.get('location') ?? '')
assert(redirectTarget.origin + redirectTarget.pathname === CLAUDE_REDIRECT, 'the redirect goes to Claude\'s callback')
assert(redirectTarget.searchParams.get('state') === 'state-abc', 'the state parameter is echoed back')
const code = redirectTarget.searchParams.get('code') ?? ''
assert(code.length > 20, 'an authorization code is issued')

// The code is stored hashed, never in the clear.
const storedCodes = table('mcp_oauth_codes')
assert(storedCodes.length === 1, 'the authorization code was persisted')
assert(
  !json(storedCodes[0]).includes(code),
  'the authorization code is stored hashed, not in the clear',
)

async function exchange(value: string, verifierValue: string, extra: Record<string, string> = {}) {
  return token(
    new Request(`${ORIGIN}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: value,
        client_id: registration.client_id,
        redirect_uri: CLAUDE_REDIRECT,
        code_verifier: verifierValue,
        ...extra,
      }).toString(),
    }),
  )
}

const wrongVerifier = await exchange(code, 'a'.repeat(43))
assert(wrongVerifier.status === 400, 'a wrong PKCE verifier is rejected')
assert(
  ((await wrongVerifier.json()) as { error: string }).error === 'invalid_grant',
  'a PKCE failure is reported as invalid_grant',
)

const tokenResponse = await exchange(code, verifier)
assert(tokenResponse.status === 200, 'a valid code + verifier is exchanged for a token')
const issued = (await tokenResponse.json()) as {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
}
assert(issued.token_type === 'Bearer', 'the token is a bearer token')
assert(issued.expires_in === 3600, 'the access token expires in an hour')

const ADMIN_TOKEN = issued.access_token

// Single use: the same code must not work twice.
const replay = await exchange(code, verifier)
assert(replay.status === 400, 'an authorization code cannot be replayed')

// And the token we just got actually works.
const withToken = await rpcJson({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: ADMIN_TOKEN })
assert(withToken.status === 200, 'the issued token authenticates tools/list')
const tools = (withToken.body as { result: { tools: { name: string }[] } }).result.tools
assert(tools.length >= 25, `tools/list advertises ${tools.length} tools`)

const toolNames = tools.map((t) => t.name)
for (const expected of [
  'whoami', 'list_workers', 'list_time_entries', 'list_active_timers', 'summarize_time',
  'clock_in', 'clock_out', 'create_time_entry', 'settle_worker', 'list_payments',
  'list_tasks', 'create_task', 'update_task', 'list_invoices', 'list_finance_items',
  'list_tickets', 'create_ticket', 'list_meetings', 'get_settings',
]) {
  assert(toolNames.includes(expected), `the tool list includes ${expected}`)
}

const readOnly = tools.filter((t) => (t as { annotations?: { readOnlyHint?: boolean } }).annotations?.readOnlyHint)
assert(readOnly.length > 0, `${readOnly.length} tools are annotated readOnlyHint so Claude labels them safe`)
const destructive = tools.filter((t) => (t as { annotations?: { destructiveHint?: boolean } }).annotations?.destructiveHint)
assert(destructive.length > 0, `${destructive.length} tools are annotated destructiveHint (delete/settle)`)

// ===========================================================================
// 6. Reading data as the admin
// ===========================================================================

console.log('\n--- Reading the workspace ---')

const who = await callTool('whoami', {}, ADMIN_TOKEN)
assert((who.data as { role: string }).role === 'admin', 'whoami reports the admin role')

const settings = await callTool('get_settings', {}, ADMIN_TOKEN)
assert((settings.data as { currency: string }).currency === 'PHP', 'get_settings returns the workspace currency')

const workers = await callTool('list_workers', {}, ADMIN_TOKEN)
assert((workers.data as { rows: unknown[] }).rows.length === 2, 'the admin sees both workers')

const entries = await callTool('list_time_entries', {}, ADMIN_TOKEN)
assert((entries.data as { rows: unknown[] }).rows.length === 2, 'the admin sees everyone\'s time')
assert(
  (entries.data as { rows: { worker: string }[] }).rows.some((r) => r.worker === 'Ana Reyes'),
  'entries are labelled with worker names, not raw ids',
)

const summary = await callTool('summarize_time', {}, ADMIN_TOKEN) as { data: { totalHours: number; totalEarnings: number; byWorker: { worker: string; hours: number }[] } }
assert(summary.data.totalHours === 11, `summarize_time totals 11h (got ${summary.data.totalHours})`)
assert(summary.data.totalEarnings === 2900, `summarize_time totals 2900 (got ${summary.data.totalEarnings})`)
assert(summary.data.byWorker.length === 2, 'the summary breaks down per worker')

const filtered = await callTool('summarize_time', { worker_id: ANA_WORKER }, ADMIN_TOKEN) as { data: { totalHours: number } }
assert(filtered.data.totalHours === 7, `filtering by worker totals 7h (got ${filtered.data.totalHours})`)

const dateFiltered = await callTool('list_time_entries', { from: '2026-09-01', to: '2026-09-01' }, ADMIN_TOKEN)
assert((dateFiltered.data as { rows: unknown[] }).rows.length === 2, 'a YYYY-MM-DD range is inclusive of that day')

const futureFiltered = await callTool('list_time_entries', { from: '2026-10-01' }, ADMIN_TOKEN)
assert((futureFiltered.data as { rows: unknown[] }).rows.length === 0, 'an empty range returns no rows')

// ===========================================================================
// 7. Worker scoping — the security assertion that matters most
// ===========================================================================

console.log('\n--- Worker permissions ---')

const { verifier: benVerifier, challenge: benChallenge } = await pkcePair()
const benUrl = new URL(`${ORIGIN}/oauth/authorize`)
benUrl.searchParams.set('client_id', registration.client_id)
benUrl.searchParams.set('redirect_uri', CLAUDE_REDIRECT)
benUrl.searchParams.set('response_type', 'code')
benUrl.searchParams.set('code_challenge', benChallenge)
benUrl.searchParams.set('code_challenge_method', 'S256')

// A plain worker signs in (no capabilities granted).
await authorize(new Request(benUrl.toString()))
const benForm = new URLSearchParams({
  client_id: registration.client_id,
  redirect_uri: CLAUDE_REDIRECT,
  code_challenge: benChallenge,
  code_challenge_method: 'S256',
  email: 'ben@example.com',
  password: 'ben-password',
})
const benRedirect = await authorize(
  new Request(`${ORIGIN}/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: benForm.toString(),
  }),
)
const benCode = new URL(benRedirect.headers.get('location') ?? '').searchParams.get('code') ?? ''
const benTokenResponse = await exchange(benCode, benVerifier)
const BEN_TOKEN = ((await benTokenResponse.json()) as { access_token: string }).access_token
assert(Boolean(BEN_TOKEN), 'a plain worker can sign in and get a token')

const benWho = await callTool('whoami', {}, BEN_TOKEN) as { data: { role: string; permissions: unknown } }
assert(benWho.data.role === 'worker', 'the worker token is recognised as a worker')
assert(benWho.data.permissions === 'None — this is a standard worker account.', 'the worker holds no extra capabilities')

const benWorkers = await callTool('list_workers', {}, BEN_TOKEN)
assert(
  (benWorkers.data as { rows: { name: string }[] }).rows.length === 1,
  'the worker sees only themselves in the team list',
)

const benEntries = await callTool('list_time_entries', {}, BEN_TOKEN)
assert(
  (benEntries.data as { rows: { worker: string }[] }).rows.every((r) => r.worker === 'Ben Cruz'),
  'the worker sees only their own time entries',
)

// Writes the worker is not allowed to make must fail clearly, not silently.
const benSettle = await callTool('settle_worker', { worker_id: ANA_WORKER }, BEN_TOKEN)
assert(benSettle.isError, 'a plain worker cannot settle someone else\'s time')
assert(
  String((benSettle.data ?? '')).includes('payments.manage'),
  'the refusal names the permission that is missing',
)

const benManualEntry = await callTool(
  'create_time_entry',
  { worker_id: ANA_WORKER, start_time: '2026-09-02T01:00:00.000Z', end_time: '2026-09-02T03:00:00.000Z' },
  BEN_TOKEN,
)
assert(benManualEntry.isError, 'a plain worker cannot add time to another worker')

// But they can still work on their own board.
const ownTask = await callTool('create_task', { title: 'Fix the login page' }, BEN_TOKEN)
assert(!ownTask.isError, 'a plain worker can create a task on their own board')
assert(
  table('tasks').some((t) => t.title === 'Fix the login page' && t.worker_id === BEN_WORKER),
  'the task was created on the worker\'s own board',
)

const othersTask = await callTool('update_task', { task_id: 'ddddddd1-1111-4111-8111-111111111111', title: 'Hijacked' }, BEN_TOKEN)
assert(othersTask.isError, 'a plain worker cannot edit another worker\'s task')

// ===========================================================================
// 8. Writes: clock in/out arithmetic
// ===========================================================================

console.log('\n--- Clock in / clock out ---')

const clockIn = await callTool('clock_in', { worker_id: ANA_WORKER, client_id: CLIENT_ACME, notes: 'Design sprint' }, ADMIN_TOKEN)
assert(!clockIn.isError, 'the admin can clock a worker in')
const timerId = (clockIn.data as { timerId: string }).timerId
assert(table('active_timers').length === 1, 'a running timer exists')

const activeTimers = await callTool('list_active_timers', {}, ADMIN_TOKEN) as { data: { rows: { worker: string; status: string }[] } }
assert(activeTimers.data.rows[0].worker === 'Ana Reyes', 'list_active_timers names who is on the clock')
assert(activeTimers.data.rows[0].status === 'working', 'the timer reports "working"')

const duplicateClockIn = await callTool('clock_in', { worker_id: ANA_WORKER, client_id: CLIENT_ACME }, ADMIN_TOKEN)
assert(duplicateClockIn.isError, 'clocking the same worker in twice is refused')

const onBreak = await callTool('start_break', { timer_id: timerId }, ADMIN_TOKEN)
assert(!onBreak.isError, 'a break can be started')
assert(table('active_timers')[0].paused === true, 'the timer is paused')

const breakTimers = await callTool('list_active_timers', {}, ADMIN_TOKEN) as { data: { rows: { status: string }[] } }
assert(breakTimers.data.rows[0].status === 'on break', 'the timer reports "on break"')

const offBreak = await callTool('end_break', { timer_id: timerId }, ADMIN_TOKEN)
assert(!offBreak.isError, 'the break can be ended')
assert(table('active_timers')[0].paused === false, 'the timer is running again')
assert(table('active_timers')[0].total_pause_ms > 0, 'the break time was accumulated, not discarded')

const clockOut = await callTool('clock_out', { timer_id: timerId, notes: 'Wrapped up' }, ADMIN_TOKEN)
assert(!clockOut.isError, 'the worker can be clocked out')
assert(table('active_timers').length === 0, 'the timer is cleared on clock-out')
const newEntry = table('time_entries').find((e) => e.notes?.includes('Wrapped up'))
assert(Boolean(newEntry), 'the shift was saved as a time entry')
assert(
  Number(newEntry.hourly_rate) === 300,
  'the entry carries the worker\'s rate',
)
assert(
  typeof newEntry.total_minutes === 'number' && newEntry.total_minutes >= 0,
  'the entry has a computed duration',
)
assert(table('time_entries').length === 3, 'clocking out added exactly one entry')

// ===========================================================================
// 9. Writes: settling and payments
// ===========================================================================

console.log('\n--- Settling ---')

const settle = await callTool('settle_worker', { worker_id: ANA_WORKER }, ADMIN_TOKEN) as { data: { amount: number; entriesSettled: number; hours: number } }
assert(!settle.isError || settle.data?.entriesSettled > 0, 'settling Ana succeeds')
assert(settle.data.entriesSettled === 2, `both of Ana's unsettled entries were settled (got ${settle.data.entriesSettled})`)
assert(settle.data.amount === 2100, `the payment covers Ana's 2100 (got ${settle.data.amount})`)
assert(settle.data.hours === 7, `the payment covers 7h (got ${settle.data.hours})`)

assert(table('payments').length === 1, 'one payment was created')
assert(table('payments')[0].status === 'unpaid', 'the payment starts unpaid')
assert(
  table('time_entries').filter((e) => e.worker_id === ANA_WORKER).every((e) => e.settled_at),
  'every settled entry was stamped, so it cannot be paid twice',
)

const settleAgain = await callTool('settle_worker', { worker_id: ANA_WORKER }, ADMIN_TOKEN)
assert(
  (settleAgain.data as { message?: string })?.message?.includes('no unsettled time') ?? false,
  'settling again is a no-op with a clear message',
)
assert(table('payments').length === 1, 'the second settle created no payment')

const unpaidFilter = await callTool('list_time_entries', { settled: false }, ADMIN_TOKEN)
assert(
  (unpaidFilter.data as { rows: { worker: string }[] }).rows.every((r) => r.worker === 'Ben Cruz'),
  'only Ben has unsettled time left',
)

const markPaid = await callTool(
  'mark_payment_paid',
  { payment_id: table('payments')[0].id, method: 'cash', reference_number: 'GC-12345' },
  ADMIN_TOKEN,
)
assert(!markPaid.isError, 'the payment can be marked paid')
assert(table('payments')[0].status === 'paid', 'the payment is now paid')
assert(table('payments')[0].reference_number === 'GC-12345', 'the reference number was stored')

const noMethod = await callTool('mark_payment_paid', { payment_id: table('payments')[0].id }, ADMIN_TOKEN)
assert(noMethod.isError, 'marking paid without a method is refused')

// ===========================================================================
// 10. Task board
// ===========================================================================

console.log('\n--- Tasks ---')

const moved = await callTool('update_task', { task_id: 'ddddddd1-1111-4111-8111-111111111111', status: 'completed' }, ADMIN_TOKEN)
assert(!moved.isError, 'a task can be moved to completed')
const movedTask = table('tasks').find((t) => t.id === 'ddddddd1-1111-4111-8111-111111111111')
assert(movedTask.status === 'completed', 'the status changed')
assert(Boolean(movedTask.completed_at), 'completed_at was stamped (Team KPI reads this)')
assert(
  Array.isArray(movedTask.stage_history) && movedTask.stage_history.length === 1,
  'the move was appended to stage_history, not overwritten',
)
assert(
  movedTask.stage_history[0].from === 'todo' && movedTask.stage_history[0].to === 'completed',
  'the history entry records from → to',
)

const reopened = await callTool('update_task', { task_id: 'ddddddd1-1111-4111-8111-111111111111', status: 'in_progress' }, ADMIN_TOKEN)
assert(!reopened.isError, 'a completed task can be reopened')
assert(table('tasks').find((t) => t.id === 'ddddddd1-1111-4111-8111-111111111111').completed_at === null, 'completed_at clears when a task reopens')

const badStatus = await callTool('update_task', { task_id: 'ddddddd1-1111-4111-8111-111111111111', status: 'done-ish' }, ADMIN_TOKEN)
assert(badStatus.isError, 'an unknown column name is rejected')
assert(String(badStatus.data).includes('must be one of'), 'the error lists the allowed columns')

const badId = await callTool('update_task', { task_id: 'not-a-uuid', status: 'todo' }, ADMIN_TOKEN)
assert(badId.isError, 'a malformed task id is rejected before it reaches the database')
assert(String(badId.data).includes('must be an id'), 'the error explains what an id looks like')

const overdue = await callTool('list_tasks', { overdue: true }, ADMIN_TOKEN)
assert(!overdue.isError, 'the overdue filter runs')

// ===========================================================================
// 11. Protocol edge cases
// ===========================================================================

console.log('\n--- Protocol handling ---')

const unknownTool = await rpcJson(
  { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'delete_everything', arguments: {} } },
  { token: ADMIN_TOKEN },
)
assert(
  (unknownTool.body as { error?: { code: number } }).error?.code === -32601,
  'an unknown tool returns JSON-RPC method-not-found',
)

const notifications = await rpc([{ jsonrpc: '2.0', method: 'notifications/initialized' }], { token: ADMIN_TOKEN })
assert(notifications.status === 202, 'a notifications-only batch returns 202 with no body')

const batch = await rpcJson(
  [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } },
  ],
  { token: ADMIN_TOKEN },
)
assert(Array.isArray(batch.body), 'a batch returns an array of responses')
assert((batch.body as unknown[]).length === 2, 'both batched requests were answered')

const malformed = await rpc(null)
assert(malformed.status === 200, 'an empty body is tolerated')

const badJson = await mcp(
  new Request('https://tracker.example.com/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: '{not json',
  }),
)
assert(badJson.status === 400, 'invalid JSON returns 400')
assert(
  ((await badJson.json()) as { error: { code: number } }).error.code === -32700,
  'invalid JSON is reported as a parse error',
)

const getRequest = await mcp(new Request('https://tracker.example.com/mcp', { method: 'GET' }))
assert(getRequest.status === 405, 'GET /mcp is answered 405 (this server does not stream SSE)')

const headRequest = await mcp(new Request('https://tracker.example.com/mcp', { method: 'HEAD' }))
assert(headRequest.status === 200, 'HEAD /mcp is a cheap liveness probe')
assert(
  Boolean(headRequest.headers.get('mcp-protocol-version')),
  'the response advertises the MCP protocol version',
)

// ===========================================================================
// 12. Refresh tokens and rotation
// ===========================================================================

console.log('\n--- Refresh tokens ---')

async function refreshWith(value: string) {
  return token(
    new Request(`${ORIGIN}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: value,
        client_id: registration.client_id,
      }).toString(),
    }),
  )
}

const refreshed = await refreshWith(issued.refresh_token)
assert(refreshed.status === 200, 'a refresh token can be exchanged for a new pair')
const refreshedTokens = (await refreshed.json()) as { access_token: string; refresh_token: string }
assert(Boolean(refreshedTokens.access_token), 'a new access token is issued')

const rotatedAway = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: ADMIN_TOKEN })
assert(rotatedAway.status === 401, 'the old access token stops working after rotation')

const reusedRefresh = await refreshWith(issued.refresh_token)
assert(reusedRefresh.status === 400, 'the old refresh token cannot be reused after rotation')

const newTokenWorks = await rpcJson({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: refreshedTokens.access_token })
assert(newTokenWorks.status === 200, 'the refreshed token works')

const garbageRefresh = await refreshWith('not-a-refresh-token')
assert(garbageRefresh.status === 400, 'an unknown refresh token is refused')

// ===========================================================================
// 13. Expired sessions are handled, not crashed on
// ===========================================================================

console.log('\n--- Session expiry ---')

state.failRefresh = true
const staleToken = refreshedTokens.access_token

// Force the next call down the refresh path by backdating the Supabase
// session the token carries — this is the real "user has been signed in for
// over an hour" state, not a synthetic one.
const staleRow = table('mcp_oauth_tokens').find((row) => row.user_id === ADMIN_ID)
assert(Boolean(staleRow), 'the admin token row is present before the refresh attempt')
staleRow.supabase_access_token = makeJwt(ADMIN_ID, -60)

// A call on a session that is about to lapse first tries to refresh it, and
// when that fails the endpoint answers with a real 401 rather than a crash or
// a half-empty result.
const stale = await rpc(
  { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } },
  { token: staleToken },
)
assert(stale.status === 401, 'an expired session is answered with 401, not a silent success')
assert(
  (stale.headers.get('www-authenticate') ?? '').includes('invalid_token'),
  'the 401 tells Claude the token is invalid so it can try to recover',
)

// The dead token is retired, so Claude's own refresh cannot keep a broken
// session alive — the user gets a clean "sign in again" prompt instead.
const deadRefresh = await refreshWith(refreshedTokens.refresh_token)
assert(deadRefresh.status === 400, 'once the session is gone, refreshing cannot resurrect it')
state.failRefresh = false

// ===========================================================================
// 14. Session termination
//
// Last, by necessity: DELETE revokes the token, and every earlier section
// still needs theirs.
// ===========================================================================

console.log('\n--- Session termination ---')

const deleteRequest = await mcp(
  new Request('https://tracker.example.com/mcp', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${refreshedTokens.access_token}` },
  }),
)
assert(deleteRequest.status === 204, 'DELETE /mcp terminates the session')

const afterDelete = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: refreshedTokens.access_token })
assert(afterDelete.status === 401, 'after DELETE the token no longer works')

// ===========================================================================
// Cleanup
// ===========================================================================

await server.stop()

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exitCode = 1
}
