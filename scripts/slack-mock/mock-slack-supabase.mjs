/**
 * Mock stand-in for src/lib/supabaseDb.ts used by verify-slack-local.ts:
 * the Slack verify script runs in demo mode, so Supabase is "not configured"
 * and there is never an access token.
 */
export function isSupabaseConfigured() {
  return false
}

export async function getSupabaseAccessToken() {
  return null
}
