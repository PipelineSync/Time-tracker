/**
 * POST /mcp — the Claude Connector (remote MCP server).
 *
 * This is the endpoint you paste into Claude under
 * Settings → Connectors → Add custom connector:
 *
 *     https://<your-site>.netlify.app/mcp
 *
 * Claude registers itself (POST /oauth/register), sends you to
 * /oauth/authorize to sign in, and then calls this endpoint with a bearer
 * token. Every tool call runs as the account that signed in, so a worker's
 * connector can never see another worker's data — the database enforces it.
 *
 * Transport: Streamable HTTP, stateless. Every POST carries its own token and
 * its own JSON-RPC request(s); there is no session state to keep alive, which
 * is what lets this run as a serverless function.
 */

import {
  handleJsonRpc,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from './lib/mcp/protocol'
import { AuthError, resolveCaller, type Caller } from './lib/mcp/session'
import { siteOrigin } from './lib/mcp/oauth'
import { connectorConfigProblem, logConnectorEvent, missingConnectorEnv } from './lib/mcp/diagnostics'

/** Used when the client does not send an Mcp-Protocol-Version header. */
const DEFAULT_PROTOCOL_VERSION = LATEST_PROTOCOL_VERSION

function cors(request: Request): Record<string, string> {
  // Claude's connector handshake is cross-origin from claude.ai, so the
  // preflight has to be answered. The allowed origin is echoed rather than
  // wildcarded because these responses carry credentials.
  const origin = request.headers.get('origin')
  return {
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, Mcp-Protocol-Version, Mcp-Session-Id, Accept',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // Tool results are live business data; nothing here may be cached.
      'Cache-Control': 'no-store',
      ...extra,
    },
  })
}

/** Tell an unauthenticated client exactly where to authenticate (RFC 6750). */
function unauthorized(request: Request, authError: AuthError): Response {
  const origin = siteOrigin(request)
  const description =
    authError.oauthCode === 'missing'
      ? 'This connector requires an OAuth token.'
      : 'The access token is invalid or has expired.'

  return new Response(null, {
    status: 401,
    headers: {
      'WWW-Authenticate':
        `Bearer realm="work-tracker", error="${authError.oauthCode}", ` +
        `error_description="${description}", ` +
        `resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      'Cache-Control': 'no-store',
      ...cors(request),
    },
  })
}

function bearerToken(request: Request): string {
  const header = request.headers.get('authorization') ?? ''
  if (!header.toLowerCase().startsWith('bearer ')) return ''
  return header.slice(7).trim()
}

/**
 * A 500 that names the missing variable, for callers that already presented a
 * bearer token. It must never run for tokenless requests: without a token,
 * every method on /mcp answers 401 first (RFC 9728 §5.1) — that header is
 * what makes Claude detect the OAuth flow at all.
 */
function missingConfigResponse(problem: string): Response {
  logConnectorEvent('error', 'mcp.config_missing', { missing: missingConnectorEnv() })
  return json(
    { jsonrpc: '2.0', id: null, error: { code: -32603, message: problem } },
    500,
  )
}

export default async function handler(request: Request): Promise<Response> {
  const protocolVersion =
    request.headers.get('mcp-protocol-version') ?? DEFAULT_PROTOCOL_VERSION

  // ---- CORS preflight -----------------------------------------------------
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors(request) })
  }

  const headers = (extra: Record<string, string> = {}) => ({
    'MCP-Protocol-Version': (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(protocolVersion)
      ? protocolVersion
      : DEFAULT_PROTOCOL_VERSION,
    ...cors(request),
    ...extra,
  })

  // ---- Liveness / protocol probe -----------------------------------------
  // Some hosts HEAD the endpoint before connecting to check the transport.
  // Require authentication so unauthenticated probes cannot read the server
  // as open.
  if (request.method === 'HEAD') {
    const token = bearerToken(request)
    if (!token) {
      return unauthorized(request, new AuthError('missing', 'This connector requires an OAuth token.'))
    }
    const configProblem = connectorConfigProblem()
    if (configProblem) {
      return missingConfigResponse(configProblem)
    }
    try {
      await resolveCaller(token)
      return new Response(null, { status: 200, headers: headers() })
    } catch (error) {
      if (error instanceof AuthError) {
        return unauthorized(request, error)
      }
      throw error
    }
  }

  if (request.method === 'GET') {
    return json(
      {
        error: 'This MCP server uses the Streamable HTTP transport with JSON responses.',
        hint: 'Send JSON-RPC 2.0 requests as POST /mcp. It does not open an SSE stream.',
      },
      405,
      { ...headers(), Allow: 'POST, DELETE, HEAD, OPTIONS' },
    )
  }

  // ---- Session termination -----------------------------------------------
  // There is no server-side session to destroy (every request is self
  // contained), so this is an acknowledgement rather than an error.
  if (request.method === 'DELETE') {
    const token = bearerToken(request)
    if (token) {
      const { revokeToken } = await import('./lib/mcp/oauth-store')
      await revokeToken(token).catch(() => undefined)
    }
    return new Response(null, { status: 204, headers: headers() })
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed.' }, 405, {
      ...headers(),
      Allow: 'POST, DELETE, HEAD, OPTIONS',
    })
  }

  // ---- Parse -------------------------------------------------------------
  // Config preflight for authenticated calls: with a token in hand, a missing
  // environment variable should name itself instead of surfacing as a generic
  // internal error. Without a token the 401 gate above already ran — and must
  // keep running first, because it is what Claude's OAuth detection uses.
  if (bearerToken(request)) {
    const configProblem = connectorConfigProblem()
    if (configProblem) {
      return json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: configProblem } }, 500, {
        ...headers(),
      })
    }
  }

  let body: unknown
  try {
    const text = await request.text()
    body = text ? JSON.parse(text) : null
  } catch {
    return json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON in the request body.' } },
      400,
      headers(),
    )
  }

  // Resolve the caller lazily and once per request: `initialize` never needs a
  // token, and a batch of tool calls should not re-read the token row for each.
  let cached: Caller | null = null
  let resolved = false
  const callerFactory = async (): Promise<Caller | null> => {
    if (resolved) return cached
    const token = bearerToken(request)
    if (!token) {
      throw new AuthError('missing', 'This connector requires an OAuth token.')
    }
    cached = await resolveCaller(token)
    resolved = true
    return cached
  }

  let response: { status: number; payload: unknown; authError?: AuthError }
  try {
    response = await handleJsonRpc(body, protocolVersion, callerFactory)
  } catch (error) {
    if (error instanceof AuthError) {
      return unauthorized(request, error)
    }
    console.error('[mcp] unhandled error:', error)
    logConnectorEvent('error', 'mcp.unhandled_error', {
      message: error instanceof Error ? error.message : String(error),
    })
    return json(
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Internal error.',
        },
      },
      500,
      headers(),
    )
  }

  if (response.authError) return unauthorized(request, response.authError)
  if (response.payload === null) {
    // An all-notifications batch, or a session termination: 202 with no body.
    return new Response(null, { status: response.status, headers: headers() })
  }

  return json(response.payload, response.status, headers())
}
