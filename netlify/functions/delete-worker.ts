import type { SupabaseClient } from '@supabase/supabase-js'
import { json, requireAdmin, requireCapability } from './lib/supabase'

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
  const body = (await request.json().catch(() => ({}))) as { workerId?: string; all?: boolean }
  // Wiping the workspace stays admin-only; deleting a single worker is the
  // "Add, edit and remove workers" capability, which the admin can delegate.
  const auth = body.all === true
    ? await requireAdmin(request)
    : await requireCapability(request, 'workers.manage')
  if ('error' in auth) return auth.error
  const { sb } = auth
  // A delegate must not delete their own account out from under themselves.
  if ('workerId' in auth && auth.workerId && auth.workerId === (body.workerId || '').trim()) {
    return json(403, { error: 'You cannot delete your own worker account.' })
  }

  try {
    // Full reset (Settings → delete all data): remove every worker's login
    // account and all workspace data scoped to this admin.
    if (body.all === true) {
      const ownerId = auth.userId
      const { data: workerProfiles, error: profileError } = await sb
        .from('profiles')
        .select('user_id, worker_id')
        .eq('role', 'worker')
      if (profileError) return json(400, { error: profileError.message })

      // Only delete worker logins that belong to this workspace (user_id = owner or profile linked to owner's workers).
      // Fetch owner's worker ids to filter.
      const { data: ownerWorkers } = await sb.from('workers').select('id').eq('user_id', ownerId)
      const ownerWorkerIds = new Set((ownerWorkers as Array<{ id: string }> | null)?.map((w) => w.id) ?? [])
      const toDelete = (workerProfiles || []).filter((p) => !p.worker_id || ownerWorkerIds.has(p.worker_id as string))

      // Delete the logins first (auth user → profile row cascades).
      for (const p of toDelete) {
        await deleteAuthAccountForWorker(sb, p.user_id ?? null, null)
      }

      // Helper: delete workspace rows scoped to ownerId, ignoring missing tables (migration not applied).
      async function deleteOwned(table: string) {
        try {
          const res = await sb.from(table).delete().eq('user_id', ownerId)
          if (res.error && !/does not exist|not found in schema/i.test(res.error.message)) {
            console.warn(`[delete-worker] could not clear ${table}:`, res.error.message)
          }
        } catch (e) {
          console.warn(`[delete-worker] could not clear ${table}:`, e)
        }
      }

      // Workspace-owned tables (same set as localDb emptyData + chat + slack + invoices etc)
      // Order matters for FKs: delete children before parents where cascade not guaranteed.
      const workspaceTables = [
        'chat_reactions',
        'chat_messages',
        'time_entry_comments',
        'notifications',
        'active_timers',
        'time_entries',
        'payments',
        'tasks',
        'invoices',
        'meetings',
        'client_priorities',
        'finance_items',
        'clients',
        'slack_settings',
        'workers', // last among workspace tables
      ]
      for (const t of workspaceTables) {
        await deleteOwned(t)
      }

      // Notepad and personal finance are per-auth-user, not workspace-owned.
      // For a full workspace reset, clear the admin's own notepad/slack (already via user_id) and
      // also clear notepad rows for workers whose logins we just deleted.
      // Best-effort: delete notepad_notes for admin + deleted worker user_ids.
      try {
        const adminAndWorkerUserIds = [ownerId, ...toDelete.map((p) => p.user_id).filter(Boolean)] as string[]
        if (adminAndWorkerUserIds.length > 0) {
          await sb.from('notepad_notes').delete().in('user_id', adminAndWorkerUserIds)
        }
      } catch {
        // table may not exist yet
      }

      // Keep settings row? Local demo wipes settings (emptyData). For Supabase we preserve settings
      // to avoid orphaning workspace, but clear heavy columns? Original behavior kept settings.
      // We'll keep settings for now to match previous prod behavior.

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
