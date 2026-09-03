import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getConfig } from './config'

/**
 * `chrome.storage.local` behind the storage interface supabase-js expects, so
 * the session survives the popup closing (a popup is torn down the moment it
 * loses focus, which would otherwise sign the worker out on every use).
 */
const chromeStorage = {
  async getItem(key: string): Promise<string | null> {
    const stored = await chrome.storage.local.get(key)
    const value = stored[key]
    return typeof value === 'string' ? value : null
  },
  async setItem(key: string, value: string): Promise<void> {
    await chrome.storage.local.set({ [key]: value })
  },
  async removeItem(key: string): Promise<void> {
    await chrome.storage.local.remove(key)
  },
}

let cached: { url: string; key: string; client: SupabaseClient } | null = null

/**
 * One client per workspace configuration, built the same way the web app builds
 * its client (persisted session + automatic token refresh). Returns null while
 * the extension has no Supabase credentials saved yet.
 */
export async function getClient(): Promise<SupabaseClient | null> {
  const { supabaseUrl, anonKey } = await getConfig()
  if (!supabaseUrl || !anonKey) return null

  if (cached && cached.url === supabaseUrl && cached.key === anonKey) return cached.client

  const client = createClient(supabaseUrl, anonKey, {
    auth: {
      storage: chromeStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  })
  cached = { url: supabaseUrl, key: anonKey, client }
  return client
}

/** Drop the cached client (after saving new credentials, or on sign-out). */
export function resetClient(): void {
  cached = null
}
