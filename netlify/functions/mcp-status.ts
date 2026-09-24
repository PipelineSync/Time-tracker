/**
 * GET /mcp-status — one-request health check for a connector deployment.
 *
 * Answers the three questions every "Claude will not connect" report starts
 * with, in a single curl:
 *
 *   1. Are the required environment variables set?      (presence only — the
 *      response names *which* variable, never its value)
 *   2. Can the server reach the three mcp_oauth_* tables via the service-role
 *      key, exactly the way the OAuth flow does?
 *   3. What origin is the connector advertising to Claude? (siteOrigin(), the
 *      same resolution the discovery documents use)
 *
 * Safe to expose: the response carries booleans, the public origin (which
 * /.well-known/oauth-protected-resource already publishes) and PostgREST error
 * messages. No keys, no tokens, no user data, no row counts.
 *
 * Route: wired to /mcp-status by a rewrite in netlify.toml, alongside the
 * other connector routes.
 */

import { adminClient } from './lib/supabase'
import { siteOrigin } from './lib/mcp/oauth'
import { connectorEnv, envPresence } from './lib/mcp/diagnostics'

const OAUTH_TABLES = ['mcp_oauth_clients', 'mcp_oauth_codes', 'mcp_oauth_tokens'] as const

interface TableProbe {
  reachable: boolean
  error: string | null
}

/** One lightweight query per table — the cheapest read the store does. */
async function probeTable(name: string): Promise<TableProbe> {
  try {
    const { error } = await adminClient().from(name).select('*').limit(1)
    if (error) return { reachable: false, error: error.message }
    return { reachable: true, error: null }
  } catch (error) {
    return { reachable: false, error: error instanceof Error ? error.message : 'unreachable' }
  }
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return new Response('Method not allowed.', { status: 405, headers: { Allow: 'GET' } })
  }

  const env = connectorEnv()
  const probes = await Promise.all(OAUTH_TABLES.map(probeTable))
  const tables: Record<string, TableProbe> = {}
  OAUTH_TABLES.forEach((name, index) => {
    tables[name] = probes[index]
  })

  const envSlots = envPresence(env)
  const ok = envSlots.every((slot) => slot.set) && probes.every((probe) => probe.reachable)

  return new Response(
    JSON.stringify(
      {
        service: 'work-tracker-claude-connector',
        checkedAt: new Date().toISOString(),
        ok,
        origin: siteOrigin(request),
        // Presence and variable *names* only — values never leave the server.
        env: Object.fromEntries(
          envSlots.map((slot) => [slot.key, { set: slot.set, variable: slot.variable }]),
        ),
        tables,
      },
      null,
      2,
    ),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    },
  )
}
