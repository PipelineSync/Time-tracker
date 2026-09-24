/**
 * Deployment diagnostics shared by the connector's functions.
 *
 * When the connector "does nothing" on sign-in, the cause is almost always
 * environmental: a missing environment variable or an unreachable database.
 * This module exists so every entry point can say so explicitly — naming the
 * **variable** (never its value) — instead of dying with a generic error that
 * is indistinguishable from a broken page inside Claude's small popup.
 *
 * Used by:
 *   - oauth-authorize.ts / oauth-token.ts / mcp.ts  → config preflight + logs
 *   - mcp-status.ts                                 → the /mcp-status report
 */

/** One required setting, the names it may be configured under, and why it exists. */
interface RequiredEnv {
  /** Key in the ConnectorEnvSnapshot. */
  key: 'supabaseUrl' | 'publishableKey' | 'serviceRoleKey'
  /** The preferred variable name, as it appears in .env.example and the docs. */
  variable: string
  /** Other names accepted for the same setting, in priority order. */
  alternates: string[]
  purpose: string
}

/** The variables the connector cannot run without, in report order. */
const REQUIRED_ENV: RequiredEnv[] = [
  {
    key: 'supabaseUrl',
    variable: 'VITE_SUPABASE_URL',
    alternates: ['SUPABASE_URL'],
    purpose: 'the Supabase project URL',
  },
  {
    key: 'publishableKey',
    variable: 'VITE_SUPABASE_PUBLISHABLE_KEY',
    alternates: ['VITE_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY'],
    purpose: 'the publishable key used to verify passwords',
  },
  {
    key: 'serviceRoleKey',
    variable: 'SUPABASE_SECRET_KEY',
    alternates: ['SUPABASE_SERVICE_ROLE_KEY'],
    purpose: 'the server key that reads the connector OAuth tables',
  },
]

export interface ConnectorEnvSnapshot {
  supabaseUrl: string | null
  publishableKey: string | null
  serviceRoleKey: string | null
}

/**
 * Read the connector's settings at call time (not import time), so a status
 * check reflects the environment a request actually runs under.
 */
export function connectorEnv(): ConnectorEnvSnapshot {
  const firstSet = (...names: string[]): string | null => {
    for (const name of names) {
      const value = process.env[name]
      if (value) return value
    }
    return null
  }
  return {
    supabaseUrl: firstSet('VITE_SUPABASE_URL', 'SUPABASE_URL'),
    publishableKey: firstSet(
      'VITE_SUPABASE_PUBLISHABLE_KEY',
      'VITE_SUPABASE_ANON_KEY',
      'SUPABASE_ANON_KEY',
    ),
    serviceRoleKey: firstSet('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'),
  }
}

/**
 * Human-readable descriptions of everything that is missing — the variable
 * *names* and what each one does, never any value.
 */
export function missingConnectorEnv(env: ConnectorEnvSnapshot = connectorEnv()): string[] {
  return REQUIRED_ENV.filter((slot) => !env[slot.key]).map((slot) => {
    const alternates = slot.alternates.length ? ` (or ${slot.alternates.join(' / ')})` : ''
    return `${slot.variable}${alternates} — ${slot.purpose}`
  })
}

/** A sentence naming the missing variables, or null when everything is set. */
export function connectorConfigProblem(env: ConnectorEnvSnapshot = connectorEnv()): string | null {
  const missing = missingConnectorEnv(env)
  if (missing.length === 0) return null
  return (
    `The connector is not configured on the server: missing ${missing.join('; ')}. ` +
    'Set the listed variable(s) under Netlify → Site configuration → Environment variables, then redeploy.'
  )
}

/** Presence of one variable slot, for the /mcp-status report. */
export interface EnvSlotStatus {
  /** Slot name used in the /mcp-status JSON. */
  key: string
  set: boolean
  /** Which concrete variable satisfied the slot — the name only, never a value. */
  variable: string | null
}

/** Presence-only view of the required variables (for GET /mcp-status). */
export function envPresence(env: ConnectorEnvSnapshot = connectorEnv()): EnvSlotStatus[] {
  return REQUIRED_ENV.map((slot) => ({
    key: slot.key,
    set: Boolean(env[slot.key]),
    variable: env[slot.key] ? slot.variable : null,
  }))
}

/**
 * One structured line per event, so the Netlify function log distinguishes a
 * misconfigured deployment from rejected credentials without reading code:
 *
 *   [mcp-oauth] {"event":"authorize.invalid_credentials","supabaseCode":"invalid_credentials"}
 */
export function logConnectorEvent(
  level: 'log' | 'error',
  event: string,
  detail: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({ event, ...detail })
  if (level === 'error') console.error(`[mcp-oauth] ${line}`)
  else console.log(`[mcp-oauth] ${line}`)
}
