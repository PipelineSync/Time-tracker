import { adminClient, json, requireAdmin } from './lib/supabase'

export default async function handler(request: Request) {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' })
  const auth = await requireAdmin(request)
  if ('error' in auth) return auth.error
  const { sb } = auth

  try {
    const body = await request.json() as { workerId?: string; newPassword?: string }
    const workerId = body.workerId || ''
    const newPassword = body.newPassword || ''
    if (!workerId) return json(400, { error: 'Worker id is required.' })
    if (newPassword.length < 6) return json(400, { error: 'New password must be at least 6 characters.' })

    const { data: profile, error: profileError } = await sb
      .from('profiles')
      .select('user_id')
      .eq('worker_id', workerId)
      .eq('role', 'worker')
      .maybeSingle()
    if (profileError) return json(400, { error: profileError.message })
    if (!profile?.user_id) return json(404, { error: 'Worker login account not found.' })

    const { error } = await sb.auth.admin.updateUserById(profile.user_id, { password: newPassword })
    if (error) return json(400, { error: error.message })
    return json(200, { ok: true })
  } catch (error) {
    return json(500, { error: error instanceof Error ? error.message : 'Server error.' })
  }
}
