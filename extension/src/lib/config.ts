/**
 * Workspace configuration for the extension.
 *
 * The extension is deliberately shipped unconfigured: whoever installs it
 * pastes the Supabase Project URL and the publishable (anon) key into the
 * Options page once, and both are kept in `chrome.storage.local`.
 *
 * Only ever store the **publishable / anon** key here. The service-role key
 * bypasses Row Level Security and must never be put in an extension.
 */

export interface ExtensionConfig {
  supabaseUrl: string
  anonKey: string
}

const STORAGE_KEY = 'workTracker.config'

export const EMPTY_CONFIG: ExtensionConfig = { supabaseUrl: '', anonKey: '' }

export async function getConfig(): Promise<ExtensionConfig> {
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  const raw = stored[STORAGE_KEY] as Partial<ExtensionConfig> | undefined
  return {
    supabaseUrl: (raw?.supabaseUrl ?? '').trim(),
    anonKey: (raw?.anonKey ?? '').trim(),
  }
}

export async function saveConfig(config: ExtensionConfig): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      supabaseUrl: config.supabaseUrl.trim(),
      anonKey: config.anonKey.trim(),
    },
  })
}

export async function clearConfig(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY)
}

export function isConfigured(config: ExtensionConfig): boolean {
  return Boolean(config.supabaseUrl && config.anonKey)
}

/**
 * Accepts whatever someone pastes out of the Supabase dashboard — a full
 * `https://xyz.supabase.co`, one with a trailing slash or a path, or just the
 * project ref — and returns the bare origin.
 */
export function normalizeSupabaseUrl(input: string): { url: string; error: string | null } {
  const value = input.trim().replace(/\/+$/, '')
  if (!value) return { url: '', error: 'Enter your Supabase Project URL.' }

  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}.supabase.co`
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return { url: '', error: 'That does not look like a valid URL.' }
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && !parsed.hostname.endsWith('.localhost')) {
    return { url: '', error: 'The Project URL must use https://.' }
  }
  return { url: parsed.origin, error: null }
}

/**
 * The single origin the extension talks to. Used to request (and later check)
 * the optional host permission, so Chrome never asks for access to *every*
 * website — only to the worker's own Supabase project.
 */
export function originFromConfig(config: ExtensionConfig): string | null {
  if (!isConfigured(config)) return null
  try {
    return new URL(config.supabaseUrl).origin
  } catch {
    return null
  }
}

/** Ask Chrome for permission to reach this workspace. Must run in a click. */
export async function ensureHostPermission(origin: string): Promise<boolean> {
  if (!origin.startsWith('https://')) return true
  try {
    const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] })
    if (granted) return true
    return await chrome.permissions.request({ origins: [`${origin}/*`] })
  } catch {
    // Supabase sends permissive CORS headers, so the popup still works without
    // it. Never let a permission prompt failure block a punch.
    return false
  }
}
