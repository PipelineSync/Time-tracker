/**
 * Fake Supabase (PostgREST + GoTrue) for the connector verification harness.
 *
 * scripts/verify-mcp-connector.ts points VITE_SUPABASE_URL at this server, so
 * the **real** handlers run — real supabase-js client, real JSON-RPC layer,
 * real OAuth code — with only the database replaced. Nothing in
 * netlify/functions is stubbed or rewritten, which is the whole point: the
 * connector's behaviour is verified, not a mock of its behaviour.
 *
 * Scope: the subset of PostgREST the connector actually uses
 * (select / eq / neq / is / in / gt / gte / lt / lte / ilike / not / order /
 * limit, plus insert / update / delete with `Prefer: return=representation`)
 * and the two GoTrue calls it makes (password grant, refresh grant, /user).
 *
 * Row Level Security is simulated per table: requests bearing the service-role
 * key see everything, and a user token sees only what that account may see.
 * That is what lets the harness assert that a worker's connector really cannot
 * read another worker's hours.
 */

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

const b64url = (obj) =>
  Buffer.from(JSON.stringify(obj))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

/** A structurally valid (but unsigned) JWT — jwtExpiry() reads its `exp`. */
export function makeJwt(userId, ttlSeconds = 3600) {
  const header = b64url({ alg: 'HS256', typ: 'JWT' })
  const payload = b64url({
    sub: userId,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    iat: Math.floor(Date.now() / 1000),
  })
  return `${header}.${payload}.signature`
}

export function jwtSubject(token) {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(Buffer.from(part, 'base64').toString()).sub
  } catch {
    return null
  }
}

const SERVICE_ROLE_KEY = 'service-role-key'
const ANON_KEY = 'anon-key'

// ---------------------------------------------------------------------------
// In-memory database
// ---------------------------------------------------------------------------

/** Tables the connector touches, seeded empty. */
const TABLE_NAMES = [
  'workers',
  'profiles',
  'settings',
  'clients',
  'time_entries',
  'active_timers',
  'time_entry_comments',
  'payments',
  'tasks',
  'invoices',
  'finance_items',
  'meetings',
  'monthly_goals',
  'tickets',
  'ticket_replies',
  'mcp_oauth_clients',
  'mcp_oauth_codes',
  'mcp_oauth_tokens',
]

export const state = {
  tables: Object.fromEntries(TABLE_NAMES.map((name) => [name, []])),
  /** Accounts that can sign in: email → { password, userId }. */
  accounts: new Map(),
  /** Rows keyed by userId for the /user endpoint. */
  users: new Map(),
  /** Set by the harness to make the next refresh fail. */
  failRefresh: false,
  /** Every request the server has served, for assertions. */
  requests: [],
}

export function resetState() {
  for (const name of TABLE_NAMES) state.tables[name] = []
  state.accounts.clear()
  state.users.clear()
  state.failRefresh = false
  state.requests.length = 0
}

/** Register an account that can sign in at /oauth/authorize. */
export function addAccount({ userId, email, password, role = 'worker', workerId = null }) {
  state.accounts.set(email.toLowerCase(), { password, userId })
  state.users.set(userId, { id: userId, email, role, workerId })
  state.tables.profiles.push({ user_id: userId, role, worker_id: workerId })
}

export function table(name) {
  if (!state.tables[name]) state.tables[name] = []
  return state.tables[name]
}

// ---------------------------------------------------------------------------
// Row Level Security simulation
// ---------------------------------------------------------------------------

/**
 * Which rows a caller may see.
 *
 * Mirrors the app's real policies closely enough for the assertions that
 * matter: the admin (workspace owner) sees the whole workspace, and a worker
 * sees their own rows plus the shared boards.
 */
function visibleRows(tableName, rows, actor) {
  if (actor.isServiceRole) return rows
  if (!actor.userId) return []

  switch (tableName) {
    case 'profiles':
      return rows.filter((r) => r.user_id === actor.userId)
    case 'workers':
      // Workers see themselves; the admin sees everyone.
      if (actor.role === 'admin') return rows
      return rows.filter((r) => r.id === actor.workerId)
    case 'time_entries':
    case 'active_timers':
    case 'payments':
      if (actor.role === 'admin') return rows
      return rows.filter((r) => r.worker_id === actor.workerId)
    case 'tasks':
      if (actor.role === 'admin') return rows
      return rows.filter((r) => r.worker_id === actor.workerId)
    case 'tickets':
      // The IT Support queue is not readable by the admin; a requester sees
      // only their own tickets.
      return rows.filter((r) => r.requester_user_id === actor.userId)
    case 'mcp_oauth_clients':
    case 'mcp_oauth_codes':
    case 'mcp_oauth_tokens':
      // RLS with no policies: no user-scoped access at all.
      return []
    default:
      return rows
  }
}

// ---------------------------------------------------------------------------
// PostgREST query parsing
// ---------------------------------------------------------------------------

const CONTROL_PARAMS = new Set(['select', 'order', 'limit', 'offset'])

function decodeValue(raw) {
  if (raw === 'null') return null
  if (raw === 'true') return true
  if (raw === 'false') return false
  return raw
}

function splitIn(raw) {
  const inner = raw.replace(/^\(/, '').replace(/\)$/, '')
  if (inner === '') return []
  return inner.split(',').map((v) => decodeValue(v.replace(/^"|"$/g, '')))
}

function matches(row, column, filter) {
  const value = row[column]
  const { op, operand, negated } = filter

  let result
  switch (op) {
    case 'eq':
      result = String(value) === String(operand)
      break
    case 'neq':
      result = String(value) !== String(operand)
      break
    case 'is':
      result = operand === null ? value === null || value === undefined : value === operand
      break
    case 'in':
      result = operand.some((candidate) => String(candidate) === String(value))
      break
    case 'gt':
      result = value != null && String(value) > String(operand)
      break
    case 'gte':
      result = value != null && String(value) >= String(operand)
      break
    case 'lt':
      result = value != null && String(value) < String(operand)
      break
    case 'lte':
      result = value != null && String(value) <= String(operand)
      break
    case 'like':
    case 'ilike': {
      const pattern = String(operand).replace(/%/g, '.*').replace(/\*/g, '.*')
      result = new RegExp(`^${pattern}$`, op === 'ilike' ? 'i' : '').test(String(value ?? ''))
      break
    }
    default:
      result = true
  }
  return negated ? !result : result
}

/** Turn `?status=eq.active&settled_at=is.null` into filter descriptors. */
function parseFilters(params) {
  const filters = []
  for (const [column, raw] of params.entries()) {
    if (CONTROL_PARAMS.has(column)) continue

    let rest = raw
    let negated = false
    if (rest.startsWith('not.')) {
      negated = true
      rest = rest.slice(4)
    }

    const dot = rest.indexOf('.')
    if (dot === -1) {
      filters.push({ column, op: 'eq', operand: decodeValue(rest), negated })
      continue
    }
    const op = rest.slice(0, dot)
    let operandRaw = rest.slice(dot + 1)

    if (op === 'in') {
      filters.push({ column, op, operand: splitIn(operandRaw), negated })
      continue
    }
    if (op === 'is') {
      filters.push({ column, op, operand: operandRaw === 'null' ? null : decodeValue(operandRaw), negated })
      continue
    }
    // Timestamps arrive URL-encoded and contain colons; they compare correctly
    // as ISO strings, which is why the gt/lt cases use string comparison.
    filters.push({ column, op, operand: decodeValue(decodeURIComponent(operandRaw)), negated })
  }
  return filters
}

function applyOrder(rows, orderParam) {
  if (!orderParam) return rows
  const [column, ...modifiers] = orderParam.split('.')
  const ascending = !modifiers.includes('desc')
  const nullsFirst = modifiers.includes('nullsfirst')

  return [...rows].sort((a, b) => {
    const left = a[column]
    const right = b[column]
    if (left === right) return 0
    if (left === null || left === undefined) return nullsFirst ? -1 : 1
    if (right === null || right === undefined) return nullsFirst ? 1 : -1
    const comparison = String(left) < String(right) ? -1 : 1
    return ascending ? comparison : -comparison
  })
}

/** Project a row onto the requested columns (`select=id,name`). */
function project(rows, selectParam) {
  if (!selectParam || selectParam === '*') return rows.map((r) => ({ ...r }))
  return rows.map((row) => {
    const out = {}
    for (const column of selectParam.split(',')) {
      const name = column.trim()
      if (name) out[name] = row[name] ?? null
    }
    return out
  })
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function readBody(request) {
  return new Promise((resolve) => {
    let data = ''
    request.on('data', (chunk) => (data += chunk))
    request.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch {
        resolve({})
      }
    })
  })
}

/**
 * Read a request header.
 *
 * `request` here is a Node IncomingMessage, not a fetch Request, so its
 * headers are a plain lower-cased object rather than a Headers instance.
 */
function header(request, name) {
  const value = request.headers?.[name.toLowerCase()]
  return typeof value === 'string' ? value : ''
}

function actorFrom(request) {
  const apikey = header(request, 'apikey')
  const auth = header(request, 'authorization')
  const token = auth.replace(/^Bearer\s+/i, '')

  if (apikey === SERVICE_ROLE_KEY || token === SERVICE_ROLE_KEY) {
    return { isServiceRole: true, userId: null, role: 'admin', workerId: null }
  }
  const userId = token ? jwtSubject(token) : null
  const user = userId ? state.users.get(userId) : null
  return {
    isServiceRole: false,
    userId: userId ?? null,
    role: user?.role ?? 'worker',
    workerId: user?.workerId ?? null,
  }
}

function send(response, status, body, extraHeaders = {}) {
  const payload = body === null ? '' : JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  })
  response.end(payload)
}

/**
 * Start the fake server on an ephemeral port.
 * Returns its base URL and a `stop()` for the harness to call.
 */
export async function startFakeSupabase() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    state.requests.push({ method: request.method, path: url.pathname, query: url.search })

    // ---------------- GoTrue ----------------
    if (url.pathname === '/auth/v1/token') {
      const grant = url.searchParams.get('grant_type')
      const body = await readBody(request)

      if (grant === 'password') {
        const account = state.accounts.get(String(body.email ?? '').toLowerCase())
        if (!account || account.password !== body.password) {
          return send(response, 400, {
            error: 'invalid_grant',
            error_description: 'Invalid login credentials',
          })
        }
        return send(response, 200, {
          access_token: makeJwt(account.userId),
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: `refresh-${account.userId}-${randomUUID()}`,
          user: state.users.get(account.userId),
        })
      }

      if (grant === 'refresh_token') {
        if (state.failRefresh) {
          return send(response, 400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' })
        }
        const previous = String(body.refresh_token ?? '')
        const match = /^refresh-(.+)-/.exec(previous)
        const userId = match ? match[1] : 'user-unknown'
        if (!state.users.has(userId)) {
          return send(response, 400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' })
        }
        return send(response, 200, {
          access_token: makeJwt(userId),
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: `refresh-${userId}-${randomUUID()}`,
          user: state.users.get(userId),
        })
      }

      return send(response, 400, { error: 'unsupported_grant_type' })
    }

    if (url.pathname === '/auth/v1/user') {
      const actor = actorFrom(request)
      const user = actor.userId ? state.users.get(actor.userId) : null
      if (!user) return send(response, 401, { error: 'invalid_token' })
      return send(response, 200, user)
    }

    // ---------------- PostgREST ----------------
    const restPrefix = '/rest/v1/'
    if (!url.pathname.startsWith(restPrefix)) {
      return send(response, 404, { message: 'Not found' })
    }

    const tableName = url.pathname.slice(restPrefix.length)
    const rows = table(tableName)
    const actor = actorFrom(request)

    if (request.method === 'GET' || request.method === 'HEAD') {
      let filtered = visibleRows(tableName, rows, actor)
      for (const filter of parseFilters(url.searchParams)) {
        filtered = filtered.filter((row) => matches(row, filter.column, filter))
      }
      filtered = applyOrder(filtered, url.searchParams.get('order'))
      const limitParam = url.searchParams.get('limit')
      if (limitParam) filtered = filtered.slice(0, Number(limitParam))

      const prefer = header(request, 'prefer')
      if (prefer.includes('count=exact')) {
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Range': `0-${Math.max(0, filtered.length - 1)}/${filtered.length}`,
        })
        return response.end(request.method === 'HEAD' ? '' : JSON.stringify(project(filtered, url.searchParams.get('select'))))
      }

      return request.method === 'HEAD'
        ? send(response, 200, null)
        : send(response, 200, project(filtered, url.searchParams.get('select')))
    }

    if (request.method === 'POST') {
      const body = await readBody(request)
      const incoming = Array.isArray(body) ? body : [body]
      const inserted = incoming.map((row) => ({
        id: row.id ?? randomUUID(),
        created_at: new Date().toISOString(),
        ...row,
      }))
      for (const row of inserted) {
        if (tableName === 'tasks' && row.stage_history === undefined) row.stage_history = []
        rows.push(row)
      }
      // PostgREST returns the representation only when asked.
      const prefer = header(request, 'prefer')
      if (!prefer.includes('return=representation')) return send(response, 201, null)
      return send(response, 201, Array.isArray(body) ? inserted : inserted[0])
    }

    if (request.method === 'PATCH') {
      const body = await readBody(request)
      let filtered = visibleRows(tableName, rows, actor)
      for (const filter of parseFilters(url.searchParams)) {
        filtered = filtered.filter((row) => matches(row, filter.column, filter))
      }
      for (const row of filtered) Object.assign(row, body)

      const prefer = header(request, 'prefer')
      if (!prefer.includes('return=representation')) return send(response, 204, null)
      const projected = project(filtered, url.searchParams.get('select'))
      return send(response, 200, url.searchParams.has('limit') ? projected : (projected[0] ?? []))
    }

    if (request.method === 'DELETE') {
      let filtered = visibleRows(tableName, rows, actor)
      for (const filter of parseFilters(url.searchParams)) {
        filtered = filtered.filter((row) => matches(row, filter.column, filter))
      }
      const doomed = new Set(filtered)
      state.tables[tableName] = rows.filter((row) => !doomed.has(row))
      return send(response, 204, null)
    }

    return send(response, 405, { message: 'Method not allowed' })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    anonKey: ANON_KEY,
    serviceRoleKey: SERVICE_ROLE_KEY,
    stop: () => new Promise((resolve) => server.close(resolve)),
  }
}
