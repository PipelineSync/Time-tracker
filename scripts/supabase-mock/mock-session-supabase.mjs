/**
 * Mock of @supabase/supabase-js used by verify-session-supabase.ts.
 *
 * Emulates just enough of the auth surface that src/lib/supabaseDb.ts uses for
 * session handling (getSession / getUser / setSession / signOut /
 * signInWithPassword), plus the row lookups behind the profile checks. The
 * module loader redirects '@supabase/supabase-js' to this file.
 *
 * The mock keeps a "server side" registry of issued refresh/access tokens so
 * tests can simulate real-world states: a wiped localStorage session whose
 * refresh token is still valid server-side (recoverable), a revoked token
 * (must sign out), a transient network failure (must NOT sign out), etc.
 */

let seq = 1
const now = () => Date.now() / 1000

export const state = {
  /** The session currently "persisted" (localStorage) — null = signed out. */
  storedSession: null,
  /** Auth users the mock server knows: { id, email, password }. */
  users: [],
  /** Profiles rows: { user_id, role, worker_id }. */
  profiles: [],
  /** Worker rows: { id }. */
  workers: [],
  /** "Server side" registry of issued sessions, by refresh and access token. */
  serverByRefresh: new Map(),
  serverByAccess: new Map(),
  /**
   * Failure injection:
   *  - getUser:  'ok' | 'network' | 'invalid' (invalid flips back to 'ok' after
   *    one call, simulating an access token that was bad once but refreshed OK)
   *  - setSession: 'auto' | 'network' | 'reject'
   *  - getSession: 'ok' | 'network'
   */
  modes: { getUser: 'ok', setSession: 'auto', getSession: 'ok' },
  calls: { getSession: 0, getUser: 0, setSession: 0, signOut: 0, signInWithPassword: 0 },
  lastSetSessionArgs: null,
}

export function resetState() {
  state.storedSession = null
  state.users = []
  state.profiles = []
  state.workers = []
  state.serverByRefresh = new Map()
  state.serverByAccess = new Map()
  state.modes = { getUser: 'ok', setSession: 'auto', getSession: 'ok' }
  state.calls = { getSession: 0, getUser: 0, setSession: 0, signOut: 0, signInWithPassword: 0 }
  state.lastSetSessionArgs = null
}

function sessionError(status, message) {
  return { name: 'AuthApiError', status, message }
}
function retryableError(message) {
  return { name: 'AuthRetryableFetchError', message }
}

/** Issue a brand-new session for a user and register it "server side". */
export function signInAs(user, { expired = false } = {}) {
  const session = {
    access_token: `at-${seq++}`,
    refresh_token: `rt-${seq++}`,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: now() + 3600,
    user: { id: user.id, email: user.email },
  }
  if (expired) session.expires_at = now() - 60
  state.serverByRefresh.set(session.refresh_token, session)
  state.serverByAccess.set(session.access_token, session)
  state.storedSession = session
  return session
}

/** Rotate a server-known session (what a successful /token call does). */
function rotate(session) {
  const next = { ...session, access_token: `at-${seq++}`, refresh_token: `rt-${seq++}`, expires_at: now() + 3600 }
  state.serverByRefresh.delete(session.refresh_token)
  state.serverByAccess.delete(session.access_token)
  state.serverByRefresh.set(next.refresh_token, next)
  state.serverByAccess.set(next.access_token, next)
  return next
}

function matches(row, filters) {
  return filters.every(([col, val]) => row[col] === val)
}

function from(table) {
  const filters = []
  const api = {
    select: () => api,
    eq: (col, val) => {
      filters.push([col, val])
      return api
    },
    or: () => api,
    order: () => api,
    limit: () => api,
    maybeSingle: async () => {
      const row = (state[table] || []).find((r) => matches(r, filters))
      return { data: row ? { ...row } : null, error: null }
    },
  }
  return api
}

export function createClient(_url, _anonKey) {
  return {
    auth: {
      async getSession() {
        state.calls.getSession += 1
        if (state.modes.getSession === 'network') {
          return { data: { session: null }, error: retryableError('Failed to fetch') }
        }
        return { data: { session: state.storedSession }, error: null }
      },
      async getUser() {
        state.calls.getUser += 1
        if (state.modes.getUser === 'network') {
          return { data: { user: null }, error: retryableError('Failed to fetch') }
        }
        if (state.modes.getUser === 'invalid') {
          // One-time failure: the current access token is rejected...
          state.modes.getUser = 'ok'
          return { data: { user: null }, error: sessionError(400, 'invalid JWT') }
        }
        const session = state.storedSession
        if (!session) {
          return { data: { user: null }, error: { name: 'AuthSessionMissingError', message: 'No session' } }
        }
        return { data: { user: session.user }, error: null }
      },
      async setSession({ access_token, refresh_token }) {
        state.calls.setSession += 1
        state.lastSetSessionArgs = { access_token, refresh_token }
        if (state.modes.setSession === 'network') {
          return { data: { session: null, user: null }, error: retryableError('Failed to fetch') }
        }
        if (state.modes.setSession === 'reject') {
          return { data: { session: null, user: null }, error: sessionError(400, 'invalid grant: refresh token not found') }
        }
        // 'auto': emulate @supabase/auth-js _setSession — refresh the session
        // when the access token has expired, otherwise validate it.
        const known = state.serverByRefresh.get(refresh_token)
        if (known) {
          const rotated = rotate(known)
          state.storedSession = rotated
          return { data: { session: rotated, user: rotated.user }, error: null }
        }
        const byAccess = state.serverByAccess.get(access_token)
        if (byAccess) {
          state.storedSession = byAccess
          return { data: { session: byAccess, user: byAccess.user }, error: null }
        }
        return { data: { session: null, user: null }, error: sessionError(400, 'invalid grant: session not found') }
      },
      async signOut() {
        state.calls.signOut += 1
        state.storedSession = null
        return { error: null }
      },
      async signInWithPassword({ email, password }) {
        state.calls.signInWithPassword += 1
        const user = state.users.find((u) => u.email === email && u.password === password)
        if (!user) return { data: { session: null, user: null }, error: sessionError(400, 'Invalid login credentials') }
        const session = signInAs(user)
        return { data: { session, user: session.user }, error: null }
      },
    },
    from,
  }
}

// Guards mirroring the real @supabase/auth-js exports used by supabaseDb.ts.
export function isAuthRetryableFetchError(e) {
  return Boolean(e && typeof e === 'object' && e.name === 'AuthRetryableFetchError')
}
export function isAuthRefreshDiscardedError(e) {
  return Boolean(e && typeof e === 'object' && e.name === 'AuthRefreshDiscardedError')
}
