/**
 * OAuth 2.1 pieces shared by the authorization, token and discovery endpoints.
 *
 * The connector is both the **authorization server** and the **resource
 * server** for one MCP endpoint, which is the arrangement Claude expects from
 * a self-hosted connector:
 *
 *   GET  /.well-known/oauth-authorization-server   → how to authenticate
 *   GET  /.well-known/oauth-protected-resource     → where to authenticate
 *   POST /oauth/register                           → Dynamic Client Registration
 *   GET  /oauth/authorize                          → sign-in + consent page
 *   POST /oauth/authorize                          → credentials → auth code
 *   POST /oauth/token                              → code/PKCE/refresh → tokens
 *
 * PKCE (S256) is mandatory: Claude will not complete the flow without it, and
 * it is what makes a public client safe to register on the fly.
 */

/**
 * Redirect URIs the connector will send a browser back to.
 *
 * Hosted Claude uses a fixed callback; Claude Code uses a loopback address
 * with an unpredictable port, so loopback matching is port-agnostic. Anything
 * else is rejected — an open redirector is the classic way an OAuth server
 * leaks an authorization code to an attacker.
 */
const CLAUDE_CALLBACKS = ['https://claude.ai/api/mcp/auth_callback']

function isLoopbackCandidate(raw: string): boolean {
  try {
    const url = new URL(raw)
    const host = url.hostname.toLowerCase()
    if (url.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1' || host === '[::1]')) {
      return true
    }
    // Custom native schemes (myapp://oauth) are legitimate for desktop clients.
    return /^[a-z][a-z0-9+.-]*:$/i.test(url.protocol) && url.protocol !== 'http:' && url.protocol !== 'https:'
  } catch {
    return false
  }
}

export function isAllowedRedirectUri(raw: string): boolean {
  if (CLAUDE_CALLBACKS.includes(raw)) return true
  return isLoopbackCandidate(raw)
}

/** Validate every redirect URI before a client is registered with it. */
export function validateRedirectUris(values: unknown): { ok: true; uris: string[] } | { ok: false; error: string } {
  if (!Array.isArray(values) || values.length === 0) {
    return { ok: false, error: 'redirect_uris must be a non-empty array.' }
  }
  const uris: string[] = []
  for (const value of values) {
    if (typeof value !== 'string' || !isAllowedRedirectUri(value)) {
      return {
        ok: false,
        error: `Redirect URI "${String(value)}" is not allowed. Use https://claude.ai/api/mcp/auth_callback, a loopback URL, or a custom app scheme.`,
      }
    }
    uris.push(value)
  }
  return { ok: true, uris }
}

/** The absolute origin of this deployment, e.g. https://tracker.example.com. */
export function siteOrigin(request: Request): string {
  const configured = process.env.MCP_PUBLIC_URL || process.env.URL || process.env.DEPLOY_PRIME_URL
  if (configured) return configured.replace(/\/+$/, '')

  // Behind Netlify's proxy the public scheme/host arrive in forwarded headers;
  // falling back to the request URL would produce an http:// origin on stage.
  const forwardedHost = request.headers.get('x-forwarded-host')
  const forwardedProto = request.headers.get('x-forwarded-proto') ?? 'https'
  if (forwardedHost) return `${forwardedProto}://${forwardedHost}`

  return new URL(request.url).origin
}

/** OAuth 2.0 Authorization Server Metadata (RFC 8414). */
export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: ['worktracker.read', 'worktracker.write'],
    // Claude's flow is PKCE-only; this is what it looks for before deciding
    // whether to attempt Dynamic Client Registration.
    service_documentation: `${origin}/`,
  }
}

/** RFC 9728 Protected Resource Metadata, served for the MCP endpoint. */
export function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    scopes_supported: ['worktracker.read', 'worktracker.write'],
  }
}

/** Standard OAuth error body + status. */
export function oauthError(
  status: number,
  code: string,
  description: string,
): Response {
  return new Response(JSON.stringify({ error: code, error_description: description }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

/** Parse an application/x-www-form-urlencoded or JSON body. */
export async function parseBody(request: Request): Promise<Record<string, string>> {
  const contentType = request.headers.get('content-type') ?? ''
  const text = await request.text()
  if (!text) return {}

  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      const out: Record<string, string> = {}
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          out[key] = String(value)
        }
      }
      return out
    } catch {
      return {}
    }
  }

  const out: Record<string, string> = {}
  for (const [key, value] of new URLSearchParams(text)) out[key] = value
  return out
}

/** Send a browser back to Claude with a code, or with an error. */
export function redirectWithParams(
  redirectUri: string,
  params: Record<string, string>,
): Response {
  const url = new URL(redirectUri)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return new Response(null, {
    status: 302,
    headers: { Location: url.toString(), 'Cache-Control': 'no-store' },
  })
}
