/**
 * Mock of @supabase/supabase-js used by the verify-delete-supabase.ts script.
 * The module loader redirects '@supabase/supabase-js' to this file.
 */

export const state = {
  users: [], // { id, email, password }
  profiles: [], // { user_id, role, worker_id }
  workers: [], // { id, name, email }
  authUser: null, // { id, email } currently signed in
  getUserError: null, // injected error for auth.getUser
  profileQueryError: null, // injected error for profiles queries
  workerRowQueryError: null, // injected error for workers row-existence queries
  fetchHandlers: {}, // url substring -> (url, opts) => { status?, body? }
  signOutCalls: 0,
  deletedWorkers: [], // worker ids deleted via from('workers').delete()
  deletedProfiles: [], // profile user_ids deleted via from('profiles').delete()
}

export function resetState() {
  state.users = []
  state.profiles = []
  state.workers = []
  state.authUser = null
  state.getUserError = null
  state.profileQueryError = null
  state.workerRowError = null
  state.fetchHandlers = {}
  state.signOutCalls = 0
  state.deletedWorkers = []
  state.deletedProfiles = []
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
      if (table === 'profiles' && state.profileQueryError) {
        return { data: null, error: { message: state.profileQueryError } }
      }
      if (table === 'workers' && state.workerRowQueryError) {
        return { data: null, error: { message: state.workerRowQueryError } }
      }
      const row = (state[table] || []).find((r) => matches(r, filters))
      return { data: row ? { ...row } : null, error: null }
    },
    single: async () => {
      const r = await api.maybeSingle()
      if (!r.data) return { data: null, error: { message: 'no rows returned by single()' } }
      return r
    },
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
    insert: () => ({
      single: async () => ({ data: null, error: { message: 'insert not supported in mock' } }),
    }),
    update: () => ({
      select: () => api,
      single: async () => ({ data: null, error: { message: 'update not supported in mock' } }),
    }),
  }
  return api
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
