import { adminClient, json, requireAdmin } from './lib/supabase'

export default async function handler(request: Request) {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' })
  const auth = await requireAdmin(request)
  if ('error' in auth) return auth.error
  const { sb, userId } = auth

  try {
    const body = await request.json() as {
      name?: string; email?: string; hourly_rate?: number; status?: 'active' | 'inactive';
      accountEmail?: string; accountPassword?: string
    }
    const name = (body.name || '').trim()
    const email = (body.accountEmail || body.email || '').trim().toLowerCase()
    const hourlyRate = Number(body.hourly_rate)
    const status = body.status === 'inactive' ? 'inactive' : 'active'
    const password = body.accountPassword || ''

    if (!name) return json(400, { error: 'Worker name is required.' })
    if (!email) return json(400, { error: 'Worker login email is required.' })
    if (!Number.isFinite(hourlyRate) || hourlyRate < 0) return json(400, { error: 'Hourly rate is invalid.' })
    if (password.length < 6) return json(400, { error: 'Worker password must be at least 6 characters.' })

    const { data: authData, error: authError } = await sb.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
    if (authError || !authData.user) return json(400, { error: authError?.message || 'Could not create worker login.' })

    const authUserId = authData.user.id
    const { data: worker, error: workerError } = await sb
      .from('workers')
      .insert({ user_id: userId, name, email, hourly_rate: hourlyRate, status })
      .select()
      .single()
    if (workerError || !worker) {
      await sb.auth.admin.deleteUser(authUserId)
      return json(400, { error: workerError?.message || 'Could not create worker.' })
    }

    const { error: profileError } = await sb
      .from('profiles')
      .insert({ user_id: authUserId, role: 'worker', worker_id: worker.id })
    if (profileError) {
      await sb.from('workers').delete().eq('id', worker.id)
      await sb.auth.admin.deleteUser(authUserId)
      return json(400, { error: profileError.message })
    }

    return json(200, { worker })
  } catch (error) {
    return json(500, { error: error instanceof Error ? error.message : 'Server error.' })
  }
}
