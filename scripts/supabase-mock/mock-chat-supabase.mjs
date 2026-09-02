/**
 * Minimal mock of @supabase/supabase-js for the team-chat / settlement
 * verification scripts. It only implements the query shapes
 * src/lib/supabaseDb.ts uses for chat, notifications, time entries and payments,
 * but it evaluates them for real (filters, ordering, limits, the workspace-owner
 * trigger, per-table RLS, and the chat/settlement RPCs) so the client code is
 * exercised, not stubbed.
 *
 * State is a plain object the test script edits between scenarios.
 */

export const state = {
  authUser: null, // { id, email } | null — the signed-in user
  profiles: [], // { user_id, role, worker_id }
  workers: [], // { id, user_id, name, email, position, avatar_url, status, hourly_rate }
  settings: [], // { id, user_id, business_name, currency, timezone, avatar_url }
  chat: [], // chat_messages rows, oldest first
  notifications: [], // { id, user_id, entry_id, type, message, read, created_at }
  timeEntries: [], // time_entries rows
  payments: [], // payments rows
  missingFunctions: [], // RPC names that behave as "not in this database yet"
  missingTables: [], // table names that behave as "relation does not exist"
  missingColumns: [], // columns that behave as "not in this database yet"
  calls: [], // { table, op } / { rpc } — what the client actually did
}

export function resetState() {
  state.authUser = null
  state.profiles = []
  state.workers = []
  state.settings = []
  state.chat = []
  state.notifications = []
  state.timeEntries = []
  state.payments = []
  state.missingFunctions = []
  state.missingTables = []
  state.missingColumns = []
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
const missingColumnError = (table, column) => ({
  code: '42703',
  message: `Could not find the '${table}.${column}' column of '${table}' in the schema cache`,
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

/**
 * public.notify_chat_message(chat_id) — one notification row per member of the
 * workspace except the author (see supabase/chat-notifications.sql).
 */
function notifyChatMessage(chatId) {
  const me = state.authUser?.id
  if (!me) return { error: { message: 'Not signed in.' } }
  const msg = state.chat.find((m) => m.id === chatId)
  if (!msg) return { error: { message: 'Chat message not found.' } }
  if (msg.author_id !== me) return { error: { message: 'You can only notify about your own message.' } }
  let preview = String(msg.body).replace(/\s+/g, ' ').trim()
  if (preview.length > 120) preview = `${preview.slice(0, 119)}…`
  let inserted = 0
  for (const member of workspaceMembers()) {
    if (!member.user_id || member.user_id === msg.author_id) continue
    state.notifications.push({
      id: id('notif'),
      user_id: member.user_id,
      entry_id: null,
      type: 'chat',
      message: `${msg.author_name}: ${preview}`,
      read: false,
      created_at: nowIso(),
    })
    inserted += 1
  }
  return { data: inserted }
}

/** The client queries `chat_messages` / `time_entries`; state uses short keys. */
const tableKey = (table) => (table === 'chat_messages' ? 'chat' : table === 'time_entries' ? 'timeEntries' : table)
function rowsOf(table) {
  return state[tableKey(table)] ?? []
}
function setRows(table, rows) {
  state[tableKey(table)] = rows
}

function applyEq(rows, filters) {
  return rows.filter((r) =>
    filters.every(([col, val]) => {
      if (val && typeof val === 'object' && val.kind === 'is') return (r[col] ?? null) === val.val
      if (val && typeof val === 'object' && val.kind === 'in') return val.vals.includes(r[col])
      if (typeof val === 'string' && val.startsWith('ANY_NOT_')) return r[col] !== val.slice('ANY_NOT_'.length)
      return r[col] === val
    })
  )
}

/** First filter that names a column this "database" does not have. */
function missingColumnOf(table, columns) {
  const found = columns.find((c) => state.missingColumns.includes(c))
  return found ? missingColumnError(table, found) : null
}

function tableApi(table, ctx) {
  const filters = []
  let orderCol = null
  let orderDesc = false
  let limitN = null

  const read = () => {
    if (state.missingTables.includes(table)) return { error: missingTableError(table) }
    const missingCol = missingColumnOf(table, filters.map(([c]) => c))
    if (missingCol) return { data: null, error: missingCol }
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
    is: (col, val) => {
      filters.push([col, { kind: 'is', val }])
      return api
    },
    in: (col, vals) => {
      filters.push([col, { kind: 'in', vals }])
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
      const missingCol = missingColumnOf(table, Object.keys(values))
      if (missingCol) return finish({ data: null, error: missingCol })
      // Row Level Security, per table (see supabase/schema.sql).
      const owner = workspaceOwnerId()
      const me = state.authUser?.id
      const isAdmin = roleOf(me) === 'admin'
      let allowed
      if (table === 'chat_messages') {
        allowed = isAdmin && values.author_id === me && values.user_id === owner
      } else if (table === 'notifications') {
        // A worker may only notify themselves or the workspace admin.
        allowed = isAdmin || values.user_id === me || values.user_id === owner
      } else if (table === 'payments') {
        allowed = isAdmin && values.user_id === me
      } else {
        allowed = isAdmin
      }
      if (!allowed) return finish({ data: null, error: { message: 'new row violates row-level security policy' } })
      const row = { id: id(tableKey(table)), created_at: nowIso(), ...values }
      // set_user_id() trigger: workspace-owned tables get the owner stamped.
      if (table !== 'chat_messages' && row.user_id == null) row.user_id = owner
      rowsOf(table).push(row)
      return finish({ data: clone(row), error: null })
    },
    update: (values) => {
      const apply = () => {
        state.calls.push({ table, op: 'update' })
        if (state.missingTables.includes(table)) return { data: null, error: missingTableError(table) }
        const missingCol =
          missingColumnOf(table, Object.keys(values)) ?? missingColumnOf(table, filters.map(([c]) => c))
        if (missingCol) return { data: null, error: missingCol }
        if (roleOf(state.authUser?.id) !== 'admin') {
          return { data: null, error: { message: 'new row violates row-level security policy' } }
        }
        const targets = applyEq(rowsOf(table), filters)
        for (const t of targets) Object.assign(t, values)
        return { data: targets.map(clone), error: null }
      }
      const chain = {
        eq: (col, val) => {
          filters.push([col, val])
          return chain
        },
        is: (col, val) => {
          filters.push([col, { kind: 'is', val }])
          return chain
        },
        in: (col, vals) => {
          filters.push([col, { kind: 'in', vals }])
          return chain
        },
        select: () => ({
          single: async () => {
            const r = apply()
            if (r.error) return { data: null, error: r.error }
            if (!r.data.length) return { data: null, error: { message: 'no rows returned by single()' } }
            return { data: r.data[0], error: null }
          },
        }),
        then: (resolve, reject) => {
          try {
            resolve(apply())
          } catch (e) {
            reject(e)
          }
        },
      }
      return chain
    },
    delete: () => {
      const chain = {
        eq: (col, val) => {
          filters.push([col, val])
          return chain
        },
        neq: (col, val) => {
          filters.push([col, 'ANY_NOT_' + val])
          return chain
        },
        then: (resolve, reject) => {
          try {
            state.calls.push({ table, op: 'delete' })
            if (roleOf(state.authUser?.id) !== 'admin') {
              resolve({ error: { message: 'row-level security' } })
              return
            }
            const rows = rowsOf(table)
            const doomed = new Set(applyEq(rows, filters).map((r) => r.id))
            setRows(table, rows.filter((r) => !doomed.has(r.id)))
            ctx.deleted.push(table)
            resolve({ error: null })
          } catch (e) {
            reject(e)
          }
        },
      }
      return chain
    },
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
        // A real Supabase session carries the signed-in user and a per-user
        // access token; mirror that so code keyed on the session (e.g. the
        // identity cache) can tell two accounts apart.
        data: {
          session: state.authUser
            ? {
                access_token: `mock-token-${state.authUser.id}`,
                refresh_token: `mock-refresh-${state.authUser.id}`,
                user: { id: state.authUser.id, email: state.authUser.email },
              }
            : null,
        },
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
      if (fn === 'notify_chat_message') {
        if (state.missingTables.includes('chat_messages')) return { data: null, error: missingTableError('chat_messages') }
        const r = notifyChatMessage(args?.p_chat_id)
        return r.error ? { data: null, error: r.error } : { data: r.data, error: null }
      }
      return { data: null, error: { message: `unexpected rpc ${fn}` } }
    },
  }
}

export { workspaceMembers, postChatMessage, notifyChatMessage, workspaceOwnerId }

// Guards mirroring the real @supabase/auth-js exports used by supabaseDb.ts.
export function isAuthRetryableFetchError(e) {
  return Boolean(e && typeof e === 'object' && e.name === 'AuthRetryableFetchError')
}
export function isAuthRefreshDiscardedError(e) {
  return Boolean(e && typeof e === 'object' && e.name === 'AuthRefreshDiscardedError')
}
