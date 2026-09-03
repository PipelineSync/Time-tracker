/**
 * A tiny stand-in for Supabase (GoTrue + PostgREST) used by the verify script.
 *
 * It implements just the surface the extension touches, so the clock-in /
 * break / clock-out logic can be exercised end to end without a real project:
 *
 *   POST /auth/v1/token?grant_type=password | refresh_token
 *   POST /auth/v1/logout
 *   GET  /auth/v1/user
 *   GET | POST | PATCH | DELETE /rest/v1/<table>?<postgrest filters>
 *   POST /rest/v1/rpc/workspace_owner_id
 *
 * It also reproduces the two behaviours the extension depends on: the
 * `set_user_id()` trigger (rows are stamped with the workspace owner) and the
 * `active_timers_one_per_worker` unique index.
 */

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const ADMIN_ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const WORKER_USER_ID = 'bbbbbbbb-0000-4000-8000-000000000002'
const WORKER_ID = 'cccccccc-0000-4000-8000-000000000003'
const OTHER_WORKER_ID = 'dddddddd-0000-4000-8000-000000000004'

const HOUR = 60 * 60 * 1000

export function createMockDb() {
  return {
    profiles: [
      { user_id: ADMIN_ID, role: 'admin', worker_id: null, created_at: new Date().toISOString() },
      { user_id: WORKER_USER_ID, role: 'worker', worker_id: WORKER_ID, created_at: new Date().toISOString() },
    ],
    workers: [
      {
        id: WORKER_ID,
        user_id: ADMIN_ID,
        name: 'Ana Reyes',
        hourly_rate: 25,
        status: 'active',
        position: 'Foreman',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: OTHER_WORKER_ID,
        user_id: ADMIN_ID,
        name: 'Sam Ocampo',
        hourly_rate: 18,
        status: 'active',
        position: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ],
    active_timers: [],
    time_entries: [],
    notifications: [],
    settings: [{ id: randomUUID(), user_id: ADMIN_ID, business_name: 'PipelineSync', currency: 'USD', default_hourly_rate: 20, timezone: 'UTC' }],
  }
}

const USERS = {
  'ana@example.com': { password: 'worker123', user: makeUser(WORKER_USER_ID, 'ana@example.com') },
  'boss@example.com': { password: 'admin123', user: makeUser(ADMIN_ID, 'boss@example.com') },
}

function makeUser(id, email) {
  return {
    id,
    aud: 'authenticated',
    role: 'authenticated',
    email,
    email_confirmed_at: new Date().toISOString(),
    phone: '',
    confirmed_at: new Date().toISOString(),
    last_sign_in_at: new Date().toISOString(),
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    is_anonymous: false,
  }
}

function sessionFor(user) {
  return {
    access_token: `access.${user.id}.${randomUUID()}`,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor((Date.now() + HOUR) / 1000),
    refresh_token: `refresh.${user.id}.${randomUUID()}`,
    user,
  }
}

// ---------------------------------------------------------------------------
// PostgREST-ish query handling
// ---------------------------------------------------------------------------

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'or', 'and'])

function parseFilters(params) {
  const filters = []
  for (const [key, raw] of params.entries()) {
    if (RESERVED.has(key)) continue
    const [op, ...rest] = String(raw).split('.')
    filters.push({ column: key, op, value: rest.join('.') })
  }
  return filters
}

function parseOr(raw) {
  if (!raw) return null
  const inner = String(raw).replace(/^\(/, '').replace(/\)$/, '')
  return inner.split(',').map((clause) => {
    const [column, op, ...rest] = clause.split('.')
    return { column, op, value: rest.join('.') }
  })
}

function compare(row, { column, op, value }) {
  const left = row[column]
  switch (op) {
    case 'eq':
      return String(left) === String(value)
    case 'neq':
      return String(left) !== String(value)
    case 'gte':
      return left >= value
    case 'gt':
      return left > value
    case 'lte':
      return left <= value
    case 'lt':
      return left < value
    case 'is':
      return value === 'null' ? (left === null || left === undefined) : left !== null
    case 'in':
      return String(value).replace(/[()]/g, '').split(',').includes(String(left))
    default:
      throw new Error(`mock: unsupported operator ${op}`)
  }
}

function selectRows(db, table, url) {
  const rows = db[table] || []
  const params = url.searchParams
  const filters = parseFilters(params)
  const orClauses = parseOr(params.get('or'))
  let out = rows.filter((row) => {
    const passes = filters.every((f) => compare(row, f))
    if (!passes) return false
    if (orClauses) return orClauses.some((f) => compare(row, f))
    return true
  })

  const order = params.get('order')
  if (order) {
    const [column, dir] = order.split('.')
    out = [...out].sort((a, b) => {
      const av = a[column]
      const bv = b[column]
      if (av === bv) return 0
      const result = av > bv ? 1 : -1
      return dir === 'desc' ? -result : result
    })
  }

  const limit = Number(params.get('limit'))
  if (Number.isFinite(limit) && limit > 0) out = out.slice(0, limit)

  return out
}

/**
 * PostgREST picks the columns *after* the rows are chosen and after RLS has
 * been applied, so projection must stay out of `selectRows` — otherwise a
 * policy that checks `worker_id` would see a row where that column has already
 * been stripped.
 */
function projectRows(rows, select) {
  if (!select || select === '*') return rows
  const columns = select.split(',').map((c) => c.trim())
  return rows.map((row) => Object.fromEntries(columns.map((c) => [c, row[c] ?? null])))
}

/**
 * PostgREST returns a bare JSON object (not an array) when the client asks for
 * `application/vnd.pgrst.object+json`, which is what `.single()` /
 * `.maybeSingle()` send — and 406 PGRST116 when the row count is not exactly
 * one. Reproducing that is what makes postgrest-js unwrap the result.
 */
function sendMaybeObject(req, res, rows, status = 200) {
  const wantsObject = String(req.headers.accept ?? '').includes('application/vnd.pgrst.object+json')
  if (!wantsObject) return send(res, status, rows)
  if (rows.length === 1) return send(res, status, rows[0])
  return send(res, 406, {
    code: 'PGRST116',
    details: `The result contains ${rows.length} rows`,
    hint: null,
    message: 'JSON object requested, multiple (or no) rows returned',
  })
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'access-control-expose-headers': 'content-range',
}

function send(res, status, body, headers = {}) {
  const payload = body === undefined || body === null ? '' : JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...CORS,
    ...headers,
  })
  res.end(payload)
}

/**
 * `set_user_id()` from supabase/schema.sql: every insert is stamped with the
 * workspace owner (the admin), which is what lets the admin dashboard see a
 * worker's punches.
 */
function applyTriggers(table, row, authUserId) {
  if (table === 'active_timers' || table === 'time_entries' || table === 'notifications') {
    row.user_id = ADMIN_ID
  }
  if (row.id === undefined) row.id = randomUUID()
  if (row.created_at === undefined) row.created_at = new Date().toISOString()
  if (table === 'time_entries' && row.updated_at === undefined) row.updated_at = new Date().toISOString()
  return row
}

export function startMockSupabase({ db = createMockDb(), port = 0 } = {}) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      handle({ req, res, url, body: raw ? JSON.parse(raw) : null })
    })
  })

  const state = { db, requests: [], revoked: new Set() }

  function authUser(req) {
    const header = req.headers.authorization ?? ''
    const token = header.replace(/^Bearer\s+/i, '')
    if (!token.startsWith('access.')) return null
    const id = token.split('.')[1]
    if (state.revoked.has(token)) return null
    const entry = Object.values(USERS).find((u) => u.user.id === id)
    return entry ? entry.user : null
  }

  function handle({ req, res, url, body }) {
    const path = url.pathname
    const method = (req.method ?? 'GET').toUpperCase()
    state.requests.push({ method, path, query: url.search, body })

    // Real Supabase sends permissive CORS headers, so the popup can reach it
    // even before the optional host permission has been granted.
    if (method === 'OPTIONS') {
      res.writeHead(204, CORS)
      return res.end()
    }

    // ---------------- auth ----------------
    if (path === '/auth/v1/token' && method === 'POST') {
      const grant = url.searchParams.get('grant_type')
      if (grant === 'password') {
        const entry = USERS[String(body?.email ?? '').toLowerCase()]
        if (!entry || entry.password !== body?.password) {
          return send(res, 400, {
            error: 'invalid_grant',
            error_description: 'Invalid login credentials',
          })
        }
        return send(res, 200, sessionFor(entry.user))
      }
      if (grant === 'refresh_token') {
        const token = String(body?.refresh_token ?? '')
        const id = token.split('.')[1]
        const entry = Object.values(USERS).find((u) => u.user.id === id)
        if (!entry) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' })
        return send(res, 200, sessionFor(entry.user))
      }
    }

    if (path === '/auth/v1/user' && method === 'GET') {
      const user = authUser(req)
      if (!user) return send(res, 401, { message: 'invalid claim: missing sub claim' })
      return send(res, 200, user)
    }

    if (path === '/auth/v1/logout' && method === 'POST') {
      const header = req.headers.authorization ?? ''
      state.revoked.add(header.replace(/^Bearer\s+/i, ''))
      return send(res, 204, null)
    }

    // ---------------- rpc ----------------
    if (path.startsWith('/rest/v1/rpc/') && method === 'POST') {
      const name = path.slice('/rest/v1/rpc/'.length)
      if (name === 'workspace_owner_id') {
        const user = authUser(req)
        if (!user) return send(res, 401, { message: 'No API key found in request' })
        // Same rule as the SQL helper: an admin owns their own workspace, a
        // worker resolves to the admin who owns their worker row.
        return send(res, 200, ADMIN_ID)
      }
      return send(res, 404, { message: `Could not find the function public.${name}` })
    }

    // ---------------- rest ----------------
    if (path.startsWith('/rest/v1/')) {
      const table = path.slice('/rest/v1/'.length)
      if (!db[table]) return send(res, 404, { message: `relation "public.${table}" does not exist` })

      const user = authUser(req)
      if (!user) return send(res, 401, { message: 'No API key found in request' })

      // Row Level Security, reduced to the two facts the extension relies on:
      // a worker may only touch rows pointing at their own worker id, and may
      // read their own worker row.
      const profile = db.profiles.find((p) => p.user_id === user.id)
      const isAdmin = profile?.role === 'admin'
      const myWorkerId = profile?.worker_id ?? null

      const select = url.searchParams.get('select')

      if (table === 'profiles' && method === 'GET') {
        const rows = selectRows(db, table, url).filter((r) => isAdmin || r.user_id === user.id)
        return sendMaybeObject(req, res, projectRows(rows, select))
      }
      if (table === 'workers' && method === 'GET') {
        const rows = selectRows(db, table, url).filter((r) => isAdmin || r.id === myWorkerId)
        return sendMaybeObject(req, res, projectRows(rows, select))
      }

      if (method === 'GET') {
        let rows = selectRows(db, table, url)
        if (!isAdmin) {
          // Mirrors the real policies: a worker sees their own rows. The one
          // exception is `settings`, whose policy is `user_id = workspace_
          // owner_id()` — workspace-wide config every signed-in member reads.
          const workspaceWide = new Set(['settings'])
          if (!workspaceWide.has(table)) {
            rows = rows.filter((r) => r.worker_id === myWorkerId || r.user_id === user.id)
          }
        }
        return sendMaybeObject(req, res, projectRows(rows, url.searchParams.get('select')))
      }

      if (method === 'POST') {
        const payloads = Array.isArray(body) ? body : [body]
        const inserted = []
        for (const payload of payloads) {
          if (!isAdmin && table === 'active_timers') {
            if (payload.worker_id !== myWorkerId) {
              return send(res, 403, { message: 'new row violates row-level security policy' })
            }
            // active_timers_one_per_worker
            if (db.active_timers.some((t) => t.worker_id === payload.worker_id)) {
              return send(res, 409, {
                code: '23505',
                message: 'duplicate key value violates unique constraint "active_timers_one_per_worker"',
              })
            }
          }
          if (!isAdmin && table === 'time_entries' && payload.worker_id !== myWorkerId) {
            return send(res, 403, { message: 'new row violates row-level security policy' })
          }
          const row = applyTriggers(table, { ...payload }, user.id)
          db[table].push(row)
          inserted.push(row)
        }
        const wantsRepresentation = String(req.headers.prefer ?? '').includes('return=representation')
        if (!wantsRepresentation) return send(res, 201, null)
        return sendMaybeObject(req, res, projectRows(inserted, url.searchParams.get('select')), 201)
      }

      if (method === 'PATCH') {
        const rows = selectRows(db, table, url)
        const updated = []
        for (const row of rows) {
          if (!isAdmin && table === 'active_timers' && row.worker_id !== myWorkerId) {
            return send(res, 403, { message: 'new row violates row-level security policy' })
          }
          Object.assign(row, body)
          updated.push(row)
        }
        const wantsRepresentation = String(req.headers.prefer ?? '').includes('return=representation')
        if (!wantsRepresentation) return send(res, 204, null)
        return sendMaybeObject(req, res, projectRows(updated, url.searchParams.get('select')), 200)
      }

      if (method === 'DELETE') {
        const rows = selectRows(db, table, url)
        for (const row of rows) {
          if (!isAdmin && table === 'active_timers' && row.worker_id !== myWorkerId) {
            return send(res, 403, { message: 'new row violates row-level security policy' })
          }
          db[table] = db[table].filter((r) => r !== row)
        }
        return send(res, 204, null)
      }
    }

    return send(res, 404, { message: `no route for ${method} ${path}` })
  }

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = server.address()
      resolve({
        url: `http://127.0.0.1:${actual}`,
        anonKey: 'mock-anon-key',
        db,
        state,
        ids: { ADMIN_ID, WORKER_USER_ID, WORKER_ID, OTHER_WORKER_ID },
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}
