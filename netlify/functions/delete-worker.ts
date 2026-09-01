import type { SupabaseClient } from '@supabase/supabase-js'
import { json, requireAdmin } from './lib/supabase'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUserNotFound(message: string): boolean {
  return /not found|no rows|does not exist|404/i.test(message)
}

/**
 * Delete the Supabase Auth account behind a worker. Deleting the auth user
 * cascades their profile row and invalidates every session/JWT they hold, so
 * the worker can no longer sign in.
 */
async function deleteAuthAccountForWorker(
  sb: SupabaseClient,
  profileUserId: string | null,
  workerEmail: string | null,
): Promise<void> {
  if (profileUserId) {
    const { error } = await sb.auth.admin.deleteUser(profileUserId)
    if (error && !isUserNotFound(error.message)) {
      throw new Error(`Could not delete the worker login: ${error.message}`)
    }
    return
  }

  // Legacy fallback: workers created before the profile/account link existed
  // have no profile row pointing at them — locate the login by email instead.
  if (workerEmail) {
    const { data, error } = await sb.auth.admin.listUsers({ perPage: 1000 })
    if (error) throw new Error(`Could not look up the worker login: ${error.message}`)
    const match = (data.users || []).find(
      (u) => (u.email || '').trim().toLowerCase() === workerEmail.trim().toLowerCase(),
    )
    if (match) {
      const del = await sb.auth.admin.deleteUser(match.id)
      if (del.error && !isUserNotFound(del.error.message)) {
        throw new Error(`Could not delete the worker login: ${del.error.message}`)
      }
    }
  }
}

export default async function handler(request: Request) {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' })
  const auth = await requireAdmin(request)
  if ('error' in auth) return auth.error
  const { sb } = auth

  try {
    const body = (await request.json().catch(() => ({}))) as { workerId?: string; all?: boolean }

    // Full reset (Settings → delete all data): remove every worker's login
    // account and all worker data.
    if (body.all === true) {
      const { data: workerProfiles, error: profileError } = await sb
        .from('profiles')
        .select('user_id, worker_id')
        .eq('role', 'worker')
      if (profileError) return json(400, { error: profileError.message })

      // Delete the logins first (auth user → profile row cascades).
      for (const p of workerProfiles || []) {
        await deleteAuthAccountForWorker(sb, p.user_id ?? null, null)
      }
      // Then the data. Worker-row cascades cover entries, timers, payments,
      // comments and entry notifications; the remaining tables are cleared
      // explicitly in case of orphan rows.
      await sb.from('workers').delete().not('id', 'is', null)
      await sb.from('time_entries').delete().not('id', 'is', null)
      await sb.from('active_timers').delete().not('id', 'is', null)
      await sb.from('payments').delete().not('id', 'is', null)
      await sb.from('time_entry_comments').delete().not('id', 'is', null)
      await sb.from('notifications').delete().not('id', 'is', null)
      return json(200, { ok: true })
    }

    const workerId = (body.workerId || '').trim()
    if (!UUID_RE.test(workerId)) return json(400, { error: 'Worker id is required.' })

    const { data: worker } = await sb
      .from('workers')
      .select('id, email')
      .eq('id', workerId)
      .maybeSingle()
    const { data: profile } = await sb
      .from('profiles')
      .select('user_id')
      .eq('worker_id', workerId)
      .eq('role', 'worker')
      .maybeSingle()

    if (!worker && !profile?.user_id) return json(200, { ok: true }) // already gone

    // 1) Remove the worker row — cascades their entries, timers, payments,
    //    comments and notifications, and sets the profile link to null.
    if (worker) {
      const { error } = await sb.from('workers').delete().eq('id', workerId)
      if (error) return json(400, { error: error.message })
    }

    // 2) Remove the login account so the worker can no longer sign in.
    if (profile?.user_id) {
      const { error: profileError } = await sb
        .from('profiles')
        .delete()
        .eq('user_id', profile.user_id)
      if (profileError) return json(400, { error: profileError.message })
      await deleteAuthAccountForWorker(sb, profile.user_id, null)
    } else if (worker?.email) {
      await deleteAuthAccountForWorker(sb, null, worker.email)
    }

    return json(200, { ok: true })
  } catch (error) {
    return json(500, { error: error instanceof Error ? error.message : 'Server error.' })
  }
}
