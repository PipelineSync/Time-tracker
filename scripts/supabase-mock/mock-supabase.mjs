/**
 * Mock of @supabase/supabase-js used by the verify-delete-supabase.ts script.
 * The module loader redirects '@supabase/supabase-js' to this file.
 */

export const state = {
  users: [], // { id, email, password }
  profiles: [], // { user_id, role, worker_id }
  workers: [], // { id, name, email, permissions, ... }
  // Tasks created via the backend. Each task is the full row the Supabase
  // mock returns from .insert(...).select().single().
  tasks: [],
  clients: [], // { id, user_id, name, color, status, created_at, updated_at }
  authUser: null, // { id, email } currently signed in
  getUserError: null, // injected error for auth.getUser
  profileQueryError: null, // injected error for profiles queries
  workerRowQueryError: null, // injected error for workers row-existence queries
  // Simulates a database created before custom client colours existed: the
  // original clients_color_check still rejects anything but the eight preset
  // names, so client insert/update with a custom hex fails with the real
  // Postgres error shape (code 23514).
  legacyClientColorConstraint: false,
  fetchHandlers: {}, // url substring -> (url, opts) => { status?, body? }
  signOutCalls: 0,
  deletedWorkers: [], // worker ids deleted via from('workers').delete()
  deletedProfiles: [], // profile user_ids deleted via from('profiles').delete()
  // Most recent select() column list requested on the `workers` table — the
  // permission-roundtrip tests use it to assert that listWorkers asks for
  // `permissions` (the bug that hid saved access from the admin).
  lastWorkersSelectColumns: null,
  // Most recent update payload applied to the `workers` table.
  lastWorkersUpdatePayload: null,
  // When the database lacks the `permissions` column, .select(...).single()
  // can return a "column not found" error and the test can simulate that by
  // setting this to the error message to surface.
  workersPermissionsColumnMissing: false,
}

export function resetState() {
  state.users = []
  state.profiles = []
  state.workers = []
  state.tasks = []
  state.clients = []
  state.legacyClientColorConstraint = false
  state.authUser = null
  state.getUserError = null
  state.profileQueryError = null
  state.workerRowError = null
  state.fetchHandlers = {}
  state.signOutCalls = 0
  state.deletedWorkers = []
  state.deletedProfiles = []
  state.lastWorkersSelectColumns = null
  state.lastWorkersUpdatePayload = null
  state.workersPermissionsColumnMissing = false
}

function matches(row, filters) {
  return filters.every(([col, val]) => row[col] === val)
}

// The eight built-in client colour tags — exactly what the ORIGINAL
// clients_color_check (before custom colours existed) allows.
const PRESET_CLIENT_COLORS = ['blue', 'aqua', 'violet', 'emerald', 'amber', 'orange', 'rose', 'slate']

/** The real Postgres error a legacy database raises for a custom colour. */
function legacyColorConstraintError() {
  return {
    code: '23514',
    message: 'new row for relation "clients" violates check constraint "clients_color_check"',
  }
}

/** Non-null when this write would trip the legacy preset-only constraint. */
function clientColorViolation(payload) {
  if (!state.legacyClientColorConstraint) return null
  const color = payload && payload.color
  if (color == null) return null
  if (PRESET_CLIENT_COLORS.includes(color)) return null
  return legacyColorConstraintError()
}

function from(table) {
  const filters = []
  // The last `select(columns)` call — used to project the returned rows the
  // way real PostgREST does. The bug we're guarding against only shows up
  // when the column projection actually drops the missing field.
  let lastSelectColumns = null
  // Project a row down to the columns the caller asked for, mirroring the
  // way PostgREST returns exactly the columns in the `select(...)` string.
  // `'*'` is treated as "all columns".
  const project = (row) => {
    if (!row) return row
    const cols = lastSelectColumns
    if (cols == null || cols === '*') return { ...row }
    if (typeof cols !== 'string') return { ...row }
    const wanted = new Set(cols.split(',').map((s) => s.trim()).filter(Boolean))
    const out = {}
    for (const k of Object.keys(row)) if (wanted.has(k)) out[k] = row[k]
    return out
  }
  // The result of awaiting the builder (a list select) — applies the
  // accumulated filters and returns all matching rows.
  const runList = async () => {
    const rows = (state[table] || []).filter((r) => matches(r, filters))
    return { data: rows.map(project), error: null, count: rows.length }
  }
  // The terminal "give me one row" result of .single() / .maybeSingle().
  const runSingle = async () => {
    if (table === 'profiles' && state.profileQueryError) {
      return { data: null, error: { message: state.profileQueryError } }
    }
    if (table === 'workers' && state.workerRowQueryError) {
      return { data: null, error: { message: state.workerRowQueryError } }
    }
    const row = (state[table] || []).find((r) => matches(r, filters))
    return { data: project(row), error: null }
  }
  const baseApi = {
    select: (columns) => {
      if (table === 'workers') state.lastWorkersSelectColumns = columns ?? '*'
      lastSelectColumns = columns ?? '*'
      // Simulate the database rejecting a select that mentions a column the
      // DB does not have. The real supabase-js client does this automatically
      // when PostgREST says PGRST204 / 42703.
      if (table === 'workers' && state.workersPermissionsColumnMissing && typeof columns === 'string' && columns.includes('permissions')) {
        const errApi = {
          ...baseApi,
          // The chain still has to be navigable, so eq/order return the same
          // erroring api; the eventual .single() returns the simulated error.
          eq: () => errApi,
          order: () => errApi,
          limit: () => errApi,
          maybeSingle: async () => ({ data: null, error: { code: 'PGRST204', message: "Could not find the 'permissions' column of 'workers' in the schema cache" } }),
          single: async () => ({ data: null, error: { code: 'PGRST204', message: "Could not find the 'permissions' column of 'workers' in the schema cache" } }),
          // Awaiting the chain itself: a list select also fails the same way.
          then: (resolve) => resolve({ data: null, error: { code: 'PGRST204', message: "Could not find the 'permissions' column of 'workers' in the schema cache" } }),
        }
        return errApi
      }
      // No-op pass-through (already handled above).
      return baseApi
    },
    eq: (col, val) => {
      filters.push([col, val])
      return baseApi
    },
    or: () => baseApi,
    order: () => baseApi,
    limit: () => baseApi,
    maybeSingle: runSingle,
    single: async () => {
      const r = await runSingle()
      if (!r.data) return { data: null, error: { message: 'no rows returned by single()' } }
      return r
    },
    // Awaiting a builder with no terminal call resolves the list query.
    // Matches supabase-js's thenable behaviour.
    then: (resolve) => runList().then(resolve),
    delete: () => ({
      eq: (col, val) =>
        ({
          then: (resolve, reject) => {
            try {
              if (table === 'workers') state.deletedWorkers.push(val)
              if (table === 'profiles') state.deletedProfiles.push(val)
              if (table === 'workers') state.workers = state.workers.filter((r) => r[col] !== val)
              if (table === 'profiles') state.profiles = state.profiles.filter((r) => r[col] !== val)
              resolve({ data: null, error: null })
            } catch (e) {
              reject(e)
            }
          },
        }),
    }),
    insert: (payload) => {
      const inserted = Array.isArray(payload) ? payload : [payload]
      // Tasks: the createTask path inserts a single row and reads it back.
      if (table === 'tasks') {
        return {
          select: () => ({
            single: async () => {
              const row = inserted[0] || {}
              const full = {
                id: row.id || `task-${state.tasks.length + 1}`,
                position: 0,
                completed_at: null,
                archived_at: null,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                ...row,
              }
              state.tasks.push(full)
              return { data: full, error: null }
            },
          }),
        }
      }
      // Clients: createClient inserts a single row and reads it back.
      if (table === 'clients') {
        return {
          select: () => ({
            single: async () => {
              const violation = clientColorViolation(inserted[0])
              if (violation) return { data: null, error: violation }
              const row = inserted[0] || {}
              const full = {
                id: row.id || `client-${state.clients.length + 1}`,
                user_id: state.authUser ? state.authUser.id : null,
                name: row.name,
                color: row.color ?? 'blue',
                status: row.status ?? 'active',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                ...row,
              }
              state.clients.push(full)
              return { data: full, error: null }
            },
          }),
        }
      }
      return {
        single: async () => ({ data: null, error: { message: 'insert not supported in mock' } }),
      }
    },
    update: (payload) => {
      state.lastWorkersUpdatePayload = payload
      return {
        eq: (col, val) => {
          filters.push([col, val])
          return {
            select: () => ({
              single: async () => {
                const violation = table === 'clients' ? clientColorViolation(payload) : null
                if (violation) return { data: null, error: violation }
                const idx = state[table]?.findIndex?.((r) => matches(r, filters))
                if (idx == null || idx < 0) return { data: null, error: { message: 'no rows matched' } }
                state[table][idx] = { ...state[table][idx], ...payload, updated_at: new Date().toISOString() }
                return { data: { ...state[table][idx] }, error: null }
              },
            }),
            // update().eq() without an explicit select() — used by the
            // password reset etc. Apply the patch to every matching row and
            // return ok (PostgREST updates all matches, not just the first).
            then: (resolve) => {
              const rows = state[table]
              if (Array.isArray(rows)) {
                rows.forEach((r, i) => {
                  if (matches(r, filters)) rows[i] = { ...r, ...payload, updated_at: new Date().toISOString() }
                })
              }
              resolve({ data: null, error: null })
            },
          }
        },
      }
    },
  }
  return baseApi
}

function auth() {
  return {
    getUser: async () => {
      if (state.getUserError) return { data: { user: null }, error: new Error(state.getUserError) }
      if (state.authUser) return { data: { user: { id: state.authUser.id, email: state.authUser.email } }, error: null }
      return { data: { user: null }, error: null }
    },
    signInWithPassword: async ({ email, password }) => {
      const user = state.users.find((u) => u.email === email && u.password === password)
      if (!user) return { data: {}, error: { message: 'Invalid login credentials' } }
      state.authUser = { id: user.id, email: user.email }
      return { data: { user: { id: user.id, email: user.email }, session: {} }, error: null }
    },
    signOut: async () => {
      state.authUser = null
      state.signOutCalls += 1
      return { data: null, error: null }
    },
    getSession: async () => ({
      data: { session: state.authUser ? { access_token: 'test-token' } : null },
      error: null,
    }),
    resetPasswordForEmail: async () => ({ data: null, error: null }),
    updateUser: async () => ({ data: {}, error: null }),
  }
}

export function createClient(_url, _key) {
  return { from, auth: auth() }
}

// Guards mirroring the real @supabase/auth-js exports used by supabaseDb.ts.
export function isAuthRetryableFetchError(e) {
  return Boolean(e && typeof e === 'object' && e.name === 'AuthRetryableFetchError')
}
export function isAuthRefreshDiscardedError(e) {
  return Boolean(e && typeof e === 'object' && e.name === 'AuthRefreshDiscardedError')
}
