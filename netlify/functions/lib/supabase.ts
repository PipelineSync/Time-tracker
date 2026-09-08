import { createClient } from '@supabase/supabase-js'

type Json = Record<string, unknown>

const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const secretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY

function json(statusCode: number, body: Json) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { 'Content-Type': 'application/json' },
  })
}

function getBearer(request: Request) {
  const value = request.headers.get('authorization') || ''
  return value.startsWith('Bearer ') ? value.slice(7) : ''
}

export function adminClient() {
  if (!url || !secretKey) throw new Error('Server Supabase credentials are not configured.')
  return createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })
}

export async function requireUser(request: Request) {
  const token = getBearer(request)
  if (!token) return { error: json(401, { error: 'Missing authentication token.' }) }
  try {
    const sb = adminClient()
    const { data: authData, error: authError } = await sb.auth.getUser(token)
    if (authError || !authData.user) return { error: json(401, { error: 'Invalid or expired session.' }) }
    const { data: profile, error: profileError } = await sb
      .from('profiles')
      .select('role, worker_id')
      .eq('user_id', authData.user.id)
      .maybeSingle()
    if (profileError || !profile) return { error: json(403, { error: 'Profile not found.' }) }
    return {
      sb,
      userId: authData.user.id,
      role: profile.role as 'admin' | 'worker',
      workerId: (profile.worker_id as string | null) ?? null,
    }
  } catch (error) {
    return { error: json(500, { error: error instanceof Error ? error.message : 'Server error.' }) }
  }
}

export async function requireAdmin(request: Request) {
  const token = getBearer(request)
  if (!token) return { error: json(401, { error: 'Missing authentication token.' }) }
  try {
    const sb = adminClient()
    const { data: authData, error: authError } = await sb.auth.getUser(token)
    if (authError || !authData.user) return { error: json(401, { error: 'Invalid or expired session.' }) }
    const { data: profile, error: profileError } = await sb
      .from('profiles')
      .select('role')
      .eq('user_id', authData.user.id)
      .maybeSingle()
    if (profileError || profile?.role !== 'admin') return { error: json(403, { error: 'Admin access required.' }) }
    return { sb, userId: authData.user.id, role: 'admin' as const, workerId: null }
  } catch (error) {
    return { error: json(500, { error: error instanceof Error ? error.message : 'Server error.' }) }
  }
}

/**
 * Allow the workspace admin, or a worker the admin granted `permission`
 * (see the Permission list in src/lib/types.ts and the `permissions` column
 * added by supabase/worker-permissions.sql).
 *
 * `ownerId` is always the workspace owner's auth id — rows created here are
 * owned by the workspace, not by whoever happened to click the button.
 */
export async function requireCapability(request: Request, permission: string) {
  const token = getBearer(request)
  if (!token) return { error: json(401, { error: 'Missing authentication token.' }) }
  try {
    const sb = adminClient()
    const { data: authData, error: authError } = await sb.auth.getUser(token)
    if (authError || !authData.user) return { error: json(401, { error: 'Invalid or expired session.' }) }
    const userId = authData.user.id
    const { data: profile, error: profileError } = await sb
      .from('profiles')
      .select('role, worker_id')
      .eq('user_id', userId)
      .maybeSingle()
    if (profileError || !profile) return { error: json(403, { error: 'Profile not found.' }) }
    if (profile.role === 'admin') {
      return { sb, userId, ownerId: userId, role: 'admin' as const, workerId: null as string | null }
    }
    if (!profile.worker_id) return { error: json(403, { error: 'Admin access required.' }) }

    let worker = await sb
      .from('workers')
      .select('id, user_id, permissions')
      .eq('id', profile.worker_id)
      .maybeSingle()
    if (worker.error && /permissions/i.test(worker.error.message || '')) {
      // Database without supabase/worker-permissions.sql: nobody holds any
      // extra capability yet.
      worker = await sb.from('workers').select('id, user_id').eq('id', profile.worker_id).maybeSingle()
    }
    if (worker.error || !worker.data) return { error: json(403, { error: 'Admin access required.' }) }
    const row = worker.data as { id: string; user_id: string; permissions?: unknown }
    const granted = Array.isArray(row.permissions) ? row.permissions : []
    if (!granted.includes(permission)) {
      return { error: json(403, { error: 'You do not have permission to do this.' }) }
    }
    return { sb, userId: row.user_id, ownerId: row.user_id, role: 'worker' as const, workerId: row.id }
  } catch (error) {
    return { error: json(500, { error: error instanceof Error ? error.message : 'Server error.' }) }
  }
}

export { json }
