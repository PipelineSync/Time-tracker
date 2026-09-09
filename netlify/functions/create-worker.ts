import { adminClient, json, requireCapability } from './lib/supabase'

/**
 * Admin capabilities that may be granted to a worker. Kept in step with
 * Permission in src/lib/types.ts (duplicated rather than imported so the
 * function bundle stays independent of the app source).
 */
const PERMISSIONS = [
  'dashboard.view',
  'workers.view',
  'workers.manage',
  'entries.view_all',
  'entries.manage',
  'tasks.view_all',
  'tasks.manage_all',
  'payments.view_all',
  'payments.manage',
  'reports.view',
  'clients.manage',
  'settings.manage',
  'finance.view',
  'finance.manage',
] as const

/** Never trust the client with the grant list — keep only known keys. */
function cleanPermissions(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return PERMISSIONS.filter((p) => value.includes(p))
}

export default async function handler(request: Request) {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' })
  // The admin, or a worker they granted "Add, edit and remove workers".
  const auth = await requireCapability(request, 'workers.manage')
  if ('error' in auth) return auth.error
  const { sb, ownerId: userId } = auth

  try {
    const body = await request.json() as {
      name?: string; email?: string; hourly_rate?: number; status?: 'active' | 'inactive';
      permissions?: unknown; accountEmail?: string; accountPassword?: string
    }
    const name = (body.name || '').trim()
    const email = (body.accountEmail || body.email || '').trim().toLowerCase()
    const hourlyRate = Number(body.hourly_rate)
    const status = body.status === 'inactive' ? 'inactive' : 'active'
    const password = body.accountPassword || ''
    const permissions = cleanPermissions(body.permissions)

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
    const row = { user_id: userId, name, email, hourly_rate: hourlyRate, status }
    let { data: worker, error: workerError } = await sb
      .from('workers')
      .insert({ ...row, permissions })
      .select()
      .single()
    let warning: string | undefined
    if (
      workerError &&
      workerError.message &&
      /workers_permissions_valid/.test(workerError.message)
    ) {
      // The database's permission allow-list predates supabase/finance.sql,
      // which widens it with the finance.* keys. Retry with the older keys
      // only, so the worker still gets everything else they were granted.
      const legacy = permissions.filter((p) => !p.startsWith('finance.'))
      if (legacy.length !== permissions.length) {
        ;({ data: worker, error: workerError } = await sb
          .from('workers')
          .insert({ ...row, permissions: legacy })
          .select()
          .single())
        if (!workerError) {
          warning =
            'Finance access was not saved: run supabase/finance.sql in the Supabase SQL editor to widen the allowed permission keys.'
        }
      }
    }
    if (workerError && /permissions/i.test(workerError.message || '')) {
      // Database without supabase/worker-permissions.sql: still create the
      // worker, just without the extra access.
      ;({ data: worker, error: workerError } = await sb.from('workers').insert(row).select().single())
    }
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

    return json(200, warning ? { worker, warning } : { worker })
  } catch (error) {
    return json(500, { error: error instanceof Error ? error.message : 'Server error.' })
  }
}
