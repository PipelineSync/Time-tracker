/**
 * Refresh a Supabase session from its refresh token.
 *
 * Shared by the token endpoint (keeping a connector alive across days) and by
 * the per-call session resolver (keeping it alive across hours), so both paths
 * behave identically when a session is about to lapse.
 */

import { jwtExpiry } from './crypto'

export interface SupabaseSession {
  accessToken: string
  refreshToken: string
  expiresAt: string | null
}

function credentials(): { url: string; anonKey: string } {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
  const anonKey =
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY

  if (!url || !anonKey) {
    throw new Error('Supabase URL / publishable key are not configured for the connector.')
  }
  return { url, anonKey }
}

/**
 * Exchange a refresh token for a new access/refresh pair.
 *
 * Supabase rotates refresh tokens on use, so the returned pair **replaces**
 * the old one — callers must persist it, or the next refresh will fail.
 */
export async function refreshSupabaseSession(refreshToken: string): Promise<SupabaseSession> {
  const { url, anonKey } = credentials()

  const response = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
  })

  if (!response.ok) {
    throw new Error('Your Work Tracker session expired. Reconnect the Claude connector to sign in again.')
  }

  const payload = (await response.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }

  if (!payload.access_token || !payload.refresh_token) {
    throw new Error('Work Tracker returned an incomplete session. Reconnect the connector.')
  }

  const exp = jwtExpiry(payload.access_token)
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: payload.expires_in
      ? new Date(Date.now() + payload.expires_in * 1000).toISOString()
      : exp === null
        ? null
        : new Date(exp * 1000).toISOString(),
  }
}
