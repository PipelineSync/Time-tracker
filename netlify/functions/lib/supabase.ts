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

export { json }
