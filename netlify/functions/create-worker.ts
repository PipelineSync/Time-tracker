import { json, requireCapability } from './lib/supabase'

/**
 * Admin capabilities that may be granted to a worker. Kept in step with
 * PERMISSIONS in src/lib/types.ts (duplicated rather than imported so the
 * function bundle stays independent of the app source).
 *
 * ⚠️ Single source of truth is src/lib/types.ts — when a capability is added
 * there, add it here too. A key missing from this list is silently dropped
 * by cleanPermissions() below, so a worker created through this function
 * would lose the grant without any warning.
 */
const PERMISSIONS = [
  'dashboard.view',
  'workers.view',
  'workers.manage',
  'entries.view_all',
  'entries.manage',
  'tasks.view_all',
  'tasks.manage_all',
  'priority_board.view',
  'meetings.view',
  'invoices.view',
  'payments.view_all',
  'payments.manage',
  'finance.view',
  'finance.manage',
  'finance.subscription',
  'finance.payroll',
  'reports.view',
  'clients.manage',
  'settings.manage',
  // The support desk. Unlike the others this one is NOT part of the admin's
  // own capability set (the queue belongs to whoever runs support), but it is
  // still a key the admin may hand to a worker.
  'it_support.manage',
  // Team KPI dashboard (Owner implies it; this is the Project Manager's tick).
  'team_kpi.view',
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
      position?: string | null;
      workdays?: unknown; weekly_capacity_hours?: unknown;
      permissions?: unknown; accountEmail?: string; accountPassword?: string
    }
    const name = (body.name || '').trim()
    const email = (body.accountEmail || body.email || '').trim().toLowerCase()
    const hourlyRate = Number(body.hourly_rate)
    const status = body.status === 'inactive' ? 'inactive' : 'active'
    const password = body.accountPassword || ''
    const permissions = cleanPermissions(body.permissions)
    const position = (body.position || '').trim() || null
    // Schedule (Team KPI workload): day indexes 0–6 (Sun–Sat) and a positive
    // weekly capacity, defaulting to the standard Mon–Fri / 40h week.
    const days = Array.isArray(body.workdays)
      ? [...new Set(body.workdays.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
      : []
    const schedule = {
      workdays: days.length > 0 ? days : [1, 2, 3, 4, 5],
      weekly_capacity_hours:
        Number.isFinite(Number(body.weekly_capacity_hours)) && Number(body.weekly_capacity_hours) > 0
          ? Number(body.weekly_capacity_hours)
          : 40,
    }

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
    const row = { user_id: userId, name, email, hourly_rate: hourlyRate, status, position }
    let { data: worker, error: workerError } = await sb
      .from('workers')
      .insert({ ...row, permissions, ...schedule })
      .select()
      .single()
    let warning: string | undefined
    if (workerError && /workdays|weekly_capacity_hours/i.test(workerError.message || '')) {
      // Database without supabase/RUN-THIS-team-kpi.sql: create the worker
      // anyway — normalizeWorker() will fill the default Mon–Fri / 40h week.
      ;({ data: worker, error: workerError } = await sb
        .from('workers')
        .insert({ ...row, permissions })
        .select()
        .single())
      if (!workerError) {
        warning =
          'Work schedule was not saved: run supabase/RUN-THIS-team-kpi.sql to set per-worker workweeks for Team KPI.'
      }
    }
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
    if (workerError && /position/i.test(workerError.message || '')) {
      // Very old workers table without the position column.
      const { user_id: _u, position: _p, ...bare } = row
      ;({ data: worker, error: workerError } = await sb.from('workers').insert(bare).select().single())
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
