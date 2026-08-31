import { adminClient, json } from './lib/supabase'

function getBearer(request: Request) {
  const value = request.headers.get('authorization') || ''
  return value.startsWith('Bearer ') ? value.slice(7) : ''
}

export default async function handler(request: Request) {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' })
  const token = getBearer(request)
  if (!token) return json(401, { error: 'Missing authentication token.' })

  try {
    const sb = adminClient()
    const { data: authData, error: authError } = await sb.auth.getUser(token)
    if (authError || !authData.user) return json(401, { error: 'Invalid or expired session.' })

    const userId = authData.user.id
    const email = (authData.user.email || '').trim().toLowerCase()
    if (!email) return json(400, { error: 'Your account has no email address.' })

    const { data: existing } = await sb
      .from('profiles')
      .select('role, worker_id')
      .eq('user_id', userId)
      .maybeSingle()

    if (existing?.role === 'worker' && existing.worker_id) {
      return json(200, { role: existing.role, workerId: existing.worker_id, repaired: false })
    }

    // Find the workspace admin first, then only match a worker inside that workspace.
    const { data: adminProfile } = await sb
      .from('profiles')
      .select('user_id')
      .eq('role', 'admin')
      .limit(1)
      .maybeSingle()
    if (!adminProfile?.user_id) return json(404, { error: 'No workspace administrator is configured.' })

    const { data: worker } = await sb
      .from('workers')
      .select('id, status')
      .eq('user_id', adminProfile.user_id)
      .eq('email', email)
      .limit(1)
      .maybeSingle()

    if (!worker) return json(404, { error: 'No worker profile matches this login email.' })
    if (worker.status !== 'active') return json(403, { error: 'This worker account is inactive.' })

    const { error: upsertError } = await sb
      .from('profiles')
      .upsert({ user_id: userId, role: 'worker', worker_id: worker.id }, { onConflict: 'user_id' })
    if (upsertError) return json(500, { error: upsertError.message })

    return json(200, { role: 'worker', workerId: worker.id, repaired: true })
  } catch (error) {
    return json(500, { error: error instanceof Error ? error.message : 'Server error.' })
  }
}
