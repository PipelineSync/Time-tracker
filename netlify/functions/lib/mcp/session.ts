/**
 * Resolve a connector bearer token into a caller that can query Supabase.
 *
 * This is the security heart of the connector, so it is worth being explicit
 * about the design:
 *
 *   Every MCP tool call runs on a Supabase client authenticated with the
 *   **signed-in user's own access token**, not the service-role key. That
 *   means Row Level Security does the permission checking — the same policies
 *   that decide what the web app shows decide what Claude can see. A worker
 *   who signs in to the connector cannot read another worker's hours, because
 *   the database refuses the query, not because we remembered to filter it.
 *
 * The service-role key is used only for the connector's own OAuth tables
 * (see oauth-store.ts), which are locked to RLS-with-no-policies.
 *
 * Supabase access tokens expire (one hour by default). When a call arrives on
 * a token that is about to expire we refresh the session first and persist the
 * new pair, so a long-lived Claude conversation does not start failing after
 * an hour.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { adminClient } from '../supabase'
import { jwtExpiry } from './crypto'
import { getAccessToken, revokeToken, saveSupabaseSession } from './oauth-store'
import { refreshSupabaseSession } from './session-refresh'

/** Refresh this far ahead of expiry (seconds) so a slow call cannot straddle it. */
const REFRESH_MARGIN_SECONDS = 90

export interface Caller {
  /** Supabase auth user id. */
  userId: string
  email: string | null
  role: 'admin' | 'worker'
  /** The workers row this account is linked to (null for the admin). */
  workerId: string | null
  /** Display name: the admin's business name, or the worker's name. */
  displayName: string
  /** Admin capabilities granted to this account (empty for a plain worker). */
  permissions: string[]
  /** A Supabase client authenticated AS this user — RLS applies. */
  sb: SupabaseClient
  /** The raw MCP access token, so the row can be updated after a refresh. */
  mcpToken: string
}

/**
 * Admin capabilities the connector recognises.
 *
 * Mirrors PERMISSIONS in src/lib/types.ts. Duplicated rather than imported on
 * purpose: the functions bundle stays independent of the app source, exactly
 * like the list in netlify/functions/create-worker.ts.
 */
export const PERMISSIONS = [
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
  'it_support.manage',
  'team_kpi.view',
] as const

export type Permission = (typeof PERMISSIONS)[number]

/** The admin implicitly holds every capability; a worker only their grants. */
export function canDo(caller: Caller, permission: Permission): boolean {
  if (caller.role === 'admin') return true
  return caller.permissions.includes(permission)
}

/** Guard used at the top of every write tool. */
export function requirePermission(caller: Caller, permission: Permission): void {
  if (canDo(caller, permission)) return
  throw new ToolError(
    caller.role === 'admin'
      ? 'This account cannot do that.'
      : `Your Work Tracker account does not have the "${permission}" permission. Ask your administrator to grant it, then reconnect the connector.`,
  )
}

/** An error whose message is safe (and useful) to show Claude verbatim. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolError'
  }
}

/**
 * The bearer token is missing, unknown, or expired.
 *
 * Distinct from ToolError because the HTTP layer must answer with a 401 that
 * carries `WWW-Authenticate` — that header is how OAuth clients discover where
 * to send the user to sign in. A generic 500 would leave Claude with no way to
 * start the login flow.
 */
export class AuthError extends ToolError {
  readonly oauthCode: 'missing' | 'invalid_token'

  constructor(oauthCode: 'missing' | 'invalid_token', message: string) {
    super(message)
    this.name = 'AuthError'
    this.oauthCode = oauthCode
  }
}

function userClient(accessToken: string): SupabaseClient {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
  const anonKey =
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY

  if (!url || !anonKey) {
    throw new Error('Supabase URL / publishable key are not configured for the connector.')
  }

  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  })
}

/**
 * Turn the `Authorization: Bearer <mcp-token>` header into a Caller.
 * Returns null when the token is unknown or expired.
 */
export async function resolveCaller(mcpToken: string): Promise<Caller | null> {
  const token = await getAccessToken(mcpToken)
  if (!token) throw new AuthError('invalid_token', 'This connector token is not valid or has expired.')

  let accessToken = token.supabase_access_token
  let refreshToken = token.supabase_refresh_token

  // Refresh before the session expires rather than after a failed query.
  const exp = jwtExpiry(accessToken)
  const expiringSoon = exp !== null && exp * 1000 - Date.now() < REFRESH_MARGIN_SECONDS * 1000
  if (expiringSoon || !accessToken) {
    try {
      const refreshed = await refreshSupabaseSession(refreshToken)
      accessToken = refreshed.accessToken
      refreshToken = refreshed.refreshToken
      await saveSupabaseSession(mcpToken, refreshed)
    } catch {
      // The Supabase session is gone, so this MCP token can never work again.
      // Retire it: that way Claude's own refresh attempt also fails and the
      // user gets a "sign in again" prompt, instead of Claude silently
      // swapping one dead token for another forever.
      await revokeToken(mcpToken).catch(() => undefined)
      throw new AuthError(
        'invalid_token',
        'Your Work Tracker session expired. Reconnect the Claude connector to sign in again.',
      )
    }
  }

  const sb = userClient(accessToken)

  // Verify the session still works and read the role in one round trip.
  const { data: userData, error: userError } = await sb.auth.getUser(accessToken)
  if (userError || !userData?.user) {
    await revokeToken(mcpToken).catch(() => undefined)
    throw new AuthError(
      'invalid_token',
      'Your Work Tracker session expired. Reconnect the Claude connector to sign in again.',
    )
  }

  const profile = await sb
    .from('profiles')
    .select('role, worker_id')
    .eq('user_id', userData.user.id)
    .maybeSingle()

  // No profile row means we cannot prove any access, so fall back to the least
  // privileged shape (a worker with no grants) rather than to admin.
  const profileRow = profile.data as { role: string; worker_id: string | null } | null
  const role: 'admin' | 'worker' = profileRow?.role === 'admin' ? 'admin' : 'worker'
  const workerId = profileRow?.worker_id ?? null

  let permissions: string[] = []
  let displayName = 'Work Tracker'

  if (role === 'admin') {
    const { data: settings } = await sb.from('settings').select('business_name').maybeSingle()
    displayName = (settings?.business_name as string | undefined) ?? 'Work Tracker'
  } else if (workerId) {
    const { data: worker } = await sb
      .from('workers')
      .select('name, permissions')
      .eq('id', workerId)
      .maybeSingle()
    const workerRow = worker as { name?: string; permissions?: unknown } | null
    displayName = workerRow?.name ?? 'Worker'
    permissions = Array.isArray(workerRow?.permissions)
      ? (workerRow?.permissions as unknown[]).filter((p): p is string => typeof p === 'string')
      : []
  }

  const caller: Caller = {
    userId: userData.user.id,
    email: userData.user.email ?? null,
    role,
    workerId,
    displayName,
    permissions,
    sb,
    mcpToken,
  }

  await adminClient()
    .from('mcp_oauth_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('token_hash', token.token_hash)
    .then(() => undefined, () => undefined)

  return caller
}
