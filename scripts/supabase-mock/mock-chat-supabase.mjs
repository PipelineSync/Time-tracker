/**
 * Minimal mock of @supabase/supabase-js for the team-chat verification script.
 * It only implements the query shapes src/lib/supabaseDb.ts uses for chat, but
 * it evaluates them for real (filters, ordering, limits, the workspace-owner
 * trigger, and the two chat RPCs) so the client code is exercised, not stubbed.
 *
 * State is a plain object the test script edits between scenarios.
 */

export const state = {
  authUser: null, // { id, email } | null — the signed-in user
  profiles: [], // { user_id, role, worker_id }
  workers: [], // { id, user_id, name, email, position, avatar_url, status, hourly_rate }
  settings: [], // { id, user_id, business_name, currency, timezone, avatar_url }
  chat: [], // chat_messages rows, oldest first
  missingFunctions: [], // RPC names that behave as "not in this database yet"
  missingTables: [], // table names that behave as "relation does not exist"
  calls: [], // { table, op } / { rpc } — what the client actually did
}

export function resetState() {
  state.authUser = null
  state.profiles = []
  state.workers = []
  state.settings = []
  state.chat = []
  state.missingFunctions = []
  state.missingTables = []
  state.calls = []
}

let seq = 0
const id = (p) => `${p}-${++seq}`
const clone = (row) => (row ? JSON.parse(JSON.stringify(row)) : row)
const nowIso = () => new Date().toISOString()

const missingTableError = (table) => ({
  code: '42P01',
  message: `relation "public.${table}" does not exist`,
})
const missingFunctionError = (fn) => ({
  code: 'PGRST202',
  message: `Could not find the function public.${fn} within the schema's specifications`,
})

/** The caller's workspace owner, mirroring public.workspace_owner_id(). */
function workspaceOwnerId() {
  const me = state.authUser?.id
  if (!me) return null
  const own = state.profiles.find((p) => p.user_id === me && p.role === 'admin')
  if (own) return own.user_id
  const profile = state.profiles.find((p) => p.user_id === me)
  const worker = profile?.worker_id ? state.workers.find((w) => w.id === profile.worker_id) : null
  return worker?.user_id ?? null
}

function roleOf(userId) {
  return state.profiles.find((p) => p.user_id === userId)?.role ?? null
}

/** public.workspace_members() — the roster, admin first then A→Z by full_name. */
function workspaceMembers() {
  const owner = workspaceOwnerId()
  if (!owner) return []
  const adminProfile = state.profiles.find((p) => p.user_id === owner && p.role === 'admin')
  const rows = []
  if (adminProfile) {
    const s = state.settings.find((x) => x.user_id === owner)
    rows.push({
      worker_id: null,
      user_id: adminProfile.user_id,
      full_name: 'Admin',
      member_role: 'admin',
      member_position: 'Owner',
      avatar_url: s?.avatar_url ?? null,
      worker_status: null,
    })
  }
  for (const w of state.workers.filter((x) => x.user_id === owner)) {
    rows.push({
      worker_id: w.id,
      user_id: state.profiles.find((p) => p.worker_id === w.id)?.user_id ?? null,
      full_name: w.name,
      member_role: 'worker',
      member_position: w.position ?? null,
      avatar_url: w.avatar_url ?? null,
      worker_status: w.status ?? 'active',
    })
  }
  return rows.sort((a, b) => (a.member_role === b.member_role ? a.full_name.localeCompare(b.full_name) : a.member_role === 'admin' ? -1 : 1))
}

/** public.post_chat_message(body) — author identity comes from auth.uid(). */
function postChatMessage(body) {
  const me = state.authUser?.id
  if (!me) return { error: { message: 'Not signed in.' } }
  const text = String(body ?? '').trim()
  if (!text) return { error: { message: 'Write a message first.' } }
  if (text.length > 2000) return { error: { message: 'Message is too long (2000 characters max).' } }
  const profile = state.profiles.find((p) => p.user_id === me)
  if (!profile) return { error: { message: 'No account profile found for this user.' } }
  let name = 'Admin'
  let position = 'Owner'
  let avatar = state.settings.find((s) => s.user_id === me)?.avatar_url ?? null
  let workerId = null
  if (profile.role !== 'admin') {
    const w = state.workers.find((x) => x.id === profile.worker_id)
    if (!w) return { error: { message: 'Worker profile not found.' } }
    name = w.name
    position = w.position ?? null
    avatar = w.avatar_url ?? null
    workerId = w.id
  }
  const row = {
    id: id('chat'),
    user_id: workspaceOwnerId(),
    author_id: me,
    worker_id: workerId,
    author_name: name,
    author_role: profile.role,
    author_position: position,
    author_avatar_url: avatar,
    body: text,
    created_at: nowIso(),
  }
  state.chat.push(row)
  return { data: row }
}

/** The client queries `chat_messages`; state keeps it under the shorter `chat`. */
function rowsOf(table) {
  return table === 'chat_messages' ? state.chat : state[table] ?? []
}
function clearRows(table) {
  if (table === 'chat_messages') state.chat = []
  else state[table] = []
}

function applyEq(rows, filters) {
  return rows.filter((r) => filters.every(([col, val]) => r[col] === val))
}

function tableApi(table, ctx) {
  const filters = []
  let orderCol = null
  let orderDesc = false
  let limitN = null

  const read = () => {
    if (state.missingTables.includes(table)) return { error: missingTableError(table) }
    let rows = applyEq(rowsOf(table), filters)
    if (orderCol) {
      rows = [...rows].sort((a, b) => {
        const cmp = String(a[orderCol] ?? '').localeCompare(String(b[orderCol] ?? ''))
        return orderDesc ? -cmp : cmp
      })
    }
    if (limitN != null) rows = rows.slice(0, limitN)
    return { data: rows.map(clone), error: null }
  }

  const api = {
    select: () => api,
    eq: (col, val) => {
      filters.push([col, val])
      return api
    },
    neq: (col, val) => {
      filters.push([col, 'ANY_NOT_' + val])
      return api
    },
    order: (col, opts) => {
      orderCol = col
      orderDesc = opts?.ascending === false
      return api
    },
    limit: (n) => {
      limitN = n
      return api
    },
    // PostgREST builders are thenable: `await from().select().order().limit()`.
    then: (resolve, reject) => {
      try {
        state.calls.push({ table, op: 'select' })
        resolve(read())
      } catch (e) {
        reject(e)
      }
    },
    maybeSingle: async () => {
      state.calls.push({ table, op: 'select' })
      const r = read()
      return r.error ? r : { data: r.data[0] ?? null, error: null }
    },
    single: async () => {
      state.calls.push({ table, op: 'select' })
      const r = read()
      if (r.error) return { data: null, error: r.error }
      if (!r.data.length) return { data: null, error: { message: 'no rows returned by single()' } }
      return { data: r.data[0], error: null }
    },
    insert: (values) => {
      state.calls.push({ table, op: 'insert' })
      const finish = (result) => ({ select: () => ({ single: async () => result }) })
      if (state.missingTables.includes(table)) return finish({ data: null, error: missingTableError(table) })
      // RLS: only the admin may insert directly, and only for themselves.
      const owner = workspaceOwnerId()
      const isAdmin = roleOf(state.authUser?.id) === 'admin'
      if (!isAdmin || values.author_id !== state.authUser?.id || values.user_id !== owner) {
        return finish({ data: null, error: { message: 'new row violates row-level security policy' } })
      }
      const row = { id: id('chat'), created_at: nowIso(), ...values }
      rowsOf(table).push(row)
      return finish({ data: clone(row), error: null })
    },
    delete: () => ({
      neq: () => {
        state.calls.push({ table, op: 'delete' })
        if (roleOf(state.authUser?.id) !== 'admin') return { error: { message: 'row-level security' } }
        clearRows(table)
        ctx.deleted.push(table)
        return { error: null }
      },
    }),
  }
  return api
}

export function createClient() {
  const ctx = { deleted: [] }
  return {
    __ctx: ctx,
    from: (table) => tableApi(table, ctx),
    auth: {
      getUser: async () =>
        state.authUser
          ? { data: { user: { id: state.authUser.id, email: state.authUser.email } }, error: null }
          : { data: { user: null }, error: null },
      getSession: async () => ({
        data: { session: state.authUser ? { access_token: 'mock-token' } : null },
        error: null,
      }),
      signOut: async () => {
        state.authUser = null
        return { data: null, error: null }
      },
    },
    rpc: async (fn, args) => {
      state.calls.push({ rpc: fn })
      if (state.missingFunctions.includes(fn)) return { data: null, error: missingFunctionError(fn) }
      if (fn === 'workspace_owner_id') return { data: workspaceOwnerId(), error: null }
      if (fn === 'workspace_members') {
        if (state.missingTables.includes('chat_messages')) return { data: null, error: missingTableError('chat_messages') }
        return { data: workspaceMembers(), error: null }
      }
      if (fn === 'post_chat_message') {
        if (state.missingTables.includes('chat_messages')) return { data: null, error: missingTableError('chat_messages') }
        const r = postChatMessage(args?.message_body)
        return r.error ? { data: null, error: r.error } : { data: r.data, error: null }
      }
      return { data: null, error: { message: `unexpected rpc ${fn}` } }
    },
  }
}

export { workspaceMembers, postChatMessage, workspaceOwnerId }
