/**
 * Options page: connect the extension to a Work Tracker workspace.
 *
 * The publishable (anon) key plus Row Level Security is what keeps this safe —
 * a worker's session can only ever reach their own rows. That is also why the
 * service-role key must never be pasted in here.
 */

import '../styles/base.css'
import './options.css'
import { clearConfig, ensureHostPermission, getConfig, normalizeSupabaseUrl, originFromConfig, saveConfig } from '../lib/config'
import { getClient, resetClient } from '../lib/supabase'
import { loadState, signOut } from '../lib/api'

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing element #${id}`)
  return node as T
}

const urlInput = el<HTMLInputElement>('cfg-url')
const keyInput = el<HTMLInputElement>('cfg-key')
const reveal = el<HTMLInputElement>('cfg-reveal')
const statusEl = el('cfg-status')
const signinState = el('signin-state')
const signOutBtn = el<HTMLButtonElement>('btn-signout')

function status(message: string | null, tone: 'error' | 'success' | 'info' = 'info') {
  if (!message) {
    statusEl.hidden = true
    return
  }
  statusEl.hidden = false
  statusEl.textContent = message
  statusEl.dataset.tone = tone
}

/**
 * A read against a table protected by RLS: with a valid URL and key it returns
 * either rows or an empty list — never an error. An error therefore means the
 * project URL or the key is wrong.
 */
async function testConnection(): Promise<{ ok: true; host: string } | { ok: false; message: string }> {
  const client = await getClient()
  if (!client) return { ok: false, message: 'Enter both the Project URL and the publishable key.' }
  const { supabaseUrl } = await getConfig()

  try {
    const { error } = await client.from('profiles').select('user_id').limit(1)
    if (error) {
      const code = (error as { code?: string; status?: number }).status
      if (code === 401 || code === 403 || /api key|jwt|Unauthorized/i.test(error.message)) {
        return { ok: false, message: 'Supabase rejected that key. Check you copied the publishable (anon) key.' }
      }
      if (/relation .* does not exist/i.test(error.message)) {
        return {
          ok: false,
          message: 'Connected, but the Work Tracker tables are missing. Run supabase/schema.sql in the SQL editor.',
        }
      }
      return { ok: false, message: error.message }
    }
    return { ok: true, host: new URL(supabaseUrl).host }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/failed to fetch|networkerror|fetch failed/i.test(message)) {
      return { ok: false, message: 'Could not reach that URL. Check the Project URL and your connection.' }
    }
    return { ok: false, message }
  }
}

async function refreshSignInState() {
  const config = await getConfig()
  if (!config.supabaseUrl || !config.anonKey) {
    signinState.textContent = 'Not connected yet — save your workspace details above first.'
    signOutBtn.hidden = true
    return
  }

  signinState.textContent = 'Checking…'
  try {
    const state = await loadState()
    if (state.kind === 'signed-out') {
      signinState.textContent = 'Not signed in. Open the extension from the toolbar to sign in.'
      signOutBtn.hidden = true
    } else if (state.kind === 'not-configured') {
      signinState.textContent = 'Not connected.'
      signOutBtn.hidden = true
    } else {
      const { worker, timer } = state.snapshot
      signinState.textContent = `Signed in as ${worker.name} · ${timer ? (timer.paused ? 'on break' : 'clocked in') : 'clocked out'}`
      signOutBtn.hidden = false
    }
  } catch (error) {
    signinState.textContent = error instanceof Error ? error.message : 'Could not check your sign-in state.'
    signOutBtn.hidden = true
  }
}

el<HTMLButtonElement>('btn-save').addEventListener('click', async () => {
  const { url, error } = normalizeSupabaseUrl(urlInput.value)
  if (error) {
    status(error, 'error')
    return
  }
  const anonKey = keyInput.value.trim()
  if (!anonKey) {
    status('Paste your publishable (anon) key.', 'error')
    return
  }

  const config = { supabaseUrl: url, anonKey }
  urlInput.value = url
  status('Saving…', 'info')
  await saveConfig(config)

  // Ask for access to this one origin (never all websites). Runs inside the
  // click, which Chrome requires for a permission prompt.
  const origin = originFromConfig(config)
  if (origin) await ensureHostPermission(origin)

  resetClient()
  const result = await testConnection()
  if (result.ok) {
    status(`Connected to ${result.host}.`, 'success')
  } else {
    status(result.message, 'error')
  }
  await refreshSignInState()
})

el<HTMLButtonElement>('btn-disconnect').addEventListener('click', async () => {
  await signOut().catch(() => undefined)
  await clearConfig()
  resetClient()
  urlInput.value = ''
  keyInput.value = ''
  status('Disconnected. The extension is back to its factory state.', 'info')
  await refreshSignInState()
})

signOutBtn.addEventListener('click', async () => {
  await signOut().catch(() => undefined)
  await refreshSignInState()
})

reveal.addEventListener('change', () => {
  keyInput.type = reveal.checked ? 'text' : 'password'
})

void (async () => {
  const config = await getConfig()
  urlInput.value = config.supabaseUrl
  keyInput.value = config.anonKey
  await refreshSignInState()
})()
